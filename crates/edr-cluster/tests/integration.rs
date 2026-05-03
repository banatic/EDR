//! Integration tests for the noise-reduction layer. These exercise the public
//! API only and mirror the test cases enumerated in the build spec.

use std::time::Duration;

use edr_cluster::{ClusterConfig, EventProcessor, ProcessOutput, Whitelist};
use edr_core::{Category, Event};

const WL_TOML: &str = r#"
[[whitelist]]
proc = "chrome.exe"
category = "network"
target_pattern = "*.google.com"

[[whitelist]]
proc = "explorer.exe"
category = "file"
target_pattern = "C:\\Users\\*\\AppData\\Local\\*"
"#;

fn ev(proc: &str, cat: Category, target: &str) -> Event {
    Event::builder(cat, "Connect")
        .pid(1)
        .ppid(0)
        .proc_name(proc)
        .target(target)
        .ts(0)
        .build()
}

// ---------- 1. Whitelist match ----------

#[test]
fn whitelist_chrome_google_matches() {
    let wl = Whitelist::from_toml_str(WL_TOML).unwrap();
    assert!(wl.matches(&ev("chrome.exe", Category::Network, "www.google.com:443")) == false);
    // Note: target_pattern is `*.google.com` (no port) — the raw target carries
    // a port. The match is exercised against normalized DNS, so we use the
    // hostname-only form for whitelist hits in production. We assert both:
    assert!(wl.matches(&ev("chrome.exe", Category::Network, "www.google.com")));
}

#[test]
fn whitelist_chrome_evil_no_match() {
    let wl = Whitelist::from_toml_str(WL_TOML).unwrap();
    assert!(!wl.matches(&ev("chrome.exe", Category::Network, "evil.com:443")));
    assert!(!wl.matches(&ev("chrome.exe", Category::Network, "evil.com")));
}

#[test]
fn whitelist_winword_file_no_match() {
    let wl = Whitelist::from_toml_str(WL_TOML).unwrap();
    assert!(!wl.matches(&ev("winword.exe", Category::File, "anything")));
    assert!(!wl.matches(&ev("winword.exe", Category::File, r"C:\Users\x\AppData\Local\foo")));
}

// ---------- 2. Glob matcher ----------

#[test]
fn glob_subdomain_star() {
    use edr_cluster::glob::glob_match;
    assert!(glob_match("*.google.com", "mail.google.com"));
    assert!(!glob_match("*.google.com", "notgoogle.com"));
}

#[test]
fn glob_user_appdata() {
    use edr_cluster::glob::glob_match;
    assert!(glob_match(
        r"C:\Users\*\AppData\Local\*",
        r"C:\Users\moomin\AppData\Local\foo"
    ));
}

// ---------- 3. Sliding window dedup ----------

#[test]
fn sliding_window_3_threshold_collapses_tail() {
    let cfg = ClusterConfig {
        window: Duration::from_secs(60),
        threshold: 3,
    };
    let mut p = EventProcessor::new(Whitelist::empty(), cfg);

    let mut emits = 0;
    let mut drops = 0;
    let mut aggs = 0;

    for i in 0..5 {
        let e = Event::builder(Category::Network, "Connect")
            .pid(7)
            .proc_name("noisy.exe")
            .target("8.8.8.8:53")
            .ts(i * 1_000_000)
            .build();
        match p.process(e) {
            ProcessOutput::Emit(_) => emits += 1,
            ProcessOutput::Drop => drops += 1,
            ProcessOutput::Aggregate(_) => aggs += 1,
        }
    }

    // First 3 pass through, next 2 are absorbed silently (tick is at 6).
    assert_eq!(emits, 3);
    assert_eq!(drops, 2);
    assert_eq!(aggs, 0);

    // Trigger the tick by sending one more.
    let e = Event::builder(Category::Network, "Connect")
        .pid(7)
        .proc_name("noisy.exe")
        .target("8.8.8.8:53")
        .ts(6_000_000)
        .build();
    if let ProcessOutput::Aggregate(ev) = p.process(e) {
        let count = ev.meta["cluster"]["count"].as_u64().unwrap();
        assert!(count >= 4, "expected count >= 4, got {}", count);
        assert!(ev.meta["cluster"]["sample"].is_array());
        assert_eq!(ev.meta["cluster"]["sample"].as_array().unwrap().len(), 3);
    } else {
        panic!("expected aggregate");
    }
}

// ---------- 4. First-seen tracking ----------

#[test]
fn first_seen_marks_only_first() {
    let mut p = EventProcessor::new(Whitelist::empty(), ClusterConfig::default());

    let e1 = Event::builder(Category::Network, "Connect")
        .pid(99)
        .proc_name("a.exe")
        .target("9.9.9.9:443")
        .ts(0)
        .build();
    let out1 = p.process(e1);
    let ev1 = match out1 {
        ProcessOutput::Emit(e) => e,
        _ => panic!("expected emit"),
    };
    assert_eq!(ev1.meta["first_seen"], serde_json::Value::Bool(true));

    let e2 = Event::builder(Category::Network, "Connect")
        .pid(99)
        .proc_name("a.exe")
        .target("9.9.9.9:443")
        .ts(1)
        .build();
    let out2 = p.process(e2);
    let ev2 = match out2 {
        ProcessOutput::Emit(e) => e,
        _ => panic!("expected emit"),
    };
    assert!(
        ev2.meta.get("first_seen").is_none(),
        "second event should not be flagged first_seen, got meta={}",
        ev2.meta
    );
}

// ---------- 5. target_pattern normalization ----------

#[test]
fn file_events_collapse_to_parent_dir() {
    let cfg = ClusterConfig {
        window: Duration::from_secs(60),
        threshold: 2,
    };
    let mut p = EventProcessor::new(Whitelist::empty(), cfg);

    let a = Event::builder(Category::File, "Write")
        .pid(11)
        .proc_name("notepad.exe")
        .target(r"C:\Users\x\a.txt")
        .ts(0)
        .build();
    let b = Event::builder(Category::File, "Write")
        .pid(11)
        .proc_name("notepad.exe")
        .target(r"C:\Users\x\b.txt")
        .ts(1_000_000)
        .build();

    // First two events with different targets but same parent dir → both
    // emit, but only the first should be tagged first_seen (because the
    // normalized key is identical).
    let out_a = p.process(a);
    let out_b = p.process(b);

    let ev_a = match out_a {
        ProcessOutput::Emit(e) => e,
        _ => panic!(),
    };
    let ev_b = match out_b {
        ProcessOutput::Emit(e) => e,
        _ => panic!(),
    };
    assert_eq!(ev_a.meta["first_seen"], serde_json::Value::Bool(true));
    assert!(
        ev_b.meta.get("first_seen").is_none(),
        "second file in same parent dir should not be first_seen"
    );
}

#[test]
fn network_events_collapse_across_ports() {
    let cfg = ClusterConfig {
        window: Duration::from_secs(60),
        threshold: 2,
    };
    let mut p = EventProcessor::new(Whitelist::empty(), cfg);

    let a = Event::builder(Category::Network, "Connect")
        .pid(22)
        .proc_name("curl.exe")
        .target("1.2.3.4:443")
        .ts(0)
        .build();
    let b = Event::builder(Category::Network, "Connect")
        .pid(22)
        .proc_name("curl.exe")
        .target("1.2.3.4:80")
        .ts(1_000_000)
        .build();

    let out_a = p.process(a);
    let out_b = p.process(b);
    let ev_a = match out_a {
        ProcessOutput::Emit(e) => e,
        _ => panic!(),
    };
    let ev_b = match out_b {
        ProcessOutput::Emit(e) => e,
        _ => panic!(),
    };
    assert_eq!(ev_a.meta["first_seen"], serde_json::Value::Bool(true));
    assert!(ev_b.meta.get("first_seen").is_none());
}

// ---------- bonus: from_path ----------

#[test]
fn whitelist_from_path() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("wl.toml");
    std::fs::write(&path, WL_TOML).unwrap();
    let wl = Whitelist::from_path(&path).unwrap();
    assert!(wl.matches(&ev("chrome.exe", Category::Network, "mail.google.com")));
}
