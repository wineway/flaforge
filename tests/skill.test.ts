import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

const skillDir = resolve(process.cwd(), ".dsh/skills/xfl-pipeline");
const skillPath = resolve(skillDir, "SKILL.md");

function frontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  expect(raw.startsWith("---\n")).toBe(true);
  const end = raw.indexOf("\n---", 4);
  expect(end).toBeGreaterThan(0);
  return {
    data: parse(raw.slice(4, end)) as Record<string, unknown>,
    body: raw.slice(end + 4),
  };
}

describe("project skill", () => {
  it("has valid kebab-case frontmatter with routing metadata", () => {
    const raw = readFileSync(skillPath, "utf8");
    const { data, body } = frontmatter(raw);
    expect(data.name).toBe("xfl-pipeline");
    expect(String(data.description).length).toBeGreaterThan(20);
    expect(String(data.whenToUse).length).toBeGreaterThan(20);
    expect(body.length).toBeLessThan(8192);
  });

  it("references existing resource files", () => {
    for (const relative of [
      "references/pipeline-internals.md",
      "references/troubleshooting.md",
    ]) {
      expect(existsSync(resolve(skillDir, relative))).toBe(true);
    }
  });

  it("documents the core commands and invariants", () => {
    const raw = readFileSync(skillPath, "utf8");
    for (const text of [
      "pnpm typecheck",
      "pnpm test",
      "pnpm sample:assets",
      "pnpm e2e",
      "DOMGroup.matrix",
      "cubics",
      "rigPropagationMatrix",
    ]) {
      expect(raw).toContain(text);
    }
  });
});
