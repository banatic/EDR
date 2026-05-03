//! Integration tests for the Phase 5 rule engine.
//!
//! Uses inline YAML mirroring `config/rules.yaml` so the suite is robust to
//! relative-path quirks when the workspace test runner moves cwd.

use edr_core::{Category, Event, Severity};
use edr_rules::{RuleEngine, RuleSet};
use serde_json::json;

const RULES_YAML: &str = r#"
- name: suspicious_office_child
  desc: "Office spawns shell"
  condition:
    parent: ["winword.exe", "excel.exe", "powerpnt.exe", "outlook.exe"]
    spawn:  ["cmd.exe", "powershell.exe", "wscript.exe", "cscript.exe", "mshta.exe"]
  severity: 2

- name: lsass_access
  desc: "lsass handle open"
  condition:
    target_proc: "lsass.exe"
    op: "OpenProcess"
    not_whitelist: true
  severity: 2

- name: run_key_persistence
  desc: "Run key add"
  condition:
    category: Registry
    op: "SetValue"
    target_pattern: "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\*"
  severity: 1

- name: etw_patch_detected
  desc: "ntdll!EtwEventWrite patched"
  condition:
    category: Integrity
    op: "EtwPatch"
  severity: 2
"#;

fn engine() -> RuleEngine {
    let rs = RuleSet::from_yaml_str(RULES_YAML).expect("rules parse");
    assert_eq!(rs.len(), 4);
    RuleEngine::new(rs)
}

#[test]
fn loads_four_rules_from_yaml() {
    let rs = RuleSet::from_yaml_str(RULES_YAML).unwrap();
    assert_eq!(rs.len(), 4);
    let names: Vec<&str> = rs.rules.iter().map(|r| r.name.as_str()).collect();
    assert!(names.contains(&"suspicious_office_child"));
    assert!(names.contains(&"lsass_access"));
    assert!(names.contains(&"run_key_persistence"));
    assert!(names.contains(&"etw_patch_detected"));
}

#[test]
fn suspicious_office_child_requires_state() {
    let eng = engine();

    // 1) winword.exe spawns and registers itself with pid=100.
    let mut e1 = Event::builder(Category::Process, "Create")
        .pid(100)
        .ppid(1)
        .proc_name("winword.exe")
        .target(r"C:\Program Files\Microsoft Office\winword.exe")
        .severity(Severity::Normal)
        .build();
    let hits1 = eng.evaluate(&mut e1);
    assert!(
        hits1.is_empty(),
        "winword.exe Create should not match any rule, got: {:?}",
        hits1
    );
    assert_eq!(e1.severity, Severity::Normal);

    // 2) winword spawns powershell.exe (pid=200, ppid=100). Must match.
    let mut e2 = Event::builder(Category::Process, "Create")
        .pid(200)
        .ppid(100)
        .proc_name("powershell.exe")
        .target(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
        .severity(Severity::Normal)
        .build();
    let hits2 = eng.evaluate(&mut e2);
    assert_eq!(hits2.len(), 1, "expected single hit, got {:?}", hits2);
    assert_eq!(hits2[0].name, "suspicious_office_child");
    assert_eq!(hits2[0].severity, 2);

    // Severity bumped to Alert (2).
    assert_eq!(e2.severity, Severity::Alert);
    // Meta annotated.
    assert_eq!(
        e2.meta.get("matched_rule").and_then(|v| v.as_str()),
        Some("suspicious_office_child")
    );
    let arr = e2
        .meta
        .get("matched_rules")
        .and_then(|v| v.as_array())
        .expect("matched_rules array");
    assert_eq!(arr.len(), 1);
}

#[test]
fn run_key_persistence_fires() {
    let eng = engine();

    let mut ev = Event::builder(Category::Registry, "SetValue")
        .pid(500)
        .ppid(1)
        .proc_name("explorer.exe")
        .target(r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\evil")
        .severity(Severity::Normal)
        .build();
    let hits = eng.evaluate(&mut ev);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "run_key_persistence");
    assert_eq!(hits[0].severity, 1);
    assert_eq!(ev.severity, Severity::Suspicious);

    // A non-Run-key SetValue should NOT fire.
    let mut ev2 = Event::builder(Category::Registry, "SetValue")
        .pid(500)
        .ppid(1)
        .proc_name("explorer.exe")
        .target(r"HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce\benign")
        .severity(Severity::Normal)
        .build();
    let hits2 = eng.evaluate(&mut ev2);
    assert!(hits2.is_empty(), "RunOnce should not match Run\\* glob");
}

#[test]
fn etw_patch_detected_fires() {
    let eng = engine();

    let mut ev = Event::builder(Category::Integrity, "EtwPatch")
        .pid(666)
        .ppid(1)
        .proc_name("malware.exe")
        .target("ntdll!EtwEventWrite")
        .severity(Severity::Normal)
        .build();
    let hits = eng.evaluate(&mut ev);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "etw_patch_detected");
    assert_eq!(ev.severity, Severity::Alert);
}

#[test]
fn lsass_access_respects_whitelist() {
    let eng = engine();

    // Without whitelist meta — fires.
    let mut ev = Event::builder(Category::Handle, "OpenProcess")
        .pid(900)
        .ppid(1)
        .proc_name("evil.exe")
        .target("lsass.exe")
        .severity(Severity::Normal)
        .build();
    let hits = eng.evaluate(&mut ev);
    assert_eq!(hits.len(), 1, "lsass_access should fire, got {:?}", hits);
    assert_eq!(hits[0].name, "lsass_access");
    assert_eq!(ev.severity, Severity::Alert);

    // Same event but whitelisted=true — suppressed.
    let mut ev2 = Event::builder(Category::Handle, "OpenProcess")
        .pid(901)
        .ppid(1)
        .proc_name("av.exe")
        .target("lsass.exe")
        .severity(Severity::Normal)
        .meta(json!({ "whitelisted": true }))
        .build();
    let hits2 = eng.evaluate(&mut ev2);
    assert!(
        hits2.is_empty(),
        "whitelisted lsass access must be suppressed, got {:?}",
        hits2
    );
    assert_eq!(ev2.severity, Severity::Normal);
}

#[test]
fn no_match_leaves_event_untouched() {
    let eng = engine();

    let mut ev = Event::builder(Category::File, "Write")
        .pid(123)
        .ppid(1)
        .proc_name("notepad.exe")
        .target(r"C:\Users\me\notes.txt")
        .severity(Severity::Normal)
        .build();
    let hits = eng.evaluate(&mut ev);
    assert!(hits.is_empty());
    assert_eq!(ev.severity, Severity::Normal);
    assert!(ev.meta.get("matched_rule").is_none());
}

#[test]
fn multiple_office_children_all_match() {
    let eng = engine();

    // Register an Excel parent.
    let mut parent = Event::builder(Category::Process, "Create")
        .pid(50)
        .ppid(1)
        .proc_name("excel.exe")
        .build();
    eng.evaluate(&mut parent);

    // cmd.exe child
    let mut child = Event::builder(Category::Process, "Create")
        .pid(51)
        .ppid(50)
        .proc_name("cmd.exe")
        .build();
    let hits = eng.evaluate(&mut child);
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].name, "suspicious_office_child");

    // wscript.exe child
    let mut child2 = Event::builder(Category::Process, "Create")
        .pid(52)
        .ppid(50)
        .proc_name("wscript.exe")
        .build();
    let hits2 = eng.evaluate(&mut child2);
    assert_eq!(hits2.len(), 1);
    assert_eq!(hits2[0].name, "suspicious_office_child");

    // notepad.exe child — NOT in spawn list.
    let mut child3 = Event::builder(Category::Process, "Create")
        .pid(53)
        .ppid(50)
        .proc_name("notepad.exe")
        .build();
    let hits3 = eng.evaluate(&mut child3);
    assert!(hits3.is_empty());
}
