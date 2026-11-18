import type { ContourIR, SegmentIR, Vec2 } from "@flaforge/ir";
import {
  closeEnough,
  contourArea,
  contourPoints,
  pointInPolygon,
  polygonInteriorPoint,
  rectFromPoints,
} from "@flaforge/ir";
import type { DiagnosticSink } from "./diagnostics.js";

/** A contiguous edge chain from one `!` move to the next. */
export interface StyleChain {
  id: number;
  order: number;
  start: Vec2;
  segments: SegmentIR[];
  /** 1-based XFL fill on the left of the directed edge; 0 = none. */
  fill0: number;
  /** 1-based XFL fill on the right of the directed edge; 0 = none. */
  fill1: number;
  /** 1-based XFL stroke style; 0 = none. */
  stroke: number;
}

interface HalfEdge {
  id: number;
  fill: number;
  from: Vec2;
  to: Vec2;
  segment: SegmentIR;
  chainId: number;
  startTangent: Vec2;
  endTangent: Vec2;
  visited: boolean;
}

export interface LoopInfo {
  contour: ContourIR;
  points: Vec2[];
  /** A point strictly inside the loop (used for containment tests). */
  rep: Vec2;
  area: number;
  depth: number;
  parentIndex?: number;
}

export interface FillTopology {
  loopsByFill: Map<number, LoopInfo[]>;
  openChains: number;
}

function pointKey(p: Vec2): string {
  return `${Math.round(p.x * 10000)}:${Math.round(p.y * 10000)}`;
}

function segmentTangents(
  from: Vec2,
  segment: SegmentIR,
): { start: Vec2; end: Vec2 } {
  if (segment.k === "L") {
    const d = { x: segment.to.x - from.x, y: segment.to.y - from.y };
    return { start: d, end: d };
  }
  if (segment.k === "Q") {
    let start = { x: segment.c.x - from.x, y: segment.c.y - from.y };
    let end = { x: segment.to.x - segment.c.x, y: segment.to.y - segment.c.y };
    if (Math.hypot(start.x, start.y) < 1e-12) {
      start = { x: segment.to.x - from.x, y: segment.to.y - from.y };
    }
    if (Math.hypot(end.x, end.y) < 1e-12) {
      end = { x: segment.to.x - from.x, y: segment.to.y - from.y };
    }
    return { start, end };
  }
  let start = { x: segment.c1.x - from.x, y: segment.c1.y - from.y };
  let end = { x: segment.to.x - segment.c2.x, y: segment.to.y - segment.c2.y };
  if (Math.hypot(start.x, start.y) < 1e-12) {
    start = { x: segment.to.x - from.x, y: segment.to.y - from.y };
  }
  if (Math.hypot(end.x, end.y) < 1e-12) {
    end = { x: segment.to.x - from.x, y: segment.to.y - from.y };
  }
  return { start, end };
}

function reverseSegment(segment: SegmentIR, to: Vec2): SegmentIR {
  switch (segment.k) {
    case "L":
      return { k: "L", to };
    case "Q":
      return { k: "Q", c: segment.c, to };
    case "C":
      return { k: "C", c1: segment.c2, c2: segment.c1, to };
  }
}

function reverseContour(contour: ContourIR): ContourIR {
  const points: Vec2[] = [contour.start];
  for (const segment of contour.segments) points.push(segment.to);
  // Reverse ending at the original start.
  const newStart = points[points.length - 1]!;
  const segments: SegmentIR[] = [];
  for (let i = points.length - 1; i > 0; i--) {
    const original = contour.segments[i - 1]!;
    segments.push(reverseSegment(original, points[i - 1]!));
  }
  return { start: newStart, segments, closed: contour.closed };
}

function buildHalfEdges(chains: StyleChain[]): HalfEdge[] {
  const edges: HalfEdge[] = [];
  let id = 0;
  for (const chain of chains) {
    let current = chain.start;
    for (const segment of chain.segments) {
      const from = current;
      const to = segment.to;
      const tangents = segmentTangents(from, segment);
      if (chain.fill0 > 0) {
        edges.push({
          id: id++,
          fill: chain.fill0,
          from,
          to,
          segment,
          chainId: chain.id,
          startTangent: tangents.start,
          endTangent: tangents.end,
          visited: false,
        });
      }
      if (chain.fill1 > 0) {
        edges.push({
          id: id++,
          fill: chain.fill1,
          from: to,
          to: from,
          segment: reverseSegment(segment, from),
          chainId: chain.id,
          startTangent: { x: -tangents.end.x, y: -tangents.end.y },
          endTangent: { x: -tangents.start.x, y: -tangents.start.y },
          visited: false,
        });
      }
      current = to;
    }
  }
  return edges;
}

function angleOf(v: Vec2): number {
  return Math.atan2(v.y, v.x);
}

function chooseNext(
  current: HalfEdge,
  candidates: HalfEdge[],
  start: HalfEdge,
): HalfEdge | undefined {
  if (candidates.length === 0) return undefined;
  const reverseAngle = angleOf({ x: -current.endTangent.x, y: -current.endTangent.y });
  let best: HalfEdge | undefined;
  let bestDelta = Infinity;
  for (const candidate of candidates) {
    if (candidate.visited && candidate !== start) continue;
    const outgoing = angleOf(candidate.startTangent);
    let delta = (reverseAngle - outgoing) % (Math.PI * 2);
    if (delta < 0) delta += Math.PI * 2;
    // Prefer closing the loop on an exact tie.
    if (delta < bestDelta - 1e-9 || (Math.abs(delta - bestDelta) <= 1e-9 && candidate === start)) {
      best = candidate;
      bestDelta = delta;
    }
  }
  return best;
}

function contourFromEdges(edges: HalfEdge[], start: Vec2): ContourIR {
  const segments = edges.map((edge) => edge.segment);
  const last = segments.length > 0 ? segments[segments.length - 1]!.to : start;
  if (!closeEnough(last, start, 1e-4)) {
    segments.push({ k: "L", to: start });
  }
  return { start, segments, closed: true };
}

function loopSignature(contour: ContourIR): string {
  const parts: string[] = [`${contour.start.x.toFixed(4)},${contour.start.y.toFixed(4)}`];
  for (const segment of contour.segments) {
    parts.push(segment.k);
    if (segment.k === "Q") parts.push(`${segment.c.x.toFixed(4)},${segment.c.y.toFixed(4)}`);
    if (segment.k === "C") {
      parts.push(`${segment.c1.x.toFixed(4)},${segment.c1.y.toFixed(4)}`);
      parts.push(`${segment.c2.x.toFixed(4)},${segment.c2.y.toFixed(4)}`);
    }
    parts.push(`${segment.to.x.toFixed(4)},${segment.to.y.toFixed(4)}`);
  }
  return parts.join("|");
}

function nearestUnvisited(
  edges: HalfEdge[],
  target: Vec2,
  fill: number,
  epsilon = 2,
): HalfEdge | undefined {
  let best: HalfEdge | undefined;
  let bestDistance = epsilon;
  for (const edge of edges) {
    if (edge.visited || edge.fill !== fill) continue;
    const d = Math.hypot(edge.from.x - target.x, edge.from.y - target.y);
    if (d < bestDistance) {
      best = edge;
      bestDistance = d;
    }
  }
  return best;
}

function classifyLoops(
  fill: number,
  loops: LoopInfo[],
  sink: DiagnosticSink,
  path: string,
): LoopInfo[] {
  if (loops.length <= 1) {
    for (const loop of loops) {
      if (loop.area < 0) {
        loop.contour = reverseContour(loop.contour);
        loop.area = -loop.area;
      }
    }
    return loops;
  }
  for (const loop of loops) {
    loop.depth = 0;
    for (const other of loops) {
      if (other === loop) continue;
      if (pointInPolygon(loop.rep, other.points)) loop.depth++;
    }
  }

  // Normalize orientation: outer CCW, hole CW. Pixi's cut() is explicit, but a
  // consistent winding also makes SVG debugging predictable.
  for (const loop of loops) {
    const shouldBeHole = loop.depth % 2 === 1;
    if ((!shouldBeHole && loop.area < 0) || (shouldBeHole && loop.area > 0)) {
      loop.contour = reverseContour(loop.contour);
      loop.area = -loop.area;
    }
  }

  const outers = loops.filter((loop) => loop.depth % 2 === 0);
  for (const loop of loops) {
    if (loop.depth % 2 === 0) continue;
    let best: LoopInfo | undefined;
    for (const outer of outers) {
      // Attach to the immediately enclosing shell, not to an island that is
      // itself inside this hole.
      if (outer.depth !== loop.depth - 1) continue;
      if (!pointInPolygon(loop.rep, outer.points)) continue;
      if (!best || Math.abs(outer.area) < Math.abs(best.area)) best = outer;
    }
    if (!best) {
      sink.warnOnce(
        "FILL_HOLE_UNASSIGNED",
        `fill ${fill}: could not assign a hole to an outer contour; rendering it as an outer region`,
        path,
      );
      loop.depth = 0;
      if (loop.area < 0) {
        loop.contour = reverseContour(loop.contour);
        loop.area = -loop.area;
      }
    } else {
      loop.parentIndex = loops.indexOf(best);
    }
  }
  return loops;
}

/**
 * Rebuild fill regions from directed edges.
 *
 * Every directed edge has fillStyle0 on its left and fillStyle1 on its right.
 * For each fill we collect half-edges with that fill on the left and trace the
 * face boundary by choosing the smallest clockwise turn at each vertex
 * (plan §4.4.2). Curves use endpoint tangents, not chords.
 */
export function buildFillTopology(
  chains: StyleChain[],
  sink: DiagnosticSink,
  path: string,
): FillTopology {
  const allEdges = buildHalfEdges(chains);
  const byFill = new Map<number, HalfEdge[]>();
  for (const edge of allEdges) {
    const list = byFill.get(edge.fill);
    if (list) list.push(edge);
    else byFill.set(edge.fill, [edge]);
  }

  const loopsByFill = new Map<number, LoopInfo[]>();
  const loopSignatures = new Map<number, Set<string>>();
  let openChains = 0;

  for (const [fill, edges] of byFill) {
    const outgoing = new Map<string, HalfEdge[]>();
    for (const edge of edges) {
      const key = pointKey(edge.from);
      const list = outgoing.get(key);
      if (list) list.push(edge);
      else outgoing.set(key, [edge]);
    }

    const loops: LoopInfo[] = [];
    const signatures = new Set<string>();
    loopSignatures.set(fill, signatures);

    for (const startEdge of edges) {
      if (startEdge.visited) continue;
      const loopEdges: HalfEdge[] = [];
      let current: HalfEdge | undefined = startEdge;
      let closed = false;
      let guard = 0;
      while (current && !current.visited && guard++ < edges.length + 4) {
        current.visited = true;
        loopEdges.push(current);
        if (closeEnough(current.to, startEdge.from, 1e-4)) {
          closed = true;
          break;
        }
        const candidates = outgoing.get(pointKey(current.to)) ?? [];
        let next = chooseNext(current, candidates, startEdge);
        if (!next) {
          // Tolerate a tiny endpoint mismatch by snapping to the nearest
          // unvisited edge of the same fill.
          next = nearestUnvisited(edges, current.to, fill);
        }
        if (!next) {
          closed = false;
          break;
        }
        current = next;
      }
      if (!closed) {
        openChains++;
        sink.warnOnce(
          "FILL_OPEN_CHAIN",
          `fill ${fill}: open boundary chain closed with a straight segment`,
          path,
        );
      }
      if (loopEdges.length === 0) continue;
      const contour = contourFromEdges(loopEdges, startEdge.from);
      const signature = loopSignature(contour);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const points = contourPoints(contour, 8);
      const area = contourArea(contour);
      if (points.length < 3 || Math.abs(area) < 1e-7) continue;
      loops.push({
        contour,
        points,
        rep: polygonInteriorPoint(points),
        area,
        depth: 0,
      });
    }

    if (loops.length === 0) {
      // Degrade to per-chain closed regions rather than dropping the shape.
      for (const chain of chains) {
        if (chain.fill0 !== fill && chain.fill1 !== fill) continue;
        if (chain.segments.length === 0) continue;
        const contour: ContourIR = {
          start: chain.start,
          segments: [...chain.segments],
          closed: true,
        };
        const last = chain.segments[chain.segments.length - 1]!.to;
        if (!closeEnough(last, chain.start, 1e-4)) {
          contour.segments.push({ k: "L", to: chain.start });
        }
        const points = contourPoints(contour, 8);
        const area = contourArea(contour);
        if (points.length < 3 || Math.abs(area) < 1e-7) continue;
        const signature = loopSignature(contour);
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        loops.push({ contour, points, rep: polygonInteriorPoint(points), area, depth: 0 });
      }
      sink.warnOnce(
        "FILL_FALLBACK_CHAIN",
        `fill ${fill}: topology traversal produced no loops; using per-chain closed regions`,
        path,
      );
    }

    if (loops.length > 0) {
      loopsByFill.set(fill, classifyLoops(fill, loops, sink, path));
    }
  }

  return { loopsByFill, openChains };
}

export function groupLoopRegions(
  loops: LoopInfo[],
): { outer: ContourIR; holes: ContourIR[] }[] {
  const outers: { loop: LoopInfo; holes: ContourIR[] }[] = [];
  loops.forEach((loop) => {
    if (loop.depth % 2 === 1) return;
    outers.push({ loop, holes: [] });
  });
  for (const loop of loops) {
    if (loop.depth % 2 === 0) continue;
    if (loop.parentIndex === undefined) continue;
    const parentLoop = loops[loop.parentIndex];
    if (!parentLoop) continue;
    const target = outers.find((outer) => outer.loop === parentLoop);
    if (target) target.holes.push(loop.contour);
  }
  return outers
    .filter((entry) => entry.loop.points.length >= 3 && Math.abs(entry.loop.area) > 1e-7)
    .map((entry) => ({ outer: entry.loop.contour, holes: entry.holes }));
}

export function loopBounds(loop: LoopInfo): ReturnType<typeof rectFromPoints> {
  return rectFromPoints(loop.points);
}
