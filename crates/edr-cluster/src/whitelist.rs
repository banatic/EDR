//! Whitelist loaded from TOML. Schema mirrors `personal_edr_spec.html`:
//!
//! ```toml
//! [[whitelist]]
//! proc = "chrome.exe"
//! category = "network"
//! target_pattern = "*.google.com"
//! ```

use std::collections::HashMap;
use std::path::Path;

use edr_core::{Category, Event};
use serde::{Deserialize, Serialize};

use crate::glob::glob_match;
use crate::{Error, Result};

/// One whitelist row, post-parse.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhitelistEntry {
    pub proc: String,
    pub category: Category,
    pub target_pattern: String,
}

/// Raw TOML row — `category` is a lowercase string we case-fold to `Category`.
#[derive(Debug, Deserialize)]
struct RawEntry {
    proc: String,
    category: String,
    target_pattern: String,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    #[serde(default)]
    whitelist: Vec<RawEntry>,
}

/// Whitelist with a per-process prefilter for cheap matching.
#[derive(Debug, Clone, Default)]
pub struct Whitelist {
    /// Bucketed by lowercased proc name — most events resolve to `None` immediately.
    by_proc: HashMap<String, Vec<WhitelistEntry>>,
}

impl Whitelist {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_toml_str(s: &str) -> Result<Self> {
        let parsed: RawFile = toml::from_str(s)?;
        let mut by_proc: HashMap<String, Vec<WhitelistEntry>> = HashMap::new();
        for raw in parsed.whitelist {
            let category = parse_category(&raw.category)?;
            let entry = WhitelistEntry {
                proc: raw.proc,
                category,
                target_pattern: raw.target_pattern,
            };
            by_proc
                .entry(entry.proc.to_ascii_lowercase())
                .or_default()
                .push(entry);
        }
        Ok(Self { by_proc })
    }

    pub fn from_path(p: impl AsRef<Path>) -> Result<Self> {
        let s = std::fs::read_to_string(p)?;
        Self::from_toml_str(&s)
    }

    /// True if any entry matches `(proc_name [ci], category, target glob)`.
    pub fn matches(&self, ev: &Event) -> bool {
        let key = ev.proc_name.to_ascii_lowercase();
        let Some(bucket) = self.by_proc.get(&key) else {
            return false;
        };
        for entry in bucket {
            if entry.category != ev.category {
                continue;
            }
            if glob_match(&entry.target_pattern, &ev.target) {
                return true;
            }
        }
        false
    }

    /// Number of loaded entries (across all buckets).
    pub fn len(&self) -> usize {
        self.by_proc.values().map(|v| v.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn parse_category(s: &str) -> Result<Category> {
    let cat = match s.to_ascii_lowercase().as_str() {
        "process" => Category::Process,
        "file" => Category::File,
        "network" => Category::Network,
        "registry" => Category::Registry,
        "imageload" | "image_load" => Category::ImageLoad,
        "thread" => Category::Thread,
        "handle" => Category::Handle,
        "integrity" => Category::Integrity,
        other => return Err(Error::InvalidCategory(other.to_string())),
    };
    Ok(cat)
}

#[cfg(test)]
mod tests {
    use super::*;
    use edr_core::{Category, Event};

    fn ev(proc: &str, cat: Category, target: &str) -> Event {
        Event::builder(cat, "Connect")
            .pid(1)
            .ppid(0)
            .proc_name(proc)
            .target(target)
            .ts(0)
            .build()
    }

    #[test]
    fn loads_and_matches_basic() {
        let toml = r#"
[[whitelist]]
proc = "chrome.exe"
category = "network"
target_pattern = "*.google.com"
"#;
        let wl = Whitelist::from_toml_str(toml).unwrap();
        assert!(wl.matches(&ev("chrome.exe", Category::Network, "www.google.com")));
        assert!(!wl.matches(&ev("chrome.exe", Category::Network, "evil.com")));
        assert!(!wl.matches(&ev("winword.exe", Category::File, "any")));
    }

    #[test]
    fn proc_match_is_case_insensitive() {
        let toml = r#"
[[whitelist]]
proc = "Chrome.EXE"
category = "network"
target_pattern = "*.google.com"
"#;
        let wl = Whitelist::from_toml_str(toml).unwrap();
        assert!(wl.matches(&ev("chrome.exe", Category::Network, "x.google.com")));
        assert!(wl.matches(&ev("CHROME.EXE", Category::Network, "x.google.com")));
    }

    #[test]
    fn invalid_category_errors() {
        let toml = r#"
[[whitelist]]
proc = "x"
category = "what"
target_pattern = "*"
"#;
        assert!(Whitelist::from_toml_str(toml).is_err());
    }

    #[test]
    fn empty_whitelist_matches_nothing() {
        let wl = Whitelist::empty();
        assert!(!wl.matches(&ev("a", Category::Network, "b")));
    }
}
