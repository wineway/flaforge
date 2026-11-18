import { describe, expect, it } from "vitest";
import {
  decomposeMatrix,
  easeTween,
  interpolateMatrix,
  multiplyMatrix,
  applyMatrix,
  identityMatrix,
} from "./matrix.js";
import type { MatrixIR } from "./types.js";

const rot90: MatrixIR = { a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 };
const mirror: MatrixIR = { a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0 };

describe("matrix decomposition", () => {
  it("decomposes identity", () => {
    const d = decomposeMatrix(identityMatrix());
    expect(d.sx).toBeCloseTo(1);
    expect(d.sy).toBeCloseTo(1);
    expect(d.angleX).toBeCloseTo(0);
    expect(d.angleY).toBeCloseTo(0);
  });

  it("decomposes a 90 degree rotation", () => {
    const d = decomposeMatrix(rot90);
    expect(d.sx).toBeCloseTo(1);
    expect(d.sy).toBeCloseTo(1);
    expect(d.angleX).toBeCloseTo(Math.PI / 2);
    expect(d.angleY).toBeCloseTo(Math.PI / 2);
  });

  it("puts a mirror into the y scale instead of the angle", () => {
    const d = decomposeMatrix(mirror);
    expect(d.sx).toBeCloseTo(1);
    expect(d.sy).toBeCloseTo(-1);
    expect(d.angleX).toBeCloseTo(0);
    expect(d.angleY).toBeCloseTo(0);
  });

  it("composes back to the original matrix", () => {
    const m: MatrixIR = { a: 0.8, b: 0.6, c: -0.3, d: 0.95, tx: 12, ty: -7 };
    const d = decomposeMatrix(m);
    const re = interpolateMatrix(m, m, 0);
    expect(re.a).toBeCloseTo(m.a);
    expect(re.b).toBeCloseTo(m.b);
    expect(re.c).toBeCloseTo(m.c);
    expect(re.d).toBeCloseTo(m.d);
    expect(re.tx).toBeCloseTo(m.tx);
    expect(re.ty).toBeCloseTo(m.ty);
    expect(d.sx).toBeCloseTo(1);
  });
});

describe("matrix tween", () => {
  it("interpolates translation and rotation without shrinking", () => {
    const from: MatrixIR = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const to: MatrixIR = { a: 0, b: 2, c: -2, d: 0, tx: 10, ty: 20 };
    const mid = interpolateMatrix(from, to, 0.5);
    expect(mid.tx).toBeCloseTo(5);
    expect(mid.ty).toBeCloseTo(10);
    // Uniform scale 1 -> 2, so the half-way matrix must not shrink below 1.
    expect(Math.hypot(mid.a, mid.b)).toBeCloseTo(1.5);
    expect(Math.atan2(mid.b, mid.a)).toBeCloseTo(Math.PI / 4);
  });

  it("uses the plan's acceleration formula", () => {
    expect(easeTween(0.5, 0)).toBeCloseTo(0.5);
    expect(easeTween(0.5, 100)).toBeCloseTo(0.75);
    expect(easeTween(0.5, -100)).toBeCloseTo(0.25);
  });

  it("unwraps angles along the shortest path", () => {
    const from: MatrixIR = { a: 0.99999, b: 0.001, c: -0.001, d: 0.99999, tx: 0, ty: 0 };
    const to: MatrixIR = { a: 0.99999, b: -0.001, c: 0.001, d: 0.99999, tx: 0, ty: 0 };
    const mid = interpolateMatrix(from, to, 0.5);
    expect(Math.atan2(mid.b, mid.a)).toBeCloseTo(0);
  });
});

describe("matrix composition", () => {
  it("applies child then parent", () => {
    const parent: MatrixIR = { a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 0 };
    const child: MatrixIR = { a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 };
    const combined = multiplyMatrix(parent, child);
    expect(applyMatrix(combined, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
  });
});
