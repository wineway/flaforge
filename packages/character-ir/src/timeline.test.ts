import { describe, expect, it } from "vitest";
import type { ElementIR, FrameIR, LayerIR, ProjectIR, TimelineIR } from "./types.js";
import { IR_VERSION } from "./types.js";
import {
  activeKeyframe,
  evaluateLayerFrame,
  evaluateTimelineFrame,
  resolveGraphicFrame,
  resolveMovieclipFrame,
  wrapTimelineFrame,
} from "./timeline.js";
import { validateProjectIR } from "./validate.js";

const element = (override: Partial<ElementIR> = {}): ElementIR => ({
  id: "e:1",
  kind: "instance",
  matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
  characterId: "symbol:x",
  startFrame: 0,
  ...override,
});

const frame = (index: number, duration: number, elements: ElementIR[], tween?: FrameIR["tween"]): FrameIR => ({
  index,
  duration,
  elements,
  ...(tween ? { tween } : {}),
});

function makeTimeline(): TimelineIR {
  const layer: LayerIR = {
    index: 0,
    name: "L",
    type: "normal",
    visible: true,
    frames: [
      frame(0, 10, [element({ matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 } })], {
        type: "motion",
        toFrame: 10,
        acceleration: 0,
        rotate: "auto",
        rotateTimes: 0,
      }),
      frame(10, 5, [element({ matrix: { a: 1, b: 0, c: 0, d: 1, tx: 100, ty: 50 } })]),
    ],
  };
  return { id: "t", name: "T", frameCount: 15, layers: [layer], labels: [] };
}

describe("timeline evaluation", () => {
  it("finds the active keyframe", () => {
    const timeline = makeTimeline();
    expect(activeKeyframe(timeline.layers[0]!, 0)?.index).toBe(0);
    expect(activeKeyframe(timeline.layers[0]!, 9)?.index).toBe(0);
    expect(activeKeyframe(timeline.layers[0]!, 10)?.index).toBe(10);
    expect(activeKeyframe(timeline.layers[0]!, 20)).toBeUndefined();
  });

  it("interpolates a motion tween and keeps element identity", () => {
    const timeline = makeTimeline();
    const resolved = evaluateLayerFrame(timeline.layers[0]!, 5)!;
    expect(resolved.keyframeIndex).toBe(0);
    expect(resolved.tweenProgress).toBeCloseTo(0.5);
    expect(resolved.elements[0]!.id).toBe("e:1");
    expect(resolved.elements[0]!.resolvedMatrix.tx).toBeCloseTo(50);
    expect(resolved.elements[0]!.resolvedMatrix.ty).toBeCloseTo(25);
  });

  it("evaluates all layers", () => {
    const timeline = makeTimeline();
    const evaluated = evaluateTimelineFrame(timeline, 10);
    expect(evaluated.length).toBe(1);
    expect(evaluated[0]!.frame?.elements[0]!.resolvedMatrix.tx).toBe(100);
  });

  it("returns null outside the timeline", () => {
    const timeline = makeTimeline();
    expect(evaluateLayerFrame(timeline.layers[0]!, 99)).toBeNull();
  });

  it("wraps preview frames past the timeline length", () => {
    const timeline = makeTimeline();
    expect(wrapTimelineFrame(timeline, 0)).toBe(0);
    expect(wrapTimelineFrame(timeline, 15)).toBe(0);
    expect(wrapTimelineFrame(timeline, 17)).toBe(2);
    expect(wrapTimelineFrame(timeline, -1)).toBe(14);
    const single = { ...timeline, frameCount: 1 };
    expect(wrapTimelineFrame(single, 5)).toBe(0);
  });
});

describe("graphic / movieclip frame resolution", () => {
  it("loops a graphic child relative to its placement frame", () => {
    expect(
      resolveGraphicFrame({
        parentFrame: 29,
        instanceStartFrame: 0,
        firstFrame: 0,
        loopMode: "loop",
        childLength: 30,
      }),
    ).toBe(29);
    expect(
      resolveGraphicFrame({
        parentFrame: 35,
        instanceStartFrame: 0,
        firstFrame: 0,
        loopMode: "loop",
        childLength: 30,
      }),
    ).toBe(5);
  });

  it("clamps play-once and freezes single-frame symbols", () => {
    expect(
      resolveGraphicFrame({
        parentFrame: 40,
        instanceStartFrame: 0,
        loopMode: "play once",
        childLength: 30,
      }),
    ).toBe(29);
    expect(
      resolveGraphicFrame({
        parentFrame: 40,
        instanceStartFrame: 0,
        firstFrame: 7,
        loopMode: "single frame",
        childLength: 30,
      }),
    ).toBe(7);
  });

  it("uses an independent movieclip clock", () => {
    expect(
      resolveMovieclipFrame({ globalFrame: 31, instanceStartFrame: 0, childLength: 30 }),
    ).toBe(1);
  });
});

describe("IR validation", () => {
  it("accepts a minimal project", () => {
    const project: ProjectIR = {
      irVersion: IR_VERSION,
      meta: { source: "test", generator: "test", generatedAt: "2026-01-01T00:00:00.000Z" },
      stage: { width: 100, height: 100, frameRate: 24 },
      library: {},
      shapes: {},
      scenes: [{ id: "scene:0", name: "S", frameCount: 1, timeline: { id: "t", name: "T", frameCount: 1, layers: [], labels: [] } }],
      assets: [],
      diagnostics: [],
    };
    const result = validateProjectIR(project);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects non-finite matrices and bad fill indices", () => {
    const project: ProjectIR = {
      irVersion: IR_VERSION,
      meta: { source: "test", generator: "test", generatedAt: "2026-01-01T00:00:00.000Z" },
      stage: { width: 100, height: 100, frameRate: 24 },
      library: {},
      shapes: {
        "shape:x": {
          id: "shape:x",
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          fills: [],
          strokes: [],
          regions: [
            {
              fill: 3,
              outer: { start: { x: 0, y: 0 }, closed: true, segments: [{ k: "L", to: { x: Number.NaN, y: 1 } }] },
              holes: [],
            },
          ],
          strokePaths: [],
        },
      },
      scenes: [],
      assets: [],
      diagnostics: [],
    };
    const result = validateProjectIR(project);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes("out of range"))).toBe(true);
    expect(result.errors.some((error) => error.includes("not finite"))).toBe(true);
  });
});
