//! Event collectors for PersonalEDR.
//!
//! Three backends, each gated behind a feature flag:
//!   * `synthetic` — fake event generator (default, cross-platform; useful for
//!     UI dev and tests).
//!   * `etw` — real ETW kernel session via `ferrisetw` (Windows only).
//!   * `integrity` — `ntdll!EtwEventWrite` byte-integrity watchdog.

use edr_core::Event;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::mpsc;

pub mod synthetic;

#[cfg(all(windows, feature = "etw"))]
pub mod etw;

#[cfg(all(windows, feature = "integrity"))]
pub mod integrity;

#[derive(Debug, thiserror::Error)]
pub enum CollectorError {
    #[error("permission denied: PersonalEDR ETW session requires Administrator")]
    NotElevated,
    #[error("ETW backend error: {0}")]
    Etw(String),
    #[error("collector backend not available in this build (enable the appropriate feature flag)")]
    BackendUnavailable,
}

pub type Result<T> = std::result::Result<T, CollectorError>;

/// A backend that produces events into the supplied channel until the returned
/// future resolves (when the collector stops or its session ends).
pub trait Collector: Send + 'static {
    fn run(self: Box<Self>, tx: mpsc::Sender<Event>)
        -> Pin<Box<dyn Future<Output = Result<()>> + Send>>;
}

/// Returns `Ok(true)` iff the current process token has `TokenIsElevated`.
/// On non-Windows or when the `integrity` feature is off (so the `windows`
/// crate isn't linked), returns `Err` with a reason — callers can map that
/// to `false` if they only care about the boolean.
#[cfg(all(target_os = "windows", feature = "integrity"))]
pub fn elevation_status() -> std::result::Result<bool, String> {
    use std::mem::{size_of, MaybeUninit};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let process = GetCurrentProcess();
        let mut token = HANDLE::default();
        if let Err(e) = OpenProcessToken(process, TOKEN_QUERY, &mut token) {
            return Err(format!("OpenProcessToken: {e}"));
        }

        let mut elevation = MaybeUninit::<TOKEN_ELEVATION>::uninit();
        let mut returned: u32 = 0;
        let result = GetTokenInformation(
            token,
            TokenElevation,
            Some(elevation.as_mut_ptr() as *mut _),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);

        match result {
            Ok(()) => Ok(elevation.assume_init().TokenIsElevated != 0),
            Err(e) => Err(format!("GetTokenInformation: {e}")),
        }
    }
}

#[cfg(not(all(target_os = "windows", feature = "integrity")))]
pub fn elevation_status() -> std::result::Result<bool, String> {
    Err("integrity feature disabled or non-Windows target".into())
}

/// Convenience wrapper: returns the boolean only.
pub fn is_elevated() -> bool {
    elevation_status().unwrap_or(false)
}
