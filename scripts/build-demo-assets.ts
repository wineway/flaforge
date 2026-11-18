import { mkdirSync, writeFileSync } from "node:fs";
import { compileXfl } from "../packages/xfl-compiler/src/index.ts";

const output = new URL("../apps/demo/src/generated/", import.meta.url);
const { project } = await compileXfl("fixtures/semantics/motion-tween.xfl", {
  generatedAt: "2026-01-01T00:00:00.000Z",
});

mkdirSync(output, { recursive: true });
writeFileSync(new URL("sample.ir.json", output), JSON.stringify(project));
