//! Tauri IPC command surface — backed by the live in-memory store.

use std::collections::HashMap;

use edr_core::{Category, Event, Severity};
use edr_store::Query;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tauri::State;

use crate::state::AppState;

// ---- Wire types ------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QueryFilter {
    pub from_ns: Option<i64>,
    pub to_ns: Option<i64>,
    pub pids: Option<Vec<u32>>,
    pub categories: Option<Vec<Category>>,
    pub search: Option<String>,
    pub limit: Option<usize>,
    pub min_severity: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProcessSummary {
    pub pid: u32,
    pub ppid: u32,
    pub proc_name: String,
    pub first_seen_ts: i64,
    pub last_seen_ts: i64,
    pub event_count: u64,
    pub alert_count: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bucket {
    pub ts_bucket: i64,
    pub pid: Option<u32>,
    pub category: Option<Category>,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub hide_whitelisted: bool,
    pub cluster_threshold: u32,
    pub show_dimmed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInfo {
    /// "etw" or "synthetic".
    pub backend: String,
    pub elevated: bool,
    pub rule_count: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hide_whitelisted: false,
            cluster_threshold: 10,
            show_dimmed: true,
        }
    }
}

// ---- Commands --------------------------------------------------------------

#[tauri::command]
pub async fn query_events(
    filter: QueryFilter,
    state: State<'_, AppState>,
) -> Result<Vec<Event>, String> {
    let mut q = Query::new();
    if let Some(s) = filter.from_ns {
        q = q.since(s);
    }
    if let Some(u) = filter.to_ns {
        q = q.until(u);
    }
    if let Some(s) = filter.min_severity {
        q = q.min_severity(s);
    }
    if let Some(limit) = filter.limit {
        q = q.limit(limit);
    } else {
        q = q.limit(50_000);
    }

    let mut events = state.store.query(&q).map_err(|e| e.to_string())?;

    if let Some(pids) = &filter.pids {
        events.retain(|e| pids.contains(&e.pid));
    }
    if let Some(cats) = &filter.categories {
        events.retain(|e| cats.contains(&e.category));
    }
    if let Some(needle) = filter.search.as_deref() {
        let needle = needle.to_lowercase();
        events.retain(|e| {
            e.proc_name.to_lowercase().contains(&needle)
                || e.op.to_lowercase().contains(&needle)
                || e.target.to_lowercase().contains(&needle)
        });
    }
    Ok(events)
}

#[tauri::command]
pub async fn list_processes(
    state: State<'_, AppState>,
) -> Result<Vec<ProcessSummary>, String> {
    let events = state
        .store
        .query(&Query::new().limit(200_000))
        .map_err(|e| e.to_string())?;

    let mut map: HashMap<u32, ProcessSummary> = HashMap::new();
    for ev in &events {
        let entry = map.entry(ev.pid).or_insert_with(|| ProcessSummary {
            pid: ev.pid,
            ppid: ev.ppid,
            proc_name: ev.proc_name.clone(),
            first_seen_ts: ev.ts,
            last_seen_ts: ev.ts,
            event_count: 0,
            alert_count: 0,
        });
        entry.event_count += 1;
        entry.last_seen_ts = entry.last_seen_ts.max(ev.ts);
        entry.first_seen_ts = entry.first_seen_ts.min(ev.ts);
        if matches!(ev.severity, Severity::Alert) {
            entry.alert_count += 1;
        }
        if entry.proc_name.is_empty() && !ev.proc_name.is_empty() {
            entry.proc_name = ev.proc_name.clone();
        }
        if entry.ppid == 0 && ev.ppid != 0 {
            entry.ppid = ev.ppid;
        }
    }
    Ok(map.into_values().collect())
}

#[tauri::command]
pub async fn aggregate_range(
    from_ns: i64,
    to_ns: i64,
    by_pid: bool,
    state: State<'_, AppState>,
) -> Result<Vec<Bucket>, String> {
    let events = state
        .store
        .query(&Query::new().since(from_ns).until(to_ns).limit(200_000))
        .map_err(|e| e.to_string())?;

    let span = (to_ns - from_ns).max(1);
    let bucket_size = (span / 60).max(1);
    let mut buckets: HashMap<(i64, Option<u32>), u64> = HashMap::new();
    for ev in events {
        let bucket_idx = (ev.ts - from_ns) / bucket_size;
        let key = (bucket_idx, if by_pid { Some(ev.pid) } else { None });
        *buckets.entry(key).or_insert(0) += 1;
    }

    Ok(buckets
        .into_iter()
        .map(|((idx, pid), count)| Bucket {
            ts_bucket: from_ns + idx * bucket_size,
            pid,
            category: None,
            count,
        })
        .collect())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.read().clone())
}

#[tauri::command]
pub async fn get_runtime_info(state: State<'_, AppState>) -> Result<RuntimeInfo, String> {
    Ok(state.runtime.read().clone())
}

#[tauri::command]
pub async fn set_setting(
    key: String,
    value: JsonValue,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut s = state.settings.write();
    match key.as_str() {
        "hide_whitelisted" => {
            if let Some(b) = value.as_bool() {
                s.hide_whitelisted = b;
            }
        }
        "cluster_threshold" => {
            if let Some(n) = value.as_u64() {
                s.cluster_threshold = n as u32;
            }
        }
        "show_dimmed" => {
            if let Some(b) = value.as_bool() {
                s.show_dimmed = b;
            }
        }
        other => {
            return Err(format!("unknown setting: {other}"));
        }
    }
    Ok(())
}
