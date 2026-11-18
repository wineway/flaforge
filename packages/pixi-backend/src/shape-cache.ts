import {
  FillGradient,
  FillPattern,
  GraphicsContext,
  Matrix,
  type FillStyle,
  type StrokeStyle,
  type Texture,
} from "pixi.js";
import type {
  ContourIR,
  FillStyleIR,
  ShapeIR,
  StrokeStyleIR,
  Vec2,
} from "@flaforge/ir";
import { applyMatrix } from "@flaforge/ir";

const GRADIENT_HALF_SIZE = 819.2;

function hexToNumber(hex: string): number {
  const clean = hex.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(clean)) return Number.parseInt(clean, 16);
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return Number.parseInt(
      `${clean[0]!}${clean[0]!}${clean[1]!}${clean[1]!}${clean[2]!}${clean[2]!}`,
      16,
    );
  }
  return 0x000000;
}

function colorWithAlpha(hex: string, alpha: number): string {
  const clean = hex.replace(/^#/, "");
  const full =
    clean.length === 3
      ? `${clean[0]!}${clean[0]!}${clean[1]!}${clean[1]!}${clean[2]!}${clean[2]!}`
      : clean;
  const n = Number.parseInt(full, 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha))})`;
}

function emitContour(context: GraphicsContext, contour: ContourIR): void {
  context.moveTo(contour.start.x, contour.start.y);
  for (const segment of contour.segments) {
    if (segment.k === "L") {
      context.lineTo(segment.to.x, segment.to.y);
    } else if (segment.k === "Q") {
      context.quadraticCurveTo(segment.c.x, segment.c.y, segment.to.x, segment.to.y);
    } else {
      context.bezierCurveTo(
        segment.c1.x,
        segment.c1.y,
        segment.c2.x,
        segment.c2.y,
        segment.to.x,
        segment.to.y,
      );
    }
  }
}

function makeGradient(fill: Extract<FillStyleIR, { kind: string }>): FillGradient | null {
  if (fill.kind === "linear-gradient") {
    const start: Vec2 = applyMatrix(fill.matrix, { x: -GRADIENT_HALF_SIZE, y: 0 });
    const end: Vec2 = applyMatrix(fill.matrix, { x: GRADIENT_HALF_SIZE, y: 0 });
    return new FillGradient({
      type: "linear",
      textureSpace: "global",
      start,
      end,
      colorStops: fill.entries.map((entry) => ({
        offset: entry.ratio,
        color: colorWithAlpha(entry.color, entry.alpha),
      })),
      wrapMode: fill.spreadMethod === "repeat" ? "repeat" : "clamp-to-edge",
      textureSize: 256,
    });
  }
  if (fill.kind === "radial-gradient") {
    const m = fill.matrix;
    const outerCenter = applyMatrix(m, { x: 0, y: 0 });
    const focalCenter = applyMatrix(m, {
      x: fill.focalPointRatio * GRADIENT_HALF_SIZE,
      y: 0,
    });
    const radiusX = GRADIENT_HALF_SIZE * Math.hypot(m.a, m.b);
    const radiusY = GRADIENT_HALF_SIZE * Math.hypot(m.c, m.d);
    const outerRadius = Math.max(0.001, radiusX);
    const scale = radiusX > 1e-9 ? radiusY / radiusX : 1;
    const rotation = Math.atan2(m.b, m.a);
    return new FillGradient({
      type: "radial",
      textureSpace: "global",
      center: focalCenter,
      innerRadius: 0,
      outerCenter,
      outerRadius,
      scale,
      rotation,
      colorStops: fill.entries.map((entry) => ({
        offset: entry.ratio,
        color: colorWithAlpha(entry.color, entry.alpha),
      })),
      wrapMode: fill.spreadMethod === "repeat" ? "repeat" : "clamp-to-edge",
      textureSize: 256,
    });
  }
  return null;
}

export interface ShapeBuildOptions {
  /** Optional diagnostics callback for unsupported features. */
  onWarning?: (message: string, shapeId: string) => void;
  /** Resolve a decoded IR bitmap asset to a Pixi texture. */
  getTexture?: (assetId: string) => Texture | undefined;
}

export class ShapeContextCache {
  private readonly contexts = new Map<string, GraphicsContext>();
  private readonly gradients: FillGradient[] = [];
  private readonly options: ShapeBuildOptions;

  constructor(options: ShapeBuildOptions = {}) {
    this.options = options;
  }

  get(shape: ShapeIR): GraphicsContext {
    const existing = this.contexts.get(shape.id);
    if (existing) return existing;
    const context = this.build(shape);
    this.contexts.set(shape.id, context);
    return context;
  }

  has(shapeId: string): boolean {
    return this.contexts.has(shapeId);
  }

  private fillInput(shape: ShapeIR, index: number): FillStyle {
    const fill = shape.fills[index];
    if (!fill) return { color: 0xff00ff, alpha: 1 };
    if (fill.kind === "solid") {
      return { color: hexToNumber(fill.color), alpha: fill.alpha };
    }
    if (fill.kind === "linear-gradient" || fill.kind === "radial-gradient") {
      const gradient = makeGradient(fill);
      if (gradient) {
        this.gradients.push(gradient);
        return { fill: gradient };
      }
    }
    if (fill.kind === "bitmap") {
      const texture = this.options.getTexture?.(fill.assetId);
      if (texture) {
        const pattern = new FillPattern(texture, fill.repeat ? "repeat" : "no-repeat");
        pattern.setTransform(
          new Matrix(fill.matrix.a, fill.matrix.b, fill.matrix.c, fill.matrix.d, fill.matrix.tx, fill.matrix.ty),
        );
        return { fill: pattern };
      }
      this.options.onWarning?.(
        `bitmap fill ${fill.assetId} has no texture; using a gray placeholder`,
        shape.id,
      );
      return { color: 0x888888, alpha: 0.7 };
    }
    return { color: 0xff00ff, alpha: 1 };
  }

  private strokeInput(shape: ShapeIR, index: number): StrokeStyle {
    const stroke = shape.strokes[index];
    if (!stroke) {
      return { width: 1, color: 0xff00ff, alpha: 1, cap: "butt", join: "round" };
    }
    return {
      width: Math.max(0, stroke.width),
      color: hexToNumber(stroke.color ?? "#000000"),
      alpha: stroke.alpha ?? 1,
      cap: stroke.cap === "none" ? "butt" : stroke.cap,
      join: stroke.join,
      miterLimit: stroke.miterLimit,
      alignment: 0.5,
      pixelLine: stroke.pixelHinting ?? false,
    } as StrokeStyle;
  }

  private build(shape: ShapeIR): GraphicsContext {
    const context = new GraphicsContext();
    for (const region of shape.regions) {
      context.beginPath();
      emitContour(context, region.outer);
      context.closePath();
      context.fill(this.fillInput(shape, region.fill));
      if (region.holes.length > 0) {
        for (const hole of region.holes) {
          context.beginPath();
          emitContour(context, hole);
          context.closePath();
          context.cut();
        }
      }
    }
    for (const path of shape.strokePaths) {
      const stroke = shape.strokes[path.stroke];
      if (!stroke || stroke.width <= 0) continue;
      context.beginPath();
      emitContour(context, {
        start: path.start,
        segments: path.segments,
        closed: path.closed,
      });
      if (path.closed) context.closePath();
      context.stroke(this.strokeInput(shape, path.stroke));
    }
    return context;
  }

  destroy(): void {
    for (const context of this.contexts.values()) context.destroy();
    this.contexts.clear();
    for (const gradient of this.gradients) gradient.destroy();
    this.gradients.length = 0;
  }
}

export { hexToNumber };
