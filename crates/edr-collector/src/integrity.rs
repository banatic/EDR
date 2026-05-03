//! ETW patching watchdog. Periodically re-reads the prologue of
//! `ntdll!EtwEventWrite` and compares against the snapshot captured at
//! startup; any deviation emits an `Integrity` event with `severity=Alert`.
//!
//! Runs on its own `std::thread` so callers don't need a Tokio runtime
//! context — the only requirement is a live `tokio::sync::mpsc::Sender`
//! whose `blocking_send` we can call from outside the async runtime.

use crate::{CollectorError, Result};
use edr_core::{Category, Event, Severity};
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::mpsc;
use windows::core::PCSTR;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::System::LibraryLoader::{GetModuleHandleA, GetProcAddress};

const PROLOGUE_BYTES: usize = 16;

/// Symbols we monitor. ETW patching utilities historically target
/// `EtwEventWrite` and `EtwEventWriteFull`; both are watched.
const SYMBOLS: &[&str] = &["EtwEventWrite", "EtwEventWriteFull"];

#[derive(Clone)]
pub struct IntegrityWatch {
    pub interval: Duration,
}

impl Default for IntegrityWatch {
    fn default() -> Self {
        Self { interval: Duration::from_secs(5) }
    }
}

pub struct IntegrityHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl IntegrityHandle {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

impl Drop for IntegrityHandle {
    fn drop(&mut self) {
        self.stop();
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl IntegrityWatch {
    /// Spawns a dedicated OS thread that emits `Category::Integrity` events
    /// whenever the monitored prologue diverges from the baseline. Returns
    /// the handle whose `Drop` joins the thread.
    pub fn spawn(self, tx: mpsc::Sender<Event>) -> Result<IntegrityHandle> {
        let baseline = capture_baseline()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stop_inner = stop.clone();
        let interval = self.interval;

        let thread = std::thread::Builder::new()
            .name("edr-integrity".into())
            .spawn(move || {
                while !stop_inner.load(Ordering::Relaxed) {
                    std::thread::sleep(interval);
                    if stop_inner.load(Ordering::Relaxed) {
                        break;
                    }
                    for entry in &baseline {
                        let current = unsafe { read_prologue(entry.addr) };
                        if current != entry.bytes {
                            let ev = Event::builder(Category::Integrity, "EtwPatch")
                                .severity(Severity::Alert)
                                .target(entry.symbol.clone())
                                .meta(serde_json::json!({
                                    "expected": hex(&entry.bytes),
                                    "actual": hex(&current),
                                    "module": "ntdll.dll",
                                }))
                                .build();
                            if tx.blocking_send(ev).is_err() {
                                stop_inner.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|e| CollectorError::Etw(format!("spawn integrity thread: {e}")))?;

        Ok(IntegrityHandle { stop, thread: Some(thread) })
    }
}

struct Baseline {
    symbol: String,
    addr: *const u8,
    bytes: [u8; PROLOGUE_BYTES],
}

unsafe impl Send for Baseline {}
unsafe impl Sync for Baseline {}

fn capture_baseline() -> Result<Vec<Baseline>> {
    let module_name = CString::new("ntdll.dll").unwrap();
    let module: HMODULE = unsafe {
        GetModuleHandleA(PCSTR(module_name.as_ptr() as *const u8))
            .map_err(|e| CollectorError::Etw(format!("GetModuleHandleA(ntdll): {e}")))?
    };

    let mut out = Vec::new();
    for sym in SYMBOLS {
        let c = CString::new(*sym).unwrap();
        let proc = unsafe { GetProcAddress(module, PCSTR(c.as_ptr() as *const u8)) };
        let Some(addr) = proc else { continue };
        let ptr = addr as *const u8;
        let bytes = unsafe { read_prologue(ptr) };
        out.push(Baseline { symbol: (*sym).to_string(), addr: ptr, bytes });
    }
    if out.is_empty() {
        return Err(CollectorError::Etw("no ETW symbols resolved in ntdll".into()));
    }
    Ok(out)
}

unsafe fn read_prologue(p: *const u8) -> [u8; PROLOGUE_BYTES] {
    let mut buf = [0u8; PROLOGUE_BYTES];
    std::ptr::copy_nonoverlapping(p, buf.as_mut_ptr(), PROLOGUE_BYTES);
    buf
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}
