// One-shot helper that writes minimal valid ICO + PNG placeholders so
// `tauri-build` is happy when running `cargo check`. Delete after first run
// or replace with a real icon.
const fs = require("fs");
const path = require("path");

// 32x32 ICO with a single solid-color BMP image. The bytes were assembled
// by hand following the ICO/BMP DIB layout — `image_size = 32*32*4 + 32*4`
// (4 bytes/pixel for the XOR mask + 1 bit/pixel for the AND mask, padded).
function buildIco() {
  const w = 32;
  const h = 32;
  const xorSize = w * h * 4;
  const andSize = ((w + 31) >> 3) * h; // 1 bit per pixel, 4 bytes/row
  const dibHeaderSize = 40;
  const imageSize = dibHeaderSize + xorSize + andSize;

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(1, 4); // count

  const dirEntry = Buffer.alloc(16);
  dirEntry.writeUInt8(w === 256 ? 0 : w, 0);
  dirEntry.writeUInt8(h === 256 ? 0 : h, 1);
  dirEntry.writeUInt8(0, 2); // colors
  dirEntry.writeUInt8(0, 3); // reserved
  dirEntry.writeUInt16LE(1, 4); // planes
  dirEntry.writeUInt16LE(32, 6); // bpp
  dirEntry.writeUInt32LE(imageSize, 8);
  dirEntry.writeUInt32LE(6 + 16, 12); // image offset

  const dib = Buffer.alloc(dibHeaderSize);
  dib.writeUInt32LE(dibHeaderSize, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h * 2, 8); // height *2 for ICO (XOR + AND)
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(xorSize, 20);
  dib.writeUInt32LE(0, 24);
  dib.writeUInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);

  // Solid-orange BGRA pixels (Anthropic accent)
  const xor = Buffer.alloc(xorSize);
  for (let i = 0; i < w * h; i++) {
    xor.writeUInt8(0x57, i * 4); // B
    xor.writeUInt8(0x77, i * 4 + 1); // G
    xor.writeUInt8(0xd9, i * 4 + 2); // R
    xor.writeUInt8(0xff, i * 4 + 3); // A
  }

  const and_ = Buffer.alloc(andSize, 0); // fully opaque

  return Buffer.concat([header, dirEntry, dib, xor, and_]);
}

function buildPng32() {
  // 1x1 transparent PNG — placeholder for tauri.conf.json bundle.icon list.
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64",
  );
}

const dir = path.dirname(__filename);
fs.writeFileSync(path.join(dir, "icon.ico"), buildIco());
fs.writeFileSync(path.join(dir, "icon.png"), buildPng32());
console.log("wrote icon.ico (" + buildIco().length + "b) + icon.png");
