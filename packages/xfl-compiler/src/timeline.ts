import type {
  BlendModeIR,
  ColorTransformIR,
  ElementIR,
  FilterIR,
  FrameIR,
  LayerIR,
  MatrixIR,
  TimelineIR,
  TweenIR,
} from "@flaforge/ir";
import { activeKeyframe, IDENTITY_MATRIX, multiplyMatrix } from "@flaforge/ir";
import type {
  XflColorTransformAst,
  XflElementAst,
  XflFilterAst,
  XflFrameAst,
  XflLayerAst,
  XflSymbolInstanceAst,
  XflTimelineAst,
} from "@flaforge/xml";
import type { DiagnosticSink } from "./diagnostics.js";
import { hashString } from "./hash.js";
import type { GeometryStats } from "./shape.js";
import type { ShapeCompileOptions } from "./shape.js";
import { compileShape } from "./shape.js";

export interface TimelineCompileContext {
  sink: DiagnosticSink;
  stats: GeometryStats;
  shapes: Record<string, import("@flaforge/ir").ShapeIR>;
  /** libraryItemName -> character id */
  characterIdByName: Map<string, string>;
  /** bitmap path/name -> IR asset id */
  bitmapAssetIdByName?: Map<string, string>;
  includeCubics?: boolean;
}

function matrixFromAst(matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number } | undefined): MatrixIR {
  if (!matrix) return { ...IDENTITY_MATRIX };
  return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, tx: matrix.tx, ty: matrix.ty };
}

function colorTransformFromAst(ast: XflColorTransformAst | undefined): ColorTransformIR | undefined {
  if (!ast) return undefined;
  return {
    redMultiplier: ast.redMultiplier ?? 1,
    greenMultiplier: ast.greenMultiplier ?? 1,
    blueMultiplier: ast.blueMultiplier ?? 1,
    alphaMultiplier: ast.alphaMultiplier ?? 1,
    redOffset: ast.redOffset ?? 0,
    greenOffset: ast.greenOffset ?? 0,
    blueOffset: ast.blueOffset ?? 0,
    alphaOffset: ast.alphaOffset ?? 0,
  };
}

const BLEND_MODES = new Set<string>([
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
  "layer",
  "alpha",
  "erase",
  "invert",
]);

function blendModeFromAst(value: string | undefined, sink: DiagnosticSink, path: string): BlendModeIR | undefined {
  if (!value) return undefined;
  if (BLEND_MODES.has(value)) return value as BlendModeIR;
  sink.warnOnce("BLEND_MODE_UNKNOWN", `unsupported blendMode ${value}; using normal`, path);
  return "normal";
}

function num(attrs: Record<string, string>, key: string, fallback = 0): number {
  const raw = attrs[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(attrs: Record<string, string>, key: string, fallback = false): boolean {
  const raw = attrs[key];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function color(value: string | undefined): string {
  if (!value) return "#000000";
  const hex = value.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[0]!}${hex[0]!}${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}`.toLowerCase();
  }
  return "#000000";
}

export function filterFromAst(ast: XflFilterAst, sink: DiagnosticSink, path: string): FilterIR {
  const a = ast.attrs;
  switch (ast.kind) {
    case "glow":
      return {
        kind: "glow",
        color: color(a.color),
        alpha: num(a, "alpha", 1),
        blurX: num(a, "blurX", 0),
        blurY: num(a, "blurY", 0),
        strength: num(a, "strength", 1),
        inner: bool(a, "inner", false),
        knockout: bool(a, "knockout", false),
        quality: Math.max(0, Math.min(3, num(a, "quality", 1))) / 3,
        approximate: true,
      };
    case "blur":
      return {
        kind: "blur",
        blurX: num(a, "blurX", 0),
        blurY: num(a, "blurY", 0),
        quality: num(a, "quality", 1),
        approximate: true,
      };
    case "drop-shadow":
      return {
        kind: "drop-shadow",
        color: color(a.color),
        alpha: num(a, "alpha", 1),
        blurX: num(a, "blurX", 0),
        blurY: num(a, "blurY", 0),
        distance: num(a, "distance", 0),
        angle: num(a, "angle", 45),
        strength: num(a, "strength", 1),
        inner: bool(a, "inner", false),
        knockout: bool(a, "knockout", false),
        quality: Math.max(0, Math.min(3, num(a, "quality", 1))) / 3,
        hideObject: bool(a, "hideObject", false),
        approximate: true,
      };
    case "bevel":
      return {
        kind: "bevel",
        blurX: num(a, "blurX", 0),
        blurY: num(a, "blurY", 0),
        distance: num(a, "distance", 0),
        angle: num(a, "angle", 45),
        strength: num(a, "strength", 1),
        quality: Math.max(0, Math.min(3, num(a, "quality", 1))) / 3,
        highlightColor: color(a.highlightColor ?? "#ffffff"),
        shadowColor: color(a.shadowColor ?? "#000000"),
        approximate: true,
      };
    case "adjust-color":
      sink.warnOnce("FILTER_ADJUST_COLOR_APPROXIMATE", "AdjustColorFilter is approximated in P0", path);
      return {
        kind: "adjust-color",
        // Identity by default; the backend can replace this with a ColorMatrixFilter
        // built from brightness/contrast/saturation/hue if desired.
        colorMatrix: [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
        approximate: true,
      };
    case "gradient-glow":
    case "gradient-bevel":
    case "color-matrix":
    case "unknown":
    default:
      sink.warnOnce(
        "FILTER_UNSUPPORTED",
        `filter ${ast.name} is preserved but not rendered in P0`,
        path,
      );
      return { kind: "unsupported", name: ast.name, approximate: true };
  }
}

function filtersFromAst(asts: XflFilterAst[] | undefined, sink: DiagnosticSink, path: string): FilterIR[] | undefined {
  if (!asts || asts.length === 0) return undefined;
  return asts.map((ast) => filterFromAst(ast, sink, path));
}

function elementKey(ast: XflElementAst, shapeId?: string): string {
  switch (ast.kind) {
    case "instance":
      return `instance:${ast.libraryItemName}|${ast.name ?? ""}|${ast.symbolType ?? ""}`;
    case "shape":
      return `shape:${shapeId ?? "inline"}`;
    case "bitmap-instance":
      return `bitmap:${ast.libraryItemName}|${ast.name ?? ""}`;
    case "text":
    case "dynamic-text":
    case "input-text":
      return `text:${ast.text}|${ast.name ?? ""}`;
    case "morph-shape":
      return "morph";
    case "group":
      return "group";
    case "unknown":
      return `unknown:${ast.name}`;
  }
}

function instanceToElement(
  ast: XflSymbolInstanceAst,
  id: string,
  characterId: string,
  startFrame: number,
  sink: DiagnosticSink,
  path: string,
): ElementIR {
  return {
    id,
    kind: "instance",
    matrix: matrixFromAst(ast.matrix),
    pivot: ast.pivot,
    colorTransform: colorTransformFromAst(ast.colorTransform),
    blendMode: blendModeFromAst(ast.blendMode, sink, path),
    filters: filtersFromAst(ast.filters, sink, path),
    visible: ast.visible,
    cacheAsBitmap: ast.cacheAsBitmap,
    characterId,
    firstFrame: ast.firstFrame ?? 0,
    loopMode: ast.loop ?? "loop",
    startFrame,
    rigPropagationMatrix: ast.rigPropagationMatrix,
  };
}

function compileElementList(
  asts: XflElementAst[],
  ctx: TimelineCompileContext,
  path: string,
  layerIndex: number,
  keyframeIndex: number,
): ElementIR[] {
  const out: ElementIR[] = [];
  const occurrences = new Map<string, number>();

  const visit = (ast: XflElementAst, subPath: string): void => {
    if (ast.kind === "group") {
      ctx.stats.groups++;
      // Plan §5.2: DOMGroup.matrix is ignored. Member matrices are absolute.
      ast.members.forEach((member, index) => visit(member, `${subPath}.members[${index}]`));
      return;
    }

    if (ast.kind === "shape") {
      const shape = compileShape(ast, ctx.sink, subPath, ctx.stats, {
        includeCubics: ctx.includeCubics,
        bitmapAssetIdByName: ctx.bitmapAssetIdByName,
      });
      if (!shape) return;
      ctx.shapes[shape.id] = shape;
      const key = elementKey(ast, shape.id);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      out.push({
        id: `e:${layerIndex}:${hashString(`${key}|${occurrence}`).slice(0, 12)}`,
        kind: "shape",
        matrix: matrixFromAst(ast.matrix),
        shapeId: shape.id,
        startFrame: keyframeIndex,
      });
      return;
    }

    if (ast.kind === "instance") {
      if (ast.rigPropagationMatrix) {
        ctx.stats.rigMatrices++;
        ctx.sink.infoOnce(
          "RIG_PROPAGATION_IGNORED",
          "rigPropagationMatrix is preserved but not applied in P0",
          subPath,
        );
      }
      const characterId = ctx.characterIdByName.get(ast.libraryItemName);
      if (!characterId) {
        if (ast.libraryItemName === "__Camera__") {
          ctx.sink.infoOnce(
            "CAMERA_LAYER_IGNORED",
            "ignored Animate camera-layer placeholder __Camera__",
            subPath,
          );
        } else {
          ctx.sink.warnOnce(
            "SYMBOL_NOT_FOUND",
            `instance references unknown library item "${ast.libraryItemName}"`,
            subPath,
          );
        }
        return;
      }
      const key = elementKey(ast);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      out.push(
        instanceToElement(
          ast,
          `e:${layerIndex}:${hashString(`${key}|${occurrence}`).slice(0, 12)}`,
          characterId,
          keyframeIndex,
          ctx.sink,
          subPath,
        ),
      );
      return;
    }

    if (ast.kind === "bitmap-instance") {
      const characterId = ctx.characterIdByName.get(ast.libraryItemName);
      if (!characterId) {
        ctx.sink.warnOnce(
          "BITMAP_NOT_FOUND",
          `bitmap instance references unknown library item "${ast.libraryItemName}"`,
          subPath,
        );
        return;
      }
      const key = elementKey(ast);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      out.push({
        id: `e:${layerIndex}:${hashString(`${key}|${occurrence}`).slice(0, 12)}`,
        kind: "bitmap",
        matrix: matrixFromAst(ast.matrix),
        pivot: ast.pivot,
        colorTransform: colorTransformFromAst(ast.colorTransform),
        blendMode: blendModeFromAst(ast.blendMode, ctx.sink, subPath),
        filters: filtersFromAst(ast.filters, ctx.sink, subPath),
        visible: ast.visible,
        characterId,
        startFrame: keyframeIndex,
      });
      return;
    }

    if (ast.kind === "text" || ast.kind === "dynamic-text" || ast.kind === "input-text") {
      const key = elementKey(ast);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      out.push({
        id: `e:${layerIndex}:${hashString(`${key}|${occurrence}`).slice(0, 12)}`,
        kind: "text",
        matrix: matrixFromAst(ast.matrix),
        pivot: ast.pivot,
        startFrame: keyframeIndex,
        text: {
          kind: ast.kind === "text" ? "static" : ast.kind === "dynamic-text" ? "dynamic" : "input",
          text: ast.text,
          width: ast.width,
          height: ast.height,
          fontFamily: ast.attrs.fontFamily ?? ast.attrs.font,
          fontSize: ast.attrs.size !== undefined ? num(ast.attrs, "size", 12) : undefined,
          color: ast.attrs.color,
          align: ast.attrs.alignment ?? ast.attrs.align,
        },
      });
      return;
    }

    if (ast.kind === "morph-shape") {
      ctx.sink.warnOnce("MORPH_SHAPE_P1", "morph shapes are deferred to P1", subPath);
      return;
    }

    ctx.sink.warnOnce("ELEMENT_UNKNOWN", `unsupported element ${ast.name}`, subPath);
  };

  asts.forEach((ast, index) => visit(ast, `${path}.elements[${index}]`));
  return out;
}

function tweenFromFrame(
  frame: XflFrameAst,
  endFrame: number,
  sink: DiagnosticSink,
  path: string,
): TweenIR | undefined {
  const type = frame.tweenType;
  if (!type) return undefined;
  if (type.includes("shape")) {
    sink.warnOnce("SHAPE_TWEEN_P1", "shape tweens are deferred to P1", path);
    return { type: "shape", toFrame: endFrame, approximate: true };
  }
  if (type.includes("motion object")) {
    sink.warnOnce(
      "MOTION_OBJECT_TWEEN_UNSUPPORTED",
      "new-style motion object tweens are deferred; using the start matrix",
      path,
    );
    return undefined;
  }
  if (type.includes("motion")) {
    const rotate = frame.motionTweenRotate;
    return {
      type: "motion",
      toFrame: endFrame,
      acceleration: frame.acceleration ?? 0,
      rotate:
        rotate === "cw" || rotate === "clockwise"
          ? "clockwise"
          : rotate === "ccw" || rotate === "counter-clockwise"
            ? "counter-clockwise"
            : "auto",
      rotateTimes: frame.motionTweenRotateTimes ?? 0,
      approximate: false,
    };
  }
  sink.warnOnce("TWEEN_UNKNOWN", `unsupported tweenType ${type}`, path);
  return undefined;
}

function layerType(ast: XflLayerAst): LayerIR["type"] {
  switch (ast.layerType) {
    case "folder":
      return "folder";
    case "mask":
      return "mask";
    case "guide":
      return "guide";
    default:
      return "normal";
  }
}

/**
 * A motion tween is one continuous instance: its placement frame must not
 * reset at the tween end keyframe. XFL repeats the DOMSymbolInstance on both
 * keyframes, so the compiler would otherwise stamp the end keyframe index into
 * `startFrame`, making nested graphic/movieclip playback jump back to frame 0
 * when the tween finishes.
 */
export function preserveTweenStartFrames(frames: FrameIR[]): void {
  for (let index = 0; index < frames.length - 1; index++) {
    const frame = frames[index]!;
    if (frame.tween?.type !== "motion") continue;
    const next = frames[index + 1]!;
    const byId = new Map(frame.elements.map((element) => [element.id, element]));
    for (const element of next.elements) {
      const previous = byId.get(element.id);
      if (previous?.startFrame !== undefined) element.startFrame = previous.startFrame;
    }
  }
}

function compileLayer(
  ast: XflLayerAst,
  frameCount: number,
  ctx: TimelineCompileContext,
  path: string,
): LayerIR {
  const sorted = [...ast.frames].sort((a, b) => a.index - b.index);
  const frames: FrameIR[] = [];
  sorted.forEach((frameAst, index) => {
    const next = sorted[index + 1];
    let duration = frameAst.duration;
    if (!frameAst.raw.attrs.duration) {
      duration = next ? next.index - frameAst.index : frameCount - frameAst.index;
    }
    if (next && frameAst.index + duration > next.index) duration = next.index - frameAst.index;
    duration = Math.max(1, duration);

    const framePath = `${path}.frames[${index}]`;
    const elements = compileElementList(
      frameAst.elements,
      ctx,
      framePath,
      ast.index,
      frameAst.index,
    );
    const filters = filtersFromAst(frameAst.filters, ctx.sink, framePath);
    if (frameAst.rigPropagationMatrix) {
      ctx.stats.rigMatrices++;
      ctx.sink.infoOnce(
        "RIG_PROPAGATION_IGNORED",
        "rigPropagationMatrix is preserved but not applied in P0",
        framePath,
      );
    }
    const frame: FrameIR = {
      index: frameAst.index,
      duration,
      elements,
      filters,
      colorTransform: colorTransformFromAst(frameAst.colorTransform),
      label: frameAst.label,
      script: frameAst.script,
      sound: frameAst.sound?.map((sound) => ({ event: "sound", raw: sound.attrs })),
      rigPropagationMatrix: frameAst.rigPropagationMatrix,
      parentIndex: frameAst.parentLayerIndex,
      blendMode: blendModeFromAst(frameAst.blendMode, ctx.sink, framePath),
    };
    if (frameAst.tweenType && next) {
      // A tweenType on the final keyframe has no destination; keep it static.
      frame.tween = tweenFromFrame(
        frameAst,
        frameAst.index + duration,
        ctx.sink,
        framePath,
      );
    }
    frames.push(frame);
  });

  preserveTweenStartFrames(frames);

  return {
    index: ast.index,
    name: ast.name,
    type: layerType(ast),
    visible: ast.visible,
    parentIndex: ast.parentLayerIndex,
    riggingIndex: ast.layerRiggingIndex,
    frames,
    color: ast.color,
  };
}

/** Compute the timeline frame count from layer keyframes. */
export function timelineFrameCount(ast: XflTimelineAst): number {
  let max = 0;
  for (const layer of ast.layers) {
    for (const frame of layer.frames) {
      max = Math.max(max, frame.index + Math.max(1, frame.duration));
    }
  }
  return Math.max(1, max);
}

/**
 * Animate layer rigging: `LayerIR.riggingIndex` is the layer's rig id and a
 * frame's `parentIndex` points to the parent's *rig id* (not the layer index).
 * The parent's world matrix must pre-multiply the child's local matrix. The
 * rigPropagationMatrix stored in XFL only carries the parent's rotation/scale,
 * so the translation is recovered by composing the rig tree here.
 */
export function applyRigParenting(layers: LayerIR[], sink: DiagnosticSink, path: string): void {
  const byRig = new Map<number, LayerIR>();
  for (const layer of layers) {
    if (layer.riggingIndex !== undefined) byRig.set(layer.riggingIndex, layer);
  }
  if (byRig.size === 0) return;

  const parentOf = (layer: LayerIR, frameIndex: number): LayerIR | undefined => {
    const frame = activeKeyframe(layer, frameIndex);
    if (!frame || frame.parentIndex === undefined) return undefined;
    const parent = byRig.get(frame.parentIndex);
    if (!parent && frame.parentIndex !== 0) {
      sink.warnOnce(
        "RIG_PARENT_NOT_FOUND",
        `rig parent ${frame.parentIndex} not found for layer ${layer.name}`,
        path,
      );
    }
    return parent;
  };

  const localAt = (layer: LayerIR, frameIndex: number): MatrixIR | undefined => {
    const frame = activeKeyframe(layer, frameIndex);
    return frame?.elements[0]?.matrix;
  };

  const cache = new Map<string, MatrixIR>();
  const worldAt = (layer: LayerIR, frameIndex: number, stack: Set<number>): MatrixIR => {
    const key = `${layer.index}:${frameIndex}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (stack.has(layer.index)) {
      sink.warnOnce("RIG_PARENT_CYCLE", `rig parent cycle at layer ${layer.name}`, path);
      return { ...IDENTITY_MATRIX };
    }
    stack.add(layer.index);
    const local = localAt(layer, frameIndex) ?? { ...IDENTITY_MATRIX };
    const parent = parentOf(layer, frameIndex);
    const world = parent ? multiplyMatrix(worldAt(parent, frameIndex, stack), local) : local;
    stack.delete(layer.index);
    cache.set(key, world);
    return world;
  };

  // Compute every world matrix from the original local matrices first; mutating
  // a parent before its children are resolved would compose it twice.
  for (const layer of layers) {
    for (const frame of layer.frames) worldAt(layer, frame.index, new Set());
  }
  for (const layer of layers) {
    for (const frame of layer.frames) {
      const parent = parentOf(layer, frame.index);
      if (!parent) continue;
      const parentWorld = worldAt(parent, frame.index, new Set());
      for (const element of frame.elements) {
        element.matrix = multiplyMatrix(parentWorld, element.matrix);
      }
    }
  }
}

export function compileTimeline(
  ast: XflTimelineAst,
  ctx: TimelineCompileContext,
  path: string,
  id?: string,
): TimelineIR {
  const frameCount = timelineFrameCount(ast);
  const layers = ast.layers.map((layer, index) =>
    compileLayer(layer, frameCount, ctx, `${path}.layers[${index}]`),
  );
  // XFL <layers> is top-to-bottom. IR/backend draw order is bottom-to-top.
  layers.reverse();

  const riggedLayers = layers.filter(
    (layer) =>
      layer.riggingIndex !== undefined ||
      layer.frames.some((frame) => frame.parentIndex !== undefined),
  );
  if (riggedLayers.length > 0) {
    // The XFL matrices are parent-relative for rigged layers; compose the rig
    // tree now so the IR stores world-space matrices for both renderers.
    applyRigParenting(layers, ctx.sink, path);
    ctx.sink.infoOnce(
      "LAYER_RIGGING_APPLIED",
      `layer rigging applied to ${riggedLayers.length} layer(s) using the XFL rig ids`,
      path,
    );
  }

  const labels: { name: string; frame: number }[] = [];
  for (const layer of layers) {
    for (const frame of layer.frames) {
      if (frame.label) labels.push({ name: frame.label, frame: frame.index });
    }
  }

  return {
    id: id ?? `timeline:${hashString(`${path}|${frameCount}|${layers.length}`).slice(0, 12)}`,
    name: ast.name,
    frameCount,
    layers,
    labels,
  };
}

export type { ShapeCompileOptions };
