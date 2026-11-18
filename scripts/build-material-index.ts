#!/usr/bin/env -S npx tsx
/**
 * Build a human + machine readable index of the local XFL material pack.
 *
 *   MATERIAL_SOURCE_DIR=INPUT MATERIAL_OUTPUT_DIR=OUTPUT pnpm exec tsx scripts/build-material-index.ts
 *   Options: --force, --limit N, --only TEXT, --no-preview
 *   Optional metadata: MATERIAL_PREP_CATALOG
 *
 * For every .fla the compiler produces an IR; we keep only index-relevant
 * metadata (never the full IR):
 *   - tags (category / genre / kind / capability / role)
 *   - library entries and stage sections of collection assets
 *   - animation capabilities (tweens, frame-by-frame, symbols, labels, sound)
 *   - diagnostics grouped by code, with parse anomalies separated from
 *     intentional P0/P1 limitations
 *   - one PNG preview (xfl2svg + rsvg-convert)
 *
 * Raster materials get PNG thumbnails and dimensions; the .rar is listed as an
 * archive. The per-file cache makes the run resumable.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { chromium } from "playwright";
import { compileXfl, projectToSvg } from "../packages/xfl-compiler/src/index.ts";
import { validateProjectIR } from "../packages/character-ir/src/index.ts";
import type {
  ProjectIR,
  SymbolCharacterIR,
  TimelineIR,
} from "../packages/character-ir/src/index.ts";

const sourceDir = process.env.MATERIAL_SOURCE_DIR;
const outputDir = process.env.MATERIAL_OUTPUT_DIR;
if (!sourceDir || !outputDir) {
  throw new Error("Set MATERIAL_SOURCE_DIR and MATERIAL_OUTPUT_DIR before building the material index.");
}
const SOURCE_ROOT = resolve(sourceDir);
const OUT_ROOT = resolve(outputDir);
const CACHE_ROOT = join(OUT_ROOT, ".cache", createHash("sha1").update(SOURCE_ROOT).digest("hex"));
const CACHE_VERSION = 4;
const FIXED_TIME = "2026-01-01T00:00:00.000Z";
const PREVIEW_MAX = 560;
const IMAGE_PREVIEW_MAX = 480;

const CATEGORY_ORDER = [
  "characters-xianxia",
  "characters-urban",
  "expressions",
  "props",
  "effects",
  "scenes",
  "reference",
  "root",
] as const;

type Category = (typeof CATEGORY_ORDER)[number];

const CATEGORY_LABEL: Record<Category, string> = {
  "characters-xianxia": "修仙人物",
  "characters-urban": "都市人物",
  expressions: "表情",
  props: "道具 / 异兽",
  effects: "特效库",
  scenes: "场景图",
  reference: "手型参考",
  root: "根目录 / 其他",
};

interface ParsedArgs {
  force: boolean;
  limit: number | null;
  only: string | null;
  preview: boolean;
}

interface Anomaly {
  severity: "fatal" | "error" | "warning" | "info";
  code: string;
  message: string;
  count?: number;
  source: "compile" | "ir" | "diagnostic" | "preview" | "file" | "image" | "archive";
}

interface Limitation {
  code: string;
  level: string;
  count: number;
  message: string;
}

interface EntryRecord {
  name: string;
  folder: string;
  type: "graphic" | "movieclip" | "button";
  frames: number;
  layers: number;
  bounds: { x: number; y: number; width: number; height: number };
  animated: boolean;
  tweens: { motion: number; shape: number };
  labels: string[];
  children: number;
  usedBy: number;
  onStage: boolean;
  role: "stage" | "child" | "library" | "orphan";
}

interface SectionRecord {
  frame: number;
  duration: number;
  entries: string[];
}

interface MaterialFile {
  id: string;
  path: string;
  name: string;
  displayName: string;
  variantHash?: string;
  category: Category;
  categoryLabel: string;
  kind: "fla" | "image" | "archive";
  format: string;
  bytes: number;
  mtimeMs?: number;
  sha256: string;
  tags: string[];
  tagGroups: Record<string, string[]>;
  summary: string;
  status: "ok" | "warning" | "error";
  parse?: {
    ok: boolean;
    anomalyCount: number;
    compileMs: number;
    irVersion?: string;
    validation?: { ok: boolean; errors: number; warnings: number };
    error?: string;
  };
  stage?: { width: number; height: number; frameRate: number; backgroundColor?: string; durationSec: number };
  scenes?: { name: string; frames: number; layers: number; labels: { name: string; frame: number }[] }[];
  animation?: {
    frameCount: number;
    frameRate: number;
    durationSec: number;
    totalSymbols: number;
    animatedSymbols: number;
    maxSymbolFrames: number;
    tweenCounts: { motion: number; shape: number };
    frameByFrame: boolean;
    labels: { name: string; frame: number; timeline: string }[];
    loopModes: string[];
    hasSound: boolean;
    hasText: boolean;
    hasScript: boolean;
    hasMask: boolean;
    filters: number;
    features: Record<string, boolean>;
    capabilities: string[];
  };
  library?: {
    total: number;
    symbols: number;
    movieclips: number;
    graphics: number;
    buttons: number;
    bitmaps: number;
    texts: number;
    sounds: number;
    folders: { name: string; count: number; animated: number; maxFrames: number }[];
    maxLayers: number;
    entries: EntryRecord[];
  };
  collection?: {
    isCollection: boolean;
    reasons: string[];
    entryCount: number;
    stageEntryCount: number;
    orphanEntries: number;
    folderGroups: { name: string; count: number; animated: number; maxFrames: number; stageCount: number }[];
    sections: SectionRecord[];
  };
  container?: {
    entries: number;
    bytes: number;
    byExtension: Record<string, number>;
    byTopLevel: Record<string, number>;
  };
  assets?: { total: number; bitmaps: number; sounds: number; fonts: number; videos: number };
  diagnostics?: {
    total: number;
    info: number;
    warn: number;
    error: number;
    byCode: { code: string; level: string; count: number; message: string }[];
  };
  anomalies: Anomaly[];
  limitations: Limitation[];
  notes: string[];
  duplicates?: string[];
  preview?: { path: string; frame: number; width: number; height: number; format: "png"; method: string };
  image?: {
    width: number;
    height: number;
    format: string;
    mode: string;
    pair?: string;
  };
  archive?: { entries: number; sample: string[]; note: string };
  prep?: PrepRecord;
}

interface PrepRecord {
  kind: "character" | "expression" | "background" | "prop" | "fx" | "hand_reference" | "audio" | "font" | "archive" | "other";
  status: "available" | "invalid" | "pending";
  absPath: string;
  capabilities: Record<string, unknown>;
  provenance: { origin: string; license: string; source_url: string | null; author: string | null; retrieved_at: string | null };
  project: string | null;
}

interface ImageThumb {
  src: string;
  out: string;
  ok: boolean;
  width: number | null;
  height: number | null;
  thumb_width: number | null;
  thumb_height: number | null;
  format: string | null;
  mode: string | null;
  bytes: number | null;
  sha256: string | null;
  error: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { force: false, limit: null, only: null, preview: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") args.force = true;
    else if (arg === "--no-preview") args.preview = false;
    else if (arg === "--limit") args.limit = Number(argv[++i] ?? "0") || null;
    else if (arg === "--only") args.only = argv[++i] ?? null;
  }
  return args;
}

function sanitizeStem(name: string): string {
  return name
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Filesystem-safe, length-bounded stem; long names get a short hash suffix. */
function safeFileStem(name: string, max = 80): string {
  const stem = sanitizeStem(name);
  if (stem.length <= max) return stem;
  const digest = createHash("sha1").update(stem).digest("hex").slice(0, 8);
  return `${stem.slice(0, max - 9)}-${digest}`;
}

function displayNameFor(fileName: string): { displayName: string; variantHash?: string } {
  const stem = fileName.replace(/\.[^.]+$/, "");
  const hashMatch = /([0-9a-f]{32})$/i.exec(stem);
  const variantHash = hashMatch ? hashMatch[1]!.slice(0, 8) : undefined;
  const displayName = stem
    .replace(/[0-9a-f]{32}$/i, "")
    .replace(/[-_\s]+$/, "")
    .trim() || stem;
  return { displayName, variantHash };
}

function categoryFor(rel: string, fileName: string): Category {
  const top = rel.split("/")[0] ?? "";
  if (top.endsWith("修仙人物") || top === "键盘") return "characters-xianxia";
  if (/都市(?:人物)?$/.test(top)) return "characters-urban";
  if (top === "表情") return "expressions";
  if (top === "道具") return "props";
  if (top === "170张古代战场场景") return "scenes";
  if (rel.includes("/")) return "root";
  if (fileName.includes("手型")) return "reference";
  if (fileName.includes("特效") || fileName.includes("地裂")) return "effects";
  return "root";
}

const PREP_CATALOG = process.env.MATERIAL_PREP_CATALOG;

async function loadPrepCatalog(): Promise<Map<string, any>> {
  if (!PREP_CATALOG) return new Map();
  try {
    const raw = JSON.parse(await readFile(PREP_CATALOG, "utf8"));
    const map = new Map<string, any>();
    for (const key of ["characters", "expressions", "effects", "hand_reference", "props"]) {
      for (const item of raw[key] ?? []) {
        if (item?.path) map.set(String(item.path), item);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function prepKindFor(file: MaterialFile): PrepRecord["kind"] {
  if (file.kind === "archive") return "archive";
  switch (file.category) {
    case "characters-xianxia":
    case "characters-urban": return "character";
    case "expressions": return "expression";
    case "scenes": return "background";
    case "props": return "prop";
    case "effects": return "fx";
    case "reference": return "hand_reference";
    default: return "other";
  }
}

function buildPrep(file: MaterialFile, catalog: Map<string, any>): PrepRecord {
  const kind = prepKindFor(file);
  const item = catalog.get(file.path) ?? {};
  const caps: Record<string, unknown> = {};
  for (const key of [
    "pose_count", "max_layers", "arm_layers", "has_wings", "has_weapon",
    "separated_legs", "masks", "poses", "capability_tier", "stage",
    "symbols", "symbol_count", "layered_count", "bitmaps", "error",
  ]) {
    const value = item[key];
    if (value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) caps[key] = value;
  }
  if (kind === "character" && !caps.poses && file.library?.entries) {
    caps.poses = file.library.entries
      .filter((entry) => entry.role === "stage" && entry.layers >= 2)
      .map((entry) => ({ name: entry.name, layers: entry.layers }));
  }
  if ((kind === "expression" || kind === "fx") && !caps.symbols && file.library?.entries) {
    caps.symbols = file.library.entries.map((entry) => entry.name);
  }
  if (file.library?.maxLayers && caps.max_layers === undefined) caps.max_layers = file.library.maxLayers;
  if (file.image) {
    caps.width = file.image.width;
    caps.height = file.image.height;
  }
  return {
    kind,
    status: file.status === "error" || item.error ? "invalid" : "available",
    absPath: join(SOURCE_ROOT, file.path),
    capabilities: caps,
    provenance: {
      origin: "local_pack",
      license: "unknown",
      source_url: null,
      author: null,
      retrieved_at: null,
    },
    project: null,
  };
}

function semanticKind(file: MaterialFile): string {
  const n = file.displayName;
  if (file.category === "expressions") return "表情";
  if (file.category === "scenes") return "场景";
  if (file.category === "reference") return "手型";
  if (file.category === "effects") return "特效";
  if (n.startsWith("人物图") || n.includes("人物图-")) return "人物";
  if (file.category === "characters-xianxia" || file.category === "characters-urban") return "人物";
  if (file.category === "props") {
    if (n.includes("怪兽") || n.includes("异兽")) return "异兽";
    return "道具";
  }
  return "其他";
}

function roleTags(name: string): string[] {
  const tags: string[] = [];
  if (/男|男孩|男子|少年|先生|大叔|爷爷|老头/.test(name)) tags.push("男性");
  if (/女|女孩|女子|女生|少女|阿姨|奶奶|姐|妹/.test(name)) tags.push("女性");
  if (/老|爷|奶|婆|翁/.test(name)) tags.push("老年");
  if (/小|童|婴|萝莉/.test(name)) tags.push("少年儿童");
  const roles: [RegExp, string][] = [
    [/学生/, "学生"],
    [/老师|教师|教授/, "教师"],
    [/医生|大夫|护士/, "医护"],
    [/警察|警花|民警|刑警/, "警察"],
    [/法官|律师|检察官/, "司法"],
    [/犯人|囚犯|罪犯|小偷|抢劫/, "罪犯"],
    [/保镖|保安|护卫/, "安保"],
    [/老板|总裁|经理|董事长/, "老板"],
    [/白领|秘书|职员|售货员|服务员/, "职场"],
    [/歌手|明星|网红/, "演艺"],
    [/运动员|体育/, "运动员"],
    [/军人|士兵|将军|将军/, "军人"],
    [/司机|快递|外卖/, "交通服务"],
    [/工人|农民|厨师|乞丐|包租婆/, "市井"],
  ];
  for (const [pattern, tag] of roles) if (pattern.test(name)) tags.push(tag);
  return tags;
}

function addTags(set: Set<string>, values: Iterable<string>): void {
  for (const value of values) if (value) set.add(value);
}

function tagGroupsFor(tags: string[]): Record<string, string[]> {
  const groups: Record<string, string[]> = { 分类: [], 题材: [], 类型: [], 能力: [], 角色: [], 备注: [] };
  const classification = new Set(["修仙人物", "都市人物", "道具", "场景", "特效", "表情", "手型", "手型参考", "键盘", "其他"]);
  const genre = new Set(["修仙", "玄幻", "都市", "现代", "古代", "历史", "战场"]);
  const kind = new Set(["人物", "角色", "表情", "道具", "武器", "翅膀", "书籍", "怪兽", "异兽", "场景", "特效", "手型", "合集", "单件", "图片", "压缩包", "重复内容"]);
  const capability = new Set([
    "矢量", "位图", "序列帧", "逐帧动画", "补间动画", "形状补间", "符号动画", "时间轴动画",
    "滤镜", "渐变", "蒙版", "音频", "文本", "静态", "多图层", "多姿态", "多条目", "循环播放", "单次播放",
  ]);
  const notes = new Set(["命名不一致", "重复内容", "双格式", "参考", "解析失败"]);
  for (const tag of tags) {
    if (notes.has(tag)) groups.备注!.push(tag);
    else if (classification.has(tag)) groups.分类!.push(tag);
    else if (genre.has(tag)) groups.题材!.push(tag);
    else if (kind.has(tag)) groups.类型!.push(tag);
    else if (capability.has(tag)) groups.能力!.push(tag);
    else groups.角色!.push(tag);
  }
  return groups;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}

function mdCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function mdLink(text: string, target: string): string {
  return `[${text}](<${target}>)`;
}

function statusIcon(status: string): string {
  return status === "error" ? "❌" : status === "warning" ? "⚠️" : "✅";
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const dir = rel ? join(root, rel) : root;
  const items = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const item of items.sort((a, b) => a.name.localeCompare(b.name, "zh"))) {
    const next = rel ? join(rel, item.name) : item.name;
    if (item.isDirectory()) files.push(...(await walk(root, next)));
    else if (item.isFile()) files.push(next);
  }
  return files;
}

async function rasterizeWithBrowser(
  svg: string,
  out: string,
  width: number,
  height: number,
): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await page.screenshot({ path: out, omitBackground: true });
    await page.close();
  } finally {
    await browser.close();
  }
}

async function rasterize(
  svg: string,
  out: string,
  width: number,
  height: number,
): Promise<"rsvg" | "chromium"> {
  // librsvg ignores CSS mix-blend-mode; use Chromium for layered blend modes.
  if (svg.includes("mix-blend-mode")) {
    try {
      await rasterizeWithBrowser(svg, out, width, height);
      return "chromium";
    } catch (error) {
      process.stderr.write(
        `chromium rasterize failed for ${out}: ${(error as Error).message}; falling back to rsvg\n`,
      );
    }
  }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("rsvg-convert", ["-o", out], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("rsvg-convert timed out"));
    }, 180_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `rsvg-convert exited with ${code}`));
    });
    child.stdin.end(svg);
  });
  return "rsvg";
}

function parseViewBox(svg: string): { width: number; height: number } | null {
  const match = /viewBox="([^"]+)"/.exec(svg);
  if (!match) return null;
  const parts = match[1]!.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) return null;
  return { width: parts[2]!, height: parts[3]! };
}

function setSvgSize(svg: string, width: number, height: number): string {
  const opening = /^<svg[^>]*>/.exec(svg);
  if (!opening) return svg;
  const tag = opening[0]
    .replace(/\swidth="[^"]*"/, ` width="${width}"`)
    .replace(/\sheight="[^"]*"/, ` height="${height}"`);
  return tag + svg.slice(opening[0].length);
}

function chooseFrame(project: ProjectIR): { frame: number; fitContent: boolean } {
  const scene = project.scenes[0];
  if (!scene) return { frame: 0, fitContent: false };
  if (scene.frameCount <= 1) return { frame: 0, fitContent: true };
  const keyframes = scene.timeline.layers.flatMap((layer) => layer.frames);
  // A single long keyframe usually wraps a nested graphic/movieclip animation
  // (e.g. a 140-frame frame-by-frame crack). Frame 0 is often just the seed
  // frame, so preview the nested sequence around its midpoint instead.
  if (keyframes.length === 1 && keyframes[0]!.duration > 1) {
    const instance = keyframes[0]!.elements.find(
      (element) => element.kind === "instance" && element.characterId,
    );
    const child = instance?.characterId ? project.library[instance.characterId] : undefined;
    const childFrames = child?.kind === "symbol" ? child.timeline.frameCount : 0;
    const frame = childFrames > 0 ? Math.floor(childFrames / 2) : Math.floor(scene.frameCount / 2);
    return { frame: Math.min(frame, scene.frameCount - 1), fitContent: false };
  }
  let best = 0;
  let bestScore = -1;
  for (const layer of scene.timeline.layers) {
    for (const keyframe of layer.frames) {
      const score = keyframe.elements.length * 10_000 + Math.min(keyframe.duration, 1000);
      if (score > bestScore) {
        bestScore = score;
        best = keyframe.index;
      }
    }
  }
  return { frame: Math.min(best, scene.frameCount - 1), fitContent: false };
}

async function renderPreview(
  project: ProjectIR,
  outPath: string,
  forceFitContent = false,
): Promise<{ path: string; frame: number; width: number; height: number; method: string } | null> {
  const chosen = chooseFrame(project);
  const frame = chosen.frame;
  const fitContent = forceFitContent || chosen.fitContent;
  let svg = projectToSvg(project, { frame, fitContent });
  const box = parseViewBox(svg);
  if (!box) return null;
  let width = box.width;
  let height = box.height;
  if (!(width > 0) || !(height > 0)) {
    width = project.stage.width;
    height = project.stage.height;
    svg = projectToSvg(project, { frame, fitContent: false });
    const fallback = parseViewBox(svg);
    if (fallback) {
      width = fallback.width;
      height = fallback.height;
    }
  }
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(PREVIEW_MAX / width, PREVIEW_MAX / height);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  svg = setSvgSize(svg, outWidth, outHeight);
  await mkdir(dirname(outPath), { recursive: true });
  const method = await rasterize(svg, outPath, outWidth, outHeight);
  return {
    path: outPath,
    frame,
    width: outWidth,
    height: outHeight,
    method: method === "chromium" ? "xfl2svg + Chromium" : "xfl2svg + rsvg-convert",
  };
}

interface TimelineScan {
  motion: number;
  shape: number;
  filters: number;
  sounds: number;
  scripts: number;
  labels: { name: string; frame: number; timeline: string }[];
  loopModes: Set<string>;
  texts: number;
  masks: number;
  keyframes: number;
  frameByFrame: boolean;
  maxLayers: number;
}

function scanTimeline(timeline: TimelineIR): TimelineScan {
  const scan: TimelineScan = {
    motion: 0,
    shape: 0,
    filters: 0,
    sounds: 0,
    scripts: 0,
    labels: [],
    loopModes: new Set(),
    texts: 0,
    masks: 0,
    keyframes: 0,
    frameByFrame: false,
    maxLayers: timeline.layers.length,
  };
  for (const layer of timeline.layers) {
    if (layer.type === "mask") scan.masks++;
    scan.keyframes += layer.frames.length;
    if (
      timeline.frameCount >= 2 &&
      layer.frames.length >= Math.max(2, Math.ceil(timeline.frameCount * 0.75))
    ) {
      scan.frameByFrame = true;
    }
    for (const frame of layer.frames) {
      if (frame.tween?.type === "motion") scan.motion++;
      else if (frame.tween?.type === "shape") scan.shape++;
      scan.filters += frame.filters?.length ?? 0;
      scan.sounds += frame.sound?.length ?? 0;
      if (frame.script) scan.scripts++;
      if (frame.label) scan.labels.push({ name: frame.label, frame: frame.index, timeline: timeline.name });
      for (const element of frame.elements) {
        scan.filters += element.filters?.length ?? 0;
        if (element.loopMode) scan.loopModes.add(element.loopMode);
        if (element.kind === "text") scan.texts++;
      }
    }
  }
  return scan;
}

function gradientCount(project: ProjectIR): number {
  let count = 0;
  for (const shape of Object.values(project.shapes)) {
    for (const fill of shape.fills) {
      if (fill.kind === "linear-gradient" || fill.kind === "radial-gradient") count++;
    }
  }
  return count;
}

const PARSE_ANOMALY_EXACT = new Set([
  "BITMAP_DAT_UNSUPPORTED",
  "BITMAP_DAT_DECODE_FAILED",
  "BITMAP_NOT_FOUND",
  "NO_SCENES",
  "SHAPE_EMPTY",
  "STROKE_STYLE_MISSING",
  "FILL_STYLE_MISSING",
  "ELEMENT_UNKNOWN",
  "TWEEN_UNKNOWN",
  "SYMBOL_PARSE_FAILED",
  "XFL_EMPTY_LAYER",
]);
const PARSE_ANOMALY_PREFIXES = ["ZIP_", "XFL_", "EDGE_", "FILL_", "SYMBOL_"];
const LIMITATION_PREFIXES = [
  "CUBICS_",
  "SHAPE_TWEEN",
  "MORPH_",
  "MEDIA_P1",
  "FILTER_",
  "GRADIENT_",
  "BITMAP_FILL",
  "RIG_",
  "CAMERA_LAYER",
  "LAYER_RIGGING",
  "BLEND_MODE",
  "MOTION_OBJECT_TWEEN",
  "VARIABLE_STROKE",
  "SVG_DEPTH",
];
const LIMITATION_EXACT = new Set(["XFL_STROKE_FILL", "XFL_STROKE_KIND", "XFL_UNKNOWN_STROKE", "XFL_UNKNOWN_FILL"]);
/** Container quirks that the tolerant reader handles; annotated, not a warning. */
const BENIGN_ANOMALY = new Set([
  "ZIP_EOCD_SIZE_MISMATCH",
  "ZIP_DUPLICATE_ENTRY",
  "ZIP_CD_SCANNED",
  "SYMBOL_DUPLICATE_NAME",
  "XFL_MIMETYPE_MISSING",
  "XFL_EMPTY_LAYER",
  "SHAPE_EMPTY",
]);

function classifyDiagnostic(level: string, code: string): "anomaly" | "limitation" | "notice" {
  if (level === "error") return "anomaly";
  if (LIMITATION_EXACT.has(code)) return "limitation";
  if (LIMITATION_PREFIXES.some((prefix) => code.startsWith(prefix)) && !PARSE_ANOMALY_EXACT.has(code)) {
    return "limitation";
  }
  if (level === "warn" && (PARSE_ANOMALY_EXACT.has(code) || PARSE_ANOMALY_PREFIXES.some((prefix) => code.startsWith(prefix)))) {
    return "anomaly";
  }
  if (level === "warn") return "limitation";
  return "notice";
}

function buildPreviewNames(rels: string[]): Map<string, string> {
  const byBase = new Map<string, string[]>();
  for (const rel of rels) {
    const fileName = basename(rel);
    const category = categoryFor(rel, fileName);
    const key = `${category}/${safeFileStem(fileName.replace(/\.[^.]+$/, ""))}`;
    const list = byBase.get(key) ?? [];
    list.push(rel);
    byBase.set(key, list);
  }
  const names = new Map<string, string>();
  for (const [key, list] of byBase) {
    if (list.length === 1) {
      names.set(list[0]!, `${key}.png`);
      continue;
    }
    for (const rel of list) {
      const suffix = createHash("sha1").update(rel).digest("hex").slice(0, 8);
      names.set(rel, `${key}-${suffix}.png`);
    }
  }
  return names;
}

async function extractFla(
  abs: string,
  rel: string,
  bytes: number,
  mtimeMs: number,
  sha256: string,
  previewFile: string | undefined,
  args: ParsedArgs,
): Promise<{ file: MaterialFile; compileMs: number }> {
  const fileName = basename(abs);
  const { displayName, variantHash } = displayNameFor(fileName);
  const category = categoryFor(rel, fileName);
  const categoryLabel = CATEGORY_LABEL[category];
  const base: MaterialFile = {
    id: rel,
    path: rel,
    name: fileName,
    displayName,
    ...(variantHash ? { variantHash } : {}),
    category,
    categoryLabel,
    kind: "fla",
    format: "fla",
    bytes,
    mtimeMs,
    sha256,
    tags: [],
    tagGroups: {},
    summary: "",
    status: "ok",
    anomalies: [],
    limitations: [],
    notes: [],
  };
  const started = performance.now();
  try {
    const { project, container } = await compileXfl(abs, { generatedAt: FIXED_TIME });
    const compileMs = Math.round(performance.now() - started);
    const scene = project.scenes[0];
    const symbols = Object.values(project.library).filter(
      (character): character is SymbolCharacterIR => character.kind === "symbol",
    );
    const scenes = project.scenes.map((item) => ({
      name: item.name,
      frames: item.frameCount,
      layers: item.timeline.layers.length,
      labels: item.timeline.labels.map((label) => ({ name: label.name, frame: label.frame })),
    }));
    const timelines: TimelineIR[] = [
      ...project.scenes.map((item) => item.timeline),
      ...symbols.map((symbol) => symbol.timeline),
    ];
    const scans = timelines.map(scanTimeline);
    const totals = scans.reduce(
      (sum, scan) => ({
        motion: sum.motion + scan.motion,
        shape: sum.shape + scan.shape,
        filters: sum.filters + scan.filters,
        sounds: sum.sounds + scan.sounds,
        scripts: sum.scripts + scan.scripts,
        texts: sum.texts + scan.texts,
        masks: sum.masks + scan.masks,
        keyframes: sum.keyframes + scan.keyframes,
        maxLayers: Math.max(sum.maxLayers, scan.maxLayers),
        frameByFrame: sum.frameByFrame || scan.frameByFrame,
        loopModes: new Set([...sum.loopModes, ...scan.loopModes]),
      }),
      {
        motion: 0,
        shape: 0,
        filters: 0,
        sounds: 0,
        scripts: 0,
        texts: 0,
        masks: 0,
        keyframes: 0,
        maxLayers: 0,
        frameByFrame: false,
        loopModes: new Set<string>(),
      },
    );
    const labels = scans.flatMap((scan) => scan.labels);
    const frameCount = scene?.frameCount ?? 0;

    // child usage + stage usage
    const usedBy = new Map<string, number>();
    for (const symbol of symbols) {
      for (const layer of symbol.timeline.layers) {
        for (const frame of layer.frames) {
          for (const element of frame.elements) {
            if (element.characterId) usedBy.set(element.characterId, (usedBy.get(element.characterId) ?? 0) + 1);
          }
        }
      }
    }
    const onStage = new Set<string>();
    for (const item of project.scenes) {
      for (const layer of item.timeline.layers) {
        for (const frame of layer.frames) {
          for (const element of frame.elements) {
            if (element.characterId) onStage.add(element.characterId);
          }
        }
      }
    }

    const entries: EntryRecord[] = [];
    const folderMap = new Map<string, { count: number; animated: number; maxFrames: number; stageCount: number }>();
    for (const symbol of symbols) {
      const t = symbol.timeline;
      let motion = 0;
      let shape = 0;
      const symbolLabels: string[] = [];
      let children = 0;
      for (const layer of t.layers) {
        for (const frame of layer.frames) {
          if (frame.tween?.type === "motion") motion++;
          else if (frame.tween?.type === "shape") shape++;
          if (frame.label) symbolLabels.push(frame.label);
          for (const element of frame.elements) {
            if (element.characterId) children++;
          }
        }
      }
      const folder = symbol.name.includes("/") ? symbol.name.split("/")[0]! : "(root)";
      const onStageEntry = onStage.has(symbol.id);
      const usedByCount = usedBy.get(symbol.id) ?? 0;
      const role: EntryRecord["role"] = onStageEntry
        ? "stage"
        : usedByCount > 0
          ? "child"
          : usedByCount === 0 && !onStageEntry
            ? "orphan"
            : "library";
      entries.push({
        name: symbol.name,
        folder,
        type: symbol.symbolType,
        frames: t.frameCount,
        layers: t.layers.length,
        bounds: {
          x: round(symbol.bounds.x),
          y: round(symbol.bounds.y),
          width: round(symbol.bounds.width),
          height: round(symbol.bounds.height),
        },
        animated: t.frameCount > 1,
        tweens: { motion, shape },
        labels: [...new Set(symbolLabels)].slice(0, 20),
        children,
        usedBy: usedByCount,
        onStage: onStageEntry,
        role,
      });
      const group = folderMap.get(folder) ?? { count: 0, animated: 0, maxFrames: 0, stageCount: 0 };
      group.count++;
      if (t.frameCount > 1) group.animated++;
      group.maxFrames = Math.max(group.maxFrames, t.frameCount);
      if (onStageEntry) group.stageCount++;
      folderMap.set(folder, group);
    }
    entries.sort((a, b) => a.folder.localeCompare(b.folder, "zh") || a.name.localeCompare(b.name, "zh"));

    const animatedSymbols = entries.filter((entry) => entry.animated).length;
    const maxSymbolFrames = entries.reduce((max, entry) => Math.max(max, entry.frames), 0);
    const stageEntryCount = new Set(
      project.scenes.flatMap((item) =>
        item.timeline.layers.flatMap((layer) =>
          layer.frames.flatMap((frame) =>
            frame.elements.map((element) => element.characterId).filter((id): id is string => Boolean(id)),
          ),
        ),
      ),
    ).size;

    const isCollection =
      fileName.includes("合集") ||
      category === "expressions" ||
      category === "reference" ||
      entries.length >= 50;
    const reasons: string[] = [];
    if (fileName.includes("合集")) reasons.push("文件名含“合集”");
    if (category === "expressions") reasons.push("表情符号库");
    if (category === "reference") reasons.push("手型参考库");
    if (entries.length >= 50) reasons.push(`库内符号 ≥ 50（${entries.length}）`);

    const sections: SectionRecord[] = [];
    if (isCollection && scene) {
      const indices = [...new Set(scene.timeline.layers.flatMap((layer) => layer.frames.map((frame) => frame.index)))].sort(
        (a, b) => a - b,
      );
      for (let i = 0; i < indices.length; i++) {
        const frame = indices[i]!;
        const next = indices[i + 1] ?? scene.frameCount;
        const names = new Set<string>();
        for (const layer of scene.timeline.layers) {
          let active: (typeof layer.frames)[number] | undefined;
          for (const keyframe of layer.frames) {
            if (keyframe.index <= frame) active = keyframe;
            else break;
          }
          for (const element of active?.elements ?? []) {
            if (element.characterId) {
              const character = project.library[element.characterId];
              if (character) names.add(character.name);
            }
          }
        }
        if (names.size > 0) sections.push({ frame, duration: next - frame, entries: [...names] });
      }
    }

    const folderGroups = [...folderMap.entries()].map(([name, group]) => ({
      name,
      count: group.count,
      animated: group.animated,
      maxFrames: group.maxFrames,
      stageCount: group.stageCount,
    }));
    folderGroups.sort((a, b) => a.name.localeCompare(b.name, "zh"));

    const loopModes = [...totals.loopModes];
    const hasSound = project.assets.some((asset) => asset.kind === "sound") || totals.sounds > 0;
    const hasText = totals.texts > 0 ||
      Object.values(project.library).some((character) => character.kind === "text");
    const gradients = gradientCount(project);
    const features: Record<string, boolean> = {
      motionTween: totals.motion > 0,
      shapeTween: totals.shape > 0,
      frameByFrame: totals.frameByFrame,
      stageTimeline: frameCount > 1,
      symbolTimeline: animatedSymbols > 0,
      loop: loopModes.includes("loop"),
      playOnce: loopModes.includes("play once") || loopModes.includes("single frame"),
      sound: hasSound,
      text: hasText,
      mask: totals.masks > 0,
      filter: totals.filters > 0,
      gradient: gradients > 0,
      bitmap: project.assets.some((asset) => asset.kind === "bitmap") ||
        Object.values(project.library).some((character) => character.kind === "bitmap"),
    };
    const capabilities: string[] = [];
    if (totals.motion > 0) capabilities.push("运动补间");
    if (totals.shape > 0) capabilities.push("形状补间");
    if (totals.frameByFrame) capabilities.push("逐帧动画");
    if (animatedSymbols > 0) capabilities.push("符号动画");
    if (frameCount > 1) capabilities.push("时间轴动画");
    if (loopModes.includes("loop")) capabilities.push("循环播放");
    if (features.mask) capabilities.push("蒙版");
    if (features.filter) capabilities.push("滤镜");
    if (features.bitmap) capabilities.push("位图");
    if (capabilities.length === 0) capabilities.push("静态");

    const kind = semanticKind(base);
    const tags = new Set<string>();
    addTags(tags, [categoryLabel]);
    if (category === "characters-xianxia") addTags(tags, ["修仙人物", "修仙"]);
    if (category === "characters-urban") addTags(tags, ["都市人物", "都市"]);
    if (category === "expressions") addTags(tags, ["表情", "表情库"]);
    if (category === "scenes") addTags(tags, ["场景", "古代战场", "战场"]);
    if (category === "effects") addTags(tags, ["特效", "特效库"]);
    if (category === "reference") addTags(tags, ["手型", "参考"]);
    if (category === "props") addTags(tags, ["道具"]);
    if (rel.startsWith("键盘/")) addTags(tags, ["键盘", "修仙"]);
    if (fileName.includes("玄幻") || fileName.includes("修仙")) addTags(tags, ["玄幻", "修仙"]);
    if (fileName.includes("都市")) addTags(tags, ["都市"]);
    if (fileName.includes("历史")) addTags(tags, ["历史", "古代"]);
    if (fileName.includes("战场")) addTags(tags, ["战场", "古代"]);
    if (/武器|法宝|剑|刀|枪|弓|鞭|锤|斧|戟|矛|扇|爪|盾|法器/.test(displayName)) addTags(tags, ["武器"]);
    if (/翅膀|翼/.test(displayName)) addTags(tags, ["翅膀"]);
    if (/书籍|书|卷轴|法旨|通缉令|鉴|图鉴/.test(displayName)) addTags(tags, ["书籍"]);
    if (/怪兽|妖兽|异兽|龙|蛇|鸟|鹿|鳄|蛊|傀儡|雕像|魔|妖|鬼/.test(displayName)) addTags(tags, ["怪兽"]);
    if (/表情/.test(displayName)) addTags(tags, ["表情"]);
    if (/手型/.test(displayName)) addTags(tags, ["手型"]);
    if (isCollection) addTags(tags, ["合集"]);
    else if (kind !== "场景") addTags(tags, ["单件"]);
    if (kind === "人物") addTags(tags, ["人物"]);
    if (fileName.includes("序列帧")) addTags(tags, ["序列帧", "位图"]);
    else if (features.bitmap) addTags(tags, ["位图"]);
    if (!features.bitmap && Object.keys(project.shapes).length > 0) addTags(tags, ["矢量"]);
    if (totals.motion > 0) addTags(tags, ["补间动画"]);
    if (totals.shape > 0) addTags(tags, ["形状补间"]);
    if (totals.frameByFrame && totals.motion === 0) addTags(tags, ["逐帧动画"]);
    if (features.mask) addTags(tags, ["蒙版"]);
    if (features.filter) addTags(tags, ["滤镜"]);
    if (features.gradient) addTags(tags, ["渐变"]);
    if (hasSound) addTags(tags, ["音频"]);
    if (hasText) addTags(tags, ["文本"]);
    if (totals.maxLayers >= 5) addTags(tags, ["多图层"]);
    if (stageEntryCount >= 3 && !isCollection) addTags(tags, ["多姿态"]);
    if (isCollection && entries.length >= 20) addTags(tags, ["多条目"]);
    if (capabilities.length === 1 && capabilities[0] === "静态") addTags(tags, ["静态"]);
    if (loopModes.includes("loop")) addTags(tags, ["循环播放"]);
    if (features.playOnce && !loopModes.includes("loop")) addTags(tags, ["单次播放"]);
    if (kind === "人物") addTags(tags, roleTags(displayName));

    // diagnostics: parse anomalies vs. intentional limitations vs. notices
    const grouped = new Map<string, { code: string; level: string; count: number; message: string }>();
    for (const diagnostic of project.diagnostics) {
      const key = `${diagnostic.level}:${diagnostic.code}`;
      const current = grouped.get(key);
      if (current) current.count++;
      else {
        grouped.set(key, {
          code: diagnostic.code,
          level: diagnostic.level,
          count: 1,
          message: diagnostic.message.slice(0, 400),
        });
      }
    }
    const byCode = [...grouped.values()].sort((a, b) => b.count - a.count);
    const anomalies: Anomaly[] = [];
    const limitations: Limitation[] = [];
    for (const group of byCode) {
      const kindOfDiagnostic = classifyDiagnostic(group.level, group.code);
      if (kindOfDiagnostic === "anomaly") {
        anomalies.push({
          severity: group.level === "error" ? "error" : BENIGN_ANOMALY.has(group.code) ? "info" : "warning",
          code: group.code,
          message: group.message,
          count: group.count,
          source: "diagnostic",
        });
      } else if (kindOfDiagnostic === "limitation") {
        limitations.push({ code: group.code, level: group.level, count: group.count, message: group.message });
      }
    }
    const validation = validateProjectIR(project);
    if (!validation.ok) {
      anomalies.push({
        severity: "error",
        code: "IR_VALIDATION",
        message: validation.errors.slice(0, 5).join("; "),
        count: validation.errors.length,
        source: "ir",
      });
    }

    // naming mismatch for character files (known trap in this pack)
    let mainSymbol: string | undefined;
    if (kind === "人物") {
      const stageSymbols = entries.filter((entry) => entry.onStage).sort((a, b) => b.frames - a.frames);
      mainSymbol = stageSymbols[0]?.name;
      const close = entries.some(
        (entry) => entry.name === displayName || entry.name.includes(displayName) || displayName.includes(entry.name),
      );
      if (mainSymbol && !close) {
        base.notes.push(`文件名“${displayName}”与库内主符号“${mainSymbol}”不一致`);
        addTags(tags, ["命名不一致"]);
      }
    }

    base.parse = {
      ok: true,
      anomalyCount: anomalies.filter((anomaly) => anomaly.severity !== "info").length,
      compileMs,
      irVersion: project.irVersion,
      validation: { ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length },
    };
    base.stage = {
      width: project.stage.width,
      height: project.stage.height,
      frameRate: project.stage.frameRate,
      ...(project.stage.backgroundColor ? { backgroundColor: project.stage.backgroundColor } : {}),
      durationSec: round(frameCount / Math.max(1, project.stage.frameRate)),
    };
    base.scenes = scenes;
    base.animation = {
      frameCount,
      frameRate: project.stage.frameRate,
      durationSec: round(frameCount / Math.max(1, project.stage.frameRate)),
      totalSymbols: entries.length,
      animatedSymbols,
      maxSymbolFrames,
      tweenCounts: { motion: totals.motion, shape: totals.shape },
      frameByFrame: totals.frameByFrame,
      labels: labels.slice(0, 200),
      loopModes,
      hasSound,
      hasText,
      hasScript: totals.scripts > 0,
      hasMask: totals.masks > 0,
      filters: totals.filters,
      features,
      capabilities,
    };
    base.library = {
      total: Object.keys(project.library).length,
      symbols: symbols.length,
      movieclips: symbols.filter((symbol) => symbol.symbolType === "movieclip").length,
      graphics: symbols.filter((symbol) => symbol.symbolType === "graphic").length,
      buttons: symbols.filter((symbol) => symbol.symbolType === "button").length,
      bitmaps: Object.values(project.library).filter((character) => character.kind === "bitmap").length,
      texts: Object.values(project.library).filter((character) => character.kind === "text").length,
      sounds: Object.values(project.library).filter((character) => character.kind === "sound").length,
      folders: folderGroups,
      maxLayers: totals.maxLayers,
      entries,
    };
    base.collection = {
      isCollection,
      reasons,
      entryCount: entries.length,
      stageEntryCount,
      orphanEntries: entries.filter((entry) => !entry.onStage && entry.usedBy === 0).length,
      folderGroups,
      sections,
    };
    const containerNames = [...container.entries.keys()];
    const byExtension: Record<string, number> = {};
    const byTopLevel: Record<string, number> = {};
    let containerBytes = 0;
    for (const name of containerNames) {
      const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "(none)").toLowerCase();
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
      const top = name.includes("/") ? name.split("/")[0]! : "(root-file)";
      byTopLevel[top] = (byTopLevel[top] ?? 0) + 1;
      containerBytes += container.entries.get(name)?.size ?? 0;
    }
    base.container = { entries: containerNames.length, bytes: containerBytes, byExtension, byTopLevel };
    base.assets = {
      total: project.assets.length,
      bitmaps: project.assets.filter((asset) => asset.kind === "bitmap").length,
      sounds: project.assets.filter((asset) => asset.kind === "sound").length,
      fonts: project.assets.filter((asset) => asset.kind === "font").length,
      videos: project.assets.filter((asset) => asset.kind === "video").length,
    };
    base.diagnostics = {
      total: project.diagnostics.length,
      info: project.diagnostics.filter((diagnostic) => diagnostic.level === "info").length,
      warn: project.diagnostics.filter((diagnostic) => diagnostic.level === "warn").length,
      error: project.diagnostics.filter((diagnostic) => diagnostic.level === "error").length,
      byCode,
    };
    base.anomalies = anomalies;
    base.limitations = limitations;
    base.tags = [...tags];
    base.tagGroups = tagGroupsFor(base.tags);

    // preview
    if (args.preview) {
      const previewRel = previewFile ?? `${category}/${safeFileStem(fileName.replace(/\.[^.]+$/, ""))}.png`;
      const outPath = join(OUT_ROOT, "preview", previewRel);
      try {
        const rendered = await renderPreview(project, outPath, category === "expressions");
        if (rendered) {
          base.preview = {
            path: `preview/${previewRel}`,
            frame: rendered.frame,
            width: rendered.width,
            height: rendered.height,
            format: "png",
            method: rendered.method,
          };
        } else {
          anomalies.push({ severity: "warning", code: "PREVIEW_EMPTY", message: "预览内容包围盒为空", source: "preview" });
        }
      } catch (error) {
        anomalies.push({
          severity: "warning",
          code: "PREVIEW_FAILED",
          message: (error as Error).message.slice(0, 300),
          source: "preview",
        });
      }
    }
    base.anomalies = anomalies;
    const hasError = anomalies.some((anomaly) => anomaly.severity === "fatal" || anomaly.severity === "error");
    const hasWarning = anomalies.some((anomaly) => anomaly.severity === "warning");
    base.status = hasError ? "error" : hasWarning ? "warning" : "ok";
    base.parse.anomalyCount = anomalies.filter((anomaly) => anomaly.severity !== "info").length;

    const animText = capabilities.includes("静态") ? "静态" : capabilities.slice(0, 3).join("、");
    base.summary = [
      categoryLabel,
      isCollection ? `${entries.length} entry` : `${symbols.length} 符号`,
      `舞台 ${project.stage.width}×${project.stage.height}`,
      frameCount > 0 ? `${frameCount} 帧 @${project.stage.frameRate}fps` : "无场景",
      animText,
      base.status === "ok" ? "" : "有解析标注",
    ].filter(Boolean).join(" · ");
    return { file: base, compileMs };
  } catch (error) {
    const compileMs = Math.round(performance.now() - started);
    const message = (error as Error).message || String(error);
    const failTags = new Set<string>([categoryLabel, "解析失败"]);
    if (category === "reference") addTags(failTags, ["手型", "参考", "合集"]);
    if (category === "expressions") addTags(failTags, ["表情", "表情库", "合集"]);
    if (category === "effects") addTags(failTags, ["特效", "特效库"]);
    if (displayName.includes("合集")) failTags.add("合集");
    const file: MaterialFile = {
      ...base,
      status: "error",
      parse: { ok: false, anomalyCount: 1, compileMs, error: message.slice(0, 1000) },
      anomalies: [{ severity: "fatal", code: "COMPILE_FAILED", message: message.slice(0, 1000), source: "compile" }],
      limitations: [],
      notes: ["文件无法作为 XFL/ZIP 读取；未生成预览与 entry 索引"],
      tags: [...failTags],
      tagGroups: tagGroupsFor([...failTags]),
      summary: `${categoryLabel} · 解析失败：${message.slice(0, 80)}`,
    };
    return { file, compileMs };
  }
}

async function runThumbs(images: { rel: string; abs: string }[]): Promise<Map<string, ImageThumb>> {
  if (images.length === 0) return new Map();
  const spec = images.map((image) => {
    const ext = (image.rel.match(/\.([^.]+)$/)?.[1] ?? "img").toLowerCase();
    const stem = basename(image.rel).replace(/\.[^.]+$/, "");
    return {
      src: image.abs,
      out: join(OUT_ROOT, "preview", "scenes", `${safeFileStem(`${stem}-${ext}`)}.png`),
      max: IMAGE_PREVIEW_MAX,
    };
  });
  const specPath = join(CACHE_ROOT, "image-spec.json");
  const resultPath = join(CACHE_ROOT, "image-thumbs.json");
  await mkdir(CACHE_ROOT, { recursive: true });
  await writeFile(specPath, JSON.stringify(spec));
  let stdout = "";
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("python3", [resolve("scripts/material-thumbs.py"), specPath], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`material-thumbs.py exited with ${code}`));
        return;
      }
      writeFile(resultPath, stdout).then(resolvePromise, reject);
    });
  });
  const raw = JSON.parse(await readFile(resultPath, "utf8")) as ImageThumb[];
  const map = new Map<string, ImageThumb>();
  for (const [index, item] of raw.entries()) {
    const rel = images[index]?.rel;
    if (rel) map.set(rel, item);
  }
  return map;
}

async function inspectRar(abs: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("unrar", ["lb", abs], { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("unrar timed out"));
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolvePromise(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function buildIndex(args: ParsedArgs): Promise<void> {
  const t0 = performance.now();
  await mkdir(OUT_ROOT, { recursive: true });
  await mkdir(CACHE_ROOT, { recursive: true });
  if (args.force) {
    await rm(join(OUT_ROOT, "preview"), { recursive: true, force: true });
    await rm(join(OUT_ROOT, "catalog"), { recursive: true, force: true });
  }
  const allRel = await walk(SOURCE_ROOT);
  const flaRels = allRel.filter((rel) => rel.toLowerCase().endsWith(".fla"));
  const imageRels = allRel.filter((rel) => /\.(jpe?g|png|webp|gif)$/i.test(rel));
  const archiveRels = allRel.filter((rel) => /\.(rar|zip|7z)$/i.test(rel));
  const selected = flaRels.filter((rel) => (args.only ? rel.includes(args.only) : true));
  const limited = args.limit ? selected.slice(0, args.limit) : selected;
  const previewNames = buildPreviewNames(selected);

  const files: MaterialFile[] = [];
  let processed = 0;
  let skipped = 0;
  for (const rel of limited) {
    const abs = join(SOURCE_ROOT, rel);
    const st = await stat(abs);
    const cachePath = join(CACHE_ROOT, `${createHash("sha1").update(rel).digest("hex")}.json`);
    let file: MaterialFile | null = null;
    if (!args.force) {
      try {
        const cached = JSON.parse(await readFile(cachePath, "utf8")) as MaterialFile & { cacheVersion?: number };
        if (
          cached.cacheVersion === CACHE_VERSION &&
          cached.bytes === st.size &&
          Math.abs((cached.mtimeMs ?? 0) - st.mtimeMs) < 1
        ) {
          file = cached;
          skipped++;
        }
      } catch {
        // no usable cache
      }
    }
    if (!file) {
      const sha256 = await sha256File(abs);
      const { file: built } = await extractFla(
        abs,
        rel,
        st.size,
        st.mtimeMs,
        sha256,
        previewNames.get(rel),
        args,
      );
      (built as MaterialFile & { cacheVersion?: number }).cacheVersion = CACHE_VERSION;
      await writeFile(cachePath, JSON.stringify(built));
      file = built;
    }
    files.push(file);
    processed++;
    if (processed % 10 === 0 || processed === limited.length) {
      const elapsed = Math.round((performance.now() - t0) / 1000);
      process.stderr.write(`[${processed}/${limited.length}] ${file.status.padEnd(7)} ${rel} (${elapsed}s)\n`);
    }
  }
  if (args.limit) {
    process.stderr.write("limit set; skipping markdown/index generation\n");
    return;
  }

  // images + thumbnails
  const thumbs = await runThumbs(imageRels.map((rel) => ({ rel, abs: join(SOURCE_ROOT, rel) })));
  for (const rel of imageRels) {
    const abs = join(SOURCE_ROOT, rel);
    const st = await stat(abs);
    const thumb = thumbs.get(rel);
    const fileName = basename(rel);
    const { displayName } = displayNameFor(fileName);
    const category = categoryFor(rel, fileName);
    const tags = new Set<string>(["场景", "古代战场", "图片"]);
    const ext = (fileName.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase();
    const image: MaterialFile = {
      id: rel,
      path: rel,
      name: fileName,
      displayName,
      category,
      categoryLabel: CATEGORY_LABEL[category],
      kind: "image",
      format: ext.toLowerCase(),
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      sha256: thumb?.sha256 ?? "",
      tags: [...tags],
      tagGroups: tagGroupsFor([...tags]),
      summary: thumb?.ok
        ? `场景图 · ${thumb.width}×${thumb.height} · ${ext}`
        : `场景图 · 读取失败`,
      status: thumb?.ok ? "ok" : "error",
      anomalies: [],
      limitations: [],
      notes: [],
      image: {
        width: thumb?.width ?? 0,
        height: thumb?.height ?? 0,
        format: thumb?.format ?? ext,
        mode: thumb?.mode ?? "",
      },
    };
    if (!thumb?.ok) {
      image.anomalies.push({
        severity: "error",
        code: "IMAGE_UNREADABLE",
        message: thumb?.error ?? "未知图像错误",
        source: "image",
      });
    }
    if (thumb?.ok && thumb.out) {
      image.preview = {
        path: relative(OUT_ROOT, thumb.out).split(sep).join("/"),
        frame: 0,
        width: thumb.thumb_width ?? thumb.width ?? 0,
        height: thumb.thumb_height ?? thumb.height ?? 0,
        format: "png",
        method: "Pillow thumbnail",
      };
    }
    files.push(image);
  }

  // archives
  for (const rel of archiveRels) {
    const abs = join(SOURCE_ROOT, rel);
    const st = await stat(abs);
    const fileName = basename(rel);
    const { displayName } = displayNameFor(fileName);
    const category = categoryFor(rel, fileName);
    const listing = rel.endsWith(".rar") ? await inspectRar(abs).catch(() => []) : [];
    const file: MaterialFile = {
      id: rel,
      path: rel,
      name: fileName,
      displayName,
      category,
      categoryLabel: CATEGORY_LABEL[category],
      kind: "archive",
      format: "rar",
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      sha256: await sha256File(abs),
      tags: ["压缩包", "场景", "重复内容"],
      tagGroups: tagGroupsFor(["压缩包", "场景", "重复内容"]),
      summary: `场景压缩包 · ${listing.length} 个文件 · 与目录素材重复`,
      status: "ok",
      anomalies: [],
      limitations: [],
      notes: ["压缩包内容与 170张古代战场场景/ 目录重复，未解包重复索引"],
      archive: {
        entries: listing.length,
        sample: listing.slice(0, 8),
        note: "与 170张古代战场场景/ 目录重复；详情以目录索引为准",
      },
    };
    files.push(file);
  }

  // duplicate detection (same sha256)
  const byHash = new Map<string, MaterialFile[]>();
  for (const file of files) {
    if (!file.sha256) continue;
    const list = byHash.get(file.sha256) ?? [];
    list.push(file);
    byHash.set(file.sha256, list);
  }
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    for (const file of group) {
      file.duplicates = group.filter((other) => other !== file).map((other) => other.path);
      file.notes.push(`与 ${file.duplicates.length} 个文件内容相同（sha256 一致）`);
      if (!file.tags.includes("重复内容")) file.tags.push("重复内容");
      file.anomalies.push({
        severity: "info",
        code: "DUPLICATE_CONTENT",
        message: `重复文件：${file.duplicates.join(", ")}`,
        source: "file",
      });
      file.tagGroups = tagGroupsFor(file.tags);
    }
  }

  // image format pairs (same stem, jpg + png)
  const byStem = new Map<string, MaterialFile[]>();
  for (const file of files) {
    if (file.kind !== "image") continue;
    const stem = file.path.replace(/\.[^.]+$/, "");
    const list = byStem.get(stem) ?? [];
    list.push(file);
    byStem.set(stem, list);
  }
  for (const group of byStem.values()) {
    if (group.length < 2) continue;
    for (const file of group) {
      const others = group.filter((other) => other !== file).map((other) => other.path);
      if (file.image) file.image.pair = others.join(", ");
      if (!file.tags.includes("双格式")) file.tags.push("双格式");
      file.tagGroups = tagGroupsFor(file.tags);
      file.notes.push(`同图另有格式：${others.join(", ")}`);
    }
  }

  const sorted = files.sort((a, b) => {
    const categoryIndex = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    return categoryIndex || a.path.localeCompare(b.path, "zh");
  });

  const prepCatalog = await loadPrepCatalog();
  let previousFiles: MaterialFile[] = [];
  try {
    const previous = JSON.parse(await readFile(join(OUT_ROOT, "index.json"), "utf8"));
    previousFiles = Array.isArray(previous.files) ? previous.files : [];
  } catch {
    previousFiles = [];
  }
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  for (const file of sorted) {
    const previous = previousByPath.get(file.path);
    if (previous?.prep) file.prep = previous.prep;
  }
  for (const file of sorted) if (!file.prep) file.prep = buildPrep(file, prepCatalog);
  const seenPaths = new Set(sorted.map((file) => file.path));
  for (const previous of previousFiles) {
    if (previous.prep && !seenPaths.has(previous.path)) sorted.push(previous);
  }
  const prepMeta = {
    updatedAt: new Date().toISOString(),
    sourceRoots: [SOURCE_ROOT],
    generatedRoot: join(OUT_ROOT, "generated"),
    counts: {
      files: sorted.length,
      by_kind: Object.fromEntries(
        [...new Set(sorted.map((file) => file.prep!.kind))]
          .sort()
          .map((kind) => [kind, sorted.filter((file) => file.prep!.kind === kind).length]),
      ),
      by_status: Object.fromEntries(
        [...new Set(sorted.map((file) => file.prep!.status))]
          .sort()
          .map((status) => [status, sorted.filter((file) => file.prep!.status === status).length]),
      ),
      by_origin: Object.fromEntries(
        [...new Set(sorted.map((file) => file.prep!.provenance.origin))]
          .sort()
          .map((origin) => [origin, sorted.filter((file) => file.prep!.provenance.origin === origin).length]),
      ),
    },
  };

  const totals = {
    files: sorted.length,
    fla: sorted.filter((file) => file.kind === "fla").length,
    images: sorted.filter((file) => file.kind === "image").length,
    archives: sorted.filter((file) => file.kind === "archive").length,
    bytes: sorted.reduce((sum, file) => sum + file.bytes, 0),
    entries: sorted.reduce((sum, file) => sum + (file.collection?.entryCount ?? 0), 0),
    collectionEntries: sorted
      .filter((file) => file.collection?.isCollection)
      .reduce((sum, file) => sum + (file.collection?.entryCount ?? 0), 0),
    collections: sorted.filter((file) => file.collection?.isCollection).length,
    previews: sorted.filter((file) => file.preview).length,
    ok: sorted.filter((file) => file.status === "ok").length,
    warning: sorted.filter((file) => file.status === "warning").length,
    error: sorted.filter((file) => file.status === "error").length,
    parseAnomalies: sorted.filter((file) =>
      file.anomalies.some(
        (anomaly) =>
          anomaly.severity !== "info" &&
          (anomaly.source === "diagnostic" || anomaly.source === "compile" || anomaly.source === "ir"),
      ),
    ).length,
    annotated: sorted.filter((file) => file.anomalies.length > 0).length,
  };

  const tagMap = new Map<string, MaterialFile[]>();
  for (const file of sorted) {
    for (const tag of file.tags) {
      const list = tagMap.get(tag) ?? [];
      list.push(file);
      tagMap.set(tag, list);
    }
  }
  const tagStats = Object.fromEntries(
    [...tagMap.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh"))
      .map(([tag, list]) => [tag, { count: list.length, files: list.map((file) => file.path) }]),
  );

  const generatedAt = new Date().toISOString();
  const index = {
    schema: 1,
    generatedAt,
    sourceRoot: SOURCE_ROOT,
    outputRoot: OUT_ROOT,
    tool: "scripts/build-material-index.ts",
    cacheVersion: CACHE_VERSION,
    totals,
    categories: CATEGORY_ORDER.map((category) => ({
      id: category,
      label: CATEGORY_LABEL[category],
      files: sorted.filter((file) => file.category === category).length,
      fla: sorted.filter((file) => file.category === category && file.kind === "fla").length,
      images: sorted.filter((file) => file.category === category && file.kind === "image").length,
      collections: sorted.filter((file) => file.category === category && file.collection?.isCollection).length,
      entries: sorted.filter((file) => file.category === category).reduce((sum, file) => sum + (file.collection?.entryCount ?? 0), 0),
    })),
    tagStats,
    files: sorted,
    prepMeta,
  };
  await writeFile(join(OUT_ROOT, "index.json"), JSON.stringify(index));
  await writeFile(join(OUT_ROOT, "tags.json"), JSON.stringify({ generatedAt, sourceRoot: SOURCE_ROOT, tagStats }, null, 2));

  // Markdown
  const anomalies = sorted.filter((file) => file.anomalies.some((anomaly) => anomaly.severity !== "info"));
  const anomalyFiles = sorted.filter((file) => file.anomalies.some((anomaly) => anomaly.severity !== "info"));
  const categoriesLine = CATEGORY_ORDER.map((category) => {
    const group = sorted.filter((file) => file.category === category);
    return `${CATEGORY_LABEL[category]} ${group.length}`;
  }).join(" · ");

  const readme: string[] = [];
  readme.push("# 素材索引");
  readme.push("");
  readme.push(`> 源目录：\`${SOURCE_ROOT}\`  `);
  readme.push(`> 生成时间：${generatedAt}  `);
  readme.push(`> 索引脚本：\`scripts/build-material-index.ts\`（机器可读数据见 [\`index.json\`](index.json)，标签见 [\`tags.json\`](tags.json)）`);
  readme.push("");
  readme.push("> 同一脚本也为每个文件写入 `prep` 字段（kind/status/absPath/capabilities/provenance），供 `xfl-material-prep` 判断素材是否就绪；`prepMeta` 为汇总。");
  readme.push("");
  readme.push("## 总览");
  readme.push("");
  readme.push(`- 文件 **${totals.files}** 个：FLA **${totals.fla}**、图片 **${totals.images}**、压缩包 **${totals.archives}**，共 **${fmtBytes(totals.bytes)}**。`);
  readme.push(`- 库内 symbol / entry 合计 **${totals.entries}** 条；其中集合类素材 **${totals.collections}** 个，entry **${totals.collectionEntries}** 条。`);
  readme.push(`- PNG 预览 **${totals.previews}** 张，位于 [\`preview/\`](preview/)。`);
  readme.push(`- 解析状态：正常 **${totals.ok}**、有警告 **${totals.warning}**、失败 **${totals.error}**；带解析异常标注的文件 **${totals.parseAnomalies}** 个，详见 [\`anomalies.md\`](anomalies.md)。`);
  readme.push(`- 另有 **${Math.max(0, totals.annotated - totals.parseAnomalies)}** 个文件只有 info 级容错读取标注（ZIP EOCD 尺寸/重复 entry 等），状态仍为正常。`);
  readme.push(`- 分类：${categoriesLine}。`);
  readme.push("");
  readme.push("## 目录结构");
  readme.push("");
  readme.push("```text");
  readme.push("material/");
  readme.push("  README.md          本文件（总览）");
  readme.push("  index.json         全量索引：标签 / entry / 动画 / 诊断 / 预览");
  readme.push("  tags.json          标签 → 文件清单");
  readme.push("  anomalies.md       解析异常与已知限制报告");
  readme.push("  collections.md     集合类素材的 entry 明细");
  readme.push("  catalog/           按分类拆分的人类可读清单");
  readme.push("  preview/           每个素材的 PNG 预览（按分类分目录）");
  readme.push("```");
  readme.push("");
  readme.push("## 依赖");
  readme.push("");
  readme.push("本机已安装并用于生成索引：`node` + `tsx`、`rsvg-convert`（librsvg）、`unrar`、`python3` + Pillow、`jq`。");
  readme.push("`Playwright Chromium` 仅为含 `mix-blend-mode` 的 SVG 预览兜底，本包 550 张预览未用到。");
  readme.push("");
  readme.push("## 索引字段");
  readme.push("");
  readme.push("| 字段 | 含义 |");
  readme.push("|---|---|");
  readme.push("| `tags` / `tagGroups` | 分类、题材、类型、能力、角色、备注六组标签 |");
  readme.push("| `prep` | 素材准备字段：kind/status/absPath/capabilities/provenance/project |");
  readme.push("| `library.entries` | XFL 库中的每个 symbol（名称、类型、帧数、图层、子项、是否上舞台） |");
  readme.push("| `collection.sections` | 集合素材舞台时间轴上的分区，以及每区展示的 entry |");
  readme.push("| `collection.folderGroups` | 集合素材按库文件夹分组的 entry 统计 |");
  readme.push("| `animation` | 场景/符号帧数、补间数、逐帧标记、frame label、循环方式、能力列表 |");
  readme.push("| `container` | FLA（ZIP）内部条目数与顶层目录统计 |");
  readme.push("| `diagnostics` | 按 code 聚合的诊断（info/warn/error） |");
  readme.push("| `anomalies` | 解析异常/失败（编译、IR 校验、ZIP/XML/edge/topology） |");
  readme.push("| `limitations` | P0/P1 已知限制（cubics、形状补间、滤镜近似等），不等同于解析异常 |");
  readme.push("| `preview` | PNG 预览路径、渲染帧、尺寸 |");
  readme.push("| `status` / `parse` | 汇总状态（ok/warning/error）、编译耗时、IR 校验结果 |");
  readme.push("");
  readme.push("## 标签体系");
  readme.push("");
  readme.push("标签由「目录 + 文件名 + 实际解析结果」共同推导，可按需在 `index.json` 中过滤：");
  readme.push("");
  readme.push("- **分类**：修仙人物 / 都市人物 / 道具 / 场景 / 特效 / 表情 / 手型 / 键盘 / 其他");
  readme.push("- **题材**：修仙 / 玄幻 / 都市 / 现代 / 古代 / 历史 / 战场");
  readme.push("- **类型**：人物 / 武器 / 翅膀 / 书籍 / 怪兽 / 合集 / 单件 / 图片 / 压缩包");
  readme.push("- **能力**：矢量 / 位图 / 序列帧 / 补间动画 / 形状补间 / 逐帧动画 / 符号动画 / 滤镜 / 渐变 / 蒙版 / 多图层 / 多姿态 / 多条目 / 循环播放 / 静态");
  readme.push("- **角色/身份**：男性 / 女性 / 老年 / 学生 / 教师 / 警察 / 罪犯 / 老板 等（仅人物类）");
  readme.push("");
  readme.push("标签是检索提示，不是内容真值；例如「命名不一致」表示文件名与库内主符号名不同。");
  readme.push("");
  readme.push("## 状态与标注");
  readme.push("");
  readme.push("| 状态 | 含义 |");
  readme.push("|---|---|");
  readme.push("| ✅ `ok` | 解析成功；只有 info 级诊断、容错读取标注或已知 P0/P1 限制 |");
  readme.push("| ⚠️ `warning` | 解析成功，但存在轮廓拓扑兜底、不支持的位图数据、edge 命令畸变等异常，或预览失败 |");
  readme.push("| ❌ `error` | 无法解析（如 ZIP 签名缺失）或 IR 校验失败 |");
  readme.push("");
  readme.push("> 容错读取标注：`ZIP_EOCD_SIZE_MISMATCH`、`ZIP_DUPLICATE_ENTRY`、`XFL_EMPTY_LAYER`、`SHAPE_EMPTY`、`SYMBOL_DUPLICATE_NAME` 会保留在 `anomalies`（severity=`info`），但不改变状态。");
  readme.push("> 管线限制：`CUBICS_IGNORED_P0`、`SHAPE_TWEEN_P1`、`FILTER_*_APPROXIMATE` 等记录在 `limitations`，不算解析异常。");
  readme.push("> “解析异常标注”统计的是 severity 为 warning/error 的解析诊断，不含上述 info 标注与 P0/P1 限制。");
  readme.push("");
  readme.push("## 已知解析异常");
  readme.push("");
  if (anomalies.length === 0) {
    readme.push("无。");
  } else {
    readme.push("| 状态 | 文件 | 标注 |");
    readme.push("|---|---|---|");
    const prioritized = [...anomalies].sort(
      (a, b) => (a.status === "error" ? 0 : 1) - (b.status === "error" ? 0 : 1),
    );
    for (const file of prioritized.slice(0, 20)) {
      const codes = file.anomalies
        .filter((anomaly) => anomaly.severity !== "info")
        .map((anomaly) => `${anomaly.code}${anomaly.count && anomaly.count > 1 ? `×${anomaly.count}` : ""}`)
        .join(", ");
      readme.push(`| ${statusIcon(file.status)} | ${mdCell(file.path)} | ${mdCell(codes)} |`);
    }
    if (anomalies.length > 20) readme.push(`| … | 其余 ${anomalies.length - 20} 个见 anomalies.md | |`);
  }
  readme.push("");
  readme.push("## 查询示例");
  readme.push("");
  readme.push("本机已安装 `jq`（1.8.1）；没有 jq 时可改用 `python3 -c` 读取同一份 `index.json`。");
  readme.push("");
  readme.push("```bash");
  readme.push("# 所有带“翅膀”标签的素材");
  readme.push("jq -r '.files[] | select(.tags | index(\"翅膀\")) | .path' index.json");
  readme.push("# 所有解析失败的文件");
  readme.push("jq -r '.files[] | select(.status==\"error\") | .path' index.json");
  readme.push("# 所有 warning 文件及其异常 code");
  readme.push("jq -r '.files[] | select(.status==\"warning\") | .path as $p | .anomalies[] | select(.severity==\"warning\") | \"\\($p)\\t\\(.code)\\t\\(.count // 1)\"' index.json");
  readme.push("# 集合类素材、entry 数与舞台分区数");
  readme.push("jq -r '.files[] | select(.collection.isCollection) | \"\\(.path)\\t\\(.collection.entryCount)\\t\\(.collection.sections|length) 区\"' index.json");
  readme.push("# 某个文件的 entry 列表");
  readme.push("jq -r --arg path \"$MATERIAL_FILE\" '.files[] | select(.path==$path) | .library.entries[].name' index.json");
  readme.push("```");
  readme.push("");
  readme.push("## 生成方式");
  readme.push("");
  readme.push("```bash");
  readme.push("MATERIAL_SOURCE_DIR=INPUT MATERIAL_OUTPUT_DIR=OUTPUT pnpm exec tsx scripts/build-material-index.ts");
  readme.push("```");
  readme.push("");
  readme.push("预览统一由 `xfl2svg` + `rsvg-convert` 光栅化，是调试渲染，不是 Animate 1:1 导出；");
  readme.push("滤镜/渐变在 SVG 预览中与 Pixi 最终渲染会有差异。");
  readme.push("");
  await writeFile(join(OUT_ROOT, "README.md"), readme.join("\n"));

  // catalog pages
  const catalogDir = join(OUT_ROOT, "catalog");
  await mkdir(catalogDir, { recursive: true });
  for (const category of CATEGORY_ORDER) {
    const group = sorted.filter((file) => file.category === category);
    if (group.length === 0) continue;
    const lines: string[] = [];
    lines.push(`# ${CATEGORY_LABEL[category]}（${group.length}）`);
    lines.push("");
    lines.push("> 返回 [总览](../README.md) · 机器数据 [index.json](../index.json)");
    lines.push("");
    const flas = group.filter((file) => file.kind === "fla");
    const images = group.filter((file) => file.kind === "image");
    const archives = group.filter((file) => file.kind === "archive");
    lines.push(
      `共 ${group.length} 项：FLA ${flas.length}、图片 ${images.length}、压缩包 ${archives.length}；` +
        `entry 合计 ${group.reduce((sum, file) => sum + (file.collection?.entryCount ?? 0), 0)}。`,
    );
    lines.push("");
    if (flas.length > 0) {
      lines.push("## FLA 素材");
      lines.push("");
      lines.push("| 名称 | 舞台 | 场景帧 | 符号 / entry | 动画 | 标签 | 解析 | 预览 |");
      lines.push("|---|---|---|---|---|---|---|---|");
      for (const file of flas) {
        const entryCount = file.collection?.entryCount ?? file.library?.symbols ?? 0;
        const entryCell = file.collection?.isCollection ? `${entryCount} entry` : `${entryCount} 符号`;
        const anim = file.animation ? (file.animation.capabilities.includes("静态") ? "静态" : file.animation.capabilities.slice(0, 2).join(" / ")) : "—";
        const tagLine = file.tags.slice(0, 6).join(" · ");
        const parseCell = file.status === "ok" ? "✅" : `${statusIcon(file.status)} ${file.anomalies.filter((a) => a.severity !== "info").length}`;
        const previewCell = file.preview ? mdLink("PNG", `../${file.preview.path}`) : "—";
        lines.push(
          `| ${mdCell(file.displayName)} | ${file.stage ? `${file.stage.width}×${file.stage.height}` : "—"} | ${file.scenes?.[0]?.frames ?? "—"} | ${entryCell} | ${mdCell(anim)} | ${mdCell(tagLine)} | ${parseCell} | ${previewCell} |`,
        );
      }
      lines.push("");
    }
    if (images.length > 0) {
      lines.push("## 场景图片");
      lines.push("");
      lines.push("| 名称 | 尺寸 | 格式 | 标签 | 预览 |");
      lines.push("|---|---|---|---|---|");
      for (const file of images) {
        lines.push(
          `| ${mdCell(file.displayName)} | ${file.image?.width ?? 0}×${file.image?.height ?? 0} | ${file.format.toUpperCase()} | ${mdCell(file.tags.slice(0, 4).join(" · "))} | ${file.preview ? mdLink("PNG", `../${file.preview.path}`) : "—"} |`,
        );
      }
      lines.push("");
    }
    if (archives.length > 0) {
      lines.push("## 压缩包");
      lines.push("");
      lines.push("| 名称 | 大小 | 内部文件数 | 说明 |");
      lines.push("|---|---|---|---|");
      for (const file of archives) {
        lines.push(`| ${mdCell(file.displayName)} | ${fmtBytes(file.bytes)} | ${file.archive?.entries ?? "—"} | ${mdCell(file.notes.join("；"))} |`);
      }
      lines.push("");
    }
    await writeFile(join(catalogDir, `${category}.md`), lines.join("\n"));
  }

  // collections.md
  const collections = sorted.filter((file) => file.collection?.isCollection);
  const collectionLines: string[] = [];
  collectionLines.push("# 集合类素材 entry 明细");
  collectionLines.push("");
  collectionLines.push("> 返回 [总览](README.md) · 机器数据 [index.json](index.json)");
  collectionLines.push("");
  collectionLines.push(`本包中有 **${collections.length}** 个集合类素材，共 **${collections.reduce((sum, file) => sum + (file.collection?.entryCount ?? 0), 0)}** 条库 entry。`);
  collectionLines.push("");
  collectionLines.push("| 素材 | entry | 分组 | 场景帧 | 补间（运动/形状） | 解析 |");
  collectionLines.push("|---|---:|---:|---:|---|---|");
  for (const file of collections) {
    collectionLines.push(
      `| ${mdCell(file.displayName)} | ${file.collection?.entryCount ?? 0} | ${file.collection?.folderGroups.length ?? 0} | ${file.scenes?.[0]?.frames ?? 0} | ${file.animation?.tweenCounts.motion ?? 0} / ${file.animation?.tweenCounts.shape ?? 0} | ${statusIcon(file.status)} |`,
    );
  }
  collectionLines.push("");
  for (const file of collections) {
    const collection = file.collection!;
    collectionLines.push(`## ${file.displayName}`);
    collectionLines.push("");
    const preview = file.preview ? `${mdLink("PNG 预览", file.preview.path)} · ` : "";
    collectionLines.push(
      `${preview}舞台 ${file.stage?.width}×${file.stage?.height} @${file.animation?.frameRate}fps · ` +
        `${file.scenes?.[0]?.frames ?? 0} 帧 · entry **${collection.entryCount}** · ` +
        `有动画符号 **${file.animation?.animatedSymbols ?? 0}** · 解析 ${statusIcon(file.status)}`,
    );
    collectionLines.push("");
    collectionLines.push(`源文件：\`${file.path}\``);
    collectionLines.push("");
    if (collection.sections.length > 0) {
      collectionLines.push("### 舞台分区（每个关键帧展示的 entry）");
      collectionLines.push("");
      collectionLines.push("| 起始帧 | 持续 | entry 内容 |");
      collectionLines.push("|---:|---:|---|");
      for (const section of collection.sections) {
        collectionLines.push(`| ${section.frame} | ${section.duration} | ${mdCell(section.entries.join("、"))} |`);
      }
      collectionLines.push("");
    }
    collectionLines.push("### 库分组");
    collectionLines.push("");
    collectionLines.push("| 分组 | entry | 有动画 | 最大帧 | 上舞台 |");
    collectionLines.push("|---|---:|---:|---:|---:|");
    for (const folder of collection.folderGroups) {
      collectionLines.push(`| ${mdCell(folder.name)} | ${folder.count} | ${folder.animated} | ${folder.maxFrames} | ${folder.stageCount} |`);
    }
    collectionLines.push("");
    collectionLines.push("### Entry 明细");
    collectionLines.push("");
    for (const folder of collection.folderGroups) {
      const entries = file.library!.entries.filter((entry) => entry.folder === folder.name);
      collectionLines.push(`<details><summary><b>${folder.name}</b>（${entries.length}）</summary>`);
      collectionLines.push("");
      for (const entry of entries) {
        const flags = [
          entry.animated ? `▶ ${entry.frames}帧` : "静态",
          `${entry.layers}层`,
          entry.role === "stage" ? "上舞台" : entry.role === "child" ? "子符号" : "未使用",
          entry.tweens.motion > 0 ? `motion×${entry.tweens.motion}` : "",
          entry.tweens.shape > 0 ? `shape×${entry.tweens.shape}` : "",
          entry.labels.length > 0 ? `label:${entry.labels.join("/")}` : "",
        ].filter(Boolean);
        collectionLines.push(`- \`${entry.name}\`（${entry.type}；${flags.join("；")}）`);
      }
      collectionLines.push("");
      collectionLines.push("</details>");
      collectionLines.push("");
    }
  }
  await writeFile(join(OUT_ROOT, "collections.md"), collectionLines.join("\n"));

  // anomalies.md
  const anomalyLines: string[] = [];
  anomalyLines.push("# 解析异常与已知限制");
  anomalyLines.push("");
  anomalyLines.push("> 返回 [总览](README.md) · 机器数据 [index.json](index.json)");
  anomalyLines.push("");
  anomalyLines.push(`生成时间：${generatedAt}`);
  anomalyLines.push("");
  anomalyLines.push("## 统计");
  anomalyLines.push("");
  anomalyLines.push(`- 文件总数 **${totals.files}**；解析失败 **${totals.error}**；有解析警告 **${totals.warning}**；非 info 解析标注 **${totals.parseAnomalies}**。`);
  const codeCounts = new Map<string, { count: number; severity: string; files: number }>();
  for (const file of sorted) {
    for (const anomaly of file.anomalies) {
      if (anomaly.severity === "info") continue;
      const current = codeCounts.get(anomaly.code) ?? { count: 0, severity: anomaly.severity, files: 0 };
      current.count += anomaly.count ?? 1;
      current.files++;
      codeCounts.set(anomaly.code, current);
    }
  }
  anomalyLines.push("");
  anomalyLines.push("| 异常 code | 级别 | 出现文件数 | 次数 |");
  anomalyLines.push("|---|---|---:|---:|");
  for (const [code, stat] of [...codeCounts.entries()].sort((a, b) => b[1].files - a[1].files)) {
    anomalyLines.push(`| \`${code}\` | ${stat.severity} | ${stat.files} | ${stat.count} |`);
  }
  anomalyLines.push("");
  anomalyLines.push("## 逐个文件");
  anomalyLines.push("");
  anomalyLines.push("| 状态 | 文件 | 分类 | 解析标注 | 已知限制 |");
  anomalyLines.push("|---|---|---|---|---|");
  for (const file of anomalyFiles) {
    const codes = file.anomalies
      .filter((anomaly) => anomaly.severity !== "info")
      .map((anomaly) => `${anomaly.code}${anomaly.count && anomaly.count > 1 ? `×${anomaly.count}` : ""}`)
      .join(", ");
    const limits = [...new Set(file.limitations.map((limitation) => limitation.code))].join(", ");
    anomalyLines.push(
      `| ${statusIcon(file.status)} | ${mdCell(file.path)} | ${file.categoryLabel} | ${mdCell(codes || "—")} | ${mdCell(limits || "—")} |`,
    );
  }
  anomalyLines.push("");
  const failures = sorted.filter((file) => file.status === "error");
  anomalyLines.push("## 解析失败详情");
  anomalyLines.push("");
  if (failures.length === 0) {
    anomalyLines.push("无。");
  } else {
    for (const file of failures) {
      anomalyLines.push(`### ${file.displayName}`);
      anomalyLines.push("");
      anomalyLines.push(`- 文件：\`${file.path}\``);
      anomalyLines.push(`- 大小：${fmtBytes(file.bytes)}`);
      for (const anomaly of file.anomalies.filter((item) => item.severity === "fatal" || item.severity === "error")) {
        anomalyLines.push(`- \`${anomaly.code}\`：${anomaly.message}`);
      }
      anomalyLines.push("");
    }
  }
  anomalyLines.push("");
  anomalyLines.push("## 已知限制（非解析异常）");
  anomalyLines.push("");
  anomalyLines.push("这些是管线刻意的 P0/P1 行为，会在 `limitations` 中保留，不算解析失败：");
  anomalyLines.push("");
  const limitCounts = new Map<string, { count: number; files: number; level: string }>();
  for (const file of sorted) {
    for (const limitation of file.limitations) {
      const current = limitCounts.get(limitation.code) ?? { count: 0, files: 0, level: limitation.level };
      current.count += limitation.count;
      current.files++;
      limitCounts.set(limitation.code, current);
    }
  }
  anomalyLines.push("| code | 级别 | 文件数 | 次数 | 说明 |");
  anomalyLines.push("|---|---|---:|---:|---|");
  const limitSamples = new Map<string, string>();
  for (const file of sorted) for (const limitation of file.limitations) limitSamples.set(limitation.code, limitation.message);
  for (const [code, stat] of [...limitCounts.entries()].sort((a, b) => b[1].files - a[1].files)) {
    anomalyLines.push(`| \`${code}\` | ${stat.level} | ${stat.files} | ${stat.count} | ${mdCell(limitSamples.get(code) ?? "")} |`);
  }
  anomalyLines.push("");
  anomalyLines.push("## 需要人工注意");
  anomalyLines.push("");
  const notable: string[] = [];
  for (const file of sorted) {
    if (file.status === "error") notable.push(`- ❌ \`${file.path}\` 无法解析：${file.anomalies[0]?.message ?? ""}`);
  }
  const naming = sorted.filter((file) => file.notes.some((note) => note.includes("不一致")));
  if (naming.length > 0) {
    notable.push(`- 文件名与库内主符号名不一致的素材 **${naming.length}** 个（属命名问题，不是解析失败），已加“命名不一致”标签；优先核对：`);
    for (const file of naming.slice(0, 12)) {
      notable.push(`  - \`${file.path}\`：${file.notes.find((note) => note.includes("不一致"))}`);
    }
    if (naming.length > 12) notable.push(`  - 其余 ${naming.length - 12} 个见 catalog 表格`);
  }
  const topology = sorted.filter((file) =>
    file.anomalies.some((anomaly) => anomaly.code === "FILL_HOLE_UNASSIGNED" || anomaly.code === "FILL_OPEN_CHAIN"),
  );
  if (topology.length > 0) {
    notable.push(
      `- 轮廓拓扑兜底（\`FILL_HOLE_UNASSIGNED\` / \`FILL_OPEN_CHAIN\`）**${topology.length}** 个文件；上方逐个文件表已列出 code 次数，建议渲染抽检。`,
    );
  }
  const previewFailed = sorted.filter((file) => file.anomalies.some((anomaly) => anomaly.code.startsWith("PREVIEW_")));
  if (previewFailed.length > 0) {
    notable.push(`- 预览渲染失败 **${previewFailed.length}** 个：${previewFailed.map((file) => `\`${file.path}\``).join("、")}`);
  }
  if (notable.length === 0) anomalyLines.push("无。");
  else anomalyLines.push(...notable);
  anomalyLines.push("");
  await writeFile(join(OUT_ROOT, "anomalies.md"), anomalyLines.join("\n"));

  process.stderr.write(
    `\nindexed ${sorted.length} files (${skipped} from cache) in ${Math.round((performance.now() - t0) / 1000)}s\n` +
      `wrote ${join(OUT_ROOT, "index.json")} (${fmtBytes(JSON.stringify(index).length)})\n`,
  );
}

const args = parseArgs(process.argv.slice(2));
await buildIndex(args).catch((error) => {
  process.stderr.write(`build-material-index failed: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
});
