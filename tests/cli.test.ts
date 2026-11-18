import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cwd = process.cwd();
const tsx = resolve(cwd, "node_modules/.bin/tsx");
const cli = resolve(cwd, "packages/cli/src/index.ts");
const fixture = resolve(cwd, "fixtures/semantics/basic-shape.xfl");

function run(args: string[]): string {
  return execFileSync(tsx, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
}

describe("CLI", () => {
  it("xfl2ir, ir-validate, xfl2svg and ir-bake work end-to-end", () => {
    const dir = mkdtempSync(join(tmpdir(), "xfl-cli-"));
    const irPath = join(dir, "project.ir.json");
    const svgPath = join(dir, "character.svg");
    const bakePath = join(dir, "baked.json");

    run(["xfl2ir", fixture, "-o", irPath, "--pretty"]);
    const project = JSON.parse(readFileSync(irPath, "utf8"));
    expect(project.irVersion).toBe("1.0");
    expect(project.stage).toMatchObject({ width: 550, height: 400, frameRate: 24 });
    expect(Object.keys(project.shapes).length).toBeGreaterThan(0);

    const validation = run(["ir-validate", irPath]);
    expect(validation).toContain("OK: 0 errors");

    run(["xfl2svg", fixture, "-o", svgPath, "--character", "Shape"]);
    const svg = readFileSync(svgPath, "utf8");
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");

    run(["ir-bake", irPath, "-o", bakePath, "--frames", "0"]);
    const baked = JSON.parse(readFileSync(bakePath, "utf8"));
    expect(baked.scenes["scene:0"]).toBeDefined();
    expect(baked.scenes["scene:0"][0].frame).toBe(0);
  }, 60_000);
});
