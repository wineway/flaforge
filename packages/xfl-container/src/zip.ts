import { inflateSync } from "fflate";

export interface XflDiagnostic {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  path?: string;
  detail?: Record<string, unknown>;
}

export interface ZipEntry {
  /** Normalized POSIX-style path. */
  name: string;
  /** Original name as stored in the archive (before normalization). */
  rawName: string;
  data: Uint8Array;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  crc32: number;
  localHeaderOffset: number;
  fromCentralDirectory: boolean;
  isDirectory: boolean;
}

export interface ZipReadOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export interface ZipReadResult {
  entries: ZipEntry[];
  diagnostics: XflDiagnostic[];
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

interface CentralEntry {
  name: string;
  rawName: string;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  isDirectory: boolean;
}

interface LocalHeader {
  offset: number;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  name: string;
  rawName: string;
  dataStart: number;
}

function u16(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

function u32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

function u64(buf: Uint8Array, off: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset + off, 8);
  return Number(view.getBigUint64(0, true));
}

function signatureAt(buf: Uint8Array, off: number, sig: number): boolean {
  return off >= 0 && off + 4 <= buf.length && u32(buf, off) === sig;
}

function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) !== SIG_EOCD) continue;
    const commentLength = u16(buf, i + 20);
    if (i + 22 + commentLength === buf.length) return i;
  }
  // Tolerate trailing bytes / a broken comment length.
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  return -1;
}

interface Eocd {
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  comment: string;
}

function parseEocd(buf: Uint8Array, offset: number): Eocd {
  let entryCount = u16(buf, offset + 10);
  let cdSize = u32(buf, offset + 12);
  let cdOffset = u32(buf, offset + 16);

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64 locator sits 20 bytes before the EOCD.
    const locator = offset - 20;
    if (signatureAt(buf, locator, SIG_ZIP64_LOCATOR)) {
      const zip64Offset = u64(buf, locator + 8);
      if (signatureAt(buf, zip64Offset, SIG_ZIP64_EOCD)) {
        entryCount = u64(buf, zip64Offset + 32);
        cdSize = u64(buf, zip64Offset + 40);
        cdOffset = u64(buf, zip64Offset + 48);
      }
    }
  }

  const commentLength = Math.min(u16(buf, offset + 20), Math.max(0, buf.length - offset - 22));
  const comment = new TextDecoder("utf-8", { fatal: false }).decode(
    buf.subarray(offset + 22, offset + 22 + commentLength),
  );
  return {
    entryCount,
    centralDirectorySize: cdSize,
    centralDirectoryOffset: cdOffset,
    comment,
  };
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function normalizeEntryName(raw: string): { name: string; unsafe?: string } {
  let name = raw.replace(/\\/g, "/");
  if (/%[0-9A-Fa-f]{2}/.test(name)) {
    try {
      name = decodeURIComponent(name);
    } catch {
      // Keep the original name; malformed escapes are not fatal.
    }
  }
  name = name.replace(/\/+/g, "/");
  if (name.startsWith("./")) name = name.slice(2);
  const segments: string[] = [];
  for (const segment of name.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      return { name, unsafe: "zip-slip: path traverses above the archive root" };
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/") || raw.startsWith("/")) {
    return { name: normalized, unsafe: "zip-slip: absolute path" };
  }
  return { name: normalized };
}

function parseExtraFields(
  extra: Uint8Array,
): { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } {
  const result: { uncompressedSize?: number; compressedSize?: number; localHeaderOffset?: number } = {};
  let p = 0;
  while (p + 4 <= extra.length) {
    const tag = u16(extra, p);
    const size = u16(extra, p + 2);
    p += 4;
    if (p + size > extra.length) break;
    if (tag === 0x0001) {
      let q = p;
      if (q + 8 <= p + size) {
        result.uncompressedSize = u64(extra, q);
        q += 8;
      }
      if (q + 8 <= p + size) {
        result.compressedSize = u64(extra, q);
        q += 8;
      }
      if (q + 8 <= p + size) {
        result.localHeaderOffset = u64(extra, q);
        q += 8;
      }
    }
    p += size;
  }
  return result;
}

function parseCentralDirectory(
  buf: Uint8Array,
  offset: number,
  count: number,
  diagnostics: XflDiagnostic[],
): CentralEntry[] {
  const entries: CentralEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (!signatureAt(buf, p, SIG_CENTRAL)) {
      diagnostics.push({
        level: "warn",
        code: "ZIP_CD_TRUNCATED",
        message: `central directory ended after ${entries.length} of ${count} entries`,
        path: `zip:${p}`,
      });
      break;
    }
    if (p + 46 > buf.length) break;
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const crc32 = u32(buf, p + 16);
    let compressedSize = u32(buf, p + 20);
    let uncompressedSize = u32(buf, p + 24);
    const nameLength = u16(buf, p + 28);
    const extraLength = u16(buf, p + 30);
    const commentLength = u16(buf, p + 32);
    let localHeaderOffset = u32(buf, p + 42);
    if (p + 46 + nameLength + extraLength + commentLength > buf.length) {
      diagnostics.push({
        level: "warn",
        code: "ZIP_CD_TRUNCATED",
        message: "central directory entry extends past the end of the archive",
        path: `zip:${p}`,
      });
      break;
    }
    const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLength));
    const extra = buf.subarray(
      p + 46 + nameLength,
      p + 46 + nameLength + extraLength,
    );
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      nameLength === 0xffff
    ) {
      const zip64 = parseExtraFields(extra);
      if (zip64.compressedSize !== undefined) compressedSize = zip64.compressedSize;
      if (zip64.uncompressedSize !== undefined) uncompressedSize = zip64.uncompressedSize;
      if (zip64.localHeaderOffset !== undefined) localHeaderOffset = zip64.localHeaderOffset;
    }
    entries.push({
      name: rawName,
      rawName,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: /[\\/]$/.test(rawName),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function scanCentralDirectory(buf: Uint8Array, diagnostics: XflDiagnostic[]): CentralEntry[] {
  // Last-resort recovery when the EOCD's central directory offset/count is wrong:
  // scan for plausible central directory headers. Chinese file names and XML
  // contents are very unlikely to contain the exact header shape we require.
  const entries: CentralEntry[] = [];
  for (let p = 0; p + 46 <= buf.length; p++) {
    if (!signatureAt(buf, p, SIG_CENTRAL)) continue;
    const nameLength = u16(buf, p + 28);
    const extraLength = u16(buf, p + 30);
    const commentLength = u16(buf, p + 32);
    const end = p + 46 + nameLength + extraLength + commentLength;
    if (end > buf.length) continue;
    const method = u16(buf, p + 10);
    if (method !== 0 && method !== 8) continue;
    const rawName = decodeName(buf.subarray(p + 46, p + 46 + nameLength));
    if (rawName.length === 0) continue;
    const compressedSize = u32(buf, p + 20);
    const uncompressedSize = u32(buf, p + 24);
    const localHeaderOffset = u32(buf, p + 42);
    if (localHeaderOffset >= buf.length) continue;
    entries.push({
      name: rawName,
      rawName,
      flags: u16(buf, p + 8),
      method,
      crc32: u32(buf, p + 16),
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      isDirectory: /[\\/]$/.test(rawName),
    });
    p = end - 1;
  }
  if (entries.length > 0) {
    diagnostics.push({
      level: "warn",
      code: "ZIP_CD_SCANNED",
      message: `recovered ${entries.length} central directory entries by signature scan`,
    });
  }
  return entries;
}

function parseLocalHeader(buf: Uint8Array, offset: number): LocalHeader | null {
  if (!signatureAt(buf, offset, SIG_LOCAL) || offset + 30 > buf.length) return null;
  const flags = u16(buf, offset + 6);
  const method = u16(buf, offset + 8);
  const crc32 = u32(buf, offset + 14);
  let compressedSize = u32(buf, offset + 18);
  let uncompressedSize = u32(buf, offset + 22);
  const nameLength = u16(buf, offset + 26);
  const extraLength = u16(buf, offset + 28);
  if (offset + 30 + nameLength + extraLength > buf.length) return null;
  const rawName = decodeName(buf.subarray(offset + 30, offset + 30 + nameLength));
  if (
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    nameLength === 0xffff
  ) {
    const extra = buf.subarray(
      offset + 30 + nameLength,
      offset + 30 + nameLength + extraLength,
    );
    const zip64 = parseExtraFields(extra);
    if (zip64.compressedSize !== undefined) compressedSize = zip64.compressedSize;
    if (zip64.uncompressedSize !== undefined) uncompressedSize = zip64.uncompressedSize;
  }
  return {
    offset,
    flags,
    method,
    crc32,
    compressedSize,
    uncompressedSize,
    name: rawName,
    rawName,
    dataStart: offset + 30 + nameLength + extraLength,
  };
}

function findNextLocalHeader(buf: Uint8Array, from: number): number {
  let best = buf.length;
  for (const sig of [SIG_LOCAL, SIG_CENTRAL, SIG_EOCD]) {
    const at = indexOfSignature(buf, sig, from);
    if (at >= 0 && at < best) best = at;
  }
  return best;
}

function indexOfSignature(buf: Uint8Array, sig: number, from: number): number {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = (sig >>> 24) & 0xff;
  for (let i = from; i + 4 <= buf.length; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1 && buf[i + 2] === b2 && buf[i + 3] === b3) {
      return i;
    }
  }
  return -1;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function decompress(
  method: number,
  data: Uint8Array,
  diagnostics: XflDiagnostic[],
  name: string,
): Uint8Array | null {
  if (method === 0) return data;
  if (method === 8) {
    try {
      return inflateSync(data);
    } catch (error) {
      // Some writers append a data descriptor to the raw stream. Try trimming
      // the last 16 bytes (descriptor) before giving up.
      if (data.length > 16) {
        try {
          return inflateSync(data.subarray(0, data.length - 16));
        } catch {
          // fall through
        }
      }
      diagnostics.push({
        level: "error",
        code: "ZIP_INFLATE_FAILED",
        message: `deflate failed for ${name}: ${(error as Error).message}`,
        path: name,
      });
      return null;
    }
  }
  diagnostics.push({
    level: "error",
    code: "ZIP_UNSUPPORTED_METHOD",
    message: `unsupported compression method ${method} for ${name}`,
    path: name,
  });
  return null;
}

export function readZip(
  bytes: Uint8Array,
  options: ZipReadOptions = {},
  diagnostics: XflDiagnostic[] = [],
): ZipReadResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const eocdOffset = findEocd(bytes);
  if (eocdOffset < 0) {
    throw new Error(
      "not a ZIP-compatible XFL container: end-of-central-directory record not found",
    );
  }
  const eocd = parseEocd(bytes, eocdOffset);
  const actualCdSize = Math.max(0, eocdOffset - eocd.centralDirectoryOffset);
  if (actualCdSize !== eocd.centralDirectorySize) {
    diagnostics.push({
      level: "warn",
      code: "ZIP_EOCD_SIZE_MISMATCH",
      message: `EOCD central-directory size ${eocd.centralDirectorySize} does not match actual ${actualCdSize}; continuing with tolerant reader`,
      detail: {
        declared: eocd.centralDirectorySize,
        actual: actualCdSize,
        entryCount: eocd.entryCount,
      },
    });
  }

  let central: CentralEntry[] = [];
  if (signatureAt(bytes, eocd.centralDirectoryOffset, SIG_CENTRAL)) {
    central = parseCentralDirectory(
      bytes,
      eocd.centralDirectoryOffset,
      eocd.entryCount,
      diagnostics,
    );
  }
  if (central.length === 0 && eocd.entryCount > 0) {
    diagnostics.push({
      level: "warn",
      code: "ZIP_CD_UNREADABLE",
      message: "central directory could not be read at the declared offset; scanning",
    });
    central = scanCentralDirectory(bytes, diagnostics);
  }

  const centralByName = new Map<string, CentralEntry[]>();
  for (const entry of central) {
    const key = entry.name.replace(/\\/g, "/");
    const list = centralByName.get(key);
    if (list) list.push(entry);
    else centralByName.set(key, [entry]);
  }

  const entries: ZipEntry[] = [];
  const seen = new Map<string, ZipEntry>();
  let totalBytes = 0;
  let position = 0;
  const localScanEnd =
    eocd.centralDirectoryOffset > 0 && eocd.centralDirectoryOffset <= bytes.length
      ? eocd.centralDirectoryOffset
      : bytes.length;

  while (position < localScanEnd) {
    const local = parseLocalHeader(bytes, position);
    if (!local) {
      const next = indexOfSignature(bytes, SIG_LOCAL, position + 1);
      if (next < 0 || next >= localScanEnd) break;
      position = next;
      continue;
    }

    const candidates = centralByName.get(local.name.replace(/\\/g, "/")) ?? [];
    let hint: CentralEntry | undefined =
      candidates.find((c) => c.localHeaderOffset === local.offset) ?? candidates[0];

    let compressedSize = hint?.compressedSize ?? local.compressedSize;
    let uncompressedSize = hint?.uncompressedSize ?? local.uncompressedSize;
    let crc = hint?.crc32 ?? local.crc32;
    const method = hint?.method ?? local.method;
    const flags = hint?.flags ?? local.flags;

    let end: number;
    if (compressedSize > 0 && local.dataStart + compressedSize <= bytes.length) {
      end = local.dataStart + compressedSize;
      // Some archives place the data descriptor before the next header; the
      // compressed size excludes it, so this is already the right end.
    } else if (method === 0 && uncompressedSize > 0) {
      compressedSize = uncompressedSize;
      end = local.dataStart + compressedSize;
    } else {
      end = findNextLocalHeader(bytes, local.dataStart);
      compressedSize = Math.max(0, end - local.dataStart);
      hint = undefined;
    }
    if (end > bytes.length) end = bytes.length;
    if (compressedSize <= 0 && method !== 0) {
      diagnostics.push({
        level: "warn",
        code: "ZIP_EMPTY_ENTRY",
        message: `could not determine compressed size for ${local.name}`,
        path: local.name,
      });
    }

    const raw = bytes.subarray(local.dataStart, Math.min(end, local.dataStart + Math.max(compressedSize, 0)));
    let data = decompress(method, raw, diagnostics, local.name);
    if (!data) {
      position = Math.max(end, local.dataStart + 1);
      continue;
    }
    if (uncompressedSize > 0 && data.length !== uncompressedSize && method !== 0) {
      // A wrong central size is common in broken FLA files. Keep the inflate
      // result rather than failing.
      diagnostics.push({
        level: "info",
        code: "ZIP_SIZE_MISMATCH",
        message: `uncompressed size for ${local.name} is ${data.length}, expected ${uncompressedSize}`,
        path: local.name,
      });
    }
    if (crc !== 0) {
      const actualCrc = crc32(data);
      if (actualCrc !== crc) {
        diagnostics.push({
          level: "warn",
          code: "ZIP_CRC_MISMATCH",
          message: `CRC mismatch for ${local.name}`,
          path: local.name,
          detail: { expected: crc, actual: actualCrc },
        });
      }
    }

    const normalized = normalizeEntryName(local.rawName);
    if (normalized.unsafe) {
      diagnostics.push({
        level: "error",
        code: "ZIP_UNSAFE_PATH",
        message: `${normalized.unsafe}: ${local.rawName}`,
        path: local.rawName,
      });
      position = Math.max(end, local.dataStart + 1);
      continue;
    }
    const name = normalized.name;
    const isDirectory = /[\\/]$/.test(local.rawName) || data.length === 0 && name.length === 0;
    if (name.length === 0 || isDirectory) {
      position = Math.max(end, local.dataStart + 1);
      // Data descriptors are 12 or 16 bytes; skip them if present.
      if (flags & 0x8 && signatureAt(bytes, position, 0x08074b50)) position += 16;
      continue;
    }

    totalBytes += data.length;
    if (entries.length >= maxEntries) {
      diagnostics.push({
        level: "error",
        code: "ZIP_TOO_MANY_ENTRIES",
        message: `archive has more than ${maxEntries} entries`,
      });
      break;
    }
    if (data.length > maxEntryBytes) {
      diagnostics.push({
        level: "error",
        code: "ZIP_ENTRY_TOO_LARGE",
        message: `${name} is ${data.length} bytes (limit ${maxEntryBytes})`,
        path: name,
      });
      position = Math.max(end, local.dataStart + 1);
      continue;
    }
    if (totalBytes > maxTotalBytes) {
      diagnostics.push({
        level: "error",
        code: "ZIP_TOTAL_TOO_LARGE",
        message: `archive expands to more than ${maxTotalBytes} bytes`,
      });
      break;
    }

    const existing = seen.get(name);
    if (existing) {
      diagnostics.push({
        level: "warn",
        code: "ZIP_DUPLICATE_ENTRY",
        message: `duplicate entry ${name}; keeping the first occurrence`,
        path: name,
      });
    } else {
      const entry: ZipEntry = {
        name,
        rawName: local.rawName,
        data,
        compressedSize,
        uncompressedSize: data.length,
        compressionMethod: method,
        crc32: crc,
        localHeaderOffset: local.offset,
        fromCentralDirectory: Boolean(hint),
        isDirectory: false,
      };
      entries.push(entry);
      seen.set(name, entry);
    }

    position = Math.max(end, local.dataStart + 1);
    if (flags & 0x8 && signatureAt(bytes, position, 0x08074b50)) {
      // Data descriptor with the optional signature: 4 + 4 + 4 + 4 bytes.
      position += 16;
    }
    // A descriptor without its signature will be skipped by the next loop
    // iteration (parseLocalHeader fails, then we scan forward).
  }

  // Include central entries whose local header could not be found, if the local
  // offset still points at usable raw data (rare; mostly for odd writers).
  for (const centralEntry of central) {
    const normalized = normalizeEntryName(centralEntry.rawName);
    if (normalized.unsafe || normalized.name.length === 0) continue;
    if (seen.has(normalized.name)) continue;
    const local = parseLocalHeader(bytes, centralEntry.localHeaderOffset);
    if (!local) {
      diagnostics.push({
        level: "warn",
        code: "ZIP_ENTRY_MISSING",
        message: `central entry ${centralEntry.rawName} has no readable local header`,
        path: centralEntry.rawName,
      });
      continue;
    }
    const raw = bytes.subarray(
      local.dataStart,
      local.dataStart + Math.max(0, centralEntry.compressedSize),
    );
    const data = decompress(centralEntry.method, raw, diagnostics, centralEntry.rawName);
    if (!data) continue;
    const entry: ZipEntry = {
      name: normalized.name,
      rawName: centralEntry.rawName,
      data,
      compressedSize: centralEntry.compressedSize,
      uncompressedSize: data.length,
      compressionMethod: centralEntry.method,
      crc32: centralEntry.crc32,
      localHeaderOffset: centralEntry.localHeaderOffset,
      fromCentralDirectory: true,
      isDirectory: false,
    };
    entries.push(entry);
    seen.set(entry.name, entry);
  }

  return { entries, diagnostics };
}
