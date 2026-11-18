/**
 * Character IR — engine-agnostic, versioned, serializable.
 *
 * Conventions:
 *  - All coordinates are CSS pixels (XFL twips have already been /20 by the compiler).
 *  - Matrices are XFL/SWF style: x' = a*x + c*y + tx, y' = b*x + d*y + ty.
 *  - Fill/stroke indices inside ShapeIR are 0-based; -1 means "none".
 *  - Timeline frame indices are 0-based.
 */

export const IR_VERSION = "1.0" as const;
export type IRVersion = typeof IR_VERSION;

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MatrixIR {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY_MATRIX: Readonly<MatrixIR> = Object.freeze({
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  tx: 0,
  ty: 0,
});

export interface ColorTransformIR {
  redMultiplier: number;
  greenMultiplier: number;
  blueMultiplier: number;
  alphaMultiplier: number;
  redOffset: number;
  greenOffset: number;
  blueOffset: number;
  alphaOffset: number;
}

export type BlendModeIR =
  | "normal"
  | "add"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity"
  | "layer"
  | "alpha"
  | "erase"
  | "invert";

export interface GradientEntryIR {
  /** #RRGGBB */
  color: string;
  alpha: number;
  /** 0..1 */
  ratio: number;
}

export type SpreadMethodIR = "pad" | "reflect" | "repeat";
export type InterpolationMethodIR = "rgb" | "linearRGB";

export interface SolidFillIR {
  kind: "solid";
  color: string;
  alpha: number;
}

export interface LinearGradientFillIR {
  kind: "linear-gradient";
  entries: GradientEntryIR[];
  /** XFL gradient matrix (source space ±819.2 px -> shape local px). */
  matrix: MatrixIR;
  spreadMethod: SpreadMethodIR;
  interpolationMethod: InterpolationMethodIR;
}

export interface RadialGradientFillIR {
  kind: "radial-gradient";
  entries: GradientEntryIR[];
  matrix: MatrixIR;
  /** -1..1; 0 = concentric. */
  focalPointRatio: number;
  spreadMethod: SpreadMethodIR;
  interpolationMethod: InterpolationMethodIR;
}

export interface BitmapFillIR {
  kind: "bitmap";
  assetId: string;
  matrix: MatrixIR;
  repeat: boolean;
  smooth: boolean;
  /** True when XFL says the bitmap fill is clipped. */
  clipped: boolean;
}

export type FillStyleIR =
  | SolidFillIR
  | LinearGradientFillIR
  | RadialGradientFillIR
  | BitmapFillIR;

export type StrokeKindIR =
  | "solid"
  | "dashed"
  | "dotted"
  | "ragged"
  | "hatched"
  | "unsupported";

export interface WidthMarkerIR {
  /** 0..1 along the stroke path. */
  position: number;
  /** Fraction of `weight` offset to the left of the path direction. */
  left: number;
  /** Fraction of `weight` offset to the right of the path direction. */
  right: number;
  type?: string;
}

export interface StrokeStyleIR {
  kind: StrokeKindIR;
  /** Solid stroke color; absent for gradient/pattern stroke fills. */
  color?: string;
  alpha?: number;
  /** Stroke fill for gradient/pattern strokes (P1). */
  fill?: FillStyleIR;
  width: number;
  cap: "none" | "round" | "square";
  join: "round" | "bevel" | "miter";
  miterLimit: number;
  scaleMode: "normal" | "none" | "horizontal" | "vertical";
  pixelHinting?: boolean;
  variableWidth?: { markers: WidthMarkerIR[] };
}

export interface LineSegmentIR {
  k: "L";
  to: Vec2;
}

export interface QuadSegmentIR {
  k: "Q";
  c: Vec2;
  to: Vec2;
}

export interface CubicSegmentIR {
  k: "C";
  c1: Vec2;
  c2: Vec2;
  to: Vec2;
}

export type SegmentIR = LineSegmentIR | QuadSegmentIR | CubicSegmentIR;

export interface ContourIR {
  start: Vec2;
  segments: SegmentIR[];
  closed: boolean;
}

export interface FillRegionIR {
  /** Index into ShapeIR.fills, -1 when the region is only a variable-width stroke outline. */
  fill: number;
  outer: ContourIR;
  holes: ContourIR[];
}

export interface StrokePathIR {
  /** Index into ShapeIR.strokes. */
  stroke: number;
  start: Vec2;
  segments: SegmentIR[];
  closed: boolean;
}

export interface ShapeIR {
  /** Content hash; stable across frames and instances. */
  id: string;
  /** Shape-local bounds, before any instance transform. */
  bounds: Rect;
  fills: FillStyleIR[];
  strokes: StrokeStyleIR[];
  regions: FillRegionIR[];
  strokePaths: StrokePathIR[];
}

export type FilterIR =
  | { kind: "glow"; color: string; alpha: number; blurX: number; blurY: number; strength: number; inner: boolean; knockout: boolean; quality: number; approximate: boolean }
  | { kind: "blur"; blurX: number; blurY: number; quality: number; approximate: boolean }
  | { kind: "drop-shadow"; color: string; alpha: number; blurX: number; blurY: number; distance: number; angle: number; strength: number; inner: boolean; knockout: boolean; quality: number; hideObject: boolean; approximate: boolean }
  | { kind: "bevel"; blurX: number; blurY: number; distance: number; angle: number; strength: number; quality: number; highlightColor: string; shadowColor: string; approximate: boolean }
  | { kind: "adjust-color"; colorMatrix: number[]; approximate: boolean }
  | { kind: "unsupported"; name: string; approximate: true };

export interface TextIR {
  kind: "static" | "dynamic" | "input";
  text: string;
  width?: number;
  height?: number;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  align?: string;
  raw?: unknown;
}

export type LoopModeIR = "loop" | "play once" | "single frame";

export interface SoundEventIR {
  assetId?: string;
  event: string;
  raw?: unknown;
}

export interface ElementIR {
  /** Stable across frames; used for tween instance-run matching and backend reuse. */
  id: string;
  kind: "instance" | "shape" | "group" | "bitmap" | "text";
  /** local -> parent (XFL-style matrix). */
  matrix: MatrixIR;
  /** transformationPoint; metadata only. Static rendering never applies it again. */
  pivot?: Vec2;
  colorTransform?: ColorTransformIR;
  blendMode?: BlendModeIR;
  filters?: FilterIR[];
  visible?: boolean;
  cacheAsBitmap?: boolean;
  /** instance */
  characterId?: string;
  firstFrame?: number;
  loopMode?: LoopModeIR;
  /** Timeline keyframe index where this instance was placed (graphic sync). */
  startFrame?: number;
  /** Shape */
  shapeId?: string;
  /** bitmap/text */
  assetId?: string;
  text?: TextIR;
  /** Preserved metadata; P0 never applies rig propagation. */
  rigPropagationMatrix?: string;
}

export interface TweenIR {
  type: "motion" | "shape";
  /** Keyframe index of the tween end. */
  toFrame: number;
  /** XFL acceleration (-100..100). */
  acceleration?: number;
  rotate?: "auto" | "clockwise" | "counter-clockwise";
  rotateTimes?: number;
  /** True when the compiler had to approximate the interpolation. */
  approximate?: boolean;
}

export interface FrameIR {
  index: number;
  /** Covers [index, index + duration). */
  duration: number;
  elements: ElementIR[];
  tween?: TweenIR;
  filters?: FilterIR[];
  colorTransform?: ColorTransformIR;
  label?: string;
  sound?: SoundEventIR[];
  /** Raw ActionScript, preserved but never executed. */
  script?: string;
  /** XFL rig cache on the keyframe; P0 never applies it. */
  rigPropagationMatrix?: string;
  /** XFL frame-level layer-rigging parent index (same order as XFL layers). */
  parentIndex?: number;
  /** XFL frame-level blend mode for this layer's content. */
  blendMode?: BlendModeIR;
}

export type LayerTypeIR = "normal" | "folder" | "mask" | "guide";

export interface LayerIR {
  /** 0-based index in the XFL <layers> list. */
  index: number;
  name: string;
  type: LayerTypeIR;
  visible: boolean;
  /** XFL DOMLayer parentLayerIndex for folders/masks/guides. */
  parentIndex?: number;
  /** XFL layerRiggingIndex (Animate layer-rigging id), metadata only. */
  riggingIndex?: number;
  /** Keyframes sorted by index. */
  frames: FrameIR[];
  color?: string;
}

export interface TimelineIR {
  id: string;
  name: string;
  frameCount: number;
  /** Draw order: bottom -> top (the backend adds children in this order). */
  layers: LayerIR[];
  labels: { name: string; frame: number }[];
}

export interface SymbolCharacterIR {
  kind: "symbol";
  id: string;
  name: string;
  symbolType: "graphic" | "movieclip" | "button";
  timeline: TimelineIR;
  /** Union bounds of the symbol's timeline, in symbol-local pixels. */
  bounds: Rect;
  linkage?: { exportName?: string; className?: string };
}

export interface BitmapCharacterIR {
  kind: "bitmap";
  id: string;
  name: string;
  assetId: string;
  width: number;
  height: number;
}

export interface TextCharacterIR {
  kind: "text";
  id: string;
  name: string;
  text: TextIR;
}

export interface SoundCharacterIR {
  kind: "sound";
  id: string;
  name: string;
  assetId: string;
}

export type CharacterIR =
  | SymbolCharacterIR
  | BitmapCharacterIR
  | TextCharacterIR
  | SoundCharacterIR;

export interface SceneIR {
  id: string;
  name: string;
  frameCount: number;
  timeline: TimelineIR;
}

export interface AssetIR {
  id: string;
  kind: "bitmap" | "sound" | "font" | "video";
  name: string;
  /** Container path (XFL href) when available. */
  path?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  /** Base64 encoded bytes when the compiler was asked to embed assets. */
  data?: string;
}

export type DiagnosticLevel = "info" | "warn" | "error";

export interface Diagnostic {
  level: DiagnosticLevel;
  code: string;
  message: string;
  /** XFL / IR path such as "DOMDocument.timelines[0].layers[2].frames[0]". */
  path?: string;
  detail?: Record<string, unknown>;
}

export interface ProjectMetaIR {
  source: string;
  xflVersion?: string;
  creator?: string;
  generator: string;
  generatedAt: string;
}

export interface StageIR {
  width: number;
  height: number;
  frameRate: number;
  /** #RRGGBB; absent means transparent. */
  backgroundColor?: string;
}

export interface ProjectIR {
  irVersion: IRVersion;
  meta: ProjectMetaIR;
  stage: StageIR;
  /** Keyed by character id (`symbol:<itemID>`, `bitmap:<name>`, ...). */
  library: Record<string, CharacterIR>;
  /** Keyed by content hash (`shape:<sha1>`). */
  shapes: Record<string, ShapeIR>;
  scenes: SceneIR[];
  assets: AssetIR[];
  diagnostics: Diagnostic[];
}

export interface ResolvedElementIR extends ElementIR {
  /**
   * For tweened elements this is the interpolated local matrix. For untweened
   * elements it equals `matrix`.
   */
  resolvedMatrix: MatrixIR;
}

export interface ResolvedFrameIR {
  index: number;
  /** Keyframe actually used (may be < index when the frame is tweened). */
  keyframeIndex: number;
  duration: number;
  elements: ResolvedElementIR[];
  tweenProgress?: number;
  filters?: FilterIR[];
  colorTransform?: ColorTransformIR;
  label?: string;
  blendMode?: BlendModeIR;
}
