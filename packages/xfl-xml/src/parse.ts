import type {
  XflColorTransformAst,
  XflWarning,
  XflDocumentAst,
  XflEdgeAst,
  XflElementAst,
  XflFillAst,
  XflFilterAst,
  XflFrameAst,
  XflGradientAst,
  XflGroupAst,
  XflIncludeAst,
  XflLayerAst,
  XflMatrix,
  XflMediaAst,
  XflPoint,
  XflShapeAst,
  XflStrokeAst,
  XflSymbolAst,
  XflSymbolInstanceAst,
  XflTimelineAst,
  XflWidthMarkerAst,
  XmlNode,
} from "./ast.js";
import {
  attr,
  boolAttr,
  findChild,
  findChildren,
  intAttr,
  numAttr,
  parseXml,
  textOf,
} from "./xml.js";

export interface ParsedDocument {
  document: XflDocumentAst;
  warnings: XflWarning[];
}

export interface ParseOptions {
  maxBytes?: number;
  source?: string;
}

const IDENTITY: XflMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

function parseMatrix(node: XmlNode | undefined): XflMatrix {
  if (!node) return { ...IDENTITY };
  const m = node.name === "Matrix" ? node : findChild(node, "Matrix");
  if (!m) return { ...IDENTITY };
  return {
    a: numAttr(m, "a", 1),
    b: numAttr(m, "b", 0),
    c: numAttr(m, "c", 0),
    d: numAttr(m, "d", 1),
    tx: numAttr(m, "tx", 0),
    ty: numAttr(m, "ty", 0),
  };
}

function matrixFromContainer(node: XmlNode | undefined): XflMatrix | undefined {
  if (!node) return undefined;
  const matrix = node.name === "matrix" ? node : findChild(node, "matrix");
  if (!matrix) return undefined;
  const m = findChild(matrix, "Matrix");
  if (!m) return undefined;
  return parseMatrix(m);
}

function parsePivot(node: XmlNode | undefined): XflPoint | undefined {
  if (!node) return undefined;
  const tp = findChild(node, "transformationPoint");
  if (!tp) return undefined;
  const p = findChild(tp, "Point");
  if (!p) return undefined;
  return { x: numAttr(p, "x", 0), y: numAttr(p, "y", 0) };
}

function parseColorTransform(node: XmlNode | undefined): XflColorTransformAst | undefined {
  if (!node) return undefined;
  const color = findChild(node, "color") ?? (node.name === "color" ? node : undefined);
  if (!color) return undefined;
  const c = findChild(color, "Color") ?? color;
  const pick = (key: string): number | undefined => {
    const raw = c.attrs[key];
    if (raw === undefined) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    redMultiplier: pick("redMultiplier"),
    greenMultiplier: pick("greenMultiplier"),
    blueMultiplier: pick("blueMultiplier"),
    alphaMultiplier: pick("alphaMultiplier"),
    redOffset: pick("redOffset"),
    greenOffset: pick("greenOffset"),
    blueOffset: pick("blueOffset"),
    alphaOffset: pick("alphaOffset"),
    raw: color,
  };
}

function parseColor(node: XmlNode): { color: string; alpha: number } {
  return {
    color: node.attrs.color ?? "#000000",
    alpha: node.attrs.alpha !== undefined ? numAttr(node, "alpha", 1) : 1,
  };
}

function filterKind(name: string): XflFilterAst["kind"] {
  switch (name) {
    case "GlowFilter":
      return "glow";
    case "BlurFilter":
      return "blur";
    case "DropShadowFilter":
      return "drop-shadow";
    case "BevelFilter":
      return "bevel";
    case "AdjustColorFilter":
      return "adjust-color";
    case "GradientGlowFilter":
      return "gradient-glow";
    case "GradientBevelFilter":
      return "gradient-bevel";
    case "ColorMatrixFilter":
      return "color-matrix";
    default:
      return "unknown";
  }
}

export function parseFilterNode(node: XmlNode): XflFilterAst {
  return {
    kind: filterKind(node.name),
    name: node.name,
    attrs: { ...node.attrs },
    children: node.children,
    raw: node,
  };
}

function parseFilters(node: XmlNode | undefined): XflFilterAst[] | undefined {
  if (!node) return undefined;
  const container =
    node.name === "filters" || node.name === "frameFilters"
      ? node
      : findChild(node, "filters") ?? findChild(node, "frameFilters");
  if (!container) return undefined;
  const filters = container.children
    .filter((child) => child.name.endsWith("Filter"))
    .map(parseFilterNode);
  return filters.length > 0 ? filters : undefined;
}

function parseGradient(node: XmlNode, kind: "linear" | "radial"): XflGradientAst {
  const matrixNode = findChild(node, "matrix");
  const entries = findChildren(node, "GradientEntry").map((entry) => {
    const c = parseColor(entry);
    return { ...c, ratio: numAttr(entry, "ratio", 0) };
  });
  const spread = node.attrs.spreadMethod;
  const interpolation = node.attrs.interpolationMethod;
  return {
    kind,
    entries,
    matrix: parseMatrix(matrixNode),
    focalPointRatio: numAttr(node, "focalPointRatio", 0),
    spreadMethod:
      spread === "reflect" || spread === "repeat" ? spread : "pad",
    interpolationMethod: interpolation === "linearRGB" ? "linearRGB" : "rgb",
    raw: node,
  };
}

function parseFillNode(node: XmlNode, index: number): XflFillAst {
  switch (node.name) {
    case "SolidColor": {
      const c = parseColor(node);
      return { kind: "solid", index, color: c.color, alpha: c.alpha, raw: node };
    }
    case "LinearGradient":
      return {
        kind: "linear-gradient",
        index,
        gradient: parseGradient(node, "linear"),
        raw: node,
      };
    case "RadialGradient":
      return {
        kind: "radial-gradient",
        index,
        gradient: parseGradient(node, "radial"),
        raw: node,
      };
    case "BitmapFill":
      return {
        kind: "bitmap",
        index,
        bitmapPath: node.attrs.bitmapPath ?? node.attrs.bitmapItemName,
        clipped: boolAttr(node, "bitmapIsClipped", false),
        matrix: parseMatrix(findChild(node, "matrix")),
        repeat: true,
        smooth: true,
        raw: node,
      };
    default:
      return { kind: "unknown", index, name: node.name, raw: node };
  }
}

function parseFillStyle(node: XmlNode): XflFillAst {
  const index = intAttr(node, "index", 1);
  const child = node.children.find((c) => c.name !== "matrix") ?? node;
  return parseFillNode(child, index);
}

function parseWidthMarkers(node: XmlNode): XflWidthMarkerAst[] {
  return findChildren(node, "WidthMarker").map((marker) => ({
    position: numAttr(marker, "position", 0),
    left: numAttr(marker, "left", 0.5),
    right: numAttr(marker, "right", 0.5),
    type: marker.attrs.type,
  }));
}

function parseStrokeStyle(node: XmlNode): XflStrokeAst {
  const inner =
    node.children.find((c) => c.name.endsWith("Stroke")) ?? node;
  let kind: XflStrokeAst["kind"] = "unsupported";
  if (inner.name === "SolidStroke") kind = "solid";
  else if (inner.name === "DashedStroke") kind = "dashed";
  else if (inner.name === "DottedStroke") kind = "dotted";
  else if (inner.name === "RaggedStroke") kind = "ragged";
  else if (inner.name === "HatchedStroke") kind = "hatched";

  const fillNode = findChild(inner, "fill");
  const fill = fillNode?.children[0]
    ? parseFillNode(fillNode.children[0], 0)
    : ({ kind: "solid", index: 0, color: "#000000", alpha: 1, raw: inner } as XflFillAst);

  const capsAttr = inner.attrs.caps;
  const jointsAttr = inner.attrs.joints;
  const scaleMode = inner.attrs.scaleMode;

  const variableNode = findChild(inner, "VariablePointWidth");
  return {
    kind,
    index: intAttr(node, "index", 1),
    weight: numAttr(inner, "weight", 1),
    scaleMode:
      scaleMode === "none" || scaleMode === "horizontal" || scaleMode === "vertical"
        ? scaleMode
        : "normal",
    caps:
      capsAttr === "none" || capsAttr === "square" ? capsAttr : "round",
    joints:
      jointsAttr === "bevel" || jointsAttr === "miter" ? jointsAttr : "round",
    miterLimit: numAttr(inner, "miterLimit", 3),
    pixelHinting: boolAttr(inner, "pixelHinting", false),
    fill,
    variableWidth: variableNode
      ? { markers: parseWidthMarkers(variableNode), raw: variableNode }
      : undefined,
    raw: node,
  };
}

function parseShape(node: XmlNode, warnings: XflWarning[], path: string): XflShapeAst {
  const fillsNode = findChild(node, "fills");
  const strokesNode = findChild(node, "strokes");
  const edgesNode = findChild(node, "edges");
  const fills = (fillsNode?.children ?? [])
    .filter((child) => child.name === "FillStyle")
    .map(parseFillStyle);
  const strokes = (strokesNode?.children ?? [])
    .filter((child) => child.name === "StrokeStyle")
    .map(parseStrokeStyle);
  if ((fillsNode?.children ?? []).some((c) => c.name !== "FillStyle")) {
    warnings.push({
      code: "XFL_UNKNOWN_FILL",
      message: "unknown child in <fills>",
      path,
    });
  }
  if ((strokesNode?.children ?? []).some((c) => c.name !== "StrokeStyle")) {
    warnings.push({
      code: "XFL_UNKNOWN_STROKE",
      message: "unknown child in <strokes>",
      path,
    });
  }
  for (const stroke of strokes) {
    if (stroke.kind !== "solid") {
      warnings.push({
        code: "XFL_STROKE_KIND",
        message: `${stroke.kind} stroke is approximated`,
        path,
      });
    }
    if (stroke.fill && stroke.fill.kind !== "solid") {
      warnings.push({
        code: "XFL_STROKE_FILL",
        message: `gradient/bitmap stroke fill is not rendered in P0`,
        path,
      });
    }
  }
  const edges: XflEdgeAst[] = [];
  for (const edgeNode of edgesNode?.children ?? []) {
    if (edgeNode.name !== "Edge") {
      warnings.push({
        code: "XFL_UNKNOWN_EDGE_CHILD",
        message: `unknown <edges> child ${edgeNode.name}`,
        path,
      });
      continue;
    }
    const edge: XflEdgeAst = {
      fillStyle0: edgeNode.attrs.fillStyle0 !== undefined ? intAttr(edgeNode, "fillStyle0", 0) : undefined,
      fillStyle1: edgeNode.attrs.fillStyle1 !== undefined ? intAttr(edgeNode, "fillStyle1", 0) : undefined,
      strokeStyle: edgeNode.attrs.strokeStyle !== undefined ? intAttr(edgeNode, "strokeStyle", 0) : undefined,
      edges: edgeNode.attrs.edges,
      cubics: edgeNode.attrs.cubics,
    };
    if (edge.edges === undefined && edge.cubics === undefined) {
      warnings.push({ code: "XFL_EMPTY_EDGE", message: "Edge has neither edges nor cubics", path });
      continue;
    }
    edges.push(edge);
  }
  return {
    kind: "shape",
    fills,
    strokes,
    edges,
    matrix: matrixFromContainer(node),
    raw: node,
  };
}

function parseGroup(node: XmlNode, warnings: XflWarning[], path: string): XflGroupAst {
  const membersNode = findChild(node, "members");
  const members = (membersNode?.children ?? []).map((child, index) =>
    parseElement(child, warnings, `${path}.members[${index}]`),
  );
  return {
    kind: "group",
    members,
    matrix: matrixFromContainer(node),
    pivot: parsePivot(node),
    name: node.attrs.name,
    raw: node,
  };
}

function parseSymbolInstance(node: XmlNode): XflSymbolInstanceAst {
  const symbolType = node.attrs.symbolType;
  const loop = node.attrs.loop;
  return {
    kind: "instance",
    libraryItemName: node.attrs.libraryItemName ?? "",
    symbolType:
      symbolType === "graphic" || symbolType === "movieclip" || symbolType === "button"
        ? symbolType
        : undefined,
    loop:
      loop === "loop" || loop === "play once" || loop === "single frame"
        ? loop
        : undefined,
    firstFrame: node.attrs.firstFrame !== undefined ? intAttr(node, "firstFrame", 0) : undefined,
    name: node.attrs.name,
    matrix: matrixFromContainer(node) ?? { ...IDENTITY },
    pivot: parsePivot(node),
    colorTransform: parseColorTransform(node),
    blendMode: node.attrs.blendMode,
    cacheAsBitmap: node.attrs.cacheAsBitmap !== undefined ? boolAttr(node, "cacheAsBitmap", false) : undefined,
    visible: node.attrs.visible !== undefined ? boolAttr(node, "visible", true) : undefined,
    filters: parseFilters(node),
    rigPropagationMatrix: node.attrs.rigPropagationMatrix,
    raw: node,
  };
}

function parseTextContent(node: XmlNode): string {
  const runs = findChildren(node, "textRun");
  if (runs.length > 0) {
    return runs
      .map((run) => {
        const characters = findChild(run, "characters");
        return characters ? textOf(characters) : textOf(run);
      })
      .join("");
  }
  const direct = findChild(node, "characters");
  return direct ? textOf(direct) : textOf(node);
}

function parseText(
  node: XmlNode,
  kind: "text" | "dynamic-text" | "input-text",
): XflElementAst {
  return {
    kind,
    text: parseTextContent(node),
    width: node.attrs.width !== undefined ? numAttr(node, "width", 0) : undefined,
    height: node.attrs.height !== undefined ? numAttr(node, "height", 0) : undefined,
    matrix: matrixFromContainer(node) ?? { ...IDENTITY },
    pivot: parsePivot(node),
    name: node.attrs.name,
    attrs: { ...node.attrs },
    raw: node,
  };
}

export function parseElement(
  node: XmlNode,
  warnings: XflWarning[],
  path: string,
): XflElementAst {
  switch (node.name) {
    case "DOMShape":
      return parseShape(node, warnings, path);
    case "DOMGroup":
      return parseGroup(node, warnings, path);
    case "DOMSymbolInstance":
      return parseSymbolInstance(node);
    case "DOMBitmapInstance":
      return {
        kind: "bitmap-instance",
        libraryItemName: node.attrs.libraryItemName ?? "",
        matrix: matrixFromContainer(node) ?? { ...IDENTITY },
        pivot: parsePivot(node),
        name: node.attrs.name,
        filters: parseFilters(node),
        colorTransform: parseColorTransform(node),
        blendMode: node.attrs.blendMode,
        visible: node.attrs.visible !== undefined ? boolAttr(node, "visible", true) : undefined,
        raw: node,
      };
    case "DOMStaticText":
      return parseText(node, "text");
    case "DOMDynamicText":
      return parseText(node, "dynamic-text");
    case "DOMInputText":
      return parseText(node, "input-text");
    case "DOMMorphShape":
      return {
        kind: "morph-shape",
        matrix: matrixFromContainer(node),
        raw: node,
      };
    default:
      warnings.push({
        code: "XFL_UNKNOWN_ELEMENT",
        message: `unsupported element <${node.name}>`,
        path,
      });
      return { kind: "unknown", name: node.name, raw: node };
  }
}

function parseFrame(
  node: XmlNode,
  fallbackIndex: number,
  warnings: XflWarning[],
  path: string,
): XflFrameAst {
  const elementsNode = findChild(node, "elements");
  const elements = (elementsNode?.children ?? []).map((child, index) =>
    parseElement(child, warnings, `${path}.elements[${index}]`),
  );
  let label: string | undefined;
  const labelNode = findChild(node, "frameLabel");
  if (labelNode) label = labelNode.attrs.name ?? textOf(labelNode) ?? undefined;
  if (!label && node.attrs.name) label = node.attrs.name;

  const actionscript = findChild(node, "Actionscript");
  const script = actionscript ? textOf(actionscript) : undefined;
  const sounds = node.children.filter((c) => c.name.toLowerCase() === "sound");

  const frame: XflFrameAst = {
    index: node.attrs.index !== undefined ? intAttr(node, "index", fallbackIndex) : fallbackIndex,
    duration: node.attrs.duration !== undefined ? intAttr(node, "duration", 1) : 1,
    tweenType: node.attrs.tweenType,
    motionTweenSnap:
      node.attrs.motionTweenSnap !== undefined
        ? boolAttr(node, "motionTweenSnap", false)
        : undefined,
    keyMode: node.attrs.keyMode !== undefined ? intAttr(node, "keyMode", 0) : undefined,
    acceleration: node.attrs.acceleration !== undefined ? numAttr(node, "acceleration", 0) : undefined,
    motionTweenRotate: node.attrs.motionTweenRotate,
    motionTweenRotateTimes:
      node.attrs.motionTweenRotateTimes !== undefined
        ? intAttr(node, "motionTweenRotateTimes", 0)
        : undefined,
    elements,
    filters: parseFilters(node),
    colorTransform: parseColorTransform(node),
    label,
    sound: sounds.length > 0 ? sounds : undefined,
    script: script && script.length > 0 ? script : undefined,
    name: node.attrs.name,
    rigPropagationMatrix: node.attrs.rigPropagationMatrix,
    parentLayerIndex:
      node.attrs.parentLayerIndex !== undefined
        ? intAttr(node, "parentLayerIndex", 0)
        : undefined,
    blendMode: node.attrs.blendMode,
    raw: node,
  };
  return frame;
}

function parseLayer(
  node: XmlNode,
  index: number,
  warnings: XflWarning[],
  path: string,
): XflLayerAst {
  const framesNode = findChild(node, "frames");
  const frames = (framesNode?.children ?? [])
    .filter((child) => child.name === "DOMFrame")
    .map((child, i) => parseFrame(child, i, warnings, `${path}.frames[${i}]`));
  if (frames.length === 0) {
    warnings.push({ code: "XFL_EMPTY_LAYER", message: `layer ${node.attrs.name} has no frames`, path });
  }
  return {
    index,
    name: node.attrs.name ?? `layer-${index}`,
    color: node.attrs.color,
    layerType: node.attrs.layerType,
    parentLayerIndex:
      node.attrs.parentLayerIndex !== undefined
        ? intAttr(node, "parentLayerIndex", 0)
        : undefined,
    layerRiggingIndex:
      node.attrs.layerRiggingIndex !== undefined
        ? intAttr(node, "layerRiggingIndex", 0)
        : undefined,
    visible: node.attrs.visible !== undefined ? boolAttr(node, "visible", true) : true,
    frames,
    raw: node,
  };
}

export function parseTimeline(
  node: XmlNode,
  warnings: XflWarning[],
  path: string,
): XflTimelineAst {
  const layersNode = findChild(node, "layers");
  const layers = (layersNode?.children ?? [])
    .filter((child) => child.name === "DOMLayer")
    .map((child, index) => parseLayer(child, index, warnings, `${path}.layers[${index}]`));
  return {
    name: node.attrs.name ?? "",
    currentFrame:
      node.attrs.currentFrame !== undefined ? intAttr(node, "currentFrame", 0) : undefined,
    layerDepthEnabled:
      node.attrs.layerDepthEnabled !== undefined
        ? boolAttr(node, "layerDepthEnabled", false)
        : undefined,
    layers,
    raw: node,
  };
}

export function parseSymbolItem(node: XmlNode): XflSymbolAst {
  const warnings: XflWarning[] = [];
  const timelineNode = findChild(node, "timeline");
  const timelineDom = findChild(timelineNode, "DOMTimeline");
  const linkageNode = findChild(node, "linkage");
  const symbolType = node.attrs.symbolType;
  return {
    name: node.attrs.name ?? "",
    itemID: node.attrs.itemID,
    symbolType:
      symbolType === "movieclip" || symbolType === "button" ? symbolType : "graphic",
    linkage: linkageNode
      ? {
          exportName: linkageNode.attrs.exportName,
          className: linkageNode.attrs.className,
        }
      : undefined,
    timeline: timelineDom ? parseTimeline(timelineDom, warnings, `symbol(${node.attrs.name}).timeline`) : undefined,
    warnings,
    raw: node,
  };
}

function parseMedia(node: XmlNode): XflMediaAst {
  const kind =
    node.name === "DOMBitmapItem"
      ? "bitmap"
      : node.name === "DOMSoundItem"
        ? "sound"
        : node.name === "DOMFontItem"
          ? "font"
          : node.name === "DOMVideoItem"
            ? "video"
            : "unknown";
  return {
    kind,
    name: node.attrs.name ?? "",
    itemID: node.attrs.itemID,
    href: node.attrs.href,
    path: node.attrs.path,
    sourceExternalFilepath: node.attrs.sourceExternalFilepath,
    attrs: { ...node.attrs },
    raw: node,
  };
}

export function parseDocument(node: XmlNode): ParsedDocument {
  const warnings: XflWarning[] = [];
  if (node.name !== "DOMDocument") {
    warnings.push({
      code: "XFL_UNEXPECTED_ROOT",
      message: `expected DOMDocument root, found ${node.name}`,
    });
  }
  const symbolsNode = findChild(node, "symbols");
  const symbols: XflIncludeAst[] = (symbolsNode?.children ?? [])
    .filter((child) => child.name === "Include")
    .map((child) => ({
      href: child.attrs.href ?? "",
      itemID: child.attrs.itemID,
      itemIcon: child.attrs.itemIcon,
      lastModified: child.attrs.lastModified,
    }));

  const timelinesNode = findChild(node, "timelines");
  const timelines = (timelinesNode?.children ?? [])
    .filter((child) => child.name === "DOMTimeline")
    .map((child, index) => parseTimeline(child, warnings, `DOMDocument.timelines[${index}]`));

  const mediaNode = findChild(node, "media");
  const media = (mediaNode?.children ?? []).map(parseMedia);

  const scriptsNode = findChild(node, "scripts");
  const scripts = scriptsNode ? textOf(scriptsNode) : undefined;

  const document: XflDocumentAst = {
    width: numAttr(node, "width", 550),
    height: numAttr(node, "height", 400),
    frameRate: numAttr(node, "frameRate", 24),
    backgroundColor: node.attrs.backgroundColor,
    xflVersion: node.attrs.xflVersion,
    creatorInfo: node.attrs.creatorInfo,
    currentTimeline: node.attrs.currentTimeline,
    symbols,
    timelines,
    media,
    scripts: scripts && scripts.length > 0 ? scripts : undefined,
    raw: node,
  };
  return { document, warnings };
}

export function parseXflDocumentXml(text: string, options: ParseOptions = {}): ParsedDocument {
  const root = parseXml(text, options);
  return parseDocument(root);
}

export function parseXflSymbolXml(text: string, options: ParseOptions = {}): XflSymbolAst {
  const root = parseXml(text, options);
  return parseSymbolItem(root);
}

export function parseXflXml(text: string, options: ParseOptions = {}): XmlNode {
  return parseXml(text, options);
}
