---
name: xfl-pipeline
description: >-
  Work on this repository's XFL (Adobe Animate) → Character IR → PixiJS v8
  pipeline: compile .fla/.xfl samples, inspect IR and diagnostics, debug
  geometry/timeline issues, run compiler/IR/Pixi tests, and use the demo/E2E
  harness.
whenToUse: >-
  Use when a task touches XFL/FLA parsing, Character IR, geometry or timeline
  compilation, PixiJS playback, the CLI/demo, or their fixtures and tests in
  this repository.
metadata:
  repository: flaforge
  primaryPlan: docs/xfl-to-pixi-implementation-plan.md
  status: docs/implementation-status.md
---

# XFL → Character IR → PixiJS runbook

This repo already implements the P0 pipeline. Read first:

- [README.md](../../../README.md) — commands, scope, limitations.
- [docs/implementation-status.md](../../../docs/implementation-status.md) — verified
  counts, diagnostics, open semantics.
- [docs/xfl-to-pixi-implementation-plan.md](../../../docs/xfl-to-pixi-implementation-plan.md) —
  design. Code + tests are the current truth.

## Quick commands

```bash
pnpm install
pnpm typecheck                     # all packages, tsc --noEmit
pnpm test
pnpm demo:build

pnpm sample:assets                 # compile the built-in demo sample
pnpm sample:svg
pnpm demo                          # Vite, http://localhost:5173

pnpm xfl2ir fixtures/semantics/motion-tween.xfl -o /tmp/sample.ir.json --pretty
pnpm ir-validate /tmp/sample.ir.json
pnpm xfl2svg fixtures/semantics/motion-tween.xfl -o /tmp/frame5.svg --frame 5
pnpm xfl2svg fixtures/semantics/motion-tween.xfl -o /tmp/char.svg --character Dot --frame 5
pnpm ir-bake /tmp/sample.ir.json -o /tmp/baked.json --frames 0,5,10
```

E2E needs a running demo and a browser:

```bash
npx playwright install chromium
pnpm demo                 # terminal A
pnpm e2e                  # terminal B
```

## Repo map

| Area | Key files |
|---|---|
| ZIP/container | `packages/xfl-container/src/zip.ts`, `container.ts` |
| XML AST | `packages/xfl-xml/src/ast.ts`, `parse.ts`, `xml.ts` |
| Edge/geometry | `packages/xfl-compiler/src/edges.ts`, `topology.ts`, `shape.ts` |
| Timeline/project | `packages/xfl-compiler/src/timeline.ts`, `project.ts` |
| Debug SVG | `packages/xfl-compiler/src/svg.ts` |
| IR | `packages/character-ir/src/{types,matrix,timeline,validate}.ts` |
| IR schema | `packages/character-ir/schema/project-ir.schema.json` |
| Pixi | `packages/pixi-backend/src/{shape-cache,filters,player}.ts` |
| CLI/demo | `packages/cli/src/index.ts`, `apps/demo/src/main.ts` |
| Tests | `packages/**/*.test.ts`, `tests/**/*.test.ts` |
| Fixtures/scripts | `fixtures/`, `scripts/{build-demo-assets.ts,e2e-demo.mjs}` |

## Golden invariants

1. Matrix convention: `x' = a*x + c*y + tx`, `y' = b*x + d*y + ty`.
2. Edge coordinates are twips; divide by 20 only in the edge parser. Stroke
   `weight` is already px.
3. XFL fill/stroke indices are 1-based, 0 = none; IR is 0-based, -1 = none.
   Convert only in the compiler.
4. XFL `<layers>` is top→bottom; IR layers are bottom→top. `LayerIR.index`
   keeps the original XFL index.
5. Ignore `DOMGroup.matrix`; member matrices are absolute, then flattened.
6. `transformationPoint` is metadata only; never apply it again.
7. Tween endpoints must share `ElementIR.id`; IDs are instance key + occurrence.
8. Graphic symbols use the parent's local frame; movieclips use the stage clock.
9. Shapes are content-hashed; `GraphicsContext` is shared. Destroying a
   `Graphics` must not destroy the shared context.
10. Variable-width strokes become fill regions in the compiler; do not
    re-stroke them in the backend.
11. `cubics` are ignored in P0 by design; do not treat them as a second shape.
12. `S<n>` after `!` is skipped; do not interpret it as a style change.
13. `rigPropagationMatrix` is preserved metadata, never applied in P0.
14. Frame filters go on the layer container; element filters on the element.
    `knockout` is handled by `pixi-filters`; do not fake it with alpha 0.
15. Diagnostics are part of the IR. Keep a fallback and record unsupported
    semantics; do not silently drop them.

## Recipes

**Compile/inspect:**

```bash
pnpm xfl2ir fixtures/semantics/motion-tween.xfl -o /tmp/sample.ir.json --pretty
pnpm ir-validate /tmp/sample.ir.json
node -e "const p=require('/tmp/sample.ir.json'); console.log(Object.keys(p.library).length, Object.keys(p.shapes).length, p.diagnostics.length, p.scenes[0].frameCount)"
```


**Debug geometry:**

```bash
pnpm xfl2svg fixtures/semantics/motion-tween.xfl -o /tmp/char.svg --character Dot --frame 5
rsvg-convert -w 720 -o /tmp/char.png /tmp/char.svg
pnpm exec tsx scripts/render-frame.ts fixtures/semantics/motion-tween.xfl Dot 5
```

`--no-filters` is for pure geometry. SVG is a debugging aid; pixel baselines
use Pixi browser captures and Animate exports at matching dimensions.

**Test:**

```bash
pnpm typecheck
pnpm test
pnpm exec vitest run packages/xfl-compiler/src/compiler.test.ts
pnpm exec vitest run packages/xfl-compiler/src/compiler.test.ts -t "semantic fixtures"
```

**Demo/E2E:**

```bash
pnpm sample:assets    # after compiler/IR changes
pnpm demo             # terminal A
pnpm e2e              # terminal B
```

Use `?frame=N` to seek and `?character=Dot&frame=5` to preview the built-in
character. `window.__xfl` exposes `player`, `seek`, and `recreate`.

Headless Chromium + SwiftShader can time out on canvas readback for scenes with many stacked glow filters. The default E2E uses
the built-in motion tween to check playback, canvas rendering, and character
preview.

## Before finishing

```bash
pnpm typecheck
pnpm test
pnpm demo:build
pnpm e2e          # only with demo running
```

For compiler output changes also:

```bash
pnpm sample:assets
pnpm xfl2ir fixtures/semantics/motion-tween.xfl -o /tmp/sample.ir.json
pnpm ir-validate /tmp/sample.ir.json
```

Do not hand-edit `apps/demo/public/*.json` or generated PNG/SVG; regenerate.

## Common pitfalls

- `pnpm: command not found` → `corepack enable pnpm`.
- `Cannot find package 'playwright'` → run Node scripts from the repo root.
- Demo overlay says IR missing → `pnpm sample:assets`.
- E2E connection refused → start `pnpm demo` (port 5173).
- `#HEX.HEX` negative values are 24-bit two’s complement (`#FFFFE3.19` ≈ -1.45 px).
- `SYMBOL_NOT_FOUND` / `SYMBOL_CYCLE` → check `libraryItemName`/Include; runtime
  depth guard is 32.
- `FILL_HOLE_UNASSIGNED` / `FILL_OPEN_CHAIN` → topology fallback ran; inspect
  the contour, do not silence it.
- `cubics`/`rigPropagationMatrix` diagnostics are expected P0 behavior.
- SVG vs Pixi differences are expected for filters/gradients; use Pixi for pixels.

## Deeper references

- [Pipeline internals](references/pipeline-internals.md)
- [Troubleshooting](references/troubleshooting.md)
