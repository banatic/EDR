//! DuckDB-backed persistent event store. Behind the `duckdb` feature.

use crate::{EventStore, Query, Result, StoreError};
use duckdb::{params, Connection};
use edr_core::{Category, Event, Severity};
use parking_lot::Mutex;
use std::path::Path;

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    ts        BIGINT  NOT NULL,
    pid       UINTEGER NOT NULL,
    ppid      UINTEGER NOT NULL,
    proc_name VARCHAR NOT NULL,
    category  VARCHAR NOT NULL,
    op        VARCHAR NOT NULL,
    target    VARCHAR NOT NULL,
    severity  UTINYINT NOT NULL,
    meta      VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);
CREATE INDEX IF NOT EXISTS events_pid_idx ON events(pid);
"#;

pub struct DuckDbStore {
    conn: Mutex<Connection>,
}

impl DuckDbStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path).map_err(StoreError::Duck)?;
        conn.execute_batch(SCHEMA_SQL).map_err(StoreError::Duck)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(StoreError::Duck)?;
        conn.execute_batch(SCHEMA_SQL).map_err(StoreError::Duck)?;
        Ok(Self { conn: Mutex::new(conn) })
    }
}

fn category_str(c: &Category) -> &'static str {
    c.as_str()
}

fn parse_category(s: &str) -> Category {
    match s {
        "Process" => Category::Process,
        "File" => Category::File,
        "Network" => Category::Network,
        "Registry" => Category::Registry,
        "ImageLoad" => Category::ImageLoad,
        "Thread" => Category::Thread,
        "Handle" => Category::Handle,
        "Integrity" => Category::Integrity,
        _ => Category::Process,
    }
}

impl EventStore for DuckDbStore {
    fn append(&self, events: &[Event]) -> Result<()> {
        if events.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(StoreError::Duck)?;
        {
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO events (ts,pid,ppid,proc_name,category,op,target,severity,meta) \
                     VALUES (?,?,?,?,?,?,?,?,?)",
                )
                .map_err(StoreError::Duck)?;
            for ev in events {
                let meta = serde_json::to_string(&ev.meta)?;
                stmt.execute(params![
                    ev.ts,
                    ev.pid,
                    ev.ppid,
                    ev.proc_name,
                    category_str(&ev.category),
                    ev.op,
                    ev.target,
                    ev.severity.as_u8(),
                    meta,
                ])
                .map_err(StoreError::Duck)?;
            }
        }
        tx.commit().map_err(StoreError::Duck)?;
        Ok(())
    }

    fn query(&self, q: &Query) -> Result<Vec<Event>> {
        let mut sql = String::from(
            "SELECT ts,pid,ppid,proc_name,category,op,target,severity,meta FROM events WHERE 1=1",
        );
        let mut binds: Vec<duckdb::types::Value> = Vec::new();
        if let Some(s) = q.since_ns {
            sql.push_str(" AND ts >= ?");
            binds.push(duckdb::types::Value::BigInt(s));
        }
        if let Some(u) = q.until_ns {
            sql.push_str(" AND ts <= ?");
            binds.push(duckdb::types::Value::BigInt(u));
        }
        if let Some(p) = q.pid {
            sql.push_str(" AND pid = ?");
            binds.push(duckdb::types::Value::UInt(p));
        }
        if let Some(c) = q.category {
            sql.push_str(" AND category = ?");
            binds.push(duckdb::types::Value::Text(c.as_str().to_string()));
        }
        if let Some(min_sev) = q.min_severity {
            sql.push_str(" AND severity >= ?");
            binds.push(duckdb::types::Value::UTinyInt(min_sev));
        }
        sql.push_str(" ORDER BY ts ASC");
        if let Some(n) = q.limit {
            sql.push_str(" LIMIT ?");
            binds.push(duckdb::types::Value::BigInt(n as i64));
        }

        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&sql).map_err(StoreError::Duck)?;
        let bind_refs: Vec<&dyn duckdb::ToSql> =
            binds.iter().map(|v| v as &dyn duckdb::ToSql).collect();
        let rows = stmt
            .query_map(duckdb::params_from_iter(bind_refs), |row| {
                let meta_str: String = row.get(8)?;
                let meta: serde_json::Value =
                    serde_json::from_str(&meta_str).unwrap_or(serde_json::Value::Null);
                Ok(Event {
                    ts: row.get(0)?,
                    pid: row.get(1)?,
                    ppid: row.get(2)?,
                    proc_name: row.get(3)?,
                    category: parse_category(&row.get::<_, String>(4)?),
                    op: row.get(5)?,
                    target: row.get(6)?,
                    severity: Severity::from_u8(row.get(7)?),
                    meta,
                })
            })
            .map_err(StoreError::Duck)?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(StoreError::Duck)?);
        }
        Ok(out)
    }

    fn cleanup_older_than(&self, older_than_ns: i64) -> Result<u64> {
        let conn = self.conn.lock();
        let n = conn
            .execute("DELETE FROM events WHERE ts < ?", params![older_than_ns])
            .map_err(StoreError::Duck)?;
        Ok(n as u64)
    }

    fn len(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
            .map_err(StoreError::Duck)?;
        Ok(n as u64)
    }
}
