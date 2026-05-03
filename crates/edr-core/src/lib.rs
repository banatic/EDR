//! Shared event schema and primitives for PersonalEDR.

pub mod event;
pub mod severity;

pub use event::{Category, Event, EventBuilder};
pub use severity::Severity;
