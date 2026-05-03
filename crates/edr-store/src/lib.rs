//! Persistence layer for PersonalEDR events.
//!
//! - [`EventStore`] trait — minimal contract every backend must satisfy.
//! - [`MemoryStore`] — bounded ring buffer used as the default backend and in
//!   tests; matches the spec's "최근 30분 메모리 링버퍼" requirement.
//! - [`DuckDbStore`] (feature `duckdb`) — column-store persistent backend.
//! - [`Pipeline`] — tokio task that drains an mpsc receiver into the store in
//!   batches.

pub mod memory;
pub mod pipeline;
pub mod query;

#[cfg(feature = "duckdb")]
pub mod duck;

pub use memory::MemoryStore;
pub use pipeline::Pipeline;
pub use query::Query;

#[cfg(feature = "duckdb")]
pub use duck::DuckDbStore;

use edr_core::Event;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("store I/O error: {0}")]
    Io(String),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[cfg(feature = "duckdb")]
    #[error(transparent)]
    Duck(#[from] duckdb::Error),
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub trait EventStore: Send + Sync + 'static {
    /// Append a batch of events. Implementations should be cheap to call with
    /// small batches because the pipeline will issue them frequently.
    fn append(&self, events: &[Event]) -> Result<()>;

    /// Query events matching `q`, ordered by timestamp ascending.
    fn query(&self, q: &Query) -> Result<Vec<Event>>;

    /// Drop all events with `ts < older_than_ns`. Returns the number of events
    /// actually removed.
    fn cleanup_older_than(&self, older_than_ns: i64) -> Result<u64>;

    /// Total number of events currently retained.
    fn len(&self) -> Result<u64>;

    fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}
