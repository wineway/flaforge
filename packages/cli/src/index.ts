#!/usr/bin/env -S npx tsx
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { characterToSvg, compileXfl, projectToSvg, summarizeProject } from "@flaforge/compiler";
import type { CompileResult } from "@flaforge/compiler";
import {
  evaluateTimelineFrame,
  validateProjectIR,
  type ProjectIR,
} from "@flaforge/ir";

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "help";
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("-") && arg !== "-") {
      const name = arg.replace(/^--?/, "");
      const eq = name.indexOf("=");
      if (eq > 0) {
        flags.set(name.slice(0, eq), name.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { command, positionals, flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true || typeof args.flags.get(name) === "string";
}

function usage(): string {
  return `flaforge CLI

Commands:
  xfl2ir <input.fla|input.xfl|input.zip|DOMDocument.xml> [-o out.json]
      [--pretty] [--embed] [--cubics] [--strict] [--no-diagnostics] [--stats]
      [--generated-at ISO]
  xfl2svg <input> [-o out.svg] [--frame N] [--scene ID] [--character NAME]
      [--scale N] [--no-filters] [--fit-content]
  ir-validate <project.ir.json> [--json]
  ir-bake <project.ir.json> [-o out.json] [--frames 0,14,29] [--scene ID]
  help

Notes:
  --strict        exit non-zero when the IR has validation errors
  --embed         embed bitmap/sound bytes as base64 assets
  --cubics        accepted but cubics are not implemented (P1)
  --no-filters    debug SVG renderer: omit filters for pure geometry checks
`;
}

function readProject(path: string): ProjectIR {
  return JSON.parse(readFileSync(path, "utf8")) as ProjectIR;
}

function writeOutput(path: string | undefined, content: string): void {
  if (!path) {
    process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
    return;
  }
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, content);
  process.stderr.write(`wrote ${path}\n`);
}

async function compileInput(args: ParsedArgs): Promise<CompileResult> {
  const input = args.positionals[0];
  if (!input) throw new Error("missing input path");
  const strict = flagBool(args, "strict");
  const result = await compileXfl(input, {
    embedAssets: flagBool(args, "embed"),
    includeCubics: flagBool(args, "cubics"),
    failOnError: strict,
    generatedAt: flagString(args, "generated-at"),
    sourceName: basename(input),
  });
  return result;
}

function statsText(result: CompileResult): string {
  const project = result.project;
  const summary = summarizeProject(project);
  return JSON.stringify(
    {
      stats: result.stats,
      summary,
      stage: project.stage,
      scenes: project.scenes.map((scene) => ({
        id: scene.id,
        name: scene.name,
        frameCount: scene.frameCount,
        layers: scene.timeline.layers.length,
      })),
    },
    null,
    2,
  );
}

async function commandXfl2Ir(args: ParsedArgs): Promise<number> {
  const result = await compileInput(args);
  const project = result.project;
  if (flagBool(args, "no-diagnostics")) project.diagnostics = [];
  const output = flagString(args, "o");
  const pretty = flagBool(args, "pretty");
  const json = pretty ? JSON.stringify(project, null, 2) : JSON.stringify(project);
  writeOutput(output, json);
  if (flagBool(args, "stats")) {
    process.stderr.write(`${statsText(result)}\n`);
  }
  const validation = validateProjectIR(project);
  if (!validation.ok) {
    process.stderr.write(`IR validation failed:\n${validation.errors.join("\n")}\n`);
    if (flagBool(args, "strict")) return 1;
  }
  return 0;
}

async function commandXfl2Svg(args: ParsedArgs): Promise<number> {
  const result = await compileInput(args);
  const project = result.project;
  const frame = Number(flagString(args, "frame") ?? 0);
  const scene = flagString(args, "scene");
  const character = flagString(args, "character");
  const scale = Number(flagString(args, "scale") ?? 1);
  let svg: string;
  if (character) {
    const found =
      project.library[character] ??
      Object.values(project.library).find((entry) => entry.name === character);
    if (!found || found.kind !== "symbol") {
      throw new Error(`character not found: ${character}`);
    }
    svg = characterToSvg(project, found.id, frame, Number.isFinite(scale) ? scale : 1);
  } else {
    svg = projectToSvg(project, {
      frame,
      sceneId: scene,
      fitContent: flagBool(args, "fit-content"),
    });
    if (flagBool(args, "no-filters")) {
      svg = svg.replace(/ filter="url\(#[^)]*\)"/g, "");
    }
  }
  writeOutput(flagString(args, "o"), svg);
  return 0;
}

async function commandIrValidate(args: ParsedArgs): Promise<number> {
  const input = args.positionals[0];
  if (!input) throw new Error("missing IR path");
  const project = readProject(input);
  const validation = validateProjectIR(project);
  if (flagBool(args, "json")) {
    process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${validation.ok ? "OK" : "FAILED"}: ${validation.errors.length} errors, ${validation.warnings.length} warnings\n`,
    );
    for (const error of validation.errors) process.stdout.write(`  error: ${error}\n`);
    for (const warning of validation.warnings) process.stdout.write(`  warning: ${warning}\n`);
  }
  return validation.ok ? 0 : 1;
}

async function commandIrBake(args: ParsedArgs): Promise<number> {
  const input = args.positionals[0];
  if (!input) throw new Error("missing IR path");
  const project = readProject(input);
  const frameList = flagString(args, "frames")
    ?.split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value));
  const sceneFilter = flagString(args, "scene");

  const bakeTimeline = (timeline: ProjectIR["scenes"][number]["timeline"]) => {
    const frames =
      frameList && frameList.length > 0
        ? frameList
        : Array.from({ length: timeline.frameCount }, (_, index) => index);
    return frames
      .filter((frame) => frame >= 0 && frame < timeline.frameCount)
      .map((frame) => ({
        frame,
        layers: evaluateTimelineFrame(timeline, frame).map(({ layer, frame: resolved }) => ({
          layer: layer.name,
          index: layer.index,
          elements:
            resolved?.elements.map((element) => ({
              id: element.id,
              kind: element.kind,
              characterId: element.characterId,
              shapeId: element.shapeId,
              matrix: element.resolvedMatrix,
            })) ?? [],
        })),
      }));
  };

  const scenes: Record<string, unknown> = {};
  for (const scene of project.scenes) {
    if (sceneFilter && scene.id !== sceneFilter) continue;
    scenes[scene.id] = bakeTimeline(scene.timeline);
  }
  const symbols: Record<string, unknown> = {};
  for (const character of Object.values(project.library)) {
    if (character.kind !== "symbol") continue;
    symbols[character.id] = bakeTimeline(character.timeline);
  }
  writeOutput(flagString(args, "o"), JSON.stringify({ irVersion: project.irVersion, scenes, symbols }, null, 2));
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "xfl2ir":
      return commandXfl2Ir(args);
    case "xfl2svg":
      return commandXfl2Svg(args);
    case "ir-validate":
      return commandIrValidate(args);
    case "ir-bake":
      return commandIrBake(args);
    case "help":
    case "h":
      process.stdout.write(usage());
      return 0;
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n${usage()}`);
      return 2;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
