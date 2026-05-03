use std::sync::Arc;

use edr_rules::RuleEngine;
use edr_store::EventStore;
use parking_lot::RwLock;

use crate::commands::{RuntimeInfo, Settings};

pub struct AppState {
    pub store: Arc<dyn EventStore>,
    /// Held so future commands (rule reload, manual evaluate) can reach it.
    #[allow(dead_code)]
    pub rule_engine: Arc<RuleEngine>,
    pub settings: RwLock<Settings>,
    pub runtime: RwLock<RuntimeInfo>,
}
