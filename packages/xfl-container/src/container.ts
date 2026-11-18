import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { XflDiagnostic, ZipEntry, ZipReadOptions } from "./zip.js";
import { readZip } from "./zip.js";

export const XFL_MIMETYPE = "application/vnd.adobe.xfl";

export interface ContainerOptions extends ZipReadOptions {
  /** Maximum size of a single XML file parsed by callers (bytes). */
  maxXmlBytes?: number;
  /** Throw instead of returning a container with error diagnostics. */
  failFast?: boolean;
}

export interface ContainerEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

export interface ReadXflResult {
  container: XflContainer;
  diagnostics: XflDiagnostic[];
}

export class XflContainer {
  readonly source: string;
  readonly entries: Map<string, ContainerEntry>;
  readonly diagnostics: XflDiagnostic[];
  private readonly lowerCase: Map<string, string>;

  constructor(
    entries: Iterable<ContainerEntry>,
    diagnostics: XflDiagnostic[],
    source: string,
  ) {
    this.source = source;
    this.entries = new Map();
    this.lowerCase = new Map();
    this.diagnostics = diagnostics;
    for (const entry of entries) {
      if (this.entries.has(entry.name)) continue;
      this.entries.set(entry.name, entry);
      this.lowerCase.set(entry.name.toLowerCase(), entry.name);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  list(prefix = ""): string[] {
    const normalized = prefix.replace(/\\/g, "/").replace(/^\/+/, "");
    return [...this.entries.keys()]
      .filter((name) => name.startsWith(normalized))
      .sort();
  }

  resolveName(name: string): string | undefined {
    const normalized = name.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (this.entries.has(normalized)) return normalized;
    return this.lowerCase.get(normalized.toLowerCase());
  }

  has(name: string): boolean {
    return this.resolveName(name) !== undefined;
  }

  getEntry(name: string): ContainerEntry | undefined {
    const resolved = this.resolveName(name);
    return resolved ? this.entries.get(resolved) : undefined;
  }

  getBytes(name: string): Uint8Array | undefined {
    return this.getEntry(name)?.data;
  }

  requireBytes(name: string): Uint8Array {
    const bytes = this.getBytes(name);
    if (!bytes) throw new Error(`XFL entry not found: ${name} (source: ${this.source})`);
    return bytes;
  }

  getText(name: string): string | undefined {
    const bytes = this.getBytes(name);
    return bytes ? decodeText(bytes) : undefined;
  }

  requireText(name: string): string {
    return decodeText(this.requireBytes(name));
  }

  entriesWithExtension(extension: string): ContainerEntry[] {
    const ext = extension.toLowerCase();
    return [...this.entries.values()].filter((entry) =>
      entry.name.toLowerCase().endsWith(ext),
    );
  }

  /** Find the DOMDocument.xml, allowing an archive with a single top folder. */
  getDocumentEntryName(): string | undefined {
    const direct = this.resolveName("DOMDocument.xml");
    if (direct) return direct;
    const candidates = this.list().filter((name) =>
      name.toLowerCase().endsWith("/domdocument.xml"),
    );
    if (candidates.length === 0) return undefined;
    // Pick the shortest path (shallowest folder).
    candidates.sort((a, b) => a.length - b.length);
    return candidates[0];
  }

  /** Remove a shared top-level folder from all entry names (in place). */
  stripPrefix(prefix: string): void {
    const clean = prefix.replace(/\/+$/, "");
    if (!clean) return;
    const next: ContainerEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.name === clean) continue;
      if (!entry.name.startsWith(clean + "/")) continue;
      const name = entry.name.slice(clean.length + 1);
      next.push({ ...entry, name });
    }
    this.entries.clear();
    this.lowerCase.clear();
    for (const entry of next) {
      this.entries.set(entry.name, entry);
      this.lowerCase.set(entry.name.toLowerCase(), entry.name);
    }
  }
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }
  }
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(offset));
}

function isDirectoryEntry(entry: ZipEntry): boolean {
  return /[\\/]$/.test(entry.rawName);
}

function binaryFormatError(bytes: Uint8Array, source: string): Error | null {
  if (bytes.length >= 3) {
    const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!);
    if (sig === "FWS" || sig === "CWS" || sig === "ZWS") {
      return new Error(
        `${source} is a binary SWF/FLA file (${sig}), not an XFL ZIP. ` +
          `Open it in Adobe Animate and save as "XFL" or "FLA (uncompressed)" first.`,
      );
    }
  }
  if (bytes.length < 4 || !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return new Error(
      `${source} is neither an XFL ZIP nor an XFL directory (ZIP signature missing)`,
    );
  }
  return null;
}

function entriesFromZip(entries: ZipEntry[]): ContainerEntry[] {
  return entries
    .filter((entry) => !isDirectoryEntry(entry) && entry.name.length > 0)
    .map((entry) => ({ name: entry.name, data: entry.data, size: entry.data.length }));
}

function finalizeContainer(
  entries: ContainerEntry[],
  diagnostics: XflDiagnostic[],
  source: string,
  options: ContainerOptions,
): XflContainer {
  const container = new XflContainer(entries, diagnostics, source);
  const documentEntry = container.getDocumentEntryName();
  if (!documentEntry) {
    throw new Error(
      `XFL container ${source} does not contain DOMDocument.xml (entries: ${container.size})`,
    );
  }
  const slash = documentEntry.lastIndexOf("/");
  if (slash > 0) {
    container.stripPrefix(documentEntry.slice(0, slash));
  }

  const mimetypeName = container.resolveName("mimetype");
  if (mimetypeName) {
    const mimetype = container.requireText(mimetypeName).trim();
    if (mimetype !== XFL_MIMETYPE) {
      throw new Error(
        `unsupported XFL container mimetype "${mimetype}" (expected "${XFL_MIMETYPE}")`,
      );
    }
  } else {
    diagnostics.push({
      level: "warn",
      code: "XFL_MIMETYPE_MISSING",
      message: "mimetype entry is missing; assuming application/vnd.adobe.xfl",
    });
  }

  const errors = diagnostics.filter((d) => d.level === "error");
  if (options.failFast && errors.length > 0) {
    throw new Error(
      `failed to read XFL container ${source}:\n` +
        errors.map((d) => `  ${d.code}: ${d.message}`).join("\n"),
    );
  }
  return container;
}

export async function readXflDirectory(
  directory: string,
  options: ContainerOptions = {},
): Promise<ReadXflResult> {
  const root = resolve(directory);
  const diagnostics: XflDiagnostic[] = [];
  const entries: ContainerEntry[] = [];
  const maxEntryBytes = options.maxEntryBytes ?? 64 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 10_000;
  let total = 0;

  async function walk(current: string, relative: string): Promise<void> {
    const dirents = await readdir(current, { withFileTypes: true });
    for (const dirent of dirents) {
      if (dirent.name === "." || dirent.name === "..") continue;
      const abs = join(current, dirent.name);
      const rel = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) {
        diagnostics.push({
          level: "warn",
          code: "XFL_SYMLINK_SKIPPED",
          message: `skipping symlink ${rel}`,
          path: rel,
        });
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (!dirent.isFile()) continue;
      const info = await stat(abs);
      if (info.size > maxEntryBytes) {
        diagnostics.push({
          level: "error",
          code: "XFL_FILE_TOO_LARGE",
          message: `${rel} is ${info.size} bytes (limit ${maxEntryBytes})`,
          path: rel,
        });
        continue;
      }
      if (entries.length >= maxEntries) {
        throw new Error(`directory has more than ${maxEntries} files`);
      }
      total += info.size;
      entries.push({ name: rel.replace(/\\/g, "/"), data: new Uint8Array(await readFile(abs)), size: info.size });
    }
  }

  await walk(root, "");
  if (entries.length === 0) throw new Error(`XFL directory ${root} is empty`);

  // Allow pointing at the parent of a single `.xfl` folder.
  let container = new XflContainer(entries, diagnostics, root);
  if (!container.getDocumentEntryName()) {
    const candidates = entries
      .filter((entry) => entry.name.toLowerCase().endsWith(".xfl"))
      .map((entry) => entry.name);
    const only = candidates[0];
    if (candidates.length === 1 && only) {
      const nested = entries.filter((entry) => entry.name.startsWith(only + "/"));
      if (nested.length > 0) {
        container = new XflContainer(
          nested.map((entry) => ({ ...entry, name: entry.name.slice(only.length + 1) })),
          diagnostics,
          root,
        );
      }
    }
  }

  const documentEntry = container.getDocumentEntryName();
  if (!documentEntry) {
    throw new Error(
      `XFL directory ${root} does not contain DOMDocument.xml (found ${entries.length} files)`,
    );
  }
  // finalizeContainer rebuilds the container from entries, so use the possibly
  // prefixed entry list.
  const finalEntries = [...container.entries.values()].map((entry) => ({
    name: entry.name,
    data: entry.data,
    size: entry.data.length,
  }));
  const final = finalizeContainer(finalEntries, diagnostics, root, options);
  return { container: final, diagnostics };
}

export async function readXflContainer(
  input: string | Uint8Array | ArrayBuffer,
  options: ContainerOptions = {},
): Promise<ReadXflResult> {
  if (typeof input === "string") {
    const info = await stat(input);
    if (info.isDirectory()) return readXflDirectory(input, options);
    if (!info.isFile()) throw new Error(`not a file or directory: ${input}`);
    const bytes = new Uint8Array(await readFile(input));
    return readXflBytes(bytes, input, options);
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return readXflBytes(bytes, "<memory>", options);
}

export function readXflBytes(
  bytes: Uint8Array,
  source = "<memory>",
  options: ContainerOptions = {},
): ReadXflResult {
  const binaryError = binaryFormatError(bytes, source);
  if (binaryError) throw binaryError;
  const diagnostics: XflDiagnostic[] = [];
  const zip = readZip(bytes, options, diagnostics);
  const container = finalizeContainer(
    entriesFromZip(zip.entries),
    diagnostics,
    source,
    options,
  );
  return { container, diagnostics: container.diagnostics };
}

export { readZip } from "./zip.js";
export type { XflDiagnostic, ZipEntry, ZipReadOptions } from "./zip.js";
export { crc32 } from "./zip.js";

// Re-export a tiny helper so callers can identify a .xfl directory without
// importing node:path themselves.
export function looksLikeXflDirectoryPath(path: string): boolean {
  return /\.xfl[\\/]?$/i.test(path) || extname(path).toLowerCase() === "";
}
