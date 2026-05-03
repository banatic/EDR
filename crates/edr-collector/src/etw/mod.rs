//! Real ETW kernel session collector. Behind the `etw` feature flag.
//!
//! NB: enabling the NT Kernel Logger requires Administrator. The session name
//! is `NT Kernel Logger` (single-instance per system) and `ferrisetw` handles
//! starting/stopping it.

mod providers;

use crate::{Collector, CollectorError, Result};
use edr_core::Event;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::mpsc;

pub struct EtwCollector {
    pub session_name: String,
}

impl Default for EtwCollector {
    fn default() -> Self {
        Self { session_name: "PersonalEDR-Kernel".into() }
    }
}

impl Collector for EtwCollector {
    fn run(
        self: Box<Self>,
        tx: mpsc::Sender<Event>,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> {
        Box::pin(async move {
            if !crate::is_elevated() {
                return Err(CollectorError::NotElevated);
            }

            // ETW session lifetime is owned by a dedicated blocking thread.
            // We block this future on a oneshot channel that the worker fires
            // when its session ends (or when the receiver is dropped).
            let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<()>>();
            let session_name = self.session_name.clone();

            std::thread::Builder::new()
                .name("edr-etw-session".into())
                .spawn(move || {
                    let result = providers::run_session(&session_name, tx);
                    let _ = done_tx.send(result);
                })
                .map_err(|e| CollectorError::Etw(format!("spawn worker thread: {e}")))?;

            done_rx
                .await
                .map_err(|e| CollectorError::Etw(format!("session worker dropped: {e}")))?
        })
    }
}
