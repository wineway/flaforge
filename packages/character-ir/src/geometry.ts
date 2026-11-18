import type {
  ContourIR,
  Rect,
  SegmentIR,
  ShapeIR,
  Vec2,
} from "./types.js";
import { rectFromPoints } from "./matrix.js";

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  if (len < 1e-12) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

/** Rotate 90° CCW. */
export function perp(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

export function pointAt(contour: ContourIR, index: number): Vec2 {
  if (index < 0) return contour.start;
  return contour.segments[index]!.to;
}

export function segmentStart(contour: ContourIR, index: number): Vec2 {
  if (index === 0) return contour.start;
  return contour.segments[index - 1]!.to;
}

export function quadPoint(p0: Vec2, c: Vec2, p1: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

export function cubicPoint(p0: Vec2, c1: Vec2, c2: Vec2, p1: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

export function segmentPoints(
  from: Vec2,
  segment: SegmentIR,
  stepsPerCurve = 12,
): Vec2[] {
  switch (segment.k) {
    case "L":
      return [segment.to];
    case "Q": {
      const out: Vec2[] = [];
      for (let i = 1; i <= stepsPerCurve; i++) {
        out.push(quadPoint(from, segment.c, segment.to, i / stepsPerCurve));
      }
      return out;
    }
    case "C": {
      const out: Vec2[] = [];
      for (let i = 1; i <= stepsPerCurve; i++) {
        out.push(
          cubicPoint(from, segment.c1, segment.c2, segment.to, i / stepsPerCurve),
        );
      }
      return out;
    }
  }
}

export function contourPoints(contour: ContourIR, stepsPerCurve = 12): Vec2[] {
  const out: Vec2[] = [contour.start];
  let current = contour.start;
  for (const segment of contour.segments) {
    const pts = segmentPoints(current, segment, stepsPerCurve);
    for (const p of pts) out.push(p);
    current = segment.to;
  }
  return out;
}

export function contourLength(contour: ContourIR): number {
  let len = 0;
  const points = contourPoints(contour, 24);
  for (let i = 1; i < points.length; i++) {
    len += length(sub(points[i]!, points[i - 1]!));
  }
  return len;
}

export function polygonArea(points: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

export function contourArea(contour: ContourIR): number {
  return polygonArea(contourPoints(contour, 16));
}

export function pointInPolygon(p: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i]!;
    const pj = polygon[j]!;
    const intersect =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonInteriorPoint(points: Vec2[]): Vec2 {
  // Centroid is not always inside a concave polygon; fall back to a midpoint of
  // a horizontal scanline through the bounding box.
  if (points.length === 0) return { x: 0, y: 0 };
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  for (let iter = 0; iter < 16; iter++) {
    const y = minY + ((iter + 0.5) / 16) * (maxY - minY);
    const xs: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const pi = points[i]!;
      const pj = points[j]!;
      if (pi.y > y !== pj.y > y) {
        xs.push(((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      if (xs[k + 1]! - xs[k]! > 1e-6) {
        return { x: (xs[k]! + xs[k + 1]!) / 2, y };
      }
    }
  }
  return points[0]!;
}

function quadraticExtrema(p0: number, c: number, p1: number): number[] {
  const denom = p0 - 2 * c + p1;
  if (Math.abs(denom) < 1e-12) return [];
  const t = (p0 - c) / denom;
  return t > 0 && t < 1 ? [t] : [];
}

function cubicExtrema(p0: number, c1: number, c2: number, p1: number): number[] {
  // derivative / 3 = A t^2 + B t + C
  const A = -p0 + 3 * c1 - 3 * c2 + p1;
  const B = 2 * (p0 - 2 * c1 + c2);
  const C = c1 - p0;
  const roots: number[] = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) {
      const t = -C / B;
      if (t > 0 && t < 1) roots.push(t);
    }
    return roots;
  }
  const disc = B * B - 4 * A * C;
  if (disc < 0) return roots;
  const sqrt = Math.sqrt(disc);
  for (const t of [(-B + sqrt) / (2 * A), (-B - sqrt) / (2 * A)]) {
    if (t > 0 && t < 1) roots.push(t);
  }
  return roots;
}

export function contourBounds(contour: ContourIR): Rect {
  const points: Vec2[] = [contour.start];
  let current = contour.start;
  for (const segment of contour.segments) {
    switch (segment.k) {
      case "L":
        points.push(segment.to);
        break;
      case "Q": {
        for (const t of [
          ...quadraticExtrema(current.x, segment.c.x, segment.to.x),
          ...quadraticExtrema(current.y, segment.c.y, segment.to.y),
        ]) {
          points.push(quadPoint(current, segment.c, segment.to, t));
        }
        points.push(segment.to);
        break;
      }
      case "C": {
        for (const t of [
          ...cubicExtrema(current.x, segment.c1.x, segment.c2.x, segment.to.x),
          ...cubicExtrema(current.y, segment.c1.y, segment.c2.y, segment.to.y),
        ]) {
          points.push(cubicPoint(current, segment.c1, segment.c2, segment.to, t));
        }
        points.push(segment.to);
        break;
      }
    }
    current = segment.to;
  }
  return rectFromPoints(points);
}

export function shapeBounds(shape: ShapeIR): Rect {
  const points: Vec2[] = [];
  let strokePad = 0;
  for (const stroke of shape.strokes) {
    strokePad = Math.max(strokePad, stroke.width / 2);
    if (stroke.variableWidth) {
      let maxFraction = 0;
      for (const marker of stroke.variableWidth.markers) {
        maxFraction = Math.max(maxFraction, marker.left, marker.right);
      }
      strokePad = Math.max(strokePad, stroke.width * maxFraction);
    }
  }
  for (const region of shape.regions) {
    for (const contour of [region.outer, ...region.holes]) {
      for (const p of contourPoints(contour, 8)) points.push(p);
    }
  }
  for (const path of shape.strokePaths) {
    for (const p of contourPoints({ start: path.start, segments: path.segments, closed: path.closed }, 8)) {
      points.push(p);
    }
  }
  const rect = rectFromPoints(points);
  if (strokePad > 0 && (shape.strokePaths.length > 0 || shape.regions.some((r) => r.fill < 0))) {
    return {
      x: rect.x - strokePad,
      y: rect.y - strokePad,
      width: rect.width + strokePad * 2,
      height: rect.height + strokePad * 2,
    };
  }
  return rect;
}

export function closeEnough(a: Vec2, b: Vec2, epsilon = 1e-4): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

export function cleanContour(contour: ContourIR, epsilon = 1e-4): ContourIR {
  const segments: SegmentIR[] = [];
  let current = contour.start;
  for (const segment of contour.segments) {
    if (closeEnough(current, segment.to, epsilon)) {
      if (segment.k === "L") continue;
      // Keep tiny curves only when they carry a real control point offset.
      if (segment.k === "Q" && closeEnough(current, segment.c, epsilon)) continue;
      if (
        segment.k === "C" &&
        closeEnough(current, segment.c1, epsilon) &&
        closeEnough(current, segment.c2, epsilon)
      ) {
        continue;
      }
    }
    segments.push(segment);
    current = segment.to;
  }
  return { start: contour.start, segments, closed: contour.closed };
}

export function contourIsClosed(contour: ContourIR, epsilon = 1e-3): boolean {
  const last = contour.segments.length
    ? contour.segments[contour.segments.length - 1]!.to
    : contour.start;
  return closeEnough(last, contour.start, epsilon);
}

export function segmentsToContour(start: Vec2, segments: SegmentIR[]): ContourIR {
  return { start, segments, closed: true };
}
