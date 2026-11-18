import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { deflateRawSync } from "node:zlib";
import {
  XFL_MIMETYPE,
  crc32,
  readXflBytes,
  readXflContainer,
  readZip,
} from "./index.js";

describe("tolerant ZIP reader", () => {
  it("accepts a normal ZIP with a DOMDocument", () => {
    const zip = zipSync({
      mimetype: strToU8(XFL_MIMETYPE),
      "DOMDocument.xml": strToU8('<DOMDocument width="10" height="10" frameRate="24"/>'),
      "LIBRARY/a.xml": strToU8("<DOMSymbolItem/>"),
    });
    const { container } = readXflBytes(zip);
    expect(container.size).toBe(3);
    expect(container.getDocumentEntryName()).toBe("DOMDocument.xml");
  });

  it("reads UTF-8 names despite a mismatched central-directory size", () => {
    const zip = zipSync({
      mimetype: strToU8(XFL_MIMETYPE),
      "DOMDocument.xml": strToU8("<DOMDocument/>"),
      "LIBRARY/形状.xml": strToU8("<DOMSymbolItem/>"),
    });
    const eocd = new DataView(zip.buffer, zip.byteOffset + zip.byteLength - 22, 22);
    const centralDirectorySizeOffset = 12;
    eocd.setUint32(centralDirectorySizeOffset, eocd.getUint32(centralDirectorySizeOffset, true) + 1, true);
    const { entries, diagnostics } = readZip(zip);
    expect(entries.map((entry) => entry.name)).toContain("LIBRARY/形状.xml");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("ZIP_EOCD_SIZE_MISMATCH");
  });

  it("rejects zip-slip paths", () => {
    const zip = zipSync({
      mimetype: strToU8(XFL_MIMETYPE),
      "DOMDocument.xml": strToU8("<DOMDocument/>"),
      "../evil.xml": strToU8("evil"),
    });
    const result = readZip(zip);
    expect(result.entries.some((entry) => entry.name.includes("evil"))).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "ZIP_UNSAFE_PATH")).toBe(true);
  });

  it("gives a clear error for a binary SWF/FLA", () => {
    const bytes = new Uint8Array([0x46, 0x57, 0x53, 0x0a, 0, 0, 0, 0]);
    expect(() => readXflBytes(bytes, "binary.fla")).toThrow(/binary SWF\/FLA/);
  });

  it("throws when DOMDocument.xml is absent", () => {
    const zip = zipSync({ "readme.txt": strToU8("nothing here") });
    expect(() => readXflBytes(zip)).toThrow(/DOMDocument\.xml/);
  });
});

function descriptorZip(): Uint8Array {
  const encoder = new TextEncoder();
  const files = [
    { name: "mimetype", content: encoder.encode(XFL_MIMETYPE), store: true },
    {
      name: "DOMDocument.xml",
      content: encoder.encode('<DOMDocument width="10" height="10" frameRate="24"/>'),
      store: false,
    },
  ];
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (value: number) => {
    const out = new Uint8Array(2);
    new DataView(out.buffer).setUint16(0, value, true);
    return out;
  };
  const u32 = (value: number) => {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
  };
  const concat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let p = 0;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  };
  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.content);
    const compressed = file.store ? file.content : new Uint8Array(deflateRawSync(file.content));
    const useDescriptor = !file.store;
    const flags = useDescriptor ? 0x0008 : 0;
    const local = concat(
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(file.store ? 0 : 8),
      u16(0),
      u16(0),
      u32(useDescriptor ? 0 : crc),
      u32(useDescriptor ? 0 : compressed.length),
      u32(useDescriptor ? 0 : file.content.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    );
    chunks.push(local);
    if (useDescriptor) {
      chunks.push(
        concat(u32(0x08074b50), u32(crc), u32(compressed.length), u32(file.content.length)),
      );
    }
    central.push(
      concat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(file.store ? 0 : 8),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(file.content.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ),
    );
    offset += local.length + (useDescriptor ? 16 : 0);
  }
  const centralOffset = chunks.reduce((sum, part) => sum + part.length, 0);
  const centralBytes = concat(...central);
  const eocd = concat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralBytes.length),
    u32(centralOffset),
    u16(0),
  );
  return concat(...chunks, centralBytes, eocd);
}

describe("ZIP data descriptors and ZIP64", () => {
  it("reads an entry with the data-descriptor flag", () => {
    const result = readZip(descriptorZip());
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "mimetype",
      "DOMDocument.xml",
    ]);
    expect(result.diagnostics.some((d) => d.code === "ZIP_CRC_MISMATCH")).toBe(false);
  });
});

describe("container directory input", () => {
  it("reads an unpacked .xfl directory", async () => {
    const { container, diagnostics } = await readXflContainer(
      resolve(process.cwd(), "fixtures/semantics/basic-shape.xfl"),
    );
    expect(container.size).toBe(3);
    expect(container.getDocumentEntryName()).toBe("DOMDocument.xml");
    expect(diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(container.requireText("LIBRARY/Shape.xml")).toContain("DOMSymbolItem");
  });
});
