//! Process snapshot + executable-icon helpers exposed as Tauri IPC commands.
//!
//! The user-mode `Microsoft-Windows-Kernel-Process` ETW provider only fires
//! events for processes that start *after* we subscribed, so the UI was
//! missing names for everything already running. [`list_running_processes`]
//! plugs that gap with a one-shot Toolhelp snapshot, and
//! [`get_process_icon`] extracts the small (16x16) shell icon for an exe so
//! the UI can show it next to each row.
//!
//! Both commands are synchronous (`#[tauri::command]` without `async`) — the
//! snapshot is one-time at startup and icon resolution is cached, so neither
//! benefits from being moved off the IPC thread.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RunningProcess {
    pub pid: u32,
    pub ppid: u32,
    /// Executable basename (e.g. `"explorer.exe"`).
    pub name: String,
    /// Full image path. `None` when the process can't be opened (typical for
    /// protected / system processes when running unelevated).
    pub exe_path: Option<String>,
}

// ---------------------------------------------------------------------------
// Public IPC surface
// ---------------------------------------------------------------------------

/// Snapshot every process currently running. Used at app startup to seed the
/// process table — the live ETW collector only sees process *transitions*.
#[tauri::command]
pub fn list_running_processes() -> Result<Vec<RunningProcess>, String> {
    #[cfg(windows)]
    {
        imp::snapshot()
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Resolve `exe_path`'s shell icon to a `data:image/png;base64,…` string. The
/// frontend can drop the result straight into `<img src=...>`. Returns `None`
/// if the icon can't be extracted (path missing, no associated icon, etc.).
///
/// Results — including negative results — are cached in-process keyed by the
/// lowercased path, so repeated calls for the same executable return in
/// well under a millisecond.
#[tauri::command]
pub fn get_process_icon(exe_path: String) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        Ok(imp::resolve_icon(&exe_path))
    }
    #[cfg(not(windows))]
    {
        let _ = exe_path;
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::RunningProcess;

    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::OnceLock;

    use base64::Engine;
    use parking_lot::Mutex;

    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, HICON, ICONINFO,
    };

    /// Process-wide cache of `lowercased path -> data url`. `None` is cached
    /// too so we don't repeatedly retry obviously-missing files.
    fn cache() -> &'static Mutex<HashMap<PathBuf, Option<String>>> {
        static CACHE: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> =
            OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(HashMap::new()))
    }

    pub(super) fn snapshot() -> Result<Vec<RunningProcess>, String> {
        // SAFETY: CreateToolhelp32Snapshot returns either a valid handle or
        // INVALID_HANDLE_VALUE encoded as an Err in the windows crate. We
        // close the handle on every exit path below.
        let snap: HANDLE = unsafe {
            CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
                .map_err(|e| format!("CreateToolhelp32Snapshot: {e}"))?
        };

        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };

        let mut out = Vec::with_capacity(256);

        // SAFETY: `entry.dwSize` is initialised above per the API contract;
        // `snap` is a valid handle owned by this scope.
        let first_ok = unsafe { Process32FirstW(snap, &mut entry).is_ok() };
        if first_ok {
            loop {
                out.push(entry_to_record(&entry));
                // SAFETY: same invariants as Process32FirstW; loop ends when
                // the API signals "no more entries" via Err.
                if unsafe { Process32NextW(snap, &mut entry).is_err() } {
                    break;
                }
            }
        }

        // SAFETY: `snap` was returned by CreateToolhelp32Snapshot and has
        // not been closed elsewhere.
        unsafe {
            let _ = CloseHandle(snap);
        }

        Ok(out)
    }

    fn entry_to_record(entry: &PROCESSENTRY32W) -> RunningProcess {
        // szExeFile is a UTF-16 array NUL-terminated.
        let name_len = entry
            .szExeFile
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(entry.szExeFile.len());
        let name = String::from_utf16_lossy(&entry.szExeFile[..name_len]);

        let pid = entry.th32ProcessID;
        let ppid = entry.th32ParentProcessID;

        RunningProcess {
            pid,
            ppid,
            name,
            exe_path: query_image_path(pid),
        }
    }

    /// Open the process with the cheapest possible rights and ask the kernel
    /// for its image path. Failures (access denied, pid recycled) are
    /// silently swallowed — many system processes are unreachable from a
    /// non-elevated token and we still want the rest of the snapshot.
    fn query_image_path(pid: u32) -> Option<String> {
        if pid == 0 {
            return None;
        }
        // SAFETY: OpenProcess returns a valid handle or an Err. We close it
        // on every exit path. PROCESS_QUERY_LIMITED_INFORMATION is the
        // narrowest right that satisfies QueryFullProcessImageNameW.
        let handle = unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => h,
                Err(_) => return None,
            }
        };

        // QueryFullProcessImageNameW writes up to `*size` characters and
        // updates `size` to the number actually written.
        let mut buf = [0u16; 1024];
        let mut size: u32 = buf.len() as u32;
        // SAFETY: `handle` is valid; `buf` outlives the call; `size` is
        // initialised to the buffer length per the contract.
        let res = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        };
        // SAFETY: handle was returned by OpenProcess and is owned here.
        unsafe {
            let _ = CloseHandle(handle);
        }
        match res {
            Ok(()) => Some(String::from_utf16_lossy(&buf[..size as usize])),
            Err(_) => None,
        }
    }

    // -------- Icon extraction ----------------------------------------------

    pub(super) fn resolve_icon(exe_path: &str) -> Option<String> {
        let key = PathBuf::from(exe_path.to_lowercase());
        if let Some(hit) = cache().lock().get(&key).cloned() {
            return hit;
        }
        let resolved = extract_icon_data_url(exe_path);
        cache().lock().insert(key, resolved.clone());
        resolved
    }

    fn extract_icon_data_url(exe_path: &str) -> Option<String> {
        let path = Path::new(exe_path);
        if path.as_os_str().is_empty() {
            return None;
        }

        // Wide-encode the path with a NUL terminator for SHGetFileInfoW.
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut info = SHFILEINFOW::default();
        // SHGetFileInfoW returns 0 on failure — for SHGFI_ICON it returns a
        // non-zero handle-ish value on success.
        // SAFETY: `wide` is NUL-terminated; `info` is appropriately sized.
        let result = unsafe {
            SHGetFileInfoW(
                PCWSTR(wide.as_ptr()),
                FILE_FLAGS_AND_ATTRIBUTES(0),
                Some(&mut info),
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_SMALLICON,
            )
        };
        if result == 0 || info.hIcon.0.is_null() {
            return None;
        }
        let hicon = info.hIcon;

        let pixels = hicon_to_rgba(hicon);

        // SAFETY: `hicon` came from SHGetFileInfoW (with SHGFI_ICON,
        // ownership transferred to caller). Always destroy regardless of
        // whether pixel extraction succeeded.
        unsafe {
            let _ = DestroyIcon(hicon);
        }

        let (w, h, rgba) = pixels?;
        encode_png_data_url(w, h, rgba)
    }

    /// Convert an HICON to a `(width, height, rgba)` triple. We always
    /// request a 32bpp top-down DIB so we can hand it to the `image` crate
    /// without re-orienting rows.
    fn hicon_to_rgba(hicon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        let mut iconinfo = ICONINFO::default();
        // SAFETY: `iconinfo` is properly initialised; `hicon` is valid.
        // GetIconInfo allocates new bitmap handles in `hbmColor`/`hbmMask`
        // that the caller is responsible for deleting.
        if unsafe { GetIconInfo(hicon, &mut iconinfo) }.is_err() {
            return None;
        }

        // hbmColor may be null for monochrome icons (very rare for shell
        // icons) — fall back to deriving the size from hbmMask in that
        // case. We still need the colour bitmap for actual pixels, so we
        // bail if it's missing.
        let result = (|| -> Option<(u32, u32, Vec<u8>)> {
            if iconinfo.hbmColor.0.is_null() {
                return None;
            }

            // Read the bitmap dimensions via GetObjectW(BITMAP).
            let mut bm = BITMAP::default();
            // SAFETY: `bm` matches the requested type; the handle is valid.
            let got = unsafe {
                windows::Win32::Graphics::Gdi::GetObjectW(
                    HGDIOBJ(iconinfo.hbmColor.0),
                    std::mem::size_of::<BITMAP>() as i32,
                    Some(&mut bm as *mut _ as *mut _),
                )
            };
            if got == 0 {
                return None;
            }
            let width = bm.bmWidth.max(0) as u32;
            let height = bm.bmHeight.max(0) as u32;
            if width == 0 || height == 0 {
                return None;
            }

            // Ask GDI to give us a 32bpp BGRA top-down (negative height) DIB.
            let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
            header.bmiHeader = BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width as i32,
                biHeight: -(height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            };

            let stride = (width as usize) * 4;
            let mut buf = vec![0u8; stride * (height as usize)];

            // SAFETY: GetDC(None) returns the screen DC; we release it.
            let hdc = unsafe { GetDC(HWND(std::ptr::null_mut())) };
            // SAFETY: hdc valid; hbmColor valid; buf is large enough for
            // width*height*4 bytes; header describes that exact layout.
            let scanlines = unsafe {
                GetDIBits(
                    hdc,
                    iconinfo.hbmColor,
                    0,
                    height,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut header,
                    DIB_RGB_COLORS,
                )
            };
            // SAFETY: hdc came from GetDC and was not released elsewhere.
            unsafe {
                ReleaseDC(HWND(std::ptr::null_mut()), hdc);
            }
            if scanlines == 0 {
                return None;
            }

            // Swap BGRA -> RGBA in place.
            for px in buf.chunks_exact_mut(4) {
                px.swap(0, 2);
            }

            // Some shell icons come through with a fully-zero alpha channel
            // (legacy AND-mask icons). If every alpha byte is 0 we'd render
            // a fully transparent PNG, so synthesise alpha from the AND
            // mask in that case.
            let any_alpha = buf.iter().skip(3).step_by(4).any(|&a| a != 0);
            if !any_alpha && !iconinfo.hbmMask.0.is_null() {
                apply_and_mask(
                    &mut buf,
                    width,
                    height,
                    iconinfo.hbmMask,
                );
            }

            Some((width, height, buf))
        })();

        // Always free the bitmaps GetIconInfo allocated.
        // SAFETY: handles came from GetIconInfo and are owned here.
        unsafe {
            if !iconinfo.hbmColor.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(iconinfo.hbmColor.0));
            }
            if !iconinfo.hbmMask.0.is_null() {
                let _ = DeleteObject(HGDIOBJ(iconinfo.hbmMask.0));
            }
        }

        result
    }

    /// Synthesise alpha for legacy 1bpp-mask icons. The AND mask is 1bpp:
    /// `1` = transparent, `0` = opaque. We OR the inverted mask into the
    /// alpha channel of an otherwise opaque RGB image.
    fn apply_and_mask(
        rgba: &mut [u8],
        width: u32,
        height: u32,
        hbm_mask: windows::Win32::Graphics::Gdi::HBITMAP,
    ) {
        // 1bpp DIB rows are padded to DWORD boundaries.
        let row_bytes = (((width + 31) / 32) * 4) as usize;
        let mut mask = vec![0u8; row_bytes * (height as usize)];

        let mut header: BITMAPINFO = unsafe { std::mem::zeroed() };
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 1,
            biCompression: BI_RGB.0,
            ..Default::default()
        };

        // SAFETY: hdc is acquired and released in this block; buffer is
        // sized for the requested bit depth.
        let scanlines = unsafe {
            let hdc = GetDC(HWND(std::ptr::null_mut()));
            let n = GetDIBits(
                hdc,
                hbm_mask,
                0,
                height,
                Some(mask.as_mut_ptr() as *mut _),
                &mut header,
                DIB_RGB_COLORS,
            );
            ReleaseDC(HWND(std::ptr::null_mut()), hdc);
            n
        };
        if scanlines == 0 {
            // If the mask read failed, fall back to fully opaque.
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 0xFF;
            }
            return;
        }

        for y in 0..height as usize {
            for x in 0..width as usize {
                let bit_index = y * row_bytes * 8 + x;
                let byte = mask[bit_index / 8];
                let bit = (byte >> (7 - (x % 8))) & 1;
                let dst = (y * width as usize + x) * 4;
                rgba[dst + 3] = if bit == 0 { 0xFF } else { 0x00 };
            }
        }
    }

    fn encode_png_data_url(width: u32, height: u32, rgba: Vec<u8>) -> Option<String> {
        let img: image::ImageBuffer<image::Rgba<u8>, Vec<u8>> =
            image::ImageBuffer::from_raw(width, height, rgba)?;
        let mut png = Vec::with_capacity(2048);
        img.write_to(
            &mut std::io::Cursor::new(&mut png),
            image::ImageFormat::Png,
        )
        .ok()?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Some(format!("data:image/png;base64,{b64}"))
    }
}
