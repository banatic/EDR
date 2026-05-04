//! Tauri runtime bootstrap for the PersonalEDR desktop shell.
//!
//! Wires the live `edr-collector` → `edr-cluster` → `edr-rules` → `edr-store`
//! pipeline behind the IPC surface in [`commands`]. Each post-processed event
//! is also broadcast to the UI on the `edr://event` channel.

mod commands;
mod procinfo;
mod state;

use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use edr_cluster::{ClusterConfig, EventProcessor, ProcessOutput, Whitelist};
use edr_collector::{synthetic::SyntheticCollector, Collector};
use edr_core::Event;
use edr_rules::{RuleEngine, RuleSet};
use edr_store::{EventStore, MemoryStore, Pipeline};
use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use state::AppState;

/// Rules + whitelist are baked into the binary so the installed `.exe` is
/// fully self-contained. Edit `config/rules.yaml` / `config/whitelist.toml`
/// at the workspace root and rebuild to change them.
const BUNDLED_RULES_YAML: &str = include_str!("../../../config/rules.yaml");
const BUNDLED_WHITELIST_TOML: &str = include_str!("../../../config/whitelist.toml");

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::query_events,
            commands::list_processes,
            commands::aggregate_range,
            commands::get_settings,
            commands::set_setting,
            commands::get_runtime_info,
            procinfo::list_running_processes,
            procinfo::get_process_icon,
        ])
        .setup(|app| {
            let store: Arc<dyn EventStore> = Arc::new(MemoryStore::default());
            let rule_engine = Arc::new(RuleEngine::new(load_rules()));
            let whitelist = load_whitelist();

            let elevation = edr_collector::elevation_status();
            let elevated = elevation.as_ref().copied().unwrap_or(false);
            let backend = if elevated { "etw" } else { "synthetic" };
            log_startup(&elevation, backend, rule_engine.rules().len());
            tracing::info!(elevated, backend, "PersonalEDR backend selected");

            let runtime = Arc::new(parking_lot::RwLock::new(commands::RuntimeInfo {
                backend: backend.into(),
                elevated,
                etw_failed: false,
                integrity_watch: false,
                rule_count: rule_engine.rules().len(),
                message: None,
            }));
            app.manage(AppState {
                store: store.clone(),
                rule_engine: rule_engine.clone(),
                settings: parking_lot::RwLock::new(commands::Settings::default()),
                runtime: runtime.clone(),
            });

            let (tx_raw, rx_raw) = mpsc::channel::<Event>(8192);
            let (tx_out, rx_out) = mpsc::channel::<Event>(8192);

            let pipeline = Pipeline::new(store.clone())
                .batch_size(256)
                .flush_interval(Duration::from_millis(150));
            tauri::async_runtime::spawn(pipeline.run(rx_out));

            let app_handle = app.handle().clone();
            let engine_for_task = rule_engine.clone();
            tauri::async_runtime::spawn(async move {
                let mut processor =
                    EventProcessor::new(whitelist, ClusterConfig::default());
                let mut rx_raw = rx_raw;

                // Batch UI emissions: each `app_handle.emit` is a JSON
                // serialize + IPC roundtrip + React reconcile. At 10k+
                // events/sec from ETW that flat-out kills the renderer.
                // Coalesce into ~10 emissions/sec or whenever 512 events
                // are buffered, whichever comes first.
                const BATCH_CAP: usize = 512;
                let flush_interval = Duration::from_millis(100);
                let mut buf: Vec<Event> = Vec::with_capacity(BATCH_CAP);
                let mut interval = tokio::time::interval(flush_interval);
                interval.set_missed_tick_behavior(
                    tokio::time::MissedTickBehavior::Delay,
                );

                loop {
                    tokio::select! {
                        biased;
                        _ = interval.tick() => {
                            if !buf.is_empty() {
                                let _ = app_handle.emit("edr://event-batch", &buf);
                                buf.clear();
                            }
                        }
                        maybe_ev = rx_raw.recv() => {
                            let Some(ev) = maybe_ev else {
                                if !buf.is_empty() {
                                    let _ = app_handle.emit("edr://event-batch", &buf);
                                }
                                break;
                            };
                            let mut ev = match processor.process(ev) {
                                ProcessOutput::Emit(e) => e,
                                ProcessOutput::Aggregate(e) => e,
                                ProcessOutput::Drop => continue,
                            };
                            engine_for_task.evaluate(&mut ev);
                            buf.push(ev.clone());
                            if buf.len() >= BATCH_CAP {
                                let _ = app_handle.emit("edr://event-batch", &buf);
                                buf.clear();
                            }
                            if tx_out.send(ev).await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });

            spawn_collector(tx_raw.clone(), elevated, runtime.clone());

            #[cfg(windows)]
            if elevated {
                match edr_collector::integrity::IntegrityWatch::default()
                    .spawn(tx_raw.clone())
                {
                    Ok(handle) => {
                        // Detach: the watchdog runs for the lifetime of
                        // the process. Dropping the handle would join
                        // (and stop) the worker thread.
                        std::mem::forget(handle);
                        runtime.write().integrity_watch = true;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "integrity watch failed to start");
                        let mut r = runtime.write();
                        r.integrity_watch = false;
                        let detail = format!("integrity_watch_error=\"{e}\"");
                        r.message = Some(match r.message.take() {
                            Some(prev) => format!("{prev}; {detail}"),
                            None => detail,
                        });
                    }
                }
            }

            drop(tx_raw);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn spawn_collector(
    tx: mpsc::Sender<Event>,
    elevated: bool,
    runtime: Arc<parking_lot::RwLock<commands::RuntimeInfo>>,
) {
    #[cfg(windows)]
    if elevated {
        let c = Box::new(edr_collector::etw::EtwCollector::default());
        tauri::async_runtime::spawn(async move {
            if let Err(e) = c.run(tx.clone()).await {
                let msg = format!("{e}");
                tracing::error!(error = %msg, "ETW collector failed; falling back to synthetic");
                append_log(&format!("etw_run_error=\"{msg}\" -> fallback=synthetic"));
                {
                    let mut r = runtime.write();
                    r.backend = "synthetic".to_string();
                    r.etw_failed = true;
                    r.message = Some(format!("ETW failed: {msg}"));
                }
                let s = Box::new(SyntheticCollector { rate_eps: 50, max_events: None });
                let _ = s.run(tx).await;
            }
        });
        return;
    }
    let _ = elevated;
    let _ = runtime;
    let s = Box::new(SyntheticCollector { rate_eps: 50, max_events: None });
    tauri::async_runtime::spawn(s.run(tx));
}

fn load_rules() -> RuleSet {
    match RuleSet::from_yaml_str(BUNDLED_RULES_YAML) {
        Ok(rs) => {
            tracing::info!(count = rs.len(), "rules loaded (bundled)");
            rs
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to parse bundled rules.yaml");
            RuleSet::default()
        }
    }
}

fn load_whitelist() -> Whitelist {
    match Whitelist::from_toml_str(BUNDLED_WHITELIST_TOML) {
        Ok(w) => {
            tracing::info!("whitelist loaded (bundled)");
            w
        }
        Err(e) => {
            tracing::error!(error = %e, "failed to parse bundled whitelist.toml");
            Whitelist::empty()
        }
    }
}

/// Append a one-line diagnostic to `%TEMP%\personal-edr-startup.log` so the
/// user can confirm which backend was picked and (if elevation detection
/// failed) the underlying error. Failures here are intentionally swallowed
/// — diagnostics must never block startup.
fn log_startup(
    elevation: &std::result::Result<bool, String>,
    backend: &str,
    rule_count: usize,
) {
    let path = match std::env::var_os("TEMP") {
        Some(p) => std::path::PathBuf::from(p).join("personal-edr-startup.log"),
        None => return,
    };
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };

    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let detail = match elevation {
        Ok(true) => "elevated=true".to_string(),
        Ok(false) => "elevated=false".to_string(),
        Err(e) => format!("elevation_check_error=\"{e}\""),
    };
    let _ = writeln!(
        f,
        "[{ts}] backend={backend} {detail} rules={rule_count} pid={}",
        std::process::id()
    );
}

fn append_log(line: &str) {
    let Some(temp) = std::env::var_os("TEMP") else { return };
    let path = std::path::PathBuf::from(temp).join("personal-edr-startup.log");
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let ts = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let _ = writeln!(f, "[{ts}] {line}");
}
