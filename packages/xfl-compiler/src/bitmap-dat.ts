import { deflateSync, inflateRawSync, inflateSync } from "node:zlib";

/**
 * Adobe Animate XFL bitmap data blob (`bin/M <n> <timestamp>.dat`).
 *
 * Two layouts are in the wild. Both start with the same 26-byte header:
 *   0     03            media type (bitmap)
 *   1     05/03         depth type
 *   2..3  u16           decompressed row bytes (stride, may include padding)
 *   4..5  u16           width
 *   6..7  u16           height
 *   8..23 RECT (4 x i32, twips)
 *   24    u8            has alpha
 *   25    u8            depth-dependent (see below)
 *
 * Depth 05 (32-bit ARGB, the common Animate 20+ variant):
 *   25    compressed flag (1)
 *   26..  chunk table: u16 chunk_length + chunk bytes, until length 0
 *   Concatenating the chunks yields a zlib stream of ARGB (A,R,G,B) pixels,
 *   row-major, width * height * 4 bytes.
 *
 * Depth 03 (8-bit paletted, older/imported bitmaps):
 *   25    palette color count; 0 encodes 256
 *   26..  palette, `count` entries of BGRA (B,G,R,A), 4 bytes each
 *   then  u16 (format metadata; not needed for decoding)
 *   then  the same u16 chunk table. Concatenated chunks form a zlib stream of
 *         8-bit palette indices, `rowBytes * height` bytes (each row padded to
 *         rowBytes). Palette RGB values are straight (not premultiplied).
 */
export interface DecodedBitmapDat {
  width: number;
  height: number;
  hasAlpha: boolean;
  /** RGBA8, row-major. */
  pixels: Uint8Array;
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

/** Read a u16-terminated chunk table and inflate the concatenated chunks. */
function inflateChunkTable(bytes: Uint8Array, start: number): Uint8Array | null {
  if (start + 2 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;
  const chunks: Uint8Array[] = [];
  while (pos + 2 <= bytes.length) {
    const length = view.getUint16(pos, true);
    pos += 2;
    if (length === 0) break;
    if (length > bytes.length - pos) return null;
    chunks.push(bytes.subarray(pos, pos + length));
    pos += length;
  }
  if (chunks.length === 0) return null;
  const compressed = concatChunks(chunks);
  try {
    return new Uint8Array(inflateSync(compressed));
  } catch {
    // A few writers store raw DEFLATE chunks without the zlib wrapper.
    try {
      return new Uint8Array(inflateRawSync(compressed));
    } catch {
      return null;
    }
  }
}

function decodeIndexedBitmapDat(
  bytes: Uint8Array,
  width: number,
  height: number,
  hasAlpha: boolean,
): DecodedBitmapDat | null {
  const colorCount = (bytes[25] ?? 0) === 0 ? 256 : bytes[25]!;
  if (colorCount < 2 || colorCount > 256) return null;
  const rowBytes = bytes[2]! | (bytes[3]! << 8);
  if (rowBytes < width) return null;
  const paletteStart = 26;
  const paletteEnd = paletteStart + colorCount * 4;
  // The chunk table is preceded by a u16 whose meaning is not needed here.
  if (paletteEnd + 2 > bytes.length) return null;
  const indexes = inflateChunkTable(bytes, paletteEnd + 2);
  if (!indexes || indexes.length < rowBytes * height) return null;

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const index = indexes[rowStart + x]!;
      const out = (y * width + x) * 4;
      if (index >= colorCount) {
        rgba[out] = 255;
        rgba[out + 1] = 255;
        rgba[out + 2] = 255;
        rgba[out + 3] = 0;
        continue;
      }
      // Palettes are BGRA (Windows DIB order), straight alpha.
      const p = paletteStart + index * 4;
      const b = bytes[p]!;
      const g = bytes[p + 1]!;
      const r = bytes[p + 2]!;
      const a = bytes[p + 3]!;
      if (a === 0) {
        rgba[out] = 255;
        rgba[out + 1] = 255;
        rgba[out + 2] = 255;
        rgba[out + 3] = 0;
      } else {
        rgba[out] = r;
        rgba[out + 1] = g;
        rgba[out + 2] = b;
        rgba[out + 3] = a;
      }
    }
  }
  return { width, height, hasAlpha, pixels: rgba };
}

export function decodeBitmapDat(bytes: Uint8Array): DecodedBitmapDat | null {
  if (bytes.length < 28 || bytes[0] !== 0x03) return null;
  const depth = bytes[1]!;
  if (depth !== 0x05 && depth !== 0x03) return null;
  const width = bytes[4]! | (bytes[5]! << 8);
  const height = bytes[6]! | (bytes[7]! << 8);
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) return null;
  const hasAlpha = (bytes[24] ?? 0) !== 0;
  if (depth === 0x03) return decodeIndexedBitmapDat(bytes, width, height, hasAlpha);

  if ((bytes[25] ?? 0) === 0) return null;
  const argb = inflateChunkTable(bytes, 26);
  if (!argb || argb.length !== width * height * 4) return null;

  // ARGB (premultiplied) -> straight RGBA.
  //
  // Sample-verified: edge pixels are e.g. A=127, R=G=B=127. Keeping them as
  // straight RGBA produces a faint gray rectangle around every expression
  // bitmap when composited over white. Unpremultiply, and make fully
  // transparent pixels white so texture filtering cannot bleed black.
  const rgba = new Uint8Array(argb.length);
  for (let i = 0; i < argb.length; i += 4) {
    const a = argb[i]!;
    if (a === 0) {
      rgba[i] = 255;
      rgba[i + 1] = 255;
      rgba[i + 2] = 255;
      rgba[i + 3] = 0;
    } else {
      rgba[i] = Math.min(255, Math.round((argb[i + 1]! * 255) / a));
      rgba[i + 1] = Math.min(255, Math.round((argb[i + 2]! * 255) / a));
      rgba[i + 2] = Math.min(255, Math.round((argb[i + 3]! * 255) / a));
      rgba[i + 3] = a;
    }
  }
  return { width, height, hasAlpha, pixels: rgba };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = new TextEncoder().encode(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = Buffer.concat([Buffer.from(typeBytes), Buffer.from(data)]);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/** Encode decoded RGBA pixels as a PNG (no filter, enough for IR assets). */
export function rgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ]);
}

export interface DecodedBitmapDatPng {
  width: number;
  height: number;
  png: Buffer;
}

export function decodeBitmapDatToPng(bytes: Uint8Array): DecodedBitmapDatPng | null {
  const decoded = decodeBitmapDat(bytes);
  if (!decoded) return null;
  return {
    width: decoded.width,
    height: decoded.height,
    png: rgbaToPng(decoded.width, decoded.height, decoded.pixels),
  };
}
