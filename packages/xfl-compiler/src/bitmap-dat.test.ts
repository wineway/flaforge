import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeBitmapDat,
  decodeBitmapDatToPng,
  type DecodedBitmapDat,
} from "./bitmap-dat.js";

type Bgra = [b: number, g: number, r: number, a: number];

interface IndexedDatOptions {
  width: number;
  height: number;
  rowBytes: number;
  colorCount: 16 | 256;
  /** BGRA palette entries, length must equal colorCount. */
  palette: Bgra[];
  /** One palette index per pixel; each row has at least `width` entries. */
  indices: number[][];
  splitZlib?: boolean;
}

function u16(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function buildIndexedDat(options: IndexedDatOptions): Uint8Array {
  const { width, height, rowBytes, colorCount, palette, indices } = options;
  if (palette.length !== colorCount) throw new Error("palette length mismatch");
  if (indices.length !== height) throw new Error("row count mismatch");

  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const row = indices[y]!;
    if (row.length < width) throw new Error("row width mismatch");
    for (let x = 0; x < width; x++) pixels[y * rowBytes + x] = row[x]!;
  }

  const compressed = new Uint8Array(deflateSync(pixels));
  const parts =
    options.splitZlib === false
      ? [compressed]
      : [compressed.subarray(0, 2), compressed.subarray(2)];

  const header = new Uint8Array(26);
  header[0] = 0x03;
  header[1] = 0x03;
  header.set(u16(rowBytes), 2);
  header.set(u16(width), 4);
  header.set(u16(height), 6);
  header[24] = 1;
  header[25] = colorCount === 256 ? 0 : colorCount;

  const paletteBytes = new Uint8Array(colorCount * 4);
  for (let i = 0; i < palette.length; i++) paletteBytes.set(palette[i]!, i * 4);

  const body: Uint8Array[] = [header, paletteBytes, new Uint8Array([0x00, 0x01])];
  for (const part of parts) {
    body.push(new Uint8Array(u16(part.length)), part);
  }
  body.push(new Uint8Array([0x00, 0x00]));

  const total = body.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of body) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pixel(decoded: DecodedBitmapDat, x: number, y: number): number[] {
  const offset = (y * decoded.width + x) * 4;
  return Array.from(decoded.pixels.subarray(offset, offset + 4));
}

describe("decodeBitmapDat depth 03 (8-bit paletted)", () => {
  it("decodes a 16-color BGRA palette, alpha, and row padding", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    palette[0] = [0, 0, 255, 255]; // red
    palette[1] = [0, 255, 0, 128]; // green @ 50%
    palette[2] = [255, 0, 0, 255]; // blue
    const dat = buildIndexedDat({
      width: 3,
      height: 2,
      rowBytes: 4,
      colorCount: 16,
      palette,
      indices: [
        [0, 1, 2, 0],
        [3, 0, 3, 0],
      ],
    });

    const decoded = decodeBitmapDat(dat);
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(3);
    expect(decoded!.height).toBe(2);
    expect(decoded!.hasAlpha).toBe(true);
    expect(decoded!.pixels.length).toBe(3 * 2 * 4);
    expect(pixel(decoded!, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded!, 1, 0)).toEqual([0, 255, 0, 128]);
    expect(pixel(decoded!, 2, 0)).toEqual([0, 0, 255, 255]);
    expect(pixel(decoded!, 0, 1)).toEqual([255, 255, 255, 0]);
    expect(pixel(decoded!, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixel(decoded!, 2, 1)).toEqual([255, 255, 255, 0]);
  });

  it("decodes the 256-color variant (palette count 0 encodes 256)", () => {
    const palette: Bgra[] = Array.from({ length: 256 }, () => [0, 0, 0, 0]);
    palette[0] = [10, 20, 30, 255];
    palette[255] = [40, 50, 60, 200];
    const dat = buildIndexedDat({
      width: 2,
      height: 1,
      rowBytes: 2,
      colorCount: 256,
      palette,
      indices: [[0, 255]],
    });

    const decoded = decodeBitmapDat(dat);
    expect(decoded).not.toBeNull();
    expect(pixel(decoded!, 0, 0)).toEqual([30, 20, 10, 255]);
    expect(pixel(decoded!, 1, 0)).toEqual([60, 50, 40, 200]);
  });

  it("accepts a single-chunk zlib stream", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    palette[1] = [1, 2, 3, 4];
    const dat = buildIndexedDat({
      width: 1,
      height: 1,
      rowBytes: 1,
      colorCount: 16,
      palette,
      indices: [[1]],
      splitZlib: false,
    });
    expect(pixel(decodeBitmapDat(dat)!, 0, 0)).toEqual([3, 2, 1, 4]);
  });

  it("encodes decoded pixels as a PNG", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    palette[0] = [0, 0, 255, 255];
    const dat = buildIndexedDat({
      width: 1,
      height: 1,
      rowBytes: 1,
      colorCount: 16,
      palette,
      indices: [[0]],
    });
    const png = decodeBitmapDatToPng(dat);
    expect(png?.width).toBe(1);
    expect(png?.height).toBe(1);
    expect([...png!.png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it("rejects a palette count below 2", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    const dat = buildIndexedDat({
      width: 1,
      height: 1,
      rowBytes: 1,
      colorCount: 16,
      palette,
      indices: [[0]],
    });
    dat[25] = 1;
    expect(decodeBitmapDat(dat)).toBeNull();
  });

  it("rejects a chunk length that runs past the end of the blob", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    const dat = buildIndexedDat({
      width: 1,
      height: 1,
      rowBytes: 1,
      colorCount: 16,
      palette,
      indices: [[0]],
    });
    const chunkStart = 26 + 16 * 4 + 2;
    dat[chunkStart] = 0xff;
    dat[chunkStart + 1] = 0xff;
    expect(decodeBitmapDat(dat)).toBeNull();
  });

  it("rejects a stride smaller than the width", () => {
    const palette: Bgra[] = Array.from({ length: 16 }, () => [0, 0, 0, 0]);
    const dat = buildIndexedDat({
      width: 2,
      height: 1,
      rowBytes: 2,
      colorCount: 16,
      palette,
      indices: [[0, 0]],
    });
    dat[2] = 1;
    dat[3] = 0;
    expect(decodeBitmapDat(dat)).toBeNull();
  });
});
