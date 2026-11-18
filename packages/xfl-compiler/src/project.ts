import type {
  AssetIR,
  BitmapCharacterIR,
  CharacterIR,
  Diagnostic,
  ProjectIR,
  Rect,
  SceneIR,
  ShapeIR,
  SoundCharacterIR,
  SymbolCharacterIR,
  TimelineIR,
  ElementIR,
} from "@flaforge/ir";
import { IR_VERSION, transformRect, unionRect } from "@flaforge/ir";
import type { XflContainer } from "@flaforge/container";
import { readXflContainer } from "@flaforge/container";
import type { XflDocumentAst, XflSymbolAst, XflTimelineAst } from "@flaforge/xml";
import { parseXflDocumentXml, parseXflSymbolXml } from "@flaforge/xml";
import { DiagnosticSink } from "./diagnostics.js";
import { createGeometryStats } from "./shape.js";
import { decodeBitmapDatToPng } from "./bitmap-dat.js";
import type { GeometryStats } from "./shape.js";
import type { TimelineCompileContext } from "./timeline.js";
import { compileTimeline } from "./timeline.js";

export interface CompileOptions {
  sourceName?: string;
  /** P1; not implemented yet. */
  includeCubics?: boolean;
  /** Embed bitmap/sound bytes as base64 in the IR. */
  embedAssets?: boolean;
  maxXmlBytes?: number;
  /** Throw when a diagnostic with level=error is produced. */
  failOnError?: boolean;
  /** Deterministic timestamp for tests / reproducible builds. */
  generatedAt?: string;
}

export interface CompileStats extends GeometryStats {
  symbols: number;
  timelines: number;
  layers: number;
  frames: number;
  instances: number;
  scenes: number;
}

export interface CompileResult {
  project: ProjectIR;
  container: XflContainer;
  stats: CompileStats;
}

interface SymbolSource {
  ast: XflSymbolAst;
  includeHref: string;
  entryName: string;
  id: string;
  name: string;
}

function normalizeBackground(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const hex = input.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[0]!}${hex[0]!}${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}`.toLowerCase();
  }
  return undefined;
}

function resolveIncludeEntry(container: XflContainer, href: string): string | undefined {
  const clean = href.replace(/\\/g, "/").replace(/^\.?\//, "");
  const candidates = [
    clean,
    `LIBRARY/${clean}`,
    decodeURIComponentSafe(clean),
    `LIBRARY/${decodeURIComponentSafe(clean)}`,
  ];
  for (const candidate of candidates) {
    if (container.has(candidate)) return container.resolveName(candidate);
  }
  return undefined;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mediaAssetId(kind: string, itemID: string | undefined, name: string): string {
  return `${kind}:${itemID ?? name}`;
}

function emptyTimeline(name: string, id: string): TimelineIR {
  return { id, name, frameCount: 1, layers: [], labels: [] };
}

function elementBounds(
  element: ElementIR,
  project: ProjectIR,
  symbolBounds: Map<string, Rect>,
): Rect | null {
  if (element.kind === "shape" && element.shapeId) {
    const shape = project.shapes[element.shapeId];
    if (!shape) return null;
    return transformRect(element.matrix, shape.bounds);
  }
  if (element.kind === "instance" && element.characterId) {
    const character = project.library[element.characterId];
    if (!character) return null;
    if (character.kind === "symbol") {
      const bounds = symbolBounds.get(character.id);
      return bounds ? transformRect(element.matrix, bounds) : null;
    }
    if (character.kind === "bitmap") {
      return transformRect(element.matrix, {
        x: 0,
        y: 0,
        width: character.width,
        height: character.height,
      });
    }
    return null;
  }
  if (element.kind === "bitmap" && element.characterId) {
    const character = project.library[element.characterId];
    if (character?.kind === "bitmap") {
      return transformRect(element.matrix, {
        x: 0,
        y: 0,
        width: character.width,
        height: character.height,
      });
    }
    return null;
  }
  if (element.kind === "text" && element.text) {
    const width = element.text.width ?? 0;
    const height = element.text.height ?? (element.text.fontSize ?? 12);
    return transformRect(element.matrix, { x: 0, y: 0, width, height });
  }
  return null;
}

export function computeSymbolBounds(project: ProjectIR, sink: DiagnosticSink): void {
  const symbolBounds = new Map<string, Rect>();
  const symbols = Object.values(project.library).filter(
    (character): character is SymbolCharacterIR => character.kind === "symbol",
  );
  for (let iteration = 0; iteration < 16; iteration++) {
    let changed = false;
    for (const symbol of symbols) {
      let bounds: Rect | null = null;
      for (const layer of symbol.timeline.layers) {
        // Guide paths and mask shapes are not painted art. Including them
        // (walk guides often span the whole stage) inflates a character's
        // bounds and makes previews tiny and off-center.
        if (!layer.visible || layer.type === "guide" || layer.type === "mask") continue;
        for (const frame of layer.frames) {
          for (const element of frame.elements) {
            if (element.visible === false) continue;
            const elementRect = elementBounds(element, project, symbolBounds);
            if (elementRect) bounds = unionRect(bounds, elementRect);
          }
        }
      }
      const resolved = bounds ?? { x: 0, y: 0, width: 0, height: 0 };
      const previous = symbolBounds.get(symbol.id);
      if (
        !previous ||
        previous.x !== resolved.x ||
        previous.y !== resolved.y ||
        previous.width !== resolved.width ||
        previous.height !== resolved.height
      ) {
        symbolBounds.set(symbol.id, resolved);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const symbol of symbols) {
    symbol.bounds = symbolBounds.get(symbol.id) ?? { x: 0, y: 0, width: 0, height: 0 };
    if (symbol.bounds.width === 0 && symbol.bounds.height === 0) {
      sink.infoOnce(
        "SYMBOL_NO_GEOMETRY",
        `symbol ${symbol.name} has no geometry (filter-only or empty symbol)`,
        `library.${symbol.id}`,
      );
    }
  }
}

function detectSymbolCycles(library: Record<string, CharacterIR>, sink: DiagnosticSink): void {
  const graph = new Map<string, string[]>();
  for (const character of Object.values(library)) {
    if (character.kind !== "symbol") continue;
    const targets = new Set<string>();
    for (const layer of character.timeline.layers) {
      for (const frame of layer.frames) {
        for (const element of frame.elements) {
          if (element.kind === "instance" && element.characterId) {
            const target = library[element.characterId];
            if (target?.kind === "symbol") targets.add(element.characterId);
          }
        }
      }
    }
    graph.set(character.id, [...targets]);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].map((item) => library[item]?.name ?? item);
      sink.warn(
        "SYMBOL_CYCLE",
        `symbol reference cycle: ${cycle.join(" -> ")} (runtime depth guard applies)`,
        `library.${id}`,
      );
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const target of graph.get(id) ?? []) visit(target);
    stack.pop();
    state.set(id, 2);
  };
  for (const id of graph.keys()) visit(id);
}

function countStats(project: ProjectIR, geometry: GeometryStats): CompileStats {
  let layers = 0;
  let frames = 0;
  let instances = 0;
  const timelines = new Set<string>();
  for (const character of Object.values(project.library)) {
    if (character.kind !== "symbol") continue;
    timelines.add(character.timeline.id);
    layers += character.timeline.layers.length;
    for (const layer of character.timeline.layers) frames += layer.frames.length;
    for (const layer of character.timeline.layers) {
      for (const frame of layer.frames) {
        instances += frame.elements.filter((element) => element.kind === "instance").length;
      }
    }
  }
  for (const scene of project.scenes) {
    timelines.add(scene.timeline.id);
    layers += scene.timeline.layers.length;
    for (const layer of scene.timeline.layers) frames += layer.frames.length;
  }
  return {
    ...geometry,
    symbols: Object.values(project.library).filter((c) => c.kind === "symbol").length,
    timelines: timelines.size,
    layers,
    frames,
    instances,
    scenes: project.scenes.length,
  };
}

export function compileContainer(
  container: XflContainer,
  options: CompileOptions = {},
): { project: ProjectIR; stats: CompileStats } {
  const sink = new DiagnosticSink();
  const geometry = createGeometryStats();
  const maxXmlBytes = options.maxXmlBytes ?? 32 * 1024 * 1024;

  const documentXml = container.requireText("DOMDocument.xml");
  const documentParsed = parseXflDocumentXml(documentXml, {
    maxBytes: maxXmlBytes,
    source: "DOMDocument.xml",
  });
  const document: XflDocumentAst = documentParsed.document;
  for (const warning of documentParsed.warnings) {
    sink.warn(warning.code, warning.message, warning.path);
  }

  const library: Record<string, CharacterIR> = {};
  const shapes: Record<string, ShapeIR> = {};
  const assets: AssetIR[] = [];
  const characterIdByName = new Map<string, string>();
  const bitmapAssetIdByName = new Map<string, string>();
  const symbolSources: SymbolSource[] = [];

  // ---- symbols ----
  for (const include of document.symbols) {
    if (!include.href) {
      sink.warn("SYMBOL_INCLUDE_EMPTY", "Include element has no href");
      continue;
    }
    const entryName = resolveIncludeEntry(container, include.href);
    if (!entryName) {
      sink.error(
        "SYMBOL_FILE_MISSING",
        `could not resolve symbol include "${include.href}" (looked in LIBRARY/)`,
        include.href,
      );
      continue;
    }
    let parsed: XflSymbolAst;
    try {
      parsed = parseXflSymbolXml(container.requireText(entryName), {
        maxBytes: maxXmlBytes,
        source: entryName,
      });
    } catch (error) {
      sink.error("SYMBOL_PARSE_FAILED", (error as Error).message, entryName);
      continue;
    }
    for (const warning of parsed.warnings ?? []) {
      sink.warn(warning.code, warning.message, warning.path);
    }
    const name = parsed.name || include.href.replace(/\.xml$/i, "");
    const id = `symbol:${include.itemID ?? parsed.itemID ?? name}`;
    if (library[id]) {
      sink.warn("SYMBOL_DUPLICATE_ID", `duplicate symbol id ${id}; keeping the first`, entryName);
      continue;
    }
    symbolSources.push({ ast: parsed, includeHref: include.href, entryName, id, name });
    if (characterIdByName.has(name)) {
      sink.warn(
        "SYMBOL_DUPLICATE_NAME",
        `duplicate symbol name "${name}"; libraryItemName resolution will use the first`,
        entryName,
      );
    } else {
      characterIdByName.set(name, id);
    }
    const hrefBase = include.href.replace(/^.*[\\/]/, "").replace(/\.xml$/i, "");
    if (hrefBase && !characterIdByName.has(hrefBase)) characterIdByName.set(hrefBase, id);

  }

  // ---- media (bitmap/sound/font/video) ----
  for (const media of document.media) {
    if (!media.name && !media.itemID) continue;
    const name = media.name || media.href || media.itemID || "media";
    if (media.kind === "bitmap" || media.kind === "sound") {
      const id = mediaAssetId(media.kind, media.itemID, name);
      if (library[id]) continue;
      const assetId = `asset:${media.itemID ?? name}`;
      if (media.kind === "bitmap") {
        const cleanName = name.replace(/\.(png|jpe?g)$/i, "");
        const basename = cleanName.split("/").pop() ?? cleanName;
        for (const key of [name, cleanName, basename]) {
          if (key && !bitmapAssetIdByName.has(key)) bitmapAssetIdByName.set(key, assetId);
        }
        if (media.href) {
          const cleanHref = media.href.replace(/\.(png|jpe?g)$/i, "");
          for (const key of [media.href, cleanHref]) {
            if (!bitmapAssetIdByName.has(key)) bitmapAssetIdByName.set(key, assetId);
          }
        }
      }
      const href = media.href ?? media.path ?? media.sourceExternalFilepath;
      const dataHref = media.attrs.bitmapDataHRef ?? media.attrs.soundDataHRef;
      const firstExisting = (...candidates: (string | undefined)[]): string | undefined => {
        for (const candidate of candidates) {
          if (candidate && container.has(candidate)) return container.resolveName(candidate);
        }
        return undefined;
      };
      const resolvedDataHref = firstExisting(
        dataHref ? `bin/${dataHref}` : undefined,
        dataHref,
      );
      const path =
        firstExisting(href, href ? `LIBRARY/${href}` : undefined) ??
        resolvedDataHref ??
        href;
      // XFL stores bitmap dimensions in twips as frameRight/frameBottom when
      // the image is embedded as a data blob (bitmapDataHRef) rather than a
      // standalone PNG.
      let width =
        Number(media.attrs.width ?? 0) ||
        (Number(media.attrs.frameRight ?? 0) || 0) / 20 ||
        0;
      let height =
        Number(media.attrs.height ?? 0) ||
        (Number(media.attrs.frameBottom ?? 0) || 0) / 20 ||
        0;
      let embeddedBitmap: { png: Buffer; width: number; height: number } | undefined;
      if (media.kind === "bitmap" && resolvedDataHref) {
        try {
          const decoded = decodeBitmapDatToPng(container.requireBytes(resolvedDataHref));
          if (decoded) {
            embeddedBitmap = { png: decoded.png, width: decoded.width, height: decoded.height };
            width = decoded.width;
            height = decoded.height;
            sink.infoOnce(
              "BITMAP_DAT_DECODED",
              `decoded bitmap data blob ${resolvedDataHref} (${decoded.width}x${decoded.height})`,
              `media(${name})`,
            );
          } else {
            sink.warnOnce(
              "BITMAP_DAT_UNSUPPORTED",
              `unsupported bitmap data blob ${resolvedDataHref}; asset is metadata-only`,
              `media(${name})`,
            );
          }
        } catch (error) {
          sink.warnOnce(
            "BITMAP_DAT_DECODE_FAILED",
            `failed to decode ${resolvedDataHref}: ${(error as Error).message}`,
            `media(${name})`,
          );
        }
      }
      const character: BitmapCharacterIR | SoundCharacterIR =
        media.kind === "bitmap"
          ? { kind: "bitmap", id, name, assetId, width, height }
          : { kind: "sound", id, name, assetId };
      library[id] = character;
      if (!characterIdByName.has(name)) characterIdByName.set(name, id);
      const asset: AssetIR = {
        id: assetId,
        kind: media.kind,
        name,
        path,
        mimeType: media.kind === "bitmap" ? media.attrs.mimeType : media.attrs.mimeType,
        width: character.kind === "bitmap" ? character.width : undefined,
        height: character.kind === "bitmap" ? character.height : undefined,
      };
      if (embeddedBitmap) {
        asset.data = embeddedBitmap.png.toString("base64");
        asset.mimeType = "image/png";
      } else if (options.embedAssets && path && container.has(path)) {
        try {
          asset.data = Buffer.from(container.requireBytes(path)).toString("base64");
        } catch (error) {
          sink.warn("ASSET_EMBED_FAILED", (error as Error).message, path);
        }
      }
      assets.push(asset);
    } else if (media.kind === "font" || media.kind === "video") {
      sink.infoOnce(
        "MEDIA_P1",
        `${media.kind} media is recorded but not rendered in P0`,
        `media(${name})`,
      );
      if (!characterIdByName.has(name)) characterIdByName.set(name, `media:${name}`);
    }
  }

  // ---- compile symbol timelines now that every libraryItemName is known ----
  for (const source of symbolSources) {
    const timelineAst = source.ast.timeline ?? {
      name: source.name,
      layers: [],
      raw: source.ast.raw,
    };
    const timeline = compileTimeline(
      timelineAst,
      {
        sink,
        stats: geometry,
        shapes,
        characterIdByName,
        bitmapAssetIdByName,
        includeCubics: options.includeCubics,
      },
      `symbol(${source.name}).timeline`,
      `timeline:${source.id}`,
    );
    const character: SymbolCharacterIR = {
      kind: "symbol",
      id: source.id,
      name: source.name,
      symbolType: source.ast.symbolType,
      timeline,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      linkage: source.ast.linkage,
    };
    library[source.id] = character;
  }

  detectSymbolCycles(library, sink);

  // ---- scenes ----
  const scenes: SceneIR[] = [];
  document.timelines.forEach((timelineAst, index) => {
    const timeline = compileTimeline(
      timelineAst,
      {
        sink,
        stats: geometry,
        shapes,
        characterIdByName,
        bitmapAssetIdByName,
        includeCubics: options.includeCubics,
      },
      `DOMDocument.timelines[${index}]`,
      `timeline:scene:${index}`,
    );
    scenes.push({
      id: `scene:${index}`,
      name: timelineAst.name || `Scene ${index + 1}`,
      frameCount: timeline.frameCount,
      timeline,
    });
  });
  if (scenes.length === 0) {
    sink.warn("NO_SCENES", "DOMDocument has no DOMTimeline; generating an empty scene");
    scenes.push({
      id: "scene:0",
      name: "Scene 1",
      frameCount: 1,
      timeline: emptyTimeline("Scene 1", "timeline:scene:0"),
    });
  }

  const project: ProjectIR = {
    irVersion: IR_VERSION,
    meta: {
      source: options.sourceName ?? container.source,
      xflVersion: document.xflVersion,
      creator: document.creatorInfo,
      generator: "flaforge 0.1.0",
      generatedAt: options.generatedAt ?? new Date().toISOString(),
    },
    stage: {
      width: document.width,
      height: document.height,
      frameRate: document.frameRate,
      backgroundColor: normalizeBackground(document.backgroundColor),
    },
    library,
    shapes,
    scenes,
    assets,
    diagnostics: [],
  };

  computeSymbolBounds(project, sink);

  project.diagnostics = [
    ...container.diagnostics.map((diagnostic) => ({
      level: diagnostic.level,
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
      ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
    })),
    ...sink.diagnostics,
  ];
  const stats = countStats(project, geometry);
  if (options.failOnError && sink.countLevel("error") > 0) {
    const errors = sink.diagnostics
      .filter((diagnostic) => diagnostic.level === "error")
      .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
      .join("\n");
    throw new Error(`XFL compilation failed:\n${errors}`);
  }
  return { project, stats };
}

export interface CompileFileResult extends CompileResult {}

export async function compileXfl(
  input: string | Uint8Array | ArrayBuffer,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const { container } = await readXflContainer(input, {
    failFast: false,
    maxEntryBytes: 128 * 1024 * 1024,
  });
  const { project, stats } = compileContainer(container, options);
  return { project, container, stats };
}

export function summarizeProject(project: ProjectIR): Record<string, number> {
  const diagnostics = project.diagnostics.reduce<Record<string, number>>((counts, diagnostic) => {
    const key = `${diagnostic.level}:${diagnostic.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return {
    library: Object.keys(project.library).length,
    shapes: Object.keys(project.shapes).length,
    scenes: project.scenes.length,
    assets: project.assets.length,
    diagnostics: project.diagnostics.length,
    ...diagnostics,
  };
}

export function projectDiagnostics(project: ProjectIR): Diagnostic[] {
  return project.diagnostics;
}
