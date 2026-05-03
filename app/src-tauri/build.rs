use std::fs;
use std::path::PathBuf;

fn main() {
    // Ensure a placeholder icon exists so `tauri-build`'s Windows-resource
    // step can run. The orchestrator can replace this file with a real icon
    // any time. We only generate it if absent.
    let icons_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons");
    fs::create_dir_all(&icons_dir).ok();
    let ico = icons_dir.join("icon.ico");
    if !ico.exists() {
        fs::write(&ico, build_solid_ico(32, 32, [0xd9, 0x77, 0x57, 0xff]))
            .expect("failed to write placeholder icon.ico");
    }
    let png = icons_dir.join("icon.png");
    if !png.exists() {
        fs::write(&png, MINIMAL_PNG_1X1).expect("failed to write placeholder icon.png");
    }

    tauri_build::build()
}

/// Solid-color BGRA ICO. Layout follows the ICO/DIB spec — see
/// `icons/make_icon.cjs` for the reference implementation. Width/height
/// must be ≤ 256.
fn build_solid_ico(w: u32, h: u32, bgra: [u8; 4]) -> Vec<u8> {
    let xor_size = (w * h * 4) as usize;
    let and_row = (((w + 31) >> 3) & !3) as usize; // 4-byte aligned
    let and_size = and_row * h as usize;
    let dib_header = 40usize;
    let image_size = dib_header + xor_size + and_size;

    let mut out = Vec::with_capacity(6 + 16 + image_size);

    // ICONDIR (header)
    out.extend_from_slice(&0u16.to_le_bytes());      // reserved
    out.extend_from_slice(&1u16.to_le_bytes());      // type = icon
    out.extend_from_slice(&1u16.to_le_bytes());      // count

    // ICONDIRENTRY
    out.push(if w == 256 { 0 } else { w as u8 });
    out.push(if h == 256 { 0 } else { h as u8 });
    out.push(0); // colors
    out.push(0); // reserved
    out.extend_from_slice(&1u16.to_le_bytes());      // planes
    out.extend_from_slice(&32u16.to_le_bytes());     // bpp
    out.extend_from_slice(&(image_size as u32).to_le_bytes());
    out.extend_from_slice(&((6 + 16) as u32).to_le_bytes()); // image offset

    // BITMAPINFOHEADER
    out.extend_from_slice(&(dib_header as u32).to_le_bytes());
    out.extend_from_slice(&(w as i32).to_le_bytes());
    out.extend_from_slice(&((h as i32) * 2).to_le_bytes()); // double for ICO
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    out.extend_from_slice(&(xor_size as u32).to_le_bytes());
    out.extend_from_slice(&[0u8; 16]); // resolution + palette

    // XOR (image) — solid color, BGRA
    for _ in 0..(w * h) {
        out.extend_from_slice(&bgra);
    }
    // AND (mask) — fully opaque
    out.extend(std::iter::repeat(0u8).take(and_size));

    out
}

/// 1×1 transparent PNG (cheap placeholder for `bundle.icon`).
const MINIMAL_PNG_1X1: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
    0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
    0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
    0x9C, 0x63, 0xFC, 0xFF, 0x9F, 0xA1, 0x1E, 0x00, 0x07, 0x82, 0x02, 0x7F, 0x3D, 0xC8,
    0x48, 0xEF, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];
