use crate::{EventStore, Query, Result};
use edr_core::Event;
use parking_lot::RwLock;
use std::collections::VecDeque;

/// In-memory ring buffer. Drops oldest events when `capacity` is exceeded.
pub struct MemoryStore {
    inner: RwLock<VecDeque<Event>>,
    capacity: usize,
}

impl MemoryStore {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            inner: RwLock::new(VecDeque::with_capacity(capacity.min(1024))),
            capacity,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }
}

impl Default for MemoryStore {
    /// Default capacity is 1,000,000 events (~30 min of 555 ev/s, generous).
    fn default() -> Self {
        Self::with_capacity(1_000_000)
    }
}

impl EventStore for MemoryStore {
    fn append(&self, events: &[Event]) -> Result<()> {
        let mut buf = self.inner.write();
        for ev in events {
            if buf.len() >= self.capacity {
                buf.pop_front();
            }
            buf.push_back(ev.clone());
        }
        Ok(())
    }

    fn query(&self, q: &Query) -> Result<Vec<Event>> {
        let buf = self.inner.read();
        let mut out: Vec<Event> = buf
            .iter()
            .filter(|ev| {
                if let Some(s) = q.since_ns {
                    if ev.ts < s {
                        return false;
                    }
                }
                if let Some(u) = q.until_ns {
                    if ev.ts > u {
                        return false;
                    }
                }
                if let Some(p) = q.pid {
                    if ev.pid != p {
                        return false;
                    }
                }
                if let Some(c) = q.category {
                    if ev.category != c {
                        return false;
                    }
                }
                if let Some(min_sev) = q.min_severity {
                    if ev.severity.as_u8() < min_sev {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();
        out.sort_by_key(|e| e.ts);
        if let Some(n) = q.limit {
            out.truncate(n);
        }
        Ok(out)
    }

    fn cleanup_older_than(&self, older_than_ns: i64) -> Result<u64> {
        let mut buf = self.inner.write();
        let before = buf.len();
        buf.retain(|e| e.ts >= older_than_ns);
        Ok((before - buf.len()) as u64)
    }

    fn len(&self) -> Result<u64> {
        Ok(self.inner.read().len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use edr_core::{Category, Event, Severity};

    fn ev(ts: i64, pid: u32, c: Category) -> Event {
        Event::builder(c, "Test").ts(ts).pid(pid).proc_name("x").build()
    }

    #[test]
    fn append_query_cleanup() {
        let s = MemoryStore::with_capacity(10);
        s.append(&[ev(1, 100, Category::Process), ev(2, 100, Category::File), ev(3, 200, Category::Process)])
            .unwrap();

        assert_eq!(s.len().unwrap(), 3);

        let only_pid_100 = s.query(&Query::new().pid(100)).unwrap();
        assert_eq!(only_pid_100.len(), 2);

        let only_proc = s.query(&Query::new().category(Category::Process)).unwrap();
        assert_eq!(only_proc.len(), 2);

        let removed = s.cleanup_older_than(2).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(s.len().unwrap(), 2);
    }

    #[test]
    fn capacity_drops_oldest() {
        let s = MemoryStore::with_capacity(2);
        s.append(&[ev(1, 1, Category::Process)]).unwrap();
        s.append(&[ev(2, 1, Category::Process), ev(3, 1, Category::Process)]).unwrap();
        let all = s.query(&Query::new()).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].ts, 2);
        assert_eq!(all[1].ts, 3);
        // verify severity is Normal default
        assert_eq!(all[0].severity, Severity::Normal);
    }
}
