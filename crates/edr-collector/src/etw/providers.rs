//! Wires PersonalEDR to the manifest-based `Microsoft-Windows-Kernel-*`
//! ETW providers via a private user-mode session.
//!
//! Why not the legacy `NT Kernel Logger`? It is single-instance per machine
//! and Windows 10/11 system components (DiagTrack, Defender, WdiContext, …)
//! frequently hold its kernel-flag lock, which surfaces as `AlreadyExist`
//! on `StartTraceW` even though no session named `"NT Kernel Logger"`
//! actually exists (so `StopTrace` rejects it with WMI_INSTANCE_NOT_FOUND).
//! The user-mode provider equivalents have no such global lock — many
//! sessions can subscribe simultaneously.

use crate::{CollectorError, Result};
use edr_core::{Category, Event, EventBuilder, Severity};
use ferrisetw::parser::Parser;
use ferrisetw::provider::Provider;
use ferrisetw::trace::{stop_trace_by_name, UserTrace};
use ferrisetw::{EventRecord, SchemaLocator, GUID};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// Microsoft-Windows-Kernel-Process — process create/exit + image load/unload.
const PROCESS_GUID: GUID = GUID::from_u128(0x22FB2CD6_0E7B_422B_A0C7_2FAD1FD0E716);
/// Microsoft-Windows-Kernel-File — file IRP-level operations.
const FILE_GUID: GUID = GUID::from_u128(0xEDD08927_9CC4_4E65_B970_C2560FB5C289);
/// Microsoft-Windows-Kernel-Network — TCP/UDP send/recv/connect/disconnect.
const NETWORK_GUID: GUID = GUID::from_u128(0x7DD42A49_5329_4832_8DFD_43D979153A88);
/// Microsoft-Windows-Kernel-Registry — registry create/set/delete.
const REGISTRY_GUID: GUID = GUID::from_u128(0x70EB4F03_C1DE_4F73_A051_33D13D5413BD);

const VERBOSE_LEVEL: u8 = 5;
const ALL_KEYWORDS: u64 = u64::MAX;

pub(super) fn run_session(session_name: &str, tx: mpsc::Sender<Event>) -> Result<()> {
    let tx = Arc::new(tx);

    // Best-effort cleanup of our own previous session if a prior PersonalEDR
    // run was killed before its trace handle could drop. The session name
    // here is private to us (`PersonalEDR-Kernel` by default) so this only
    // ever stops a leftover from ourselves — no risk of disturbing other
    // tools.
    let _ = stop_trace_by_name(session_name);

    let trace = match start_user_trace(session_name, tx.clone()) {
        Ok(t) => t,
        Err(e) if matches!(&e, CollectorError::Etw(m) if m.contains("AlreadyExist")) => {
            // The pre-stop didn't take (or another transient state). Try
            // once more after a forced stop.
            let _ = stop_trace_by_name(session_name);
            start_user_trace(session_name, tx.clone())?
        }
        Err(e) => return Err(e),
    };

    // `start_and_process` returns immediately after spawning ferrisetw's
    // internal processing thread. Keep `trace` alive — its Drop stops the
    // session. Park here until the consumer closes the channel.
    while !tx.is_closed() {
        std::thread::sleep(Duration::from_millis(500));
    }
    drop(trace);
    Ok(())
}

fn start_user_trace(session_name: &str, tx: Arc<mpsc::Sender<Event>>) -> Result<UserTrace> {
    let process = build_provider(PROCESS_GUID, Category::Process, tx.clone());
    let file = build_provider(FILE_GUID, Category::File, tx.clone());
    let network = build_provider(NETWORK_GUID, Category::Network, tx.clone());
    let registry = build_provider(REGISTRY_GUID, Category::Registry, tx);

    UserTrace::new()
        .named(session_name.to_string())
        .enable(process)
        .enable(file)
        .enable(network)
        .enable(registry)
        .start_and_process()
        .map_err(|e| CollectorError::Etw(format!("user trace start: {e:?}")))
}

fn build_provider(
    guid: GUID,
    category: Category,
    tx: Arc<mpsc::Sender<Event>>,
) -> Provider {
    Provider::by_guid(guid)
        .any(ALL_KEYWORDS)
        .all(0)
        .level(VERBOSE_LEVEL)
        .add_callback(move |record: &EventRecord, locator: &SchemaLocator| {
            if let Some(ev) = parse_event(record, locator, category) {
                if tx.try_send(ev).is_err() {
                    // Drop on backpressure rather than blocking the
                    // ETW dispatch thread.
                }
            }
        })
        .build()
}

/// Decide a per-event Category. Image loads come through the Process
/// provider, so promote them to `Category::ImageLoad` based on opcode.
fn refined_category(opcode: &str, default: Category) -> Category {
    let lower = opcode.to_ascii_lowercase();
    match (default, lower.as_str()) {
        (Category::Process, "load") => Category::ImageLoad,
        (Category::Process, "unload") => Category::ImageLoad,
        _ => default,
    }
}

fn parse_event(
    record: &EventRecord,
    locator: &SchemaLocator,
    default_category: Category,
) -> Option<Event> {
    let schema = locator.event_schema(record).ok()?;
    let parser = Parser::create(record, &schema);

    let opcode = schema.opcode_name();
    let category = refined_category(&opcode, default_category);

    let mut b: EventBuilder = Event::builder(category, opcode.to_string())
        .pid(record.process_id())
        .ts(edr_core::event::now_unix_ns())
        .severity(Severity::Normal);

    match category {
        Category::Process => {
            if let Ok(pid) = parser
                .try_parse::<u32>("ProcessID")
                .or_else(|_| parser.try_parse::<u32>("ProcessId"))
            {
                b = b.pid(pid);
            }
            if let Ok(ppid) = parser
                .try_parse::<u32>("ParentProcessID")
                .or_else(|_| parser.try_parse::<u32>("ParentId"))
            {
                b = b.ppid(ppid);
            }
            if let Ok(name) = parser
                .try_parse::<String>("ImageName")
                .or_else(|_| parser.try_parse::<String>("ImageFileName"))
            {
                b = b.proc_name(strip_path(&name)).target(name);
            }
            if let Ok(cmd) = parser.try_parse::<String>("CommandLine") {
                b = b.meta(serde_json::json!({ "cmdline": cmd }));
            }
        }
        Category::ImageLoad => {
            if let Ok(p) = parser
                .try_parse::<String>("ImageName")
                .or_else(|_| parser.try_parse::<String>("FileName"))
            {
                b = b.target(p);
            }
        }
        Category::File => {
            if let Ok(p) = parser.try_parse::<String>("FileName") {
                b = b.target(p);
            } else if let Ok(p) = parser.try_parse::<String>("OpenPath") {
                b = b.target(p);
            }
        }
        Category::Network => {
            let dst = parser
                .try_parse::<String>("daddr")
                .or_else(|_| parser.try_parse::<String>("DestinationAddress"))
                .ok();
            let dport = parser
                .try_parse::<u16>("dport")
                .or_else(|_| parser.try_parse::<u16>("DestinationPort"))
                .ok();
            if let (Some(a), Some(p)) = (dst, dport) {
                b = b.target(format!("{a}:{p}"));
            }
        }
        Category::Registry => {
            if let Ok(k) = parser
                .try_parse::<String>("KeyName")
                .or_else(|_| parser.try_parse::<String>("RelativeName"))
            {
                b = b.target(k);
            }
        }
        _ => {}
    }

    Some(b.build())
}

fn strip_path(p: &str) -> String {
    p.rsplit(['\\', '/']).next().unwrap_or(p).to_string()
}
