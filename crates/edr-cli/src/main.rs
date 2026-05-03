use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use edr_cluster::{ClusterConfig, EventProcessor, ProcessOutput, Whitelist};
use edr_collector::{synthetic::SyntheticCollector, Collector};
use edr_core::{Category, Event};
use edr_rules::{RuleEngine, RuleSet};
use edr_store::{EventStore, MemoryStore, Pipeline, Query};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Parser, Debug)]
#[command(name = "edr", version, about = "PersonalEDR — ETW behavior analysis")]
struct Cli {
    #[arg(long, default_value = "info")]
    log: String,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand, Debug)]
enum Cmd {
    /// Run the collector + pipeline. Press Ctrl+C to stop.
    Run {
        #[arg(long, value_enum, default_value_t = Backend::Synthetic)]
        backend: Backend,

        /// Stop after this many seconds. Default: run until Ctrl+C.
        #[arg(long)]
        seconds: Option<u64>,

        /// Persist to a DuckDB file (requires `--features duckdb`). Without
        /// this flag events live only in the in-memory ring buffer.
        #[arg(long)]
        db: Option<String>,

        /// Optional whitelist TOML (see `config/whitelist.toml`).
        #[arg(long)]
        whitelist: Option<String>,

        /// Optional detection-rules YAML (see `config/rules.yaml`).
        #[arg(long)]
        rules: Option<String>,
    },
    /// Print summary statistics for the live in-memory store.
    /// (Stand-alone CLI invocations restart the process so this is mostly
    /// useful when running against a `--db` file with the `duckdb` feature.)
    Stats {
        #[arg(long)]
        db: Option<String>,
    },
    /// Query persisted events.
    Query {
        #[arg(long)]
        db: Option<String>,
        #[arg(long)]
        pid: Option<u32>,
        #[arg(long)]
        category: Option<CategoryArg>,
        #[arg(long)]
        min_severity: Option<u8>,
        #[arg(long, default_value_t = 50)]
        limit: usize,
    },
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum Backend {
    Synthetic,
    #[cfg(all(windows, feature = "etw"))]
    Etw,
}

#[derive(Copy, Clone, Debug, ValueEnum)]
enum CategoryArg {
    Process,
    File,
    Network,
    Registry,
    ImageLoad,
    Thread,
    Handle,
    Integrity,
}

impl From<CategoryArg> for Category {
    fn from(c: CategoryArg) -> Self {
        match c {
            CategoryArg::Process => Category::Process,
            CategoryArg::File => Category::File,
            CategoryArg::Network => Category::Network,
            CategoryArg::Registry => Category::Registry,
            CategoryArg::ImageLoad => Category::ImageLoad,
            CategoryArg::Thread => Category::Thread,
            CategoryArg::Handle => Category::Handle,
            CategoryArg::Integrity => Category::Integrity,
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    init_tracing(&cli.log)?;

    match cli.cmd {
        Cmd::Run { backend, seconds, db, whitelist, rules } => {
            cmd_run(backend, seconds, db, whitelist, rules).await
        }
        Cmd::Stats { db } => cmd_stats(db).await,
        Cmd::Query { db, pid, category, min_severity, limit } => {
            cmd_query(db, pid, category, min_severity, limit).await
        }
    }
}

fn init_tracing(level: &str) -> Result<()> {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level.to_string()));
    fmt().with_env_filter(filter).with_target(false).init();
    Ok(())
}

async fn cmd_run(
    backend: Backend,
    seconds: Option<u64>,
    db: Option<String>,
    whitelist_path: Option<String>,
    rules_path: Option<String>,
) -> Result<()> {
    let store = open_store(db.as_deref())?;

    let whitelist = match whitelist_path.as_deref() {
        Some(p) => Whitelist::from_path(p).context("load whitelist")?,
        None => Whitelist::empty(),
    };
    let rules = match rules_path.as_deref() {
        Some(p) => RuleSet::from_path(p).context("load rules")?,
        None => RuleSet::default(),
    };
    let rule_count = rules.len();
    let rule_engine = Arc::new(RuleEngine::new(rules));

    // collector → tx_raw → [transform task] → tx_out → store pipeline
    let (tx_raw, rx_raw) = mpsc::channel::<Event>(8192);
    let (tx_out, rx_out) = mpsc::channel::<Event>(8192);

    let pipeline =
        Pipeline::new(store.clone()).batch_size(512).flush_interval(Duration::from_millis(200));
    let pipeline_handle = tokio::spawn(pipeline.run(rx_out));

    let transform_engine = rule_engine.clone();
    let transform_handle = tokio::spawn(async move {
        let mut processor =
            EventProcessor::new(whitelist, ClusterConfig::default());
        let mut rx_raw = rx_raw;
        while let Some(ev) = rx_raw.recv().await {
            let mut ev = match processor.process(ev) {
                ProcessOutput::Emit(e) => e,
                ProcessOutput::Aggregate(e) => e,
                ProcessOutput::Drop => continue,
            };
            transform_engine.evaluate(&mut ev);
            if tx_out.send(ev).await.is_err() {
                break;
            }
        }
    });

    let collector_handle = match backend {
        Backend::Synthetic => {
            let c = Box::new(SyntheticCollector { rate_eps: 50, max_events: None });
            tokio::spawn(c.run(tx_raw.clone()))
        }
        #[cfg(all(windows, feature = "etw"))]
        Backend::Etw => {
            let c = Box::new(edr_collector::etw::EtwCollector::default());
            tokio::spawn(c.run(tx_raw.clone()))
        }
    };

    #[cfg(all(windows, feature = "etw"))]
    let _integrity_handle = {
        edr_collector::integrity::IntegrityWatch::default().spawn(tx_raw.clone()).ok()
    };

    drop(tx_raw);

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("Ctrl+C received, shutting down");
        }
        _ = sleep_optional(seconds) => {
            tracing::info!("duration elapsed, shutting down");
        }
    }

    collector_handle.abort();
    let _ = collector_handle.await;
    let _ = transform_handle.await;
    let written = pipeline_handle.await.unwrap_or(0);
    tracing::info!(
        written,
        total_in_store = ?store.len().ok(),
        rules = rule_count,
        "stopped"
    );
    Ok(())
}

async fn sleep_optional(seconds: Option<u64>) {
    if let Some(s) = seconds {
        tokio::time::sleep(Duration::from_secs(s)).await;
    } else {
        // never resolve
        std::future::pending::<()>().await;
    }
}

async fn cmd_stats(db: Option<String>) -> Result<()> {
    let store = open_store(db.as_deref())?;
    let total = store.len().context("store len")?;
    println!("events: {total}");
    Ok(())
}

async fn cmd_query(
    db: Option<String>,
    pid: Option<u32>,
    category: Option<CategoryArg>,
    min_severity: Option<u8>,
    limit: usize,
) -> Result<()> {
    let store = open_store(db.as_deref())?;
    let mut q = Query::new().limit(limit);
    if let Some(p) = pid {
        q = q.pid(p);
    }
    if let Some(c) = category {
        q = q.category(c.into());
    }
    if let Some(s) = min_severity {
        q = q.min_severity(s);
    }
    let events = store.query(&q).context("store query")?;
    for ev in events {
        println!("{}", serde_json::to_string(&ev)?);
    }
    Ok(())
}

fn open_store(db: Option<&str>) -> Result<Arc<dyn EventStore>> {
    match db {
        None => Ok(Arc::new(MemoryStore::default())),
        Some(_path) => {
            #[cfg(feature = "duckdb")]
            {
                let store = edr_store::DuckDbStore::open(_path).context("open duckdb")?;
                Ok(Arc::new(store))
            }
            #[cfg(not(feature = "duckdb"))]
            {
                anyhow::bail!(
                    "the `--db` flag requires the `duckdb` feature; rebuild with --features duckdb"
                )
            }
        }
    }
}
