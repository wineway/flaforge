import type {
  ElementIR,
  FrameIR,
  LayerIR,
  LoopModeIR,
  ResolvedElementIR,
  ResolvedFrameIR,
  TimelineIR,
} from "./types.js";
import { interpolateMatrix, matrixEquals } from "./matrix.js";

export function frameCountOf(timeline: TimelineIR): number {
  let max = 0;
  for (const layer of timeline.layers) {
    for (const frame of layer.frames) {
      max = Math.max(max, frame.index + Math.max(1, frame.duration));
    }
  }
  return max;
}

/**
 * Preview/bake frames are absolute and may run past the timeline (a one-frame
 * pose is the common case). Loop into the timeline's declared length instead
 * of evaluating past the last keyframe, which would render nothing.
 */
export function wrapTimelineFrame(timeline: TimelineIR, frame: number): number {
  const length = Math.max(1, timeline.frameCount);
  const value = Number.isFinite(frame) ? Math.trunc(frame) : 0;
  return ((value % length) + length) % length;
}

/** Last keyframe whose span contains `frame`. */
export function activeKeyframe(layer: LayerIR, frame: number): FrameIR | undefined {
  let active: FrameIR | undefined;
  for (const keyframe of layer.frames) {
    if (keyframe.index > frame) break;
    if (frame < keyframe.index + Math.max(1, keyframe.duration)) active = keyframe;
  }
  return active;
}

export function keyframeAtOrBefore(layer: LayerIR, frame: number): FrameIR | undefined {
  let active: FrameIR | undefined;
  for (const keyframe of layer.frames) {
    if (keyframe.index > frame) break;
    active = keyframe;
  }
  return active;
}

export function nextKeyframe(layer: LayerIR, frame: FrameIR): FrameIR | undefined {
  for (const candidate of layer.frames) {
    if (candidate.index > frame.index) return candidate;
  }
  return undefined;
}

function elementsById(elements: ElementIR[]): Map<string, ElementIR> {
  const map = new Map<string, ElementIR>();
  for (const element of elements) map.set(element.id, element);
  return map;
}

/**
 * Evaluate one layer at a local frame, expanding classic motion tweens.
 *
 * The compiler gives the same element id to both ends of a tween, so this is a
 * pure function over IR and does not need any XFL data.
 */
export function evaluateLayerFrame(layer: LayerIR, frame: number): ResolvedFrameIR | null {
  const keyframe = activeKeyframe(layer, frame);
  if (!keyframe) return null;

  const resolved: ResolvedElementIR[] = [];
  let progress: number | undefined;

  if (keyframe.tween && keyframe.tween.type === "motion") {
    const next = nextKeyframe(layer, keyframe);
    const toFrame = keyframe.tween.toFrame ?? next?.index;
    if (next && toFrame !== undefined && frame > keyframe.index) {
      const span = Math.max(1, toFrame - keyframe.index);
      const t = Math.min(1, (frame - keyframe.index) / span);
      progress = t;
      const nextMap = elementsById(next.elements);
      for (const element of keyframe.elements) {
        const target = nextMap.get(element.id);
        if (!target) {
          resolved.push({ ...element, resolvedMatrix: { ...element.matrix } });
          continue;
        }
        const matrix = interpolateMatrix(element.matrix, target.matrix, t, {
          acceleration: keyframe.tween.acceleration,
          rotate: keyframe.tween.rotate,
          rotateTimes: keyframe.tween.rotateTimes,
        });
        resolved.push({
          ...element,
          resolvedMatrix: matrix,
          colorTransform: target.colorTransform ?? element.colorTransform,
          filters: target.filters ?? element.filters,
          visible: target.visible ?? element.visible,
        });
      }
    } else {
      for (const element of keyframe.elements) {
        resolved.push({ ...element, resolvedMatrix: { ...element.matrix } });
      }
    }
  } else {
    for (const element of keyframe.elements) {
      resolved.push({ ...element, resolvedMatrix: { ...element.matrix } });
    }
  }

  return {
    index: frame,
    keyframeIndex: keyframe.index,
    duration: keyframe.duration,
    elements: resolved,
    tweenProgress: progress,
    filters: keyframe.filters,
    colorTransform: keyframe.colorTransform,
    label: keyframe.label,
    blendMode: keyframe.blendMode,
  };
}

export interface EvaluatedLayer {
  layer: LayerIR;
  frame: ResolvedFrameIR | null;
}

export function evaluateTimelineFrame(
  timeline: TimelineIR,
  frame: number,
): EvaluatedLayer[] {
  return timeline.layers.map((layer) => ({
    layer,
    frame: evaluateLayerFrame(layer, frame),
  }));
}

/**
 * Graphic symbol playback (plan §5.5).
 *
 * `parentFrame` must be the parent symbol's local frame, not the stage frame.
 */
export function resolveGraphicFrame(args: {
  parentFrame: number;
  instanceStartFrame: number;
  firstFrame?: number;
  loopMode?: LoopModeIR;
  childLength: number;
}): number {
  const length = Math.max(1, args.childLength);
  const first = args.firstFrame ?? 0;
  const loopMode = args.loopMode ?? "loop";
  const rel = args.parentFrame - args.instanceStartFrame + first;

  switch (loopMode) {
    case "single frame":
      return clampFrame(first, length);
    case "play once":
      return clampFrame(rel, length);
    case "loop":
    default: {
      const mod = ((rel % length) + length) % length;
      return mod;
    }
  }
}

export function clampFrame(frame: number, length: number): number {
  if (!Number.isFinite(frame)) return 0;
  return Math.max(0, Math.min(length - 1, Math.trunc(frame)));
}

/** Movieclip independent clock (plan §4.7.4). */
export function resolveMovieclipFrame(args: {
  globalFrame: number;
  instanceStartFrame: number;
  childLength: number;
}): number {
  const length = Math.max(1, args.childLength);
  const rel = args.globalFrame - args.instanceStartFrame;
  return ((rel % length) + length) % length;
}

/** True when an element is practically static within its frame span. */
export function isElementTweened(layer: LayerIR, element: ElementIR, frame: number): boolean {
  const keyframe = activeKeyframe(layer, frame);
  if (!keyframe?.tween || keyframe.tween.type !== "motion") return false;
  const next = nextKeyframe(layer, keyframe);
  if (!next) return false;
  const target = next.elements.find((e) => e.id === element.id);
  if (!target) return false;
  return !matrixEquals(element.matrix, target.matrix);
}
