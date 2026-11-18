import type {
  BlendModeIR,
  ContourIR,
  ElementIR,
  FilterIR,
  FillStyleIR,
  ProjectIR,
  ShapeIR,
  TimelineIR,
  AssetIR,
} from "@flaforge/ir";
import {
  evaluateTimelineFrame,
  resolveGraphicFrame,
  resolveMovieclipFrame,
  transformRect,
  unionRect,
  wrapTimelineFrame,
} from "@flaforge/ir";

export interface SvgOptions {
  frame?: number;
  sceneId?: string;
  width?: number;
  height?: number;
  /** Extra viewBox padding in stage pixels. */
  padding?: number;
  /** Fit all scene content into the output viewport instead of the stage. */
  fitContent?: boolean;
  background?: boolean;
}

interface SvgContext {
  project: ProjectIR;
  assets: Map<string, AssetIR>;
  /** assetId -> shared <image> def id, so huge bitmaps are embedded once. */
  assetImages: Map<string, string>;
  defs: string[];
  defCounter: number;
  globalFrame: number;
  depth: number;
  diagnostics: string[];
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(4)).toString();
}

export function matrixToSvg(matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number }): string {
  return `matrix(${n(matrix.a)} ${n(matrix.b)} ${n(matrix.c)} ${n(matrix.d)} ${n(matrix.tx)} ${n(matrix.ty)})`;
}

export function contourToPath(contour: ContourIR): string {
  const parts = [`M ${n(contour.start.x)} ${n(contour.start.y)}`];
  for (const segment of contour.segments) {
    if (segment.k === "L") {
      parts.push(`L ${n(segment.to.x)} ${n(segment.to.y)}`);
    } else if (segment.k === "Q") {
      parts.push(
        `Q ${n(segment.c.x)} ${n(segment.c.y)} ${n(segment.to.x)} ${n(segment.to.y)}`,
      );
    } else {
      parts.push(
        `C ${n(segment.c1.x)} ${n(segment.c1.y)} ${n(segment.c2.x)} ${n(segment.c2.y)} ${n(segment.to.x)} ${n(segment.to.y)}`,
      );
    }
  }
  if (contour.closed) parts.push("Z");
  return parts.join(" ");
}

function gradientDef(
  shape: ShapeIR,
  index: number,
  ctx: SvgContext,
): string | null {
  const fill = shape.fills[index];
  if (!fill) return null;
  const id = `grad-${ctx.defCounter++}`;
  if (fill.kind === "linear-gradient") {
    const m = matrixToSvg(fill.matrix);
    const stops = fill.entries
      .map(
        (entry) =>
          `<stop offset="${n(entry.ratio)}" stop-color="${esc(entry.color)}" stop-opacity="${n(entry.alpha)}"/>`,
      )
      .join("");
    const spread =
      fill.spreadMethod === "reflect"
        ? "reflect"
        : fill.spreadMethod === "repeat"
          ? "repeat"
          : "pad";
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="-819.2" y1="0" x2="819.2" y2="0" gradientTransform="${m}" spreadMethod="${spread}">${stops}</linearGradient>`,
    );
    return `url(#${id})`;
  }
  if (fill.kind === "radial-gradient") {
    const m = matrixToSvg(fill.matrix);
    const stops = fill.entries
      .map(
        (entry) =>
          `<stop offset="${n(entry.ratio)}" stop-color="${esc(entry.color)}" stop-opacity="${n(entry.alpha)}"/>`,
      )
      .join("");
    const spread =
      fill.spreadMethod === "reflect"
        ? "reflect"
        : fill.spreadMethod === "repeat"
          ? "repeat"
          : "pad";
    const focal = fill.focalPointRatio * 819.2;
    ctx.defs.push(
      `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="819.2" fx="${n(focal)}" fy="0" gradientTransform="${m}" spreadMethod="${spread}">${stops}</radialGradient>`,
    );
    return `url(#${id})`;
  }
  return null;
}

function assetDataUrl(asset: AssetIR | undefined): string | null {
  if (!asset?.data) return null;
  const mime = asset.mimeType ?? "image/png";
  return `data:${mime};base64,${asset.data}`;
}

/**
 * One <image> def per asset. Bitmap fills and bitmap instances reference it
 * with <use>, otherwise every fill repeats the full base64 payload and a
 * texture-heavy symbol can exceed V8's maximum string length.
 */
function assetImageRef(asset: AssetIR, ctx: SvgContext): string | null {
  const href = assetDataUrl(asset);
  if (!href) return null;
  const cached = ctx.assetImages.get(asset.id);
  if (cached) return cached;
  const id = `asset-image-${ctx.defCounter++}`;
  ctx.defs.push(
    `<image id="${id}" x="0" y="0" width="${n(asset.width ?? 1)}" height="${n(asset.height ?? 1)}" href="${href}"/>`,
  );
  ctx.assetImages.set(asset.id, id);
  return id;
}

function bitmapFillPattern(fill: Extract<FillStyleIR, { kind: "bitmap" }>, ctx: SvgContext): string | null {
  const key = fill.assetId.replace(/^bitmap:/, "").replace(/\.png$/i, "");
  const basename = key.split("/").pop() ?? key;
  const asset =
    ctx.assets.get(fill.assetId) ??
    [...ctx.assets.values()].find(
      (candidate) =>
        candidate.kind === "bitmap" &&
        (candidate.name === key ||
          candidate.name.replace(/\.(png|jpg|jpeg)$/i, "") === key ||
          candidate.path?.endsWith(basename) ||
          candidate.path?.endsWith(`${basename}.png`)),
    );
  if (!asset) return null;
  const imageId = assetImageRef(asset, ctx);
  if (!imageId) return null;
  const id = `bitmap-fill-${ctx.defCounter++}`;
  const m = matrixToSvg(fill.matrix);
  ctx.defs.push(
    `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(asset.width ?? 1)}" height="${n(asset.height ?? 1)}" patternTransform="${m}"><use href="#${imageId}"/></pattern>`,
  );
  return `url(#${id})`;
}

function fillAttributes(shape: ShapeIR, index: number, ctx: SvgContext): string {
  const fill = shape.fills[index];
  if (!fill) return `fill="#ff00ff"`;
  if (fill.kind === "solid") {
    return `fill="${esc(fill.color)}" fill-opacity="${n(fill.alpha)}"`;
  }
  if (fill.kind === "linear-gradient" || fill.kind === "radial-gradient") {
    const ref = gradientDef(shape, index, ctx);
    if (ref) return `fill="${ref}"`;
  }
  if (fill.kind === "bitmap") {
    const ref = bitmapFillPattern(fill, ctx);
    if (ref) return `fill="${ref}"`;
  }
  return `fill="#888888"`;
}

export function shapeToSvg(shape: ShapeIR, ctx: SvgContext, extra = ""): string {
  const parts: string[] = [];
  for (const region of shape.regions) {
    const d = [contourToPath(region.outer), ...region.holes.map(contourToPath)].join(" ");
    parts.push(
      `<path d="${d}" fill-rule="evenodd" ${fillAttributes(shape, region.fill, ctx)}${extra}/>`,
    );
  }
  for (const path of shape.strokePaths) {
    const stroke = shape.strokes[path.stroke];
    if (!stroke) continue;
    const color = stroke.color ?? "#000000";
    const alpha = stroke.alpha ?? 1;
    const dash =
      stroke.kind === "dashed"
        ? ` stroke-dasharray="${n(stroke.width * 4)} ${n(stroke.width * 2)}"`
        : stroke.kind === "dotted"
          ? ` stroke-dasharray="${n(Math.max(0.5, stroke.width))} ${n(stroke.width * 2)}"`
          : "";
    const d = contourToPath({
      start: path.start,
      segments: path.segments,
      closed: path.closed,
    });
    parts.push(
      `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-opacity="${n(alpha)}" stroke-width="${n(stroke.width)}" stroke-linecap="${stroke.cap === "none" ? "butt" : stroke.cap}" stroke-linejoin="${stroke.join}" stroke-miterlimit="${n(stroke.miterLimit)}"${dash}${extra}/>`,
    );
  }
  return parts.join("");
}

function hexToRgb(input: string): { r: number; g: number; b: number } {
  const hex = input.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
    };
  }
  return { r: 1, g: 1, b: 1 };
}

function filterDef(filter: FilterIR, ctx: SvgContext): string | null {
  const id = `filter-${ctx.defCounter++}`;
  switch (filter.kind) {
    case "glow": {
      const sigma = Math.max(0.01, (filter.blurX + filter.blurY) / 4);
      const opacity = Math.max(0, Math.min(1, filter.alpha * filter.strength));
      const rgb = hexToRgb(filter.color);
      // Colorize the blurred alpha instead of using feFlood/feComposite: rsvg
      // renders the latter as a stray line at a filter-region edge when several
      // filtered groups overlap.
      const matrix = [
        0, 0, 0, 0, rgb.r,
        0, 0, 0, 0, rgb.g,
        0, 0, 0, 0, rgb.b,
        0, 0, 0, opacity, 0,
      ]
        .map((v) => n(v))
        .join(" ");
      const glow = `<feGaussianBlur in="SourceAlpha" stdDeviation="${n(sigma)}" result="blur"/><feColorMatrix in="blur" type="matrix" values="${matrix}" result="glow"/>`;
      const merge = filter.knockout
        ? `<feMerge><feMergeNode in="glow"/></feMerge>`
        : `<feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge>`;
      ctx.defs.push(`<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB">${glow}${merge}</filter>`);
      return `url(#${id})`;
    }
    case "blur": {
      const sigma = Math.max(0.01, (filter.blurX + filter.blurY) / 4);
      ctx.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(sigma)}"/></filter>`);
      return `url(#${id})`;
    }
    case "drop-shadow": {
      const sigma = Math.max(0.01, (filter.blurX + filter.blurY) / 4);
      const radians = (filter.angle * Math.PI) / 180;
      const dx = Math.cos(radians) * filter.distance;
      const dy = Math.sin(radians) * filter.distance;
      const node = filter.knockout
        ? `<feMerge><feMergeNode in="shadow"/></feMerge>`
        : `<feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>`;
      ctx.defs.push(
        `<filter id="${id}" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur in="SourceAlpha" stdDeviation="${n(sigma)}" result="blur"/><feOffset in="blur" dx="${n(dx)}" dy="${n(dy)}" result="offset"/><feFlood flood-color="${esc(filter.color)}" flood-opacity="${n(filter.alpha * filter.strength)}" result="color"/><feComposite in="color" in2="offset" operator="in" result="shadow"/>${node}</filter>`,
      );
      return `url(#${id})`;
    }
    case "adjust-color": {
      const values = filter.colorMatrix;
      ctx.defs.push(
        `<filter id="${id}"><feColorMatrix type="matrix" values="${values.map(n).join(" ")}"/></filter>`,
      );
      return `url(#${id})`;
    }
    case "bevel":
    case "unsupported":
      return null;
  }
}

function wrapFilters(content: string, filters: FilterIR[] | undefined, ctx: SvgContext): string {
  if (!filters || filters.length === 0 || content.length === 0) return content;
  let out = content;
  for (let i = filters.length - 1; i >= 0; i--) {
    const ref = filterDef(filters[i]!, ctx);
    if (ref) out = `<g filter="${ref}">${out}</g>`;
  }
  return out;
}

function opacityFromElement(element: ElementIR): number {
  const alpha = element.colorTransform?.alphaMultiplier;
  return alpha === undefined ? 1 : Math.max(0, Math.min(1, alpha));
}

function renderTimeline(timeline: TimelineIR, frame: number, ctx: SvgContext): string {
  if (ctx.depth > 32) {
    ctx.diagnostics.push("SVG_DEPTH_LIMIT");
    return "";
  }
  // A character preview loops its own timeline. Without this, a one-frame pose
  // (very common for library symbols) evaluates past its last keyframe at
  // frame >= 1 and renders an empty SVG.
  const localFrame = wrapTimelineFrame(timeline, frame);
  const evaluated = evaluateTimelineFrame(timeline, localFrame);
  const renderedLayers: {
    layer: TimelineIR["layers"][number];
    content: string;
    blendMode?: BlendModeIR;
  }[] = [];
  for (const { layer, frame: layerFrame } of evaluated) {
    if (!layerFrame) continue;
    if (layer.type === "folder" || layer.type === "guide") continue;
    if (!layer.visible) continue;
    const contents: string[] = [];
    for (const element of layerFrame.elements) {
      if (element.visible === false) continue;
      const transform = matrixToSvg(element.resolvedMatrix);
      const opacity = opacityFromElement(element);
      const opacityAttr = opacity < 1 ? ` opacity="${n(opacity)}"` : "";
      let inner = "";
      if (element.kind === "shape" && element.shapeId) {
        const shape = ctx.project.shapes[element.shapeId];
        if (shape) inner = shapeToSvg(shape, ctx);
      } else if (element.kind === "bitmap" && element.characterId) {
        const bitmapCharacter = ctx.project.library[element.characterId];
        if (bitmapCharacter?.kind === "bitmap") {
          const asset = ctx.assets.get(bitmapCharacter.assetId);
          const imageId = asset ? assetImageRef(asset, ctx) : null;
          if (asset && imageId) {
            const scaleX = bitmapCharacter.width / Math.max(1, asset.width ?? bitmapCharacter.width);
            const scaleY = bitmapCharacter.height / Math.max(1, asset.height ?? bitmapCharacter.height);
            inner = `<use href="#${imageId}" transform="scale(${n(scaleX)} ${n(scaleY)})"/>`;
          } else if (asset) {
            inner = `<rect x="0" y="0" width="${n(bitmapCharacter.width)}" height="${n(bitmapCharacter.height)}" fill="#888888" fill-opacity="0.7"/>`;
          }
        }
      } else if (element.kind === "instance" && element.characterId) {
        const character = ctx.project.library[element.characterId];
        if (character?.kind === "symbol") {
          const childLength = Math.max(1, character.timeline.frameCount);
          const startFrame = element.startFrame ?? layerFrame.keyframeIndex;
          const childFrame =
            character.symbolType === "graphic"
              ? resolveGraphicFrame({
                  parentFrame: localFrame,
                  instanceStartFrame: startFrame,
                  firstFrame: element.firstFrame ?? 0,
                  loopMode: element.loopMode ?? "loop",
                  childLength,
                })
              : resolveMovieclipFrame({
                  globalFrame: ctx.globalFrame,
                  instanceStartFrame: startFrame,
                  childLength,
                });
          ctx.depth++;
          inner = renderTimeline(character.timeline, childFrame, ctx);
          ctx.depth--;
        } else if (character?.kind === "text") {
          inner = `<text x="0" y="0" font-size="12" fill="#000">${esc(character.text.text)}</text>`;
        }
      } else if (element.kind === "text" && element.text) {
        inner = `<text x="0" y="0" font-size="${n(element.text.fontSize ?? 12)}" fill="${esc(element.text.color ?? "#000000")}">${esc(element.text.text)}</text>`;
      }
      if (!inner) continue;
      const filtered = wrapFilters(inner, element.filters, ctx);
      contents.push(`<g transform="${transform}"${opacityAttr}>${filtered}</g>`);
    }
    const joined = contents.join("");
    if (joined.length === 0) continue;
    const filteredLayer = wrapFilters(joined, layerFrame.filters, ctx);
    renderedLayers.push({ layer, content: filteredLayer, blendMode: layerFrame.blendMode });
  }

  // XFL masks: layerType="mask" defines the mask; the masked layer points to it
  // with parentLayerIndex. The mask layer itself is never painted.
  const maskIds = new Map<number, string>();
  for (const entry of renderedLayers) {
    if (entry.layer.type !== "mask") continue;
    const id = `mask-${ctx.defCounter++}`;
    ctx.defs.push(
      `<mask id="${id}" maskUnits="userSpaceOnUse" x="-10000" y="-10000" width="20000" height="20000" maskContentUnits="userSpaceOnUse">${entry.content}</mask>`,
    );
    maskIds.set(entry.layer.index, id);
  }

  const parts: string[] = [];
  for (const entry of renderedLayers) {
    if (entry.layer.type === "mask") continue;
    let content = entry.content;
    const parent = entry.layer.parentIndex;
    if (parent !== undefined) {
      const maskId = maskIds.get(parent);
      if (maskId) content = `<g mask="url(#${maskId})">${content}</g>`;
    }
    const blend =
      entry.blendMode && entry.blendMode !== "normal"
        ? ` style="mix-blend-mode:${esc(entry.blendMode)}"`
        : "";
    parts.push(`<g data-layer="${esc(entry.layer.name)}"${blend}>${content}</g>`);
  }
  return parts.join("");
}

function sceneContentBounds(project: ProjectIR, timeline: TimelineIR): {
  x: number; y: number; width: number; height: number;
} {
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  for (const layer of timeline.layers) {
    if (!layer.visible || layer.type === "guide" || layer.type === "mask") continue;
    for (const frame of layer.frames) {
      for (const element of frame.elements) {
        if (element.visible === false) continue;
        if (element.kind === "shape" && element.shapeId) {
          const shape = project.shapes[element.shapeId];
          if (shape) bounds = unionRect(bounds, transformRect(element.matrix, shape.bounds));
        } else if (element.characterId) {
          const character = project.library[element.characterId];
          if (character?.kind === "symbol") {
            bounds = unionRect(bounds, transformRect(element.matrix, character.bounds));
          } else if (character?.kind === "bitmap") {
            bounds = unionRect(bounds, transformRect(element.matrix, {
              x: 0, y: 0, width: character.width, height: character.height,
            }));
          }
        }
      }
    }
  }
  return bounds ?? { x: 0, y: 0, width: project.stage.width, height: project.stage.height };
}

export function projectToSvg(project: ProjectIR, options: SvgOptions = {}): string {
  const scene =
    project.scenes.find((candidate) => candidate.id === options.sceneId) ?? project.scenes[0];
  const frame = options.frame ?? 0;
  const width = options.width ?? project.stage.width;
  const height = options.height ?? project.stage.height;
  const padding = options.padding ?? 0;
  const ctx: SvgContext = {
    project,
    assets: new Map(project.assets.map((asset) => [asset.id, asset])),
    defs: [],
    assetImages: new Map(),
    defCounter: 0,
    globalFrame: frame,
    depth: 0,
    diagnostics: [],
  };
  const content = scene ? renderTimeline(scene.timeline, frame, ctx) : "";
  const bg =
    options.background !== false && project.stage.backgroundColor
      ? `<rect width="100%" height="100%" fill="${esc(project.stage.backgroundColor)}"/>`
      : "";
  const fitBounds = options.fitContent && scene
    ? sceneContentBounds(project, scene.timeline)
    : null;
  const viewBox = fitBounds
    ? `${n(fitBounds.x - padding)} ${n(fitBounds.y - padding)} ${n(fitBounds.width + padding * 2)} ${n(fitBounds.height + padding * 2)}`
    : `${n(-padding)} ${n(-padding)} ${n(width + padding * 2)} ${n(height + padding * 2)}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${viewBox}">`,
    `<defs>${ctx.defs.join("")}</defs>`,
    bg,
    content,
    `</svg>`,
  ].join("\n");
}

/** Render one library symbol at a local frame, with a tight viewBox. */
export function characterToSvg(
  project: ProjectIR,
  characterId: string,
  frame = 0,
  scale = 1,
): string {
  const character = project.library[characterId];
  if (!character || character.kind !== "symbol") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>`;
  }
  const bounds = character.bounds;
  const padding = Math.max(4, Math.max(bounds.width, bounds.height) * 0.02);
  const width = (bounds.width + padding * 2) * scale;
  const height = (bounds.height + padding * 2) * scale;
  const ctx: SvgContext = {
    project,
    assets: new Map(project.assets.map((asset) => [asset.id, asset])),
    defs: [],
    assetImages: new Map(),
    defCounter: 0,
    globalFrame: frame,
    depth: 0,
    diagnostics: [],
  };
  const content = renderTimeline(character.timeline, frame, ctx);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${n(bounds.x - padding)} ${n(bounds.y - padding)} ${n(bounds.width + padding * 2)} ${n(bounds.height + padding * 2)}">`,
    `<defs>${ctx.defs.join("")}</defs>`,
    content,
    `</svg>`,
  ].join("\n");
}

/** Render an arbitrary shape with a tight viewBox (debug/CLI). */
export function shapeToSvgDocument(shape: ShapeIR, scale = 1): string {
  const padding = Math.max(2, Math.max(shape.bounds.width, shape.bounds.height) * 0.02);
  const ctx: SvgContext = {
    assets: new Map(),
    project: {
      irVersion: "1.0",
      meta: { source: "shape", generator: "flaforge", generatedAt: "" },
      stage: { width: 0, height: 0, frameRate: 30 },
      library: {},
      shapes: { [shape.id]: shape },
      scenes: [],
      assets: [],
      diagnostics: [],
    },
    defs: [],
    assetImages: new Map(),
    defCounter: 0,
    globalFrame: 0,
    depth: 0,
    diagnostics: [],
  };
  const content = shapeToSvg(shape, ctx);
  const width = (shape.bounds.width + padding * 2) * scale;
  const height = (shape.bounds.height + padding * 2) * scale;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}" height="${n(height)}" viewBox="${n(shape.bounds.x - padding)} ${n(shape.bounds.y - padding)} ${n(shape.bounds.width + padding * 2)} ${n(shape.bounds.height + padding * 2)}">`,
    `<defs>${ctx.defs.join("")}</defs>`,
    content,
    `</svg>`,
  ].join("\n");
}
