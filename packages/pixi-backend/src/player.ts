import "pixi.js/advanced-blend-modes";

import {
  Assets,
  Container,
  Graphics,
  Matrix,
  Sprite,
  Text,
  Texture,
  type Filter,
} from "pixi.js";
import type {
  BlendModeIR,
  ColorTransformIR,
  ElementIR,
  FilterIR,
  LayerIR,
  ProjectIR,
  SceneIR,
  TimelineIR,
} from "@flaforge/ir";
import {
  evaluateLayerFrame,
  resolveGraphicFrame,
  resolveMovieclipFrame,
  transformRect,
  unionRect,
  type Rect,
  type ResolvedElementIR,
} from "@flaforge/ir";
import {
  applyFilters,
  buildFilters,
  colorMatrixForTransform,
  releaseFilters,
} from "./filters.js";
import { ShapeContextCache } from "./shape-cache.js";

export interface XflPlayerOptions {
  sceneId?: string;
  /** Render a library symbol directly instead of a scene (useful for previews/tests). */
  characterId?: string;
  /** Fit the scene content bounds into the viewport instead of the stage. */
  fitContent?: boolean;
  autoPlay?: boolean;
  loop?: boolean;
  shapeCache?: ShapeContextCache;
  /** Preloaded asset textures (see XflPlayer.create). */
  textures?: Map<string, Texture>;
  onDiagnostic?: (message: string) => void;
}

interface FilterState {
  filters?: Filter[];
  signature?: string;
}

function hexToNumber(hex: string): number {
  const clean = hex.replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(clean) ? Number.parseInt(clean, 16) : 0;
}

function colorTransformKey(transform: ColorTransformIR | undefined): string {
  if (!transform) return "";
  return [
    transform.redMultiplier,
    transform.greenMultiplier,
    transform.blueMultiplier,
    transform.alphaMultiplier,
    transform.redOffset,
    transform.greenOffset,
    transform.blueOffset,
    transform.alphaOffset,
  ].join(",");
}

function hasColorOffset(transform: ColorTransformIR): boolean {
  return (
    transform.redOffset !== 0 ||
    transform.greenOffset !== 0 ||
    transform.blueOffset !== 0 ||
    transform.alphaOffset !== 0
  );
}

function filtersKey(filters: FilterIR[] | undefined, colorKey: string): string {
  return `${filters ? JSON.stringify(filters) : ""}|${colorKey}`;
}

class ElementView {
  readonly container = new Container();
  private readonly player: XflPlayer;
  private readonly depth: number;
  private kind: ElementIR["kind"];

  get elementKind(): ElementIR["kind"] {
    return this.kind;
  }
  private shapeId?: string;
  private graphics?: Graphics;
  private child?: TimelineView;
  private childTimelineId?: string;
  private text?: Text;
  private sprite?: Sprite;
  private filterState: FilterState = {};
  private filterKey = "";
  private colorFilter: Filter | null = null;

  constructor(player: XflPlayer, element: ElementIR, depth: number) {
    this.player = player;
    this.depth = depth;
    this.kind = element.kind;
    this.container.label = element.id;
  }

  update(element: ElementIR, parentFrame: number, globalFrame: number): void {
    if (this.kind !== element.kind) {
      this.clearContent();
      this.kind = element.kind;
    }
    const m = element.matrix;
    this.container.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx, m.ty));
    this.container.visible = element.visible !== false;

    const transform = element.colorTransform;
    const usesMatrix = transform ? hasColorOffset(transform) : false;
    if (transform) {
      if (usesMatrix) {
        this.container.alpha = 1;
        this.container.tint = 0xffffff;
      } else {
        this.container.alpha = Math.max(0, Math.min(1, transform.alphaMultiplier));
        const r = Math.round(transform.redMultiplier * 255);
        const g = Math.round(transform.greenMultiplier * 255);
        const b = Math.round(transform.blueMultiplier * 255);
        this.container.tint = r === 255 && g === 255 && b === 255 ? 0xffffff : (r << 16) | (g << 8) | b;
      }
    } else {
      this.container.alpha = 1;
      this.container.tint = 0xffffff;
    }

    if (element.filters || usesMatrix) {
      const key = filtersKey(element.filters, colorTransformKey(transform));
      if (key !== this.filterKey) {
        this.filterKey = key;
        const { filters, notes } = buildFilters(element.filters);
        for (const note of notes) this.player.report(note);
        this.colorFilter = transform && usesMatrix ? colorMatrixForTransform(transform) : null;
        if (this.colorFilter) filters.push(this.colorFilter);
        applyFilters(this.container, filters, key, this.filterState);
      }
    } else if (this.filterKey) {
      this.filterKey = "";
      applyFilters(this.container, undefined, "", this.filterState);
      this.colorFilter = null;
    }

    if (element.blendMode) {
      this.applyBlendMode(element.blendMode);
    } else {
      // Inherit a frame-level blend mode from the layer container.
      this.container.blendMode = "inherit";
    }

    switch (element.kind) {
      case "shape":
        this.updateShape(element);
        break;
      case "instance":
        this.updateInstance(element, parentFrame, globalFrame);
        break;
      case "text":
        this.updateText(element);
        break;
      case "bitmap":
        this.updateBitmap(element);
        break;
      default:
        break;
    }
  }

  private updateShape(element: ElementIR): void {
    if (!element.shapeId) return;
    const shape = this.player.project.shapes[element.shapeId];
    if (!shape) {
      this.player.report(`shape ${element.shapeId} not found`);
      return;
    }
    if (!this.graphics) {
      this.graphics = new Graphics(this.player.shapeCache.get(shape));
      this.container.addChild(this.graphics);
      this.shapeId = shape.id;
    } else if (this.shapeId !== shape.id) {
      this.graphics.context = this.player.shapeCache.get(shape);
      this.shapeId = shape.id;
    }
  }

  private updateInstance(element: ElementIR, parentFrame: number, globalFrame: number): void {
    if (!element.characterId) return;
    const character = this.player.project.library[element.characterId];
    if (!character || character.kind !== "symbol") return;
    if (this.depth > 32) {
      this.player.report(`symbol nesting depth exceeded at ${element.characterId}`);
      return;
    }
    const startFrame = element.startFrame ?? 0;
    const childLength = Math.max(1, character.timeline.frameCount);
    const childFrame =
      character.symbolType === "graphic"
        ? resolveGraphicFrame({
            parentFrame,
            instanceStartFrame: startFrame,
            firstFrame: element.firstFrame ?? 0,
            loopMode: element.loopMode ?? "loop",
            childLength,
          })
        : resolveMovieclipFrame({ globalFrame, instanceStartFrame: startFrame, childLength });

    if (!this.child || this.childTimelineId !== character.timeline.id) {
      this.child?.destroy();
      this.child = new TimelineView(
        this.player,
        character.timeline,
        this.depth + 1,
      );
      this.childTimelineId = character.timeline.id;
      this.container.addChild(this.child.container);
    }
    this.child.update(childFrame, globalFrame);
  }

  private updateText(element: ElementIR): void {
    if (!element.text) return;
    if (!this.text) {
      // Pixi v8 Text constructor accepts a plain style object.
      this.text = new Text({
        text: element.text.text,
        style: {
          fontFamily: element.text.fontFamily ?? "Arial",
          fontSize: element.text.fontSize ?? 12,
          fill: element.text.color ?? "#000000",
        },
      });
      this.container.addChild(this.text);
    } else {
      this.text.text = element.text.text;
    }
  }

  private updateBitmap(element: ElementIR): void {
    if (!this.sprite) {
      this.sprite = new Sprite();
      this.container.addChild(this.sprite);
    }
    const character = element.characterId
      ? this.player.project.library[element.characterId]
      : undefined;
    const assetId =
      character?.kind === "bitmap" ? character.assetId : element.assetId;
    const texture = assetId ? this.player.assetTextures.get(assetId) : undefined;
    if (texture) {
      this.sprite.texture = texture;
      if (character?.kind === "bitmap") {
        this.sprite.width = character.width;
        this.sprite.height = character.height;
      }
    }
  }

  private applyBlendMode(mode: BlendModeIR): void {
    try {
      this.container.blendMode = mode as typeof this.container.blendMode;
    } catch {
      this.container.blendMode = "normal";
      this.player.report(`blend mode ${mode} is not available`);
    }
  }

  private clearContent(): void {
    this.child?.destroy();
    this.child = undefined;
    this.childTimelineId = undefined;
    this.graphics?.destroy();
    this.graphics = undefined;
    this.shapeId = undefined;
    this.text?.destroy();
    this.text = undefined;
    this.sprite?.destroy();
    this.sprite = undefined;
  }

  destroy(): void {
    this.clearContent();
    releaseFilters(this.filterState);
    this.colorFilter = null;
    this.container.destroy({ children: true });
  }
}

class LayerView {
  readonly container = new Container();
  readonly layer: LayerIR;
  private readonly player: XflPlayer;
  private readonly depth: number;
  private readonly views = new Map<string, ElementView>();
  private filterState: FilterState = {};
  private filterKey = "";
  private orderKey = "";

  constructor(player: XflPlayer, layer: LayerIR, depth: number) {
    this.player = player;
    this.layer = layer;
    this.depth = depth;
    this.container.label = layer.name;
  }

  update(frame: number, globalFrame: number): void {
    const resolved = evaluateLayerFrame(this.layer, frame);
    if (!resolved) {
      this.container.visible = false;
      return;
    }
    this.container.visible = this.layer.visible && this.layer.type !== "folder" && this.layer.type !== "guide";
    this.applyBlendMode(resolved.blendMode);

    if (resolved.filters && resolved.filters.length > 0) {
      const key = JSON.stringify(resolved.filters);
      if (key !== this.filterKey) {
        this.filterKey = key;
        const { filters, notes } = buildFilters(resolved.filters);
        for (const note of notes) this.player.report(note);
        applyFilters(this.container, filters, key, this.filterState);
      }
    } else if (this.filterKey) {
      this.filterKey = "";
      applyFilters(this.container, undefined, "", this.filterState);
    }

    const active = new Set<string>();
    for (const element of resolved.elements) {
      active.add(element.id);
      let view = this.views.get(element.id);
      if (!view || view.elementKind !== element.kind) {
        view?.destroy();
        view = new ElementView(this.player, element, this.depth);
        this.views.set(element.id, view);
      }
      view.update(element, frame, globalFrame);
    }

    for (const [id, view] of this.views) {
      if (active.has(id)) continue;
      view.container.visible = false;
    }

    const order = resolved.elements.map((element) => element.id).join(",");
    if (order !== this.orderKey) {
      this.orderKey = order;
      for (const element of resolved.elements) {
        const view = this.views.get(element.id);
        if (view) this.container.addChild(view.container);
      }
      for (const [id, view] of this.views) {
        if (!active.has(id) && view.container.parent === this.container) {
          this.container.removeChild(view.container);
        }
      }
    }
  }

  private applyBlendMode(mode: BlendModeIR | undefined): void {
    const applied = mode ?? "inherit";
    try {
      this.container.blendMode = applied as typeof this.container.blendMode;
    } catch {
      this.container.blendMode = "normal";
      this.player.report(`blend mode ${applied} is not available on layer ${this.layer.name}`);
    }
  }

  destroy(): void {
    for (const view of this.views.values()) {
      if (view.container.parent === this.container) {
        this.container.removeChild(view.container);
      }
      view.destroy();
    }
    this.views.clear();
    releaseFilters(this.filterState);
    this.container.destroy();
  }
}

class TimelineView {
  readonly container = new Container();
  private readonly player: XflPlayer;
  private readonly timeline: TimelineIR;
  private readonly depth: number;
  private readonly layers: LayerView[] = [];
  private lastFrame = -1;

  constructor(player: XflPlayer, timeline: TimelineIR, depth: number) {
    this.player = player;
    this.timeline = timeline;
    this.depth = depth;
    this.container.label = timeline.name;
    for (const layer of timeline.layers) {
      const view = new LayerView(player, layer, depth);
      this.layers.push(view);
      this.container.addChild(view.container);
    }
    this.applyMasks();
  }

  private applyMasks(): void {
    for (const layerView of this.layers) {
      const parent = layerView.layer.parentIndex;
      if (parent === undefined) continue;
      const maskLayer = this.layers.find(
        (candidate) => candidate.layer.type === "mask" && candidate.layer.index === parent,
      );
      if (maskLayer) layerView.container.mask = maskLayer.container;
    }
    // Some XFL writers put parentLayerIndex on the mask layer instead.
    for (const maskLayer of this.layers) {
      if (maskLayer.layer.type !== "mask") continue;
      const parent = maskLayer.layer.parentIndex;
      if (parent === undefined) continue;
      const masked = this.layers.find((candidate) => candidate.layer.index === parent);
      if (masked) masked.container.mask = maskLayer.container;
    }
  }

  update(frame: number, globalFrame: number): void {
    if (this.lastFrame === frame) return;
    this.lastFrame = frame;
    for (const layer of this.layers) {
      layer.update(frame, globalFrame);
    }
  }

  getLayerContainers(): Map<string, Container> {
    const map = new Map<string, Container>();
    for (const view of this.layers) map.set(view.layer.name, view.container);
    return map;
  }

  destroy(): void {
    for (const layer of this.layers) {
      if (layer.container.parent === this.container) {
        this.container.removeChild(layer.container);
      }
      layer.destroy();
    }
    this.layers.length = 0;
    this.container.destroy();
  }
}

function timelineContentBounds(project: ProjectIR, timeline: TimelineIR): Rect {
  let bounds: Rect | null = null;
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

export class XflPlayer {
  readonly project: ProjectIR;
  readonly root = new Container();
  readonly shapeCache: ShapeContextCache;
  readonly assetTextures = new Map<string, Texture>();
  readonly scene: SceneIR;
  readonly bounds: { x: number; y: number; width: number; height: number };
  readonly fps: number;
  readonly totalFrames: number;
  private readonly mainView: TimelineView;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly reported = new Set<string>();
  private readonly loop: boolean;
  private currentFrame = 0;
  private accumulator = 0;
  playing = false;

  /**
   * Asynchronous factory: preloads embedded bitmap textures, then builds the
   * scene. Prefer this when IR contains bitmap assets.
   */
  static async create(
    project: ProjectIR,
    options: XflPlayerOptions = {},
  ): Promise<XflPlayer> {
    const textures = new Map<string, Texture>();
    await Promise.all(
      project.assets
        .filter((asset) => asset.data && asset.kind === "bitmap")
        .map(async (asset) => {
          try {
            const mime = asset.mimeType ?? "image/png";
            const texture = (await Assets.load(
              `data:${mime};base64,${asset.data}`,
            )) as Texture;
            if (texture) textures.set(asset.id, texture);
          } catch (error) {
            options.onDiagnostic?.(
              `failed to load texture for ${asset.id}: ${(error as Error).message}`,
            );
          }
        }),
    );
    return new XflPlayer(project, { ...options, textures });
  }

  constructor(project: ProjectIR, options: XflPlayerOptions = {}) {
    this.project = project;
    this.fps = project.stage.frameRate > 0 ? project.stage.frameRate : 30;
    this.onDiagnostic = options.onDiagnostic;
    this.loop = options.loop ?? true;
    const character = options.characterId
      ? project.library[options.characterId] ??
        Object.values(project.library).find(
          (item) => item.kind === "symbol" && item.name === options.characterId,
        )
      : undefined;
    if (character?.kind === "symbol") {
      this.scene = {
        id: `character:${character.id}`,
        name: character.name,
        frameCount: character.timeline.frameCount,
        timeline: character.timeline,
      };
      this.bounds = character.bounds;
    } else {
      this.scene =
        project.scenes.find((candidate) => candidate.id === options.sceneId) ??
        project.scenes[0] ??
        {
          id: "scene:empty",
          name: "Empty",
          frameCount: 1,
          timeline: { id: "timeline:empty", name: "Empty", frameCount: 1, layers: [], labels: [] },
        };
      this.bounds = { x: 0, y: 0, width: project.stage.width, height: project.stage.height };
    }
    this.totalFrames = Math.max(1, this.scene.frameCount);
    if (options.fitContent) {
      this.bounds = timelineContentBounds(project, this.scene.timeline);
    }
    if (options.textures) {
      for (const [id, texture] of options.textures) this.assetTextures.set(id, texture);
    }
    this.shapeCache =
      options.shapeCache ??
      new ShapeContextCache({
        onWarning: (message) => this.report(message),
        getTexture: (assetId) => this.assetTextures.get(assetId),
      });
    this.root.label = "xfl-scene-root";
    this.mainView = new TimelineView(this, this.scene.timeline, 0);
    this.root.addChild(this.mainView.container);
    this.applyFrame(0);
    if (options.autoPlay) this.playing = true;
  }

  get frame(): number {
    return this.currentFrame;
  }

  report(message: string): void {
    if (this.reported.has(message)) return;
    this.reported.add(message);
    this.onDiagnostic?.(message);
  }

  play(): void {
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  toggle(): void {
    this.playing = !this.playing;
  }

  stop(): void {
    this.playing = false;
    this.seek(0);
  }

  seek(frame: number): void {
    const target = Math.max(0, Math.min(this.totalFrames - 1, Math.trunc(frame)));
    this.currentFrame = target;
    this.applyFrame(target);
  }

  /** Advance by wall-clock time. Call from a Pixi Ticker or your own loop. */
  update(deltaMs: number): void {
    if (!this.playing || deltaMs <= 0) return;
    this.accumulator += deltaMs;
    const frameDuration = 1000 / this.fps;
    let guard = 0;
    while (this.accumulator >= frameDuration && guard++ < 10) {
      this.accumulator -= frameDuration;
      let next = this.currentFrame + 1;
      if (next >= this.totalFrames) {
        if (!this.loop) {
          this.playing = false;
          next = this.totalFrames - 1;
        } else {
          next = 0;
        }
      }
      this.applyFrame(next);
    }
  }

  private applyFrame(frame: number): void {
    this.currentFrame = frame;
    this.mainView.update(frame, frame);
  }

  /** Top-level animation layers, keyed by name. Exposed for custom assembly. */
  get layerContainers(): Map<string, Container> {
    return this.mainView.getLayerContainers();
  }


  destroy(): void {
    this.root.removeChildren();
    this.mainView.destroy();
    this.shapeCache.destroy();
    for (const texture of this.assetTextures.values()) texture.destroy(true);
    this.assetTextures.clear();
    this.root.destroy();
  }
}
