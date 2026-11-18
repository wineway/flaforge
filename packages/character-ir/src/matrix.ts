import type { MatrixIR, Rect, Vec2 } from "./types.js";
import { IDENTITY_MATRIX } from "./types.js";

export function identityMatrix(): MatrixIR {
  return { ...IDENTITY_MATRIX };
}

export function cloneMatrix(m: MatrixIR): MatrixIR {
  return { a: m.a, b: m.b, c: m.c, d: m.d, tx: m.tx, ty: m.ty };
}

/** parent * child (applies child first, then parent). */
export function multiplyMatrix(parent: MatrixIR, child: MatrixIR): MatrixIR {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty,
  };
}

export function applyMatrix(m: MatrixIR, p: Vec2): Vec2 {
  return {
    x: m.a * p.x + m.c * p.y + m.tx,
    y: m.b * p.x + m.d * p.y + m.ty,
  };
}

export function applyMatrixVector(m: MatrixIR, p: Vec2): Vec2 {
  return {
    x: m.a * p.x + m.c * p.y,
    y: m.b * p.x + m.d * p.y,
  };
}

export function determinant(m: MatrixIR): number {
  return m.a * m.d - m.b * m.c;
}

export function invertMatrix(m: MatrixIR): MatrixIR | null {
  const det = determinant(m);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return {
    a: m.d * inv,
    b: -m.b * inv,
    c: -m.c * inv,
    d: m.a * inv,
    tx: (m.c * m.ty - m.d * m.tx) * inv,
    ty: (m.b * m.tx - m.a * m.ty) * inv,
  };
}

export interface DecomposedMatrix {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Rotation of the local x axis, radians. */
  angleX: number;
  /** Rotation of the local y axis, radians. */
  angleY: number;
}

/**
 * JPEXS ClassicTweenDetector decomposition (plan §5.4):
 *   sx = hypot(a, b)
 *   sy = hypot(c, d) * sign(det)
 *   angleX = atan2(b, a)
 *   angleY = atan2(-c / sy, d / sy)
 */
export function decomposeMatrix(m: MatrixIR): DecomposedMatrix {
  const sx = Math.hypot(m.a, m.b);
  const det = determinant(m);
  const sign = det < 0 ? -1 : 1;
  const sy = Math.hypot(m.c, m.d) * sign;

  const angleX = sx > 1e-12 ? Math.atan2(m.b, m.a) : 0;
  let angleY = 0;
  if (Math.abs(sy) > 1e-12) {
    angleY = Math.atan2(-m.c / sy, m.d / sy);
  } else if (Math.hypot(m.c, m.d) > 1e-12) {
    angleY = Math.atan2(-m.c, m.d);
  }

  return { tx: m.tx, ty: m.ty, sx, sy, angleX, angleY };
}

export function composeMatrix(d: DecomposedMatrix): MatrixIR {
  return {
    a: d.sx * Math.cos(d.angleX),
    b: d.sx * Math.sin(d.angleX),
    c: -d.sy * Math.sin(d.angleY),
    d: d.sy * Math.cos(d.angleY),
    tx: d.tx,
    ty: d.ty,
  };
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2;
  let r = a % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r <= -Math.PI) r += twoPi;
  return r;
}

export type TweenRotateDirection = "auto" | "clockwise" | "counter-clockwise";

export interface MatrixTweenOptions {
  /** -100..100, XFL convention (already flipped by the compiler when needed). */
  acceleration?: number;
  rotate?: TweenRotateDirection;
  rotateTimes?: number;
}

export function easeTween(t: number, acceleration = 0): number {
  const clamped = Math.max(0, Math.min(1, t));
  // Plan §5.4: eased = t + acceleration/100 * t*(1-t).
  return clamped + (acceleration / 100) * clamped * (1 - clamped);
}

/**
 * Decomposed matrix interpolation. Never interpolate a,b,c,d directly: doing so
 * shrinks the symbol while it rotates.
 */
export function interpolateMatrix(
  from: MatrixIR,
  to: MatrixIR,
  t: number,
  options: MatrixTweenOptions = {},
): MatrixIR {
  const p = easeTween(t, options.acceleration ?? 0);
  const d0 = decomposeMatrix(from);
  const d1 = decomposeMatrix(to);

  let dx = d1.angleX - d0.angleX;
  let dy = d1.angleY - d0.angleY;

  const direction = options.rotate ?? "auto";
  const turns = Math.max(0, Math.trunc(options.rotateTimes ?? 0));

  if (direction === "clockwise") {
    dx = normalizeAngle(dx);
    if (dx <= 0) dx += Math.PI * 2;
    dy = normalizeAngle(dy);
    if (dy <= 0) dy += Math.PI * 2;
    dx += turns * Math.PI * 2;
    dy += turns * Math.PI * 2;
  } else if (direction === "counter-clockwise") {
    dx = normalizeAngle(dx);
    if (dx >= 0) dx -= Math.PI * 2;
    dy = normalizeAngle(dy);
    if (dy >= 0) dy -= Math.PI * 2;
    dx -= turns * Math.PI * 2;
    dy -= turns * Math.PI * 2;
  } else {
    dx = normalizeAngle(dx);
    dy = normalizeAngle(dy);
  }

  return composeMatrix({
    tx: d0.tx + (d1.tx - d0.tx) * p,
    ty: d0.ty + (d1.ty - d0.ty) * p,
    sx: d0.sx + (d1.sx - d0.sx) * p,
    sy: d0.sy + (d1.sy - d0.sy) * p,
    angleX: d0.angleX + dx * p,
    angleY: d0.angleY + dy * p,
  });
}

export function matrixEquals(a: MatrixIR, b: MatrixIR, epsilon = 1e-9): boolean {
  return (
    Math.abs(a.a - b.a) <= epsilon &&
    Math.abs(a.b - b.b) <= epsilon &&
    Math.abs(a.c - b.c) <= epsilon &&
    Math.abs(a.d - b.d) <= epsilon &&
    Math.abs(a.tx - b.tx) <= epsilon &&
    Math.abs(a.ty - b.ty) <= epsilon
  );
}

export function rectFromPoints(points: Vec2[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function transformRect(m: MatrixIR, r: Rect): Rect {
  return rectFromPoints([
    applyMatrix(m, { x: r.x, y: r.y }),
    applyMatrix(m, { x: r.x + r.width, y: r.y }),
    applyMatrix(m, { x: r.x, y: r.y + r.height }),
    applyMatrix(m, { x: r.x + r.width, y: r.y + r.height }),
  ]);
}
