//! Phase 5 detection rule engine for PersonalEDR.
//!
//! Loads YAML rules (see `config/rules.yaml`) and evaluates them against a
//! stream of [`edr_core::Event`] values. Stateful matching (e.g. `parent +
//! spawn` patterns where an Office app spawns `cmd.exe`) is supported via an
//! internal `pid -> proc_name` map fed by every Process Create event the
//! engine sees.

use std::collections::HashMap;
use std::path::Path;

use edr_core::{Category, Event, Severity};
use parking_lot::RwLock;
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RuleError {
    #[error("failed to read rules file: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse YAML: {0}")]
    Parse(#[from] serde_yaml::Error),
}

pub type Result<T> = std::result::Result<T, RuleError>;

/// One of the `category` field shapes — single value or list of values.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum OneOrMany<T> {
    One(T),
    Many(Vec<T>),
}

impl<T: Clone> OneOrMany<T> {
    fn into_vec(self) -> Vec<T> {
        match self {
            OneOrMany::One(v) => vec![v],
            OneOrMany::Many(v) => v,
        }
    }
}

/// Raw on-disk schema. Mirrors the keys in `config/rules.yaml`.
#[derive(Debug, Clone, Deserialize)]
struct RawCondition {
    #[serde(default)]
    category: Option<OneOrMany<Category>>,
    #[serde(default)]
    op: Option<OneOrMany<String>>,
    #[serde(default)]
    parent: Option<Vec<String>>,
    #[serde(default)]
    spawn: Option<Vec<String>>,
    #[serde(default)]
    target_proc: Option<String>,
    #[serde(default)]
    target_pattern: Option<String>,
    #[serde(default)]
    not_whitelist: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct RawRule {
    name: String,
    #[serde(default)]
    desc: Option<String>,
    condition: RawCondition,
    #[serde(default)]
    severity: u8,
}

/// One detection rule, parsed and ready to evaluate.
#[derive(Debug, Clone)]
pub struct Rule {
    pub name: String,
    pub desc: Option<String>,
    pub categories: Vec<Category>,
    pub ops: Vec<String>,
    pub parents: Vec<String>,
    pub spawns: Vec<String>,
    pub target_proc: Option<String>,
    pub target_pattern: Option<String>,
    pub not_whitelist: bool,
    pub severity: u8,
}

impl From<RawRule> for Rule {
    fn from(r: RawRule) -> Self {
        Rule {
            name: r.name,
            desc: r.desc,
            categories: r
                .condition
                .category
                .map(OneOrMany::into_vec)
                .unwrap_or_default(),
            ops: r
                .condition
                .op
                .map(OneOrMany::into_vec)
                .unwrap_or_default(),
            parents: r.condition.parent.unwrap_or_default(),
            spawns: r.condition.spawn.unwrap_or_default(),
            target_proc: r.condition.target_proc,
            target_pattern: r.condition.target_pattern,
            not_whitelist: r.condition.not_whitelist,
            severity: r.severity,
        }
    }
}

/// A parsed collection of detection rules.
#[derive(Debug, Clone, Default)]
pub struct RuleSet {
    pub rules: Vec<Rule>,
}

impl RuleSet {
    pub fn from_yaml_str(yaml: &str) -> Result<Self> {
        let raws: Vec<RawRule> = serde_yaml::from_str(yaml)?;
        Ok(RuleSet {
            rules: raws.into_iter().map(Rule::from).collect(),
        })
    }

    pub fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        let s = std::fs::read_to_string(path)?;
        Self::from_yaml_str(&s)
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }
}

/// Result of a fired rule. Cheap to clone and store on the event meta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedRule {
    pub name: String,
    pub severity: u8,
}

/// Stateful evaluator. Tracks `pid -> proc_name` so `parent` rules can resolve
/// PPID-to-name. Wrapped in `RwLock` so the engine is `Sync` and safe to share
/// across collector tasks.
pub struct RuleEngine {
    rules: RuleSet,
    proc_map: RwLock<HashMap<u32, String>>,
}

impl RuleEngine {
    pub fn new(rules: RuleSet) -> Self {
        Self {
            rules,
            proc_map: RwLock::new(HashMap::new()),
        }
    }

    pub fn rules(&self) -> &RuleSet {
        &self.rules
    }

    /// Update the engine's process tree state from a single event.
    /// Specifically, on Process Create, register `pid -> proc_name`.
    fn ingest_state(&self, ev: &Event) {
        if matches!(ev.category, Category::Process) && ev.op.eq_ignore_ascii_case("Create") {
            if ev.pid != 0 && !ev.proc_name.is_empty() {
                self.proc_map
                    .write()
                    .insert(ev.pid, ev.proc_name.to_lowercase());
            }
        }
    }

    /// Look up the process name registered for `pid`, if any.
    fn proc_name_for_pid(&self, pid: u32) -> Option<String> {
        self.proc_map.read().get(&pid).cloned()
    }

    /// Test a single rule against `ev`.
    fn rule_matches(&self, rule: &Rule, ev: &Event) -> bool {
        // not_whitelist short-circuit: if the event is whitelisted, suppress.
        if rule.not_whitelist && meta_bool(&ev.meta, "whitelisted") {
            return false;
        }

        if !rule.categories.is_empty() && !rule.categories.contains(&ev.category) {
            return false;
        }

        if !rule.ops.is_empty()
            && !rule.ops.iter().any(|o| o.eq_ignore_ascii_case(&ev.op))
        {
            return false;
        }

        // `spawn`: current event must be a Process Create with one of these
        // proc_names. Implies Process category.
        if !rule.spawns.is_empty() {
            if !matches!(ev.category, Category::Process) || !ev.op.eq_ignore_ascii_case("Create") {
                return false;
            }
            let me = ev.proc_name.to_lowercase();
            if !rule.spawns.iter().any(|s| s.eq_ignore_ascii_case(&me)) {
                return false;
            }
        }

        // `parent`: current event's PPID must resolve (via proc_map) to one of
        // these proc_names. The current event is processed AFTER state ingest
        // so that a Process Create event registering the parent itself is
        // visible too — but for `parent`, we need an *earlier* Create.
        if !rule.parents.is_empty() {
            let parent_name = match self.proc_name_for_pid(ev.ppid) {
                Some(n) => n,
                None => return false,
            };
            if !rule
                .parents
                .iter()
                .any(|p| p.eq_ignore_ascii_case(&parent_name))
            {
                return false;
            }
        }

        // `target_proc`: prefer `meta.target_proc` (string) — fall back to
        // event.target so simple test fixtures work without rich meta.
        if let Some(tp) = &rule.target_proc {
            let candidate = meta_str(&ev.meta, "target_proc")
                .map(String::from)
                .unwrap_or_else(|| ev.target.clone());
            if !candidate.eq_ignore_ascii_case(tp) {
                return false;
            }
        }

        if let Some(pat) = &rule.target_pattern {
            if !glob_match(pat, &ev.target) {
                return false;
            }
        }

        true
    }

    /// Evaluate `ev` against every loaded rule. Side effects:
    /// - On Process Create, registers pid -> proc_name in the state map.
    /// - For every rule that fires, raises `ev.severity` to
    ///   `max(ev.severity, rule.severity)` and writes `meta.matched_rule`
    ///   (the highest-severity rule's name) plus `meta.matched_rules` (full
    ///   array) of names.
    pub fn evaluate(&self, ev: &mut Event) -> Vec<MatchedRule> {
        // State ingest happens first so that a Process Create can be matched
        // by `spawn` rules that reference its own name. (For `parent`, the
        // ppid lookup uses an *earlier* Create — registering self never
        // affects that lookup since pid != ppid in any real event.)
        self.ingest_state(ev);

        let mut hits: Vec<MatchedRule> = Vec::new();
        for rule in &self.rules.rules {
            if self.rule_matches(rule, ev) {
                hits.push(MatchedRule {
                    name: rule.name.clone(),
                    severity: rule.severity,
                });
            }
        }

        if hits.is_empty() {
            return hits;
        }

        // Pick the highest-severity hit (ties broken by first occurrence).
        let top = hits
            .iter()
            .max_by_key(|h| h.severity)
            .cloned()
            .expect("hits non-empty");

        // Bump event severity to max(rule, event).
        let new_sev_u8 = top.severity.max(ev.severity.as_u8());
        ev.severity = Severity::from_u8(new_sev_u8);

        // Stamp meta with rule names. Preserve any existing meta object;
        // promote Null/non-object meta to a fresh object.
        if !ev.meta.is_object() {
            ev.meta = json!({});
        }
        if let Some(obj) = ev.meta.as_object_mut() {
            obj.insert("matched_rule".to_string(), JsonValue::String(top.name.clone()));
            let arr: Vec<JsonValue> = hits
                .iter()
                .map(|h| JsonValue::String(h.name.clone()))
                .collect();
            obj.insert("matched_rules".to_string(), JsonValue::Array(arr));
        }

        hits
    }
}

// ---- helpers ---------------------------------------------------------------

fn meta_bool(meta: &JsonValue, key: &str) -> bool {
    meta.get(key).and_then(JsonValue::as_bool).unwrap_or(false)
}

fn meta_str<'a>(meta: &'a JsonValue, key: &str) -> Option<&'a str> {
    meta.get(key).and_then(JsonValue::as_str)
}

/// Minimal glob: `*` matches any run of characters (including the empty
/// string), every other char is literal and case-insensitive. Sufficient for
/// the registry-key style patterns in the spec, e.g.
/// `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\*`.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().flat_map(char::to_lowercase).collect();
    let t: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    glob_inner(&p, &t)
}

fn glob_inner(p: &[char], t: &[char]) -> bool {
    // Iterative two-pointer with backtracking — O(|p| * |t|) worst case,
    // plenty fast for short rule patterns.
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star_p, mut match_t): (Option<usize>, usize) = (None, 0);

    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            star_p = Some(pi);
            match_t = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(sp) = star_p {
            pi = sp + 1;
            match_t += 1;
            ti = match_t;
        } else {
            return false;
        }
    }

    // Trailing '*'s can absorb the empty suffix.
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_basic_literal() {
        assert!(glob_match("foo", "foo"));
        assert!(!glob_match("foo", "bar"));
    }

    #[test]
    fn glob_case_insensitive() {
        assert!(glob_match("FOO", "foo"));
        assert!(glob_match("foo", "FOO"));
    }

    #[test]
    fn glob_trailing_star() {
        assert!(glob_match(
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\*",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\evil"
        ));
        assert!(glob_match(
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\*",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\"
        ));
        assert!(!glob_match(
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\*",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce\evil"
        ));
    }

    #[test]
    fn glob_middle_star() {
        assert!(glob_match("a*z", "abcz"));
        assert!(glob_match("a*z", "az"));
        assert!(!glob_match("a*z", "abc"));
    }

    #[test]
    fn glob_multiple_stars() {
        assert!(glob_match("*foo*", "xxfooxx"));
        assert!(glob_match("*", ""));
        assert!(glob_match("**", "anything"));
    }

    #[test]
    fn parses_minimal_yaml() {
        let yaml = r#"
- name: just_a_test
  condition:
    category: Process
    op: Create
  severity: 1
"#;
        let rs = RuleSet::from_yaml_str(yaml).unwrap();
        assert_eq!(rs.len(), 1);
        assert_eq!(rs.rules[0].name, "just_a_test");
        assert_eq!(rs.rules[0].severity, 1);
    }

    #[test]
    fn category_accepts_list() {
        let yaml = r#"
- name: multi_cat
  condition:
    category: [Process, File]
  severity: 0
"#;
        let rs = RuleSet::from_yaml_str(yaml).unwrap();
        assert_eq!(rs.rules[0].categories.len(), 2);
    }
}
