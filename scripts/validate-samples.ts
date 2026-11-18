import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { compileXfl, projectToSvg, summarizeProject } from "../packages/xfl-compiler/src/index.ts";
import { validateProjectIR } from "../packages/character-ir/src/index.ts";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: tsx scripts/validate-samples.ts <file.fla> ...");
  process.exit(1);
}
const outRoot = resolve("/tmp/xfl-validation");
mkdirSync(outRoot, { recursive: true });
const results: any[] = [];
for (const [index, input] of paths.entries()) {
  const name = basename(input).replace(/\.fla$/i, "");
  const dir = resolve(outRoot, `${index + 1}-${name.replace(/[\\/:*?"<>| ]/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  try {
    const { project, stats } = await compileXfl(input, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const compileMs = Math.round(performance.now() - started);
    const validation = validateProjectIR(project);
    const summary = summarizeProject(project);
    const frameCount = project.scenes[0]?.frameCount ?? 0;
    const frame = frameCount > 1 ? Math.min(29, frameCount - 1) : 0;
    const svg = projectToSvg(project, { frame });
    writeFileSync(resolve(dir, "project.ir.json"), JSON.stringify(project));
    writeFileSync(resolve(dir, `scene-${frame}.svg`), svg);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const shape of Object.values(project.shapes)) {
      minX = Math.min(minX, shape.bounds.x);
      minY = Math.min(minY, shape.bounds.y);
      maxX = Math.max(maxX, shape.bounds.x + shape.bounds.width);
      maxY = Math.max(maxY, shape.bounds.y + shape.bounds.height);
    }
    const filters = Object.values(project.library).flatMap((character: any) =>
      character.kind === "symbol"
        ? character.timeline.layers.flatMap((layer: any) =>
            layer.frames.flatMap((f: any) => f.filters ?? []),
          )
        : [],
    );
    const result = {
      index: index + 1,
      name,
      input,
      ok: validation.ok && summary["info:error"] === undefined,
      compileMs,
      stage: project.stage,
      scene: { name: project.scenes[0]?.name, frameCount, renderedFrame: frame, layers: stats.layers },
      stats,
      validation: { ok: validation.ok, errors: validation.errors.length, warnings: validation.warnings.length },
      diagnostics: {
        total: project.diagnostics.length,
        warn: project.diagnostics.filter((d) => d.level === "warn").length,
        error: project.diagnostics.filter((d) => d.level === "error").length,
        codes: Object.fromEntries(
          Object.entries(summary).filter(([key]) => key.includes(":")),
        ),
      },
      library: Object.keys(project.library).length,
      assets: project.assets.map((asset) => ({ kind: asset.kind, path: asset.path, width: asset.width, height: asset.height })),
      shapes: Object.keys(project.shapes).length,
      filters: filters.length,
      shapeBounds: { minX, minY, maxX, maxY },
      svgBytes: svg.length,
      outputDir: dir,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  } catch (error) {
    const result = {
      index: index + 1,
      name,
      input,
      ok: false,
      compileMs: Math.round(performance.now() - started),
      error: (error as Error).message,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
writeFileSync(resolve(outRoot, "summary.json"), JSON.stringify(results, null, 2));
console.log(`\nwrote ${resolve(outRoot, "summary.json")}`);
