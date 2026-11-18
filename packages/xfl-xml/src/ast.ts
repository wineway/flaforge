/** Typed XFL AST. This layer only turns XML into typed objects; semantics live in the compiler. */

export interface XmlNode {
  /** Local element name (namespace prefix stripped). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Direct text/CDATA content, concatenated and trimmed. */
  text: string;
}

export interface XflMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface XflPoint {
  x: number;
  y: number;
}

export interface XflColor {
  color: string;
  alpha: number;
}

export interface XflGradientEntry extends XflColor {
  ratio: number;
}

export interface XflGradientAst {
  kind: "linear" | "radial";
  entries: XflGradientEntry[];
  matrix: XflMatrix;
  focalPointRatio: number;
  spreadMethod: "pad" | "reflect" | "repeat";
  interpolationMethod: "rgb" | "linearRGB";
  raw: XmlNode;
}

export type XflFillAst =
  | { kind: "solid"; color: string; alpha: number; index: number; raw: XmlNode }
  | ({ kind: "linear-gradient" | "radial-gradient"; index: number; gradient: XflGradientAst; raw: XmlNode })
  | {
      kind: "bitmap";
      index: number;
      bitmapPath?: string;
      clipped: boolean;
      matrix: XflMatrix;
      repeat: boolean;
      smooth: boolean;
      raw: XmlNode;
    }
  | { kind: "unknown"; index: number; name: string; raw: XmlNode };

export interface XflWidthMarkerAst {
  position: number;
  left: number;
  right: number;
  type?: string;
}

export interface XflStrokeAst {
  kind: "solid" | "dashed" | "dotted" | "ragged" | "hatched" | "unsupported";
  index: number;
  weight: number;
  scaleMode: "normal" | "none" | "horizontal" | "vertical";
  caps: "none" | "round" | "square";
  joints: "round" | "bevel" | "miter";
  miterLimit: number;
  pixelHinting: boolean;
  fill?: XflFillAst;
  variableWidth?: { markers: XflWidthMarkerAst[]; raw: XmlNode };
  raw: XmlNode;
}

export interface XflEdgeAst {
  fillStyle0?: number;
  fillStyle1?: number;
  strokeStyle?: number;
  edges?: string;
  cubics?: string;
}

export interface XflFilterAst {
  kind:
    | "glow"
    | "blur"
    | "drop-shadow"
    | "bevel"
    | "adjust-color"
    | "gradient-glow"
    | "gradient-bevel"
    | "color-matrix"
    | "unknown";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  raw: XmlNode;
}

export interface XflShapeAst {
  kind: "shape";
  fills: XflFillAst[];
  strokes: XflStrokeAst[];
  edges: XflEdgeAst[];
  matrix?: XflMatrix;
  raw: XmlNode;
}

export interface XflGroupAst {
  kind: "group";
  members: XflElementAst[];
  matrix?: XflMatrix;
  pivot?: XflPoint;
  name?: string;
  unknown?: XmlNode[];
  raw: XmlNode;
}

export interface XflSymbolInstanceAst {
  kind: "instance";
  libraryItemName: string;
  symbolType?: "graphic" | "movieclip" | "button";
  loop?: "loop" | "play once" | "single frame";
  firstFrame?: number;
  name?: string;
  matrix: XflMatrix;
  pivot?: XflPoint;
  colorTransform?: XflColorTransformAst;
  blendMode?: string;
  cacheAsBitmap?: boolean;
  visible?: boolean;
  filters?: XflFilterAst[];
  /** Present on Animate rig frames; P0 ignores it (see plan §5.7). */
  rigPropagationMatrix?: string;
  unknown?: XmlNode[];
  raw: XmlNode;
}

export interface XflColorTransformAst {
  redMultiplier?: number;
  greenMultiplier?: number;
  blueMultiplier?: number;
  alphaMultiplier?: number;
  redOffset?: number;
  greenOffset?: number;
  blueOffset?: number;
  alphaOffset?: number;
  raw: XmlNode;
}

export interface XflBitmapInstanceAst {
  kind: "bitmap-instance";
  libraryItemName: string;
  matrix: XflMatrix;
  pivot?: XflPoint;
  name?: string;
  filters?: XflFilterAst[];
  colorTransform?: XflColorTransformAst;
  blendMode?: string;
  visible?: boolean;
  raw: XmlNode;
}

export interface XflTextAst {
  kind: "text" | "dynamic-text" | "input-text";
  text: string;
  width?: number;
  height?: number;
  matrix: XflMatrix;
  pivot?: XflPoint;
  name?: string;
  attrs: Record<string, string>;
  raw: XmlNode;
}

export interface XflMorphShapeAst {
  kind: "morph-shape";
  matrix?: XflMatrix;
  raw: XmlNode;
}

export interface XflUnknownElementAst {
  kind: "unknown";
  name: string;
  raw: XmlNode;
}

export type XflElementAst =
  | XflShapeAst
  | XflGroupAst
  | XflSymbolInstanceAst
  | XflBitmapInstanceAst
  | XflTextAst
  | XflMorphShapeAst
  | XflUnknownElementAst;

export interface XflFrameAst {
  index: number;
  duration: number;
  tweenType?: string;
  motionTweenSnap?: boolean;
  keyMode?: number;
  acceleration?: number;
  motionTweenRotate?: string;
  motionTweenRotateTimes?: number;
  elements: XflElementAst[];
  filters?: XflFilterAst[];
  colorTransform?: XflColorTransformAst;
  label?: string;
  sound?: XmlNode[];
  script?: string;
  name?: string;
  rigPropagationMatrix?: string;
  /** Animate layer-rigging parent (frame-level rig parent). */
  parentLayerIndex?: number;
  /** Frame-level blend mode applied to the layer content. */
  blendMode?: string;
  raw: XmlNode;
}

export interface XflLayerAst {
  index: number;
  name: string;
  color?: string;
  layerType?: string;
  parentLayerIndex?: number;
  /** Animate layer-rigging id (per layer). */
  layerRiggingIndex?: number;
  visible: boolean;
  frames: XflFrameAst[];
  raw: XmlNode;
}

export interface XflTimelineAst {
  name: string;
  currentFrame?: number;
  layerDepthEnabled?: boolean;
  layers: XflLayerAst[];
  raw: XmlNode;
}

export interface XflWarning {
  code: string;
  message: string;
  path?: string;
}

export interface XflSymbolAst {
  name: string;
  itemID?: string;
  symbolType: "graphic" | "movieclip" | "button";
  linkage?: { exportName?: string; className?: string };
  timeline?: XflTimelineAst;
  warnings?: XflWarning[];
  raw: XmlNode;
}

export interface XflIncludeAst {
  href: string;
  itemID?: string;
  itemIcon?: string;
  lastModified?: string;
}

export interface XflMediaAst {
  kind: "bitmap" | "sound" | "font" | "video" | "unknown";
  name: string;
  itemID?: string;
  href?: string;
  path?: string;
  sourceExternalFilepath?: string;
  attrs: Record<string, string>;
  raw: XmlNode;
}

export interface XflDocumentAst {
  width: number;
  height: number;
  frameRate: number;
  backgroundColor?: string;
  xflVersion?: string;
  creatorInfo?: string;
  currentTimeline?: string;
  symbols: XflIncludeAst[];
  timelines: XflTimelineAst[];
  media: XflMediaAst[];
  scripts?: string;
  raw: XmlNode;
}
