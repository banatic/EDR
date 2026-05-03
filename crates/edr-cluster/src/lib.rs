//! Noise-reduction layer for PersonalEDR.
//!
//! Implements the "클러스터링 / 노이즈 압축 로직" section of the spec:
//!   1. Whitelist (TOML) — dim known-good events.
//!   2. Sliding-window deduplication — fold repeated events.
//!   3. First-seen tracking — flag novel `(proc, category, target_pattern)` triples.

pub mod glob;
pub mod normalize;
pub mod whitelist;
pub mod processor;

pub use processor::{ClusterConfig, EventProcessor, ProcessOutput};
pub use whitelist::{Whitelist, WhitelistEntry};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse error: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("invalid category: {0}")]
    InvalidCategory(String),
}

pub type Result<T> = std::result::Result<T, Error>;
