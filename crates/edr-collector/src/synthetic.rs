//! Synthetic event generator. Cross-platform; used for UI development and
//! integration tests without requiring Administrator + ETW.

use crate::{Collector, Result};
use edr_core::{Category, Event, Severity};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::sync::mpsc;

pub struct SyntheticCollector {
    /// Approximate events per second.
    pub rate_eps: u32,
    /// Stop after this many events (None = run forever).
    pub max_events: Option<u64>,
}

impl Default for SyntheticCollector {
    fn default() -> Self {
        Self { rate_eps: 20, max_events: None }
    }
}

impl Collector for SyntheticCollector {
    fn run(
        self: Box<Self>,
        tx: mpsc::Sender<Event>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> {
        Box::pin(async move {
            let interval = if self.rate_eps == 0 {
                Duration::from_millis(100)
            } else {
                Duration::from_micros(1_000_000 / self.rate_eps as u64)
            };

            let mut ticker = tokio::time::interval(interval);
            let scenario = scripted_scenario();
            let mut idx = 0usize;
            let mut emitted = 0u64;

            loop {
                ticker.tick().await;

                let template = &scenario[idx % scenario.len()];
                idx += 1;

                let ev = Event::builder(template.category, template.op)
                    .pid(template.pid)
                    .ppid(template.ppid)
                    .proc_name(template.proc_name)
                    .target(template.target)
                    .severity(template.severity)
                    .meta(serde_json::json!({"synthetic": true, "seq": emitted}))
                    .build();

                if tx.send(ev).await.is_err() {
                    break;
                }
                emitted += 1;
                if let Some(max) = self.max_events {
                    if emitted >= max {
                        break;
                    }
                }
            }
            Ok(())
        })
    }
}

struct EventTemplate {
    pid: u32,
    ppid: u32,
    proc_name: &'static str,
    category: Category,
    op: &'static str,
    target: &'static str,
    severity: Severity,
}

fn scripted_scenario() -> Vec<EventTemplate> {
    use Category::*;
    vec![
        EventTemplate { pid: 4321, ppid: 600, proc_name: "explorer.exe", category: Process, op: "Create", target: r"C:\Windows\System32\notepad.exe", severity: Severity::Normal },
        EventTemplate { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: File, op: "Open", target: r"C:\Users\moomin\Documents\todo.txt", severity: Severity::Normal },
        EventTemplate { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: File, op: "Read", target: r"C:\Users\moomin\Documents\todo.txt", severity: Severity::Normal },
        EventTemplate { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: Network, op: "Connect", target: "142.250.196.110:443", severity: Severity::Normal },
        EventTemplate { pid: 5500, ppid: 600, proc_name: "chrome.exe", category: Network, op: "DnsQuery", target: "www.google.com", severity: Severity::Normal },
        EventTemplate { pid: 7777, ppid: 600, proc_name: "winword.exe", category: Process, op: "Create", target: r"C:\Windows\System32\cmd.exe", severity: Severity::Alert },
        EventTemplate { pid: 8888, ppid: 7777, proc_name: "cmd.exe", category: Registry, op: "SetValue", target: r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run\evil", severity: Severity::Alert },
        EventTemplate { pid: 9001, ppid: 4321, proc_name: "notepad.exe", category: ImageLoad, op: "Load", target: r"C:\Windows\System32\shell32.dll", severity: Severity::Normal },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn produces_bounded_stream() {
        let (tx, mut rx) = mpsc::channel::<Event>(64);
        let collector = Box::new(SyntheticCollector { rate_eps: 1000, max_events: Some(10) });
        let h = tokio::spawn(collector.run(tx));

        let mut count = 0;
        while rx.recv().await.is_some() {
            count += 1;
        }
        h.await.unwrap().unwrap();
        assert_eq!(count, 10);
    }
}
