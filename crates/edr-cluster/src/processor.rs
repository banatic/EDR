//! Sliding-window dedup + first-seen tagging.
//!
//! Each event is keyed by `(pid, category, normalized_target)`. The first N
//! events in a window pass through normally; from the (N+1)th onward they are
//! folded into a single aggregate event emitted once per *threshold-crossing
//! tick* (i.e. once for every additional N events accumulated past the first
//! threshold).
//!
//! Timestamps are taken from `Event::ts` (Unix nanoseconds) so the window is
//! deterministic for replay/testing — no wall-clock dependency here.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use edr_core::{Category, Event};
use serde_json::{json, Value as JsonValue};

use crate::normalize::normalize_target;
use crate::whitelist::Whitelist;

/// Configuration for the dedup window.
#[derive(Debug, Clone, Copy)]
pub struct ClusterConfig {
    pub window: Duration,
    pub threshold: u32,
}

impl Default for ClusterConfig {
    fn default() -> Self {
        Self {
            window: Duration::from_secs(60),
            threshold: 10,
        }
    }
}

/// What the consumer should do with the post-processed event.
#[derive(Debug)]
pub enum ProcessOutput {
    /// Emit the event as-is (possibly with mutated meta).
    Emit(Event),
    /// Suppress entirely (currently unused — reserved for fully-hidden whitelist mode).
    #[allow(dead_code)]
    Drop,
    /// A rolled-up aggregate that replaces the single event.
    Aggregate(Event),
}

/// Per-key sliding state.
#[derive(Debug)]
struct KeyState {
    /// Timestamps of events still inside the window (ns).
    times: VecDeque<i64>,
    /// First three raw events sampled, for `meta.cluster.sample`.
    sample: Vec<Event>,
    /// Number of events folded into the *current* aggregate burst (since
    /// the most recent flush). Counts include the threshold-crossing event.
    folded_count: u32,
    /// Timestamp of the first event in the current burst (ns).
    first_ts: i64,
    /// Timestamp of the most recent folded event (ns).
    last_ts: i64,
    /// Total events seen in this key (since processor start) — for diagnostics.
    total: u64,
}

impl KeyState {
    fn new() -> Self {
        Self {
            times: VecDeque::new(),
            sample: Vec::with_capacity(3),
            folded_count: 0,
            first_ts: 0,
            last_ts: 0,
            total: 0,
        }
    }
}

type Key = (u32, Category, String);

/// Processor that runs whitelist tagging, sliding-window dedup, and
/// first-seen tracking on each event before they hit downstream consumers.
pub struct EventProcessor {
    pub whitelist: Whitelist,
    pub cluster: ClusterConfig,
    states: HashMap<Key, KeyState>,
    /// First-seen set keyed on `(proc_name_lowercase, category, normalized_target)`.
    seen: HashSet<(String, Category, String)>,
}

impl EventProcessor {
    pub fn new(whitelist: Whitelist, cluster: ClusterConfig) -> Self {
        Self {
            whitelist,
            cluster,
            states: HashMap::new(),
            seen: HashSet::new(),
        }
    }

    /// Process one event. Mutates `ev` to add `meta.first_seen` /
    /// `meta.whitelisted` / `meta.cluster` as appropriate.
    pub fn process(&mut self, mut ev: Event) -> ProcessOutput {
        // 1) Whitelist tag — does NOT drop. The CLI consumer can decide to
        //    dim/hide based on the meta flag.
        let whitelisted = self.whitelist.matches(&ev);
        if whitelisted {
            set_meta_flag(&mut ev.meta, "whitelisted", JsonValue::Bool(true));
        }

        // 2) First-seen tracking. Uses normalized target for stability.
        let norm = normalize_target(ev.category, &ev.target);
        let seen_key = (
            ev.proc_name.to_ascii_lowercase(),
            ev.category,
            norm.clone(),
        );
        if self.seen.insert(seen_key) {
            set_meta_flag(&mut ev.meta, "first_seen", JsonValue::Bool(true));
        }

        // 3) Sliding-window dedup.
        let key: Key = (ev.pid, ev.category, norm);
        let window_ns = self.cluster.window.as_nanos() as i64;
        let threshold = self.cluster.threshold;

        let state = self.states.entry(key).or_insert_with(KeyState::new);
        state.total += 1;

        // Evict stale timestamps outside the window.
        let cutoff = ev.ts.saturating_sub(window_ns);
        while let Some(&front) = state.times.front() {
            if front < cutoff {
                state.times.pop_front();
            } else {
                break;
            }
        }
        // If the window emptied out, clear the in-flight burst too — a long
        // quiet period resets the dedup state for this key.
        if state.times.is_empty() {
            state.folded_count = 0;
            state.sample.clear();
        }

        state.times.push_back(ev.ts);
        let in_window = state.times.len() as u32;

        // First N events pass through.
        if in_window <= threshold {
            if state.sample.len() < 3 {
                state.sample.push(ev.clone());
            }
            if state.folded_count == 0 {
                state.first_ts = ev.ts;
            }
            state.last_ts = ev.ts;
            state.folded_count = state.folded_count.saturating_add(1);
            return ProcessOutput::Emit(ev);
        }

        // Past the threshold — fold. We emit one aggregate per "tick" of N
        // additional events. So events N+1 .. 2N - 1 silently absorb; on
        // event 2N we emit. Then 2N+1 .. 3N-1 absorb; on 3N we emit. Etc.
        state.folded_count = state.folded_count.saturating_add(1);
        state.last_ts = ev.ts;
        if state.sample.len() < 3 {
            state.sample.push(ev.clone());
        }

        let crosses_tick = state.folded_count % threshold == 0;
        if !crosses_tick {
            // Silently absorbed; the consumer does not see this event.
            // We model that as Aggregate-with-zero is wrong; instead emit
            // Drop so the consumer ignores it. (Drop is also used for
            // hidden-whitelist mode, but here it means "absorbed by cluster".)
            return ProcessOutput::Drop;
        }

        // Emit a rolled-up aggregate event.
        let mut agg = ev.clone();
        let cluster_meta = json!({
            "count": state.folded_count,
            "first_ts": state.first_ts,
            "last_ts": state.last_ts,
            "sample": state.sample.iter().map(event_to_json).collect::<Vec<_>>(),
        });
        set_meta_flag(&mut agg.meta, "cluster", cluster_meta);
        ProcessOutput::Aggregate(agg)
    }

    /// Number of distinct cluster keys currently tracked.
    pub fn key_count(&self) -> usize {
        self.states.len()
    }
}

fn set_meta_flag(meta: &mut JsonValue, key: &str, value: JsonValue) {
    if !meta.is_object() {
        *meta = JsonValue::Object(serde_json::Map::new());
    }
    if let Some(obj) = meta.as_object_mut() {
        obj.insert(key.to_string(), value);
    }
}

fn event_to_json(ev: &Event) -> JsonValue {
    serde_json::to_value(ev).unwrap_or(JsonValue::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use edr_core::Category;

    fn make_ev(pid: u32, ts: i64, target: &str) -> Event {
        Event::builder(Category::Network, "Connect")
            .pid(pid)
            .ppid(1)
            .proc_name("chrome.exe")
            .target(target)
            .ts(ts)
            .build()
    }

    #[test]
    fn first_n_pass_then_aggregate_on_tick() {
        let cfg = ClusterConfig {
            window: Duration::from_secs(60),
            threshold: 3,
        };
        let mut p = EventProcessor::new(Whitelist::empty(), cfg);

        let outs: Vec<_> = (0..5)
            .map(|i| p.process(make_ev(100, i * 1_000_000, "1.2.3.4:443")))
            .collect();

        // 0,1,2 -> Emit, 3 -> Drop (absorbed), 4 -> Drop (absorbed; tick is at 6).
        let kinds: Vec<&str> = outs
            .iter()
            .map(|o| match o {
                ProcessOutput::Emit(_) => "emit",
                ProcessOutput::Drop => "drop",
                ProcessOutput::Aggregate(_) => "agg",
            })
            .collect();
        assert_eq!(kinds, vec!["emit", "emit", "emit", "drop", "drop"]);

        // 6th event (folded_count == 6) should aggregate.
        let sixth = p.process(make_ev(100, 5_000_000, "1.2.3.4:443"));
        match sixth {
            ProcessOutput::Aggregate(ev) => {
                let cluster = ev.meta.get("cluster").expect("cluster meta");
                let count = cluster.get("count").and_then(|v| v.as_u64()).unwrap();
                assert!(count >= 4);
            }
            other => panic!("expected aggregate, got {:?}", other),
        }
    }

    #[test]
    fn first_seen_tracking() {
        let mut p = EventProcessor::new(Whitelist::empty(), ClusterConfig::default());
        let out1 = p.process(make_ev(1, 0, "1.1.1.1:443"));
        let out2 = p.process(make_ev(1, 1, "1.1.1.1:443"));
        match out1 {
            ProcessOutput::Emit(ev) => assert_eq!(ev.meta["first_seen"], JsonValue::Bool(true)),
            _ => panic!(),
        }
        match out2 {
            ProcessOutput::Emit(ev) => assert!(ev.meta.get("first_seen").is_none()),
            _ => panic!(),
        }
    }

    #[test]
    fn whitelist_meta_flag_set() {
        let toml = r#"
[[whitelist]]
proc = "chrome.exe"
category = "network"
target_pattern = "*.google.com"
"#;
        let wl = Whitelist::from_toml_str(toml).unwrap();
        let mut p = EventProcessor::new(wl, ClusterConfig::default());
        let ev = Event::builder(Category::Network, "Connect")
            .pid(1)
            .proc_name("chrome.exe")
            .target("www.google.com")
            .ts(0)
            .build();
        match p.process(ev) {
            ProcessOutput::Emit(ev) => assert_eq!(ev.meta["whitelisted"], JsonValue::Bool(true)),
            _ => panic!(),
        }
    }
}
