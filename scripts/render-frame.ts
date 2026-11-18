import { compileXfl } from "../packages/xfl-compiler/src/index.ts";
import { characterToSvg, projectToSvg } from "../packages/xfl-compiler/src/svg.ts";
import { writeFileSync } from "node:fs";

const [input, name, frameArg = "0"] = process.argv.slice(2);
if (!input || !name) throw new Error("Usage: tsx scripts/render-frame.ts INPUT CHARACTER [FRAME]");
const frame = Number(frameArg);
const { project } = await compileXfl(input, { generatedAt: "2026-01-01T00:00:00.000Z" });
const c = Object.values(project.library).find((c) => c.kind === "symbol" && c.name === name);
if (!c || c.kind !== "symbol") throw new Error("not found");
writeFileSync(`/tmp/${name.replace(/[^\p{L}\p{N}_-]/gu, "_")}-${frame}.svg`, characterToSvg(project, c.id, frame, 1));
writeFileSync(`/tmp/scene-${frame}.svg`, projectToSvg(project, { frame }));
console.log("wrote", frame, name, c.bounds);
