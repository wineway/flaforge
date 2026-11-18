import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { compileXfl } from "@flaforge/compiler";

const schemaPath = resolve(process.cwd(), "packages/character-ir/schema/project-ir.schema.json");

describe("Project IR JSON Schema", () => {
  it("validates the motion-tween IR", async () => {
    const { project } = await compileXfl(resolve(process.cwd(), "fixtures/semantics/motion-tween.xfl"), {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const ok = validate(project);
    if (!ok) {
      throw new Error(ajv.errorsText(validate.errors, { separator: "\n" }));
    }
    expect(ok).toBe(true);
  });

  it("rejects a project with a bad fill index", async () => {
    const { project } = await compileXfl(resolve(process.cwd(), "fixtures/semantics/basic-shape.xfl"), {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const shape = Object.values(project.shapes)[0]!;
    shape.regions[0]!.fill = -2;
    const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    expect(validate(project)).toBe(false);
  });
});
