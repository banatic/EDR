use crate::EventStore;
use edr_core::Event;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// Drains an mpsc::Receiver<Event> into a backing [`EventStore`] in batches.
///
/// Flushes when either:
///   - `batch_size` events are buffered, or
///   - `flush_interval` has elapsed since the last flush.
pub struct Pipeline<S: EventStore + ?Sized> {
    store: Arc<S>,
    batch_size: usize,
    flush_interval: Duration,
}

impl<S: EventStore + ?Sized> Pipeline<S> {
    pub fn new(store: Arc<S>) -> Self {
        Self {
            store,
            batch_size: 1024,
            flush_interval: Duration::from_millis(250),
        }
    }

    pub fn batch_size(mut self, n: usize) -> Self {
        self.batch_size = n.max(1);
        self
    }

    pub fn flush_interval(mut self, d: Duration) -> Self {
        self.flush_interval = d;
        self
    }

    /// Run until `rx` is closed. Returns the total number of events written.
    pub async fn run(self, mut rx: mpsc::Receiver<Event>) -> u64 {
        let mut buf: Vec<Event> = Vec::with_capacity(self.batch_size);
        let mut written: u64 = 0;
        let mut last_flush = Instant::now();

        loop {
            let timeout = self
                .flush_interval
                .checked_sub(last_flush.elapsed())
                .unwrap_or_else(|| Duration::from_millis(0));

            tokio::select! {
                maybe_ev = rx.recv() => {
                    match maybe_ev {
                        Some(ev) => {
                            buf.push(ev);
                            if buf.len() >= self.batch_size {
                                written += flush(&self.store, &mut buf);
                                last_flush = Instant::now();
                            }
                        }
                        None => {
                            written += flush(&self.store, &mut buf);
                            return written;
                        }
                    }
                }
                _ = tokio::time::sleep(timeout) => {
                    if !buf.is_empty() {
                        written += flush(&self.store, &mut buf);
                    }
                    last_flush = Instant::now();
                }
            }
        }
    }
}

fn flush<S: EventStore + ?Sized>(store: &Arc<S>, buf: &mut Vec<Event>) -> u64 {
    if buf.is_empty() {
        return 0;
    }
    let n = buf.len() as u64;
    if let Err(e) = store.append(buf) {
        tracing::error!(error = %e, "store append failed");
    }
    buf.clear();
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryStore;
    use edr_core::{Category, Event};

    #[tokio::test]
    async fn drains_until_sender_dropped() {
        let store = Arc::new(MemoryStore::with_capacity(1024));
        let (tx, rx) = mpsc::channel(64);
        let pipe = Pipeline::new(store.clone())
            .batch_size(8)
            .flush_interval(Duration::from_millis(50));
        let h = tokio::spawn(pipe.run(rx));

        for i in 0..20 {
            tx.send(
                Event::builder(Category::Process, "Create")
                    .ts(i)
                    .pid(i as u32)
                    .proc_name("x")
                    .build(),
            )
            .await
            .unwrap();
        }
        drop(tx);

        let total = h.await.unwrap();
        assert_eq!(total, 20);
        assert_eq!(store.len().unwrap(), 20);
    }
}
