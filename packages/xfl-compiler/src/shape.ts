import type {
  ContourIR,
  FillRegionIR,
  FillStyleIR,
  GradientEntryIR,
  ShapeIR,
  StrokePathIR,
  StrokeStyleIR,
  Vec2,
  WidthMarkerIR,
} from "@flaforge/ir";
import {
  closeEnough,
  contourArea,
  contourLength,
  contourPoints,
  normalize,
  perp,
  shapeBounds,
  sub,
} from "@flaforge/ir";
import type { XflFillAst, XflShapeAst, XflStrokeAst } from "@flaforge/xml";
import type { DiagnosticSink } from "./diagnostics.js";
import type { EdgeParseStats } from "./edges.js";
import { parseEdgeString } from "./edges.js";
import { contentHash } from "./hash.js";
import type { StyleChain } from "./topology.js";
import { buildFillTopology, groupLoopRegions } from "./topology.js";

export interface GeometryStats {
  shapes: number;
  edgeElements: number;
  edgeStrings: number;
  cubics: number;
  moves: number;
  lines: number;
  quads: number;
  fills: number;
  strokes: number;
  variableStrokes: number;
  variableStrokeOutlines: number;
  subpathMarkers: number;
  rigMatrices: number;
  regions: number;
  strokePaths: number;
  groups: number;
}

export function createGeometryStats(): GeometryStats {
  return {
    shapes: 0,
    edgeElements: 0,
    edgeStrings: 0,
    cubics: 0,
    moves: 0,
    lines: 0,
    quads: 0,
    fills: 0,
    strokes: 0,
    variableStrokes: 0,
    variableStrokeOutlines: 0,
    subpathMarkers: 0,
    rigMatrices: 0,
    regions: 0,
    strokePaths: 0,
    groups: 0,
  };
}

export interface ShapeCompileOptions {
  /** P1: replace quadratic edges with cubics. P0 ignores cubics. */
  includeCubics?: boolean;
  /** XFL bitmap path/name -> IR asset id (resolved media). */
  bitmapAssetIdByName?: Map<string, string>;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeColor(input: string | undefined): string {
  if (!input) return "#000000";
  let value = input.trim();
  if (!value.startsWith("#")) {
    if (/^[0-9a-fA-F]{6}$/.test(value)) value = `#${value}`;
    else return "#000000";
  }
  const hex = value.slice(1);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[0]!}${hex[0]!}${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(0, 6).toLowerCase()}`;
  return "#000000";
}

function gradientEntries(ast: { ratio: number; color: string; alpha: number }[]): GradientEntryIR[] {
  return [...ast]
    .sort((a, b) => a.ratio - b.ratio)
    .map((entry) => ({
      color: normalizeColor(entry.color),
      alpha: clamp01(entry.alpha),
      ratio: clamp01(entry.ratio),
    }));
}

/** Animate occasionally writes a zero scale for a mirrored/cloned gradient. */
function isDegenerateGradientMatrix(matrix: { a: number; b: number; c: number; d: number }): boolean {
  return Math.abs(matrix.a) + Math.abs(matrix.b) + Math.abs(matrix.c) + Math.abs(matrix.d) < 1e-9;
}

/**
 * Fallback for XFL gradients whose matrix has no scale. Fit the gradient to the
 * shape bounds; linear gradients default to vertical, matching the usual
 * pants/clothing gradients written by Animate.
 */
function boundsFitGradientMatrix(
  bounds: { x: number; y: number; width: number; height: number },
  radial: boolean,
): { a: number; b: number; c: number; d: number; tx: number; ty: number } {
  const half = 819.2;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const sx = Math.max(1, bounds.width) / (2 * half);
  const sy = Math.max(1, bounds.height) / (2 * half);
  return radial
    ? { a: sx, b: 0, c: 0, d: sy, tx: cx, ty: cy }
    : { a: 0, b: sy, c: sx, d: 0, tx: cx, ty: cy };
}

export function fillToIR(
  fill: XflFillAst,
  sink: DiagnosticSink,
  path: string,
  bitmapAssetIdByName?: Map<string, string>,
): FillStyleIR | null {
  switch (fill.kind) {
    case "solid":
      return { kind: "solid", color: normalizeColor(fill.color), alpha: clamp01(fill.alpha) };
    case "linear-gradient": {
      const g = fill.gradient;
      if (g.entries.length === 0) {
        sink.warnOnce("GRADIENT_EMPTY", "gradient fill has no GradientEntry", path);
        return { kind: "solid", color: "#000000", alpha: 1 };
      }
      if (g.spreadMethod === "reflect") {
        sink.warnOnce(
          "GRADIENT_REFLECT_APPROXIMATE",
          "gradient spreadMethod=reflect is approximated by clamp in P0",
          path,
        );
      }
      if (g.spreadMethod === "repeat") {
        sink.warnOnce(
          "GRADIENT_REPEAT_APPROXIMATE",
          "gradient spreadMethod=repeat is approximated by clamp in P0",
          path,
        );
      }
      if (g.interpolationMethod === "linearRGB") {
        sink.warnOnce(
          "GRADIENT_LINEARRGB_APPROXIMATE",
          "gradient interpolationMethod=linearRGB is approximated by sRGB in P0",
          path,
        );
      }
      return {
        kind: "linear-gradient",
        entries: gradientEntries(g.entries),
        matrix: { ...g.matrix },
        spreadMethod: g.spreadMethod,
        interpolationMethod: g.interpolationMethod,
      };
    }
    case "radial-gradient": {
      const g = fill.gradient;
      if (g.entries.length === 0) {
        sink.warnOnce("GRADIENT_EMPTY", "gradient fill has no GradientEntry", path);
        return { kind: "solid", color: "#000000", alpha: 1 };
      }
      if (Math.abs(g.focalPointRatio) > 1e-6) {
        sink.warnOnce(
          "GRADIENT_FOCAL_APPROXIMATE",
          "radial focalPointRatio is mapped to a focal inner circle in P0",
          path,
        );
      }
      if (g.spreadMethod !== "pad" || g.interpolationMethod === "linearRGB") {
        sink.warnOnce(
          "GRADIENT_RADIAL_APPROXIMATE",
          "radial spread/interpolation is approximated in P0",
          path,
        );
      }
      return {
        kind: "radial-gradient",
        entries: gradientEntries(g.entries),
        matrix: { ...g.matrix },
        focalPointRatio: Math.max(-1, Math.min(1, g.focalPointRatio)),
        spreadMethod: g.spreadMethod,
        interpolationMethod: g.interpolationMethod,
      };
    }
    case "bitmap": {
      const bitmapPath = fill.bitmapPath ?? "unknown";
      const cleanPath = bitmapPath.replace(/\.(png|jpe?g)$/i, "");
      const basename = cleanPath.split("/").pop() ?? cleanPath;
      const resolvedAssetId =
        bitmapAssetIdByName?.get(bitmapPath) ??
        bitmapAssetIdByName?.get(cleanPath) ??
        bitmapAssetIdByName?.get(basename) ??
        `bitmap:${bitmapPath}`;
      sink.infoOnce(
        "BITMAP_FILL_TEXTURED",
        `bitmap fill resolved to ${resolvedAssetId} (matrix scale normalized from twips)`,
        path,
      );
      // Sample-derived: bitmap-fill matrix scale is in twips, while gradient
      // matrices are already px. Translation stays in px for bitmap fills.
      sink.infoOnce(
        "BITMAP_FILL_MATRIX_NORMALIZED",
        "bitmap fill matrix scale normalized from twips",
        path,
      );
      return {
        kind: "bitmap",
        assetId: resolvedAssetId,
        matrix: {
          a: fill.matrix.a / 20,
          b: fill.matrix.b / 20,
          c: fill.matrix.c / 20,
          d: fill.matrix.d / 20,
          tx: fill.matrix.tx,
          ty: fill.matrix.ty,
        },
        repeat: fill.repeat,
        smooth: fill.smooth,
        clipped: fill.clipped,
      };
    }
    case "unknown":
      sink.warnOnce(
        "FILL_UNKNOWN",
        `unsupported fill <${fill.name}>`,
        path,
      );
      return null;
  }
}

function strokeToIR(
  stroke: XflStrokeAst,
  sink: DiagnosticSink,
  path: string,
  bitmapAssetIdByName?: Map<string, string>,
): StrokeStyleIR {
  let color: string | undefined;
  let alpha: number | undefined;
  let fill: FillStyleIR | undefined;
  if (stroke.fill) {
    if (stroke.fill.kind === "solid") {
      color = normalizeColor(stroke.fill.color);
      alpha = clamp01(stroke.fill.alpha);
    } else {
      fill = fillToIR(stroke.fill, sink, path, bitmapAssetIdByName) ?? undefined;
      if (fill?.kind === "solid") {
        color = fill.color;
        alpha = fill.alpha;
        fill = undefined;
      }
    }
  }
  if (stroke.variableWidth) {
    sink.infoOnce(
      "VARIABLE_STROKE_TO_FILL",
      "VariablePointWidth stroke is converted to a filled outline",
      path,
    );
  }
  if (stroke.scaleMode !== "normal") {
    sink.warnOnce(
      "STROKE_SCALEMODE_UNSUPPORTED",
      `stroke scaleMode=${stroke.scaleMode} has no Pixi equivalent; using normal scaling`,
      path,
    );
  }
  const markers: WidthMarkerIR[] | undefined = stroke.variableWidth?.markers
    .map((marker) => ({
      position: clamp01(marker.position),
      left: Math.max(0, marker.left),
      right: Math.max(0, marker.right),
      type: marker.type,
    }))
    .sort((a, b) => a.position - b.position);

  return {
    kind: stroke.kind === "solid" ? "solid" : stroke.kind === "unsupported" ? "unsupported" : stroke.kind,
    color,
    alpha,
    fill,
    width: Math.max(0, stroke.weight),
    cap: stroke.caps,
    join: stroke.joints,
    miterLimit: stroke.miterLimit,
    scaleMode: stroke.scaleMode,
    pixelHinting: stroke.pixelHinting,
    variableWidth: markers ? { markers } : undefined,
  };
}

function reverseContour(contour: ContourIR): ContourIR {
  const points: Vec2[] = [contour.start];
  for (const segment of contour.segments) points.push(segment.to);
  const segments = [];
  for (let i = points.length - 1; i > 0; i--) {
    const original = contour.segments[i - 1]!;
    const to = points[i - 1]!;
    if (original.k === "L") segments.push({ k: "L" as const, to });
    else if (original.k === "Q") segments.push({ k: "Q" as const, c: original.c, to });
    else segments.push({ k: "C" as const, c1: original.c2, c2: original.c1, to });
  }
  return { start: points[points.length - 1]!, segments, closed: contour.closed };
}

function contourSignature(contour: ContourIR): string {
  const parts: string[] = [];
  const p = (v: Vec2) => `${v.x.toFixed(4)},${v.y.toFixed(4)}`;
  parts.push(p(contour.start));
  for (const segment of contour.segments) {
    parts.push(segment.k);
    if (segment.k === "Q") parts.push(p(segment.c));
    if (segment.k === "C") {
      parts.push(p(segment.c1));
      parts.push(p(segment.c2));
    }
    parts.push(p(segment.to));
  }
  return parts.join("|");
}

function interpolateWidth(markers: WidthMarkerIR[], position: number): { left: number; right: number } {
  if (markers.length === 0) return { left: 0.5, right: 0.5 };
  if (markers.length === 1) return { left: markers[0]!.left, right: markers[0]!.right };
  if (position <= markers[0]!.position) return { left: markers[0]!.left, right: markers[0]!.right };
  const last = markers[markers.length - 1]!;
  if (position >= last.position) return { left: last.left, right: last.right };
  for (let i = 1; i < markers.length; i++) {
    const b = markers[i]!;
    if (position > b.position) continue;
    const a = markers[i - 1]!;
    const span = b.position - a.position;
    const t = span <= 1e-9 ? 0 : (position - a.position) / span;
    return {
      left: a.left + (b.left - a.left) * t,
      right: a.right + (b.right - a.right) * t,
    };
  }
  return { left: last.left, right: last.right };
}

function flattenPath(contour: ContourIR): Vec2[] {
  const points: Vec2[] = [contour.start];
  let current = contour.start;
  for (const segment of contour.segments) {
    const lengthEstimate =
      segment.k === "L"
        ? Math.hypot(segment.to.x - current.x, segment.to.y - current.y)
        : segment.k === "Q"
          ? Math.hypot(segment.c.x - current.x, segment.c.y - current.y) +
            Math.hypot(segment.to.x - segment.c.x, segment.to.y - segment.c.y)
          : Math.hypot(segment.c1.x - current.x, segment.c1.y - current.y) +
            Math.hypot(segment.c2.x - segment.c1.x, segment.c2.y - segment.c1.y) +
            Math.hypot(segment.to.x - segment.c2.x, segment.to.y - segment.c2.y);
    const steps = Math.max(1, Math.min(64, Math.ceil(lengthEstimate / 1.5)));
    const start = current;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (segment.k === "L") {
        points.push({ x: start.x + (segment.to.x - start.x) * t, y: start.y + (segment.to.y - start.y) * t });
      } else if (segment.k === "Q") {
        const mt = 1 - t;
        points.push({
          x: mt * mt * start.x + 2 * mt * t * segment.c.x + t * t * segment.to.x,
          y: mt * mt * start.y + 2 * mt * t * segment.c.y + t * t * segment.to.y,
        });
      } else {
        const mt = 1 - t;
        points.push({
          x: mt ** 3 * start.x + 3 * mt * mt * t * segment.c1.x + 3 * mt * t * t * segment.c2.x + t ** 3 * segment.to.x,
          y: mt ** 3 * start.y + 3 * mt * mt * t * segment.c1.y + 3 * mt * t * t * segment.c2.y + t ** 3 * segment.to.y,
        });
      }
    }
    current = segment.to;
  }
  return points;
}

function removeDuplicatePoints(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (!last || !closeEnough(last, point, 1e-4)) out.push(point);
  }
  return out;
}

/**
 * Convert a VariablePointWidth stroke into a filled outline.
 *
 * XFL semantics used here (plan §4.4.4): each marker's left/right values are
 * fractions of `weight`; the marker at position 0 with (0.5,0.5) is a 2 px
 * stroke at weight=2, and (0,0) tapers to 0. End caps/joins are approximated by
 * straight connections in P0 (the sample tapers to zero).
 */
export function buildVariableStrokeOutline(
  start: Vec2,
  segments: ContourIR["segments"],
  closed: boolean,
  stroke: StrokeStyleIR,
): ContourIR | null {
  const markers = stroke.variableWidth?.markers ?? [];
  if (markers.length === 0) return null;
  let points = removeDuplicatePoints(flattenPath({ start, segments, closed }));
  if (points.length < 2) return null;
  if (closed || closeEnough(points[0]!, points[points.length - 1]!, 1e-3)) {
    if (!closeEnough(points[0]!, points[points.length - 1]!, 1e-6)) {
      points.push({ ...points[0]! });
    }
  }
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total < 1e-6) return null;
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    let tangent = normalize(sub(next, prev));
    if (Math.hypot(tangent.x, tangent.y) < 1e-9) tangent = { x: 1, y: 0 };
    const normal = perp(tangent);
    const position = total > 0 ? cumulative[i]! / total : 0;
    const width = interpolateWidth(markers, position);
    const leftOffset = stroke.width * width.left;
    const rightOffset = stroke.width * width.right;
    left.push({ x: points[i]!.x + normal.x * leftOffset, y: points[i]!.y + normal.y * leftOffset });
    right.push({ x: points[i]!.x - normal.x * rightOffset, y: points[i]!.y - normal.y * rightOffset });
  }
  const outline: Vec2[] = [...left, ...right.slice().reverse()];
  const cleaned = removeDuplicatePoints(outline);
  if (cleaned.length < 3) return null;
  const contourSegments = [];
  for (let i = 1; i < cleaned.length; i++) {
    contourSegments.push({ k: "L" as const, to: cleaned[i]! });
  }
  let contour: ContourIR = {
    start: cleaned[0]!,
    segments: contourSegments,
    closed: true,
  };
  if (contourArea(contour) < 0) contour = reverseContour(contour);
  return contour;
}

export function compileShape(
  ast: XflShapeAst,
  sink: DiagnosticSink,
  path: string,
  stats: GeometryStats,
  options: ShapeCompileOptions = {},
): ShapeIR | null {
  stats.shapes++;
  const parseStats: EdgeParseStats = { moves: 0, lines: 0, quads: 0, cubics: 0, unknownTokens: 0, subpathStyleIds: [] };
  const chains: StyleChain[] = [];
  let chainId = 0;
  let order = 0;

  for (const edge of ast.edges) {
    stats.edgeElements++;
    const fill0 = edge.fillStyle0 ?? 0;
    const fill1 = edge.fillStyle1 ?? 0;
    const stroke = edge.strokeStyle ?? 0;
    if (edge.edges) {
      stats.edgeStrings++;
      const subpaths = parseEdgeString(edge.edges, sink, path, parseStats);
      for (const subpath of subpaths) {
        chains.push({
          id: chainId++,
          order: order++,
          start: subpath.start,
          segments: subpath.segments,
          fill0,
          fill1,
          stroke,
        });
      }
    }
    if (edge.cubics) {
      stats.cubics++;
      if (!options.includeCubics) {
        sink.infoOnce(
          "CUBICS_IGNORED_P0",
          "Edge.cubics geometry is ignored in P0; quadratic edges are used instead",
          path,
        );
      } else {
        sink.warnOnce(
          "CUBICS_NOT_IMPLEMENTED",
          "includeCubics is not implemented yet; quadratic edges are used",
          path,
        );
      }
    }
  }
  stats.moves += parseStats.moves;
  stats.lines += parseStats.lines;
  stats.quads += parseStats.quads;
  stats.subpathMarkers += parseStats.subpathStyleIds.length;

  // Map XFL 1-based fill/stroke indices to IR 0-based indices.
  const fillMap = new Map<number, number>();
  const fills: FillStyleIR[] = [];
  for (const fillAst of [...ast.fills].sort((a, b) => a.index - b.index)) {
    const ir = fillToIR(fillAst, sink, path, options.bitmapAssetIdByName);
    if (!ir) continue;
    fillMap.set(fillAst.index, fills.length);
    fills.push(ir);
  }
  const strokeMap = new Map<number, number>();
  const strokes: StrokeStyleIR[] = [];
  for (const strokeAst of [...ast.strokes].sort((a, b) => a.index - b.index)) {
    strokeMap.set(strokeAst.index, strokes.length);
    if (strokeAst.variableWidth) stats.variableStrokes++;
    strokes.push(strokeToIR(strokeAst, sink, path, options.bitmapAssetIdByName));
  }
  stats.fills += fills.length;
  stats.strokes += strokes.length;

  const topology = buildFillTopology(chains, sink, path);
  const regions: FillRegionIR[] = [];
  for (const [xflFill, loops] of topology.loopsByFill) {
    const fillIndex = fillMap.get(xflFill);
    if (fillIndex === undefined) {
      sink.warnOnce(
        "FILL_STYLE_MISSING",
        `edge references fillStyle ${xflFill}, which is not declared`,
        path,
      );
      continue;
    }
    for (const region of groupLoopRegions(loops)) {
      regions.push({ fill: fillIndex, outer: region.outer, holes: region.holes });
    }
  }

  const strokePaths: StrokePathIR[] = [];
  const strokeSignatures = new Set<string>();
  const variablePaths: { stroke: StrokeStyleIR; start: Vec2; segments: ContourIR["segments"]; closed: boolean }[] = [];

  for (const chain of chains) {
    if (chain.stroke <= 0) continue;
    const strokeIndex = strokeMap.get(chain.stroke);
    if (strokeIndex === undefined) {
      sink.warnOnce(
        "STROKE_STYLE_MISSING",
        `edge references strokeStyle ${chain.stroke}, which is not declared`,
        path,
      );
      continue;
    }
    const last = chain.segments.length > 0 ? chain.segments[chain.segments.length - 1]!.to : chain.start;
    const closed = chain.segments.length > 1 && closeEnough(last, chain.start, 1e-3);
    const contour: ContourIR = {
      start: chain.start,
      segments: chain.segments,
      closed,
    };
    const signature = `${strokeIndex}|${contourSignature(contour)}`;
    if (strokeSignatures.has(signature)) continue;
    strokeSignatures.add(signature);
    const stroke = strokes[strokeIndex]!;
    if (stroke.variableWidth && stroke.variableWidth.markers.length > 0) {
      variablePaths.push({ stroke, start: chain.start, segments: chain.segments, closed });
      continue;
    }
    strokePaths.push({
      stroke: strokeIndex,
      start: chain.start,
      segments: chain.segments,
      closed,
    });
  }

  // Variable-width strokes become fill outlines. Add a synthesized fill style
  // for each distinct stroke paint.
  for (const variable of variablePaths) {
    const outline = buildVariableStrokeOutline(
      variable.start,
      variable.segments,
      variable.closed,
      variable.stroke,
    );
    if (!outline) continue;
    let fillIndex = fills.findIndex(
      (fill) => JSON.stringify(fill) === JSON.stringify(variable.stroke.fill ?? { kind: "solid", color: variable.stroke.color ?? "#000000", alpha: variable.stroke.alpha ?? 1 }),
    );
    if (fillIndex < 0) {
      const fill =
        variable.stroke.fill ??
        ({ kind: "solid", color: variable.stroke.color ?? "#000000", alpha: variable.stroke.alpha ?? 1 } as FillStyleIR);
      fillIndex = fills.length;
      fills.push(fill);
    }
    regions.push({ fill: fillIndex, outer: outline, holes: [] });
    stats.variableStrokeOutlines++;
  }

  stats.regions += regions.length;
  stats.strokePaths += strokePaths.length;

  if (regions.length === 0 && strokePaths.length === 0) {
    sink.warnOnce("SHAPE_EMPTY", "shape produced no renderable regions or strokes", path);
    return null;
  }

  const shape: ShapeIR = {
    id: "",
    bounds: { x: 0, y: 0, width: 0, height: 0 },
    fills,
    strokes,
    regions,
    strokePaths,
  };
  shape.bounds = shapeBounds(shape);
  for (const fill of shape.fills) {
    if (
      (fill.kind === "linear-gradient" || fill.kind === "radial-gradient") &&
      isDegenerateGradientMatrix(fill.matrix)
    ) {
      fill.matrix = boundsFitGradientMatrix(shape.bounds, fill.kind === "radial-gradient");
      sink.warnOnce(
        "GRADIENT_MATRIX_DEGENERATE",
        "gradient matrix has zero scale; fitted a default gradient to the shape bounds",
        path,
      );
    }
  }
  shape.id = `shape:${contentHash({
    fills,
    strokes,
    regions,
    strokePaths,
  })}`;
  return shape;
}

/** Debug helper: total path length of a shape's contours. */
export function shapePathLength(shape: ShapeIR): number {
  let total = 0;
  for (const region of shape.regions) {
    total += contourLength(region.outer);
    for (const hole of region.holes) total += contourLength(hole);
  }
  for (const stroke of shape.strokePaths) {
    total += contourLength({ start: stroke.start, segments: stroke.segments, closed: stroke.closed });
  }
  return total;
}

/** Debug helper: flatten all contours of a shape for SVG/debug output. */
export function shapeContours(shape: ShapeIR): { fill?: number; stroke?: number; contour: ContourIR }[] {
  const out: { fill?: number; stroke?: number; contour: ContourIR }[] = [];
  for (const region of shape.regions) {
    out.push({ fill: region.fill, contour: region.outer });
    for (const hole of region.holes) out.push({ fill: region.fill, contour: hole });
  }
  for (const stroke of shape.strokePaths) {
    out.push({
      stroke: stroke.stroke,
      contour: { start: stroke.start, segments: stroke.segments, closed: stroke.closed },
    });
  }
  return out;
}

export { contourPoints };
