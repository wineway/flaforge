import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contourArea, contourPoints, evaluateLayerFrame, type FrameIR, type ProjectIR } from "@flaforge/ir";
import { parseXflSymbolXml } from "@flaforge/xml";
import {
  characterToSvg,
  applyRigParenting,
  compileShape,
  compileTimeline,
  computeSymbolBounds,
  createGeometryStats,
  decodeBitmapDat,
  DiagnosticSink,
  preserveTweenStartFrames,
  compileXfl,
} from "./index.js";

const basicShapePath = resolve(process.cwd(), "fixtures/semantics/basic-shape.xfl");
const variableWidthPath = resolve(process.cwd(), "fixtures/semantics/variable-width.xfl");
const motionTweenPath = resolve(process.cwd(), "fixtures/semantics/motion-tween.xfl");
const bitmapDataPath = resolve(process.cwd(), "fixtures/semantics/bitmap-data.xfl");

function shapeXml(shapeBody: string): string {
  return `<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Test" itemID="test" symbolType="graphic">
    <timeline><DOMTimeline name="Test"><layers><DOMLayer name="L"><frames><DOMFrame index="0"><elements>
      <DOMShape>${shapeBody}</DOMShape>
    </elements></DOMFrame></frames></DOMLayer></layers></DOMTimeline></timeline>
  </DOMSymbolItem>`;
}

function compileFirstShape(shapeBody: string) {
  const symbol = parseXflSymbolXml(shapeXml(shapeBody));
  const element = symbol.timeline!.layers[0]!.frames[0]!.elements[0]!;
  if (element.kind !== "shape") throw new Error("not a shape");
  const sink = new DiagnosticSink();
  const stats = createGeometryStats();
  const shape = compileShape(element, sink, "test", stats);
  return { shape, sink, stats };
}

describe("semantic fixtures", () => {
  it("compiles an unpacked .xfl directory", async () => {
    const { project } = await compileXfl(basicShapePath, { generatedAt: "2026-01-01T00:00:00.000Z" });
    const shapeCharacter = Object.values(project.library).find(
      (character) => character.kind === "symbol" && character.name === "Shape",
    );
    expect(shapeCharacter?.kind).toBe("symbol");
    const shape = Object.values(project.shapes)[0]!;
    expect(shape.regions.length).toBe(1);
    expect(shape.strokePaths.length).toBe(1);
    expect(shape.fills[0]?.kind).toBe("solid");
    const sceneFrame = project.scenes[0]!.timeline.layers[0]!.frames[0]!;
    const instance = sceneFrame.elements[0]!;
    expect(instance.kind).toBe("instance");
    expect(instance.matrix).toMatchObject({ tx: 10, ty: 20 });
  });

  it("converts VariablePointWidth strokes to filled outlines", async () => {
    const { project } = await compileXfl(variableWidthPath, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const shape = Object.values(project.shapes).find((candidate) =>
      candidate.regions.some((region) => region.fill >= 0),
    );
    expect(shape).toBeDefined();
    if (!shape) return;
    expect(shape.strokePaths.length).toBe(0);
    expect(shape.regions.length).toBe(1);
    expect(shape.strokes[0]!.variableWidth?.markers.length).toBe(2);
    expect(shape.bounds.width).toBeGreaterThan(40);
    expect(shape.bounds.width).toBeLessThan(60);
    expect(shape.bounds.height).toBeGreaterThan(2);
    expect(shape.bounds.height).toBeLessThan(6);
  });

  it("resolves embedded bitmap data blobs and their twip dimensions", async () => {
    const { project } = await compileXfl(bitmapDataPath, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const asset = project.assets.find((item) => item.kind === "bitmap");
    expect(asset).toBeDefined();
    expect(asset?.path).toBe("bin/M 1.fixture.dat");
    expect(asset?.width).toBe(10);
    expect(asset?.height).toBe(5);
    const bitmap = Object.values(project.library).find((item) => item.kind === "bitmap");
    expect(bitmap).toMatchObject({ kind: "bitmap", width: 10, height: 5 });
    const faceSymbol = Object.values(project.library).find(
      (item) => item.kind === "symbol" && item.name === "FaceSymbol",
    );
    expect(faceSymbol?.kind).toBe("symbol");
    if (faceSymbol?.kind === "symbol") {
      expect(faceSymbol.bounds.width).toBe(10);
      expect(faceSymbol.bounds.height).toBe(5);
    }
    expect(project.diagnostics.some((d) => d.code === "BITMAP_DAT_DECODED")).toBe(true);
    expect(asset?.data).toBeDefined();
    const pngBytes = Buffer.from(asset!.data!, "base64");
    expect([...pngBytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const datBytes = new Uint8Array(
      await readFile(
        resolve(process.cwd(), "fixtures/semantics/bitmap-data.xfl/bin/M 1.fixture.dat"),
      ),
    );
    const decoded = decodeBitmapDat(datBytes);
    expect(decoded?.width).toBe(10);
    expect(decoded?.height).toBe(5);
    expect(decoded?.pixels.length).toBe(10 * 5 * 4);
    // Premultiplied ARGB: transparent -> white/alpha0; 64/alpha128 -> 128.
    expect([...decoded!.pixels.subarray(0, 4)]).toEqual([255, 255, 255, 0]);
    expect([...decoded!.pixels.subarray(4, 8)]).toEqual([128, 128, 128, 128]);
  });

  it("compiles a classic motion tween and interpolates the right element", async () => {
    const { project } = await compileXfl(motionTweenPath, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const dot = Object.values(project.library).find(
      (character) => character.kind === "symbol" && character.name === "Dot",
    );
    expect(dot?.kind).toBe("symbol");
    if (dot?.kind !== "symbol") return;
    expect(dot.timeline.frameCount).toBe(11);
    const frame5 = evaluateLayerFrame(dot.timeline.layers[0]!, 5)!;
    expect(frame5.elements.length).toBe(1);
    expect(frame5.elements[0]!.resolvedMatrix.tx).toBeCloseTo(50);
    expect(frame5.elements[0]!.resolvedMatrix.ty).toBeCloseTo(25);
    const frame10 = evaluateLayerFrame(dot.timeline.layers[0]!, 10)!;
    expect(frame10.elements[0]!.resolvedMatrix.tx).toBeCloseTo(100);
    expect(frame10.elements[0]!.id).toBe(frame5.elements[0]!.id);
  });
});

describe("shape geometry", () => {
  it("rebuilds a simple filled square and a stroke path", () => {
    const { shape } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <strokes><StrokeStyle index="1"><SolidStroke weight="2"><fill><SolidColor color="#000000"/></fill></SolidStroke></StrokeStyle></strokes>
      <edges><Edge fillStyle1="1" strokeStyle="1" edges="!0 0|200 0|200 200|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    expect(shape!.regions.length).toBe(1);
    expect(shape!.fills[0]).toMatchObject({ kind: "solid", color: "#ff0000", alpha: 1 });
    expect(shape!.strokePaths.length).toBe(1);
    expect(shape!.strokePaths[0]!.closed).toBe(true);
    expect(contourArea(shape!.regions[0]!.outer)).toBeGreaterThan(0);
    expect(shape!.bounds.width).toBeCloseTo(12);
    expect(shape!.bounds.height).toBeCloseTo(12);
  });

  it("assigns a hole to its outer contour", () => {
    const { shape } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#00FF00"/></FillStyle></fills>
      <edges>
        <Edge fillStyle1="1" edges="!0 0|200 0|200 200|0 200|0 0"/>
        <Edge fillStyle0="1" edges="!50 50|150 50|150 150|50 150|50 50"/>
      </edges>
    `);
    expect(shape).not.toBeNull();
    expect(shape!.regions.length).toBe(1);
    expect(shape!.regions[0]!.holes.length).toBe(1);
    expect(contourArea(shape!.regions[0]!.outer)).toBeGreaterThan(0);
    expect(contourArea(shape!.regions[0]!.holes[0]!)).toBeLessThan(0);
  });

  it("decodes negative JPEXS hex coordinates instead of treating them as huge", () => {
    const { shape } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!0 0|#FFFFE3.19 0|0 100|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    expect(shape!.bounds.width).toBeLessThan(10);
    expect(shape!.bounds.x).toBeLessThan(0);
  });

  it("fits a default gradient when the XFL gradient matrix has zero scale", () => {
    const { shape, sink } = compileFirstShape(`
      <fills>
        <FillStyle index="1">
          <LinearGradient spreadMethod="reflect">
            <matrix><Matrix a="0" d="0" tx="-60.4" ty="-87.55"/></matrix>
            <GradientEntry color="#44494F" ratio="0"/>
            <GradientEntry color="#353A40" ratio="1"/>
          </LinearGradient>
        </FillStyle>
      </fills>
      <edges><Edge fillStyle1="1" edges="!0 0|200 0|200 200|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    const fill = shape!.fills[0];
    expect(fill?.kind).toBe("linear-gradient");
    if (fill?.kind === "linear-gradient") {
      expect(Math.abs(fill.matrix.b)).toBeGreaterThan(0);
      expect(fill.matrix.tx).toBeCloseTo(5);
      expect(fill.matrix.ty).toBeCloseTo(5);
    }
    expect(sink.diagnostics.some((d) => d.code === "GRADIENT_MATRIX_DEGENERATE")).toBe(true);
  });

  it("ignores S<n> subpath markers and records them", () => {
    const { shape, stats } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!0 0S5|200 0|200 200|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    expect(stats.subpathMarkers).toBe(1);
  });

  it("treats a 2-number '/' edge command as lineTo (Animate sample-derived)", () => {
    const { shape, sink, stats } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!0 0/200 100|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    expect(stats.lines).toBeGreaterThanOrEqual(2);
    expect(sink.diagnostics.some((d) => d.code === "EDGE_UNKNOWN_COMMAND")).toBe(false);
    expect(sink.diagnostics.some((d) => d.code === "EDGE_SLASH_LINE")).toBe(true);
    expect(
      shape!.regions.some((region) =>
        region.outer.segments.some(
          (segment) => segment.k === "L" && Math.abs(segment.to.x - 10) < 1e-6 && Math.abs(segment.to.y - 5) < 1e-6,
        ),
      ),
    ).toBe(true);
  });

  it("normalizes bitmap-fill matrix scale from twips and keeps translation", () => {
    const { shape } = compileFirstShape(`
      <fills><FillStyle index="1"><BitmapFill bitmapPath="face.png"><matrix><Matrix a="200" d="200" tx="20" ty="30"/></matrix></BitmapFill></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!0 0|200 0|200 200|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    const fill = shape!.fills[0];
    expect(fill?.kind).toBe("bitmap");
    if (fill?.kind === "bitmap") {
      expect(fill.matrix.a).toBeCloseTo(10);
      expect(fill.matrix.d).toBeCloseTo(10);
      expect(fill.matrix.tx).toBeCloseTo(20);
      expect(fill.matrix.ty).toBeCloseTo(30);
      expect(fill.assetId).toContain("face.png");
    }
  });

  it("keeps a quadratic curve in the contour", () => {
    const { shape } = compileFirstShape(`
      <fills><FillStyle index="1"><SolidColor color="#FF0000"/></FillStyle></fills>
      <edges><Edge fillStyle1="1" edges="!0 0[100 0 200 100|0 200|0 0"/></edges>
    `);
    expect(shape).not.toBeNull();
    const hasQuad = shape!.regions.some((region) =>
      region.outer.segments.some((segment) => segment.k === "Q"),
    );
    expect(hasQuad).toBe(true);
    expect(contourPoints(shape!.regions[0]!.outer, 4).length).toBeGreaterThanOrEqual(7);
  });
});

describe("SVG preview frame wrapping", () => {
  it("keeps a one-frame symbol visible past its timeline length", () => {
    const project: ProjectIR = {
      irVersion: "1.0",
      meta: { source: "unit-test", generator: "flaforge", generatedAt: "" },
      stage: { width: 100, height: 100, frameRate: 30 },
      library: {
        "symbol:pose": {
          kind: "symbol",
          id: "symbol:pose",
          name: "Pose",
          symbolType: "graphic",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          timeline: {
            id: "timeline:pose",
            name: "Pose",
            frameCount: 1,
            labels: [],
            layers: [
              {
                index: 0,
                name: "L",
                type: "normal",
                visible: true,
                frames: [
                  {
                    index: 0,
                    duration: 1,
                    elements: [
                      {
                        id: "e:shape",
                        kind: "shape",
                        matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
                        shapeId: "shape:tri",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      shapes: {
        "shape:tri": {
          id: "shape:tri",
          bounds: { x: 0, y: 0, width: 10, height: 10 },
          fills: [{ kind: "solid", color: "#ff0000", alpha: 1 }],
          strokes: [],
          regions: [
            {
              fill: 0,
              outer: {
                start: { x: 0, y: 0 },
                segments: [
                  { k: "L", to: { x: 10, y: 0 } },
                  { k: "L", to: { x: 0, y: 10 } },
                ],
                closed: true,
              },
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
    expect(characterToSvg(project, "symbol:pose", 0)).toContain("<path");
    expect(characterToSvg(project, "symbol:pose", 1)).toContain("<path");
    expect(characterToSvg(project, "symbol:pose", 5)).toContain("<path");
  });
});

describe("motion tween placement frames", () => {
  const instance = (startFrame: number) => ({
    id: "e:1",
    kind: "instance" as const,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    characterId: "symbol:child",
    startFrame,
  });

  it("keeps the start frame at the tween end keyframe", () => {
    const start: FrameIR = {
      index: 0,
      duration: 10,
      elements: [instance(0)],
      tween: { type: "motion", toFrame: 10 },
    };
    const end: FrameIR = { index: 10, duration: 1, elements: [instance(10)] };
    preserveTweenStartFrames([start, end]);
    expect(end.elements[0]!.startFrame).toBe(0);
  });

  it("propagates the original placement through chained tweens", () => {
    const a: FrameIR = {
      index: 0,
      duration: 10,
      elements: [instance(0)],
      tween: { type: "motion", toFrame: 10 },
    };
    const b: FrameIR = {
      index: 10,
      duration: 10,
      elements: [instance(10)],
      tween: { type: "motion", toFrame: 20 },
    };
    const c: FrameIR = { index: 20, duration: 1, elements: [instance(20)] };
    preserveTweenStartFrames([a, b, c]);
    expect(b.elements[0]!.startFrame).toBe(0);
    expect(c.elements[0]!.startFrame).toBe(0);
  });

  it("leaves a non-tween keyframe placement alone", () => {
    const a: FrameIR = { index: 0, duration: 10, elements: [instance(0)] };
    const b: FrameIR = { index: 10, duration: 1, elements: [instance(10)] };
    preserveTweenStartFrames([a, b]);
    expect(b.elements[0]!.startFrame).toBe(10);
  });
});

describe("symbol bounds", () => {
  const shape = (id: string, x: number, y: number, width: number, height: number) => ({
    id,
    bounds: { x, y, width, height },
    fills: [],
    strokes: [],
    regions: [],
    strokePaths: [],
  });
  const shapeElement = (shapeId: string, visible: boolean) => ({
    id: `e:${shapeId}`,
    kind: "shape" as const,
    matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    shapeId,
    visible,
  });

  it("ignores guide, mask, hidden layers and invisible elements", () => {
    const project: ProjectIR = {
      irVersion: "1.0",
      meta: { source: "unit-test", generator: "flaforge", generatedAt: "" },
      stage: { width: 2000, height: 2000, frameRate: 30 },
      library: {
        "symbol:s": {
          kind: "symbol",
          id: "symbol:s",
          name: "S",
          symbolType: "graphic",
          bounds: { x: 0, y: 0, width: 0, height: 0 },
          timeline: {
            id: "timeline:s",
            name: "S",
            frameCount: 1,
            labels: [],
            layers: [
              {
                index: 0,
                name: "art",
                type: "normal",
                visible: true,
                frames: [
                  {
                    index: 0,
                    duration: 1,
                    elements: [shapeElement("shape:art", true), shapeElement("shape:invisible", false)],
                  },
                ],
              },
              {
                index: 1,
                name: "guide",
                type: "guide",
                visible: true,
                frames: [{ index: 0, duration: 1, elements: [shapeElement("shape:guide", true)] }],
              },
              {
                index: 2,
                name: "mask",
                type: "mask",
                visible: true,
                frames: [{ index: 0, duration: 1, elements: [shapeElement("shape:mask", true)] }],
              },
              {
                index: 3,
                name: "hidden",
                type: "normal",
                visible: false,
                frames: [{ index: 0, duration: 1, elements: [shapeElement("shape:hidden", true)] }],
              },
            ],
          },
        },
      },
      shapes: {
        "shape:art": shape("shape:art", 0, 0, 10, 10),
        "shape:invisible": shape("shape:invisible", 2000, 2000, 10, 10),
        "shape:guide": shape("shape:guide", 1000, 1000, 10, 10),
        "shape:mask": shape("shape:mask", 500, 500, 10, 10),
        "shape:hidden": shape("shape:hidden", 800, 800, 10, 10),
      },
      scenes: [],
      assets: [],
      diagnostics: [],
    };

    computeSymbolBounds(project, new DiagnosticSink());
    const symbol = project.library["symbol:s"]!;
    expect(symbol.kind).toBe("symbol");
    if (symbol.kind === "symbol") {
      expect(symbol.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    }
  });
});

describe("layer rigging metadata", () => {
  it("preserves frame parent indexes and layer rigging ids in the IR", () => {
    const symbol = parseXflSymbolXml(`<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Rig" itemID="rig" symbolType="graphic">
      <timeline><DOMTimeline name="Rig"><layers>
        <DOMLayer name="body" layerRiggingIndex="2">
          <frames><DOMFrame index="0" duration="1" parentLayerIndex="1"><elements/></DOMFrame></frames>
        </DOMLayer>
      </layers></DOMTimeline></timeline>
    </DOMSymbolItem>`);
    const sink = new DiagnosticSink();
    const timeline = compileTimeline(
      symbol.timeline!,
      { sink, stats: createGeometryStats(), shapes: {}, characterIdByName: new Map() },
      "symbol(Rig).timeline",
    );
    expect(timeline.layers[0]!.riggingIndex).toBe(2);
    expect(timeline.layers[0]!.frames[0]!.parentIndex).toBe(1);
    expect(sink.diagnostics.some((d) => d.code === "LAYER_RIGGING_APPLIED")).toBe(true);
  });
});


describe("frame blend modes", () => {
  it("carries DOMFrame blendMode into the IR", () => {
    const symbol = parseXflSymbolXml(`<DOMSymbolItem xmlns="http://ns.adobe.com/xfl/2008/" name="Blend" itemID="blend" symbolType="graphic">
      <timeline><DOMTimeline name="Blend"><layers>
        <DOMLayer name="layer">
          <frames><DOMFrame index="0" duration="1" blendMode="overlay"><elements/></DOMFrame></frames>
        </DOMLayer>
      </layers></DOMTimeline></timeline>
    </DOMSymbolItem>`);
    const sink = new DiagnosticSink();
    const timeline = compileTimeline(
      symbol.timeline!,
      { sink, stats: createGeometryStats(), shapes: {}, characterIdByName: new Map() },
      "symbol(Blend).timeline",
    );
    expect(timeline.layers[0]!.frames[0]!.blendMode).toBe("overlay");
  });
});

describe("layer rig parenting", () => {
  const layer = (index: number, name: string, riggingIndex: number | undefined, parentIndex: number | undefined, tx: number, ty: number) => ({
    index,
    name,
    type: "normal" as const,
    visible: true,
    riggingIndex,
    frames: [{
      index: 0,
      duration: 1,
      elements: [{
        id: `e:${name}`,
        kind: "shape" as const,
        matrix: { a: 1, b: 0, c: 0, d: 1, tx, ty },
        shapeId: "shape:test",
      }],
      ...(parentIndex === undefined ? {} : { parentIndex }),
    }],
  });

  it("pre-multiplies the parent world matrix onto children", () => {
    const layers = [
      layer(0, "body", 0, undefined, 10, 20),
      layer(1, "head", undefined, 0, 5, 5),
      layer(2, "hat", 1, 0, 1, 2),
    ];
    applyRigParenting(layers as any, new DiagnosticSink(), "test");
    expect(layers[1]!.frames[0]!.elements[0]!.matrix.tx).toBe(15);
    expect(layers[1]!.frames[0]!.elements[0]!.matrix.ty).toBe(25);
    expect(layers[2]!.frames[0]!.elements[0]!.matrix.tx).toBe(11);
    expect(layers[2]!.frames[0]!.elements[0]!.matrix.ty).toBe(22);
  });

  it("composes a rig chain from the rig ids", () => {
    const layers = [
      layer(0, "body", 0, undefined, 10, 0),
      layer(1, "upper", 1, 0, 5, 0),
      layer(2, "lower", 2, 1, 2, 0),
    ];
    applyRigParenting(layers as any, new DiagnosticSink(), "test");
    expect(layers[1]!.frames[0]!.elements[0]!.matrix.tx).toBe(15);
    expect(layers[2]!.frames[0]!.elements[0]!.matrix.tx).toBe(17);
  });
});
