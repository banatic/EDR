use crate::severity::Severity;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum Category {
    Process,
    File,
    Network,
    Registry,
    ImageLoad,
    Thread,
    Handle,
    Integrity,
}

impl Category {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Process => "Process",
            Self::File => "File",
            Self::Network => "Network",
            Self::Registry => "Registry",
            Self::ImageLoad => "ImageLoad",
            Self::Thread => "Thread",
            Self::Handle => "Handle",
            Self::Integrity => "Integrity",
        }
    }
}

/// Event matches the schema in `personal_edr_spec.html`:
/// `(ts, pid, ppid, proc_name, category, op, target, severity, meta)`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    /// Unix timestamp in nanoseconds.
    pub ts: i64,
    pub pid: u32,
    pub ppid: u32,
    pub proc_name: String,
    pub category: Category,
    /// Operation verb (Create / Write / Connect / SetValue / ...).
    pub op: String,
    /// Path / `IP:port` / registry key / etc.
    pub target: String,
    pub severity: Severity,
    pub meta: JsonValue,
}

impl Event {
    pub fn builder(category: Category, op: impl Into<String>) -> EventBuilder {
        EventBuilder::new(category, op)
    }
}

#[derive(Debug)]
pub struct EventBuilder {
    ts: Option<i64>,
    pid: u32,
    ppid: u32,
    proc_name: String,
    category: Category,
    op: String,
    target: String,
    severity: Severity,
    meta: JsonValue,
}

impl EventBuilder {
    pub fn new(category: Category, op: impl Into<String>) -> Self {
        Self {
            ts: None,
            pid: 0,
            ppid: 0,
            proc_name: String::new(),
            category,
            op: op.into(),
            target: String::new(),
            severity: Severity::Normal,
            meta: JsonValue::Null,
        }
    }

    pub fn ts(mut self, ts: i64) -> Self {
        self.ts = Some(ts);
        self
    }

    pub fn pid(mut self, pid: u32) -> Self {
        self.pid = pid;
        self
    }

    pub fn ppid(mut self, ppid: u32) -> Self {
        self.ppid = ppid;
        self
    }

    pub fn proc_name(mut self, n: impl Into<String>) -> Self {
        self.proc_name = n.into();
        self
    }

    pub fn target(mut self, t: impl Into<String>) -> Self {
        self.target = t.into();
        self
    }

    pub fn severity(mut self, s: Severity) -> Self {
        self.severity = s;
        self
    }

    pub fn meta(mut self, m: JsonValue) -> Self {
        self.meta = m;
        self
    }

    pub fn build(self) -> Event {
        let ts = self.ts.unwrap_or_else(now_unix_ns);
        Event {
            ts,
            pid: self.pid,
            ppid: self.ppid,
            proc_name: self.proc_name,
            category: self.category,
            op: self.op,
            target: self.target,
            severity: self.severity,
            meta: self.meta,
        }
    }
}

pub fn now_unix_ns() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_builder_roundtrip_via_json() {
        let ev = Event::builder(Category::Process, "Create")
            .pid(1234)
            .ppid(5678)
            .proc_name("notepad.exe")
            .target(r"C:\Windows\System32\notepad.exe")
            .severity(Severity::Normal)
            .meta(serde_json::json!({"cmdline": "notepad.exe foo.txt"}))
            .ts(42)
            .build();

        let json = serde_json::to_string(&ev).unwrap();
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(back.pid, 1234);
        assert_eq!(back.ts, 42);
        assert!(matches!(back.category, Category::Process));
    }

    #[test]
    fn severity_ordering() {
        assert!(Severity::Alert > Severity::Normal);
        assert_eq!(Severity::Suspicious.as_u8(), 1);
    }
}
