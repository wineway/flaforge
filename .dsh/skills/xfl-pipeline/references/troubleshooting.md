# Troubleshooting

## Diagnostic codes

| Code | Meaning | Action |
|---|---|---|
| `ZIP_EOCD_SIZE_MISMATCH` | Declared central-directory size differs | Check the archive if entries are missing |
| `ZIP_DUPLICATE_ENTRY` | Same normalized name twice | First wins; inspect if content differs |
| `ZIP_UNSAFE_PATH` | `..` or absolute path | Entry rejected intentionally |
| `ZIP_CRC_MISMATCH` | CRC differs from data | Could be corrupt; do not trust that entry |
| `XFL_MIMETYPE_MISSING` | No `mimetype` entry | Assumed XFL; add one if authoring fixtures |
| `CUBICS_IGNORED_P0` | `Edge.cubics` present | P0 uses `edges`; compare with Animate before enabling |
| `EDGE_SUBPATH_STYLE_MARKER` | `S<n>` found | Ignored; semantics still open |
| `VARIABLE_STROKE_TO_FILL` | Variable width converted to region | Expected; check outline visually |
| `RIG_PROPAGATION_IGNORED` | Rig cache present | Expected; do not apply |
| `FILL_OPEN_CHAIN` | Boundary did not return to start | Inspect contour; fallback closed it |
| `FILL_HOLE_UNASSIGNED` | Hole had no enclosing shell | Inspect topology; fallback renders it as outer |
| `FILL_FALLBACK_CHAIN` | No loop was built for a fill | Per-chain regions used; inspect |
| `STROKE_SCALEMODE_UNSUPPORTED` | `none`/`horizontal`/`vertical` | Rendered as normal; P1 |
| `GRADIENT_*` | Gradient approximation | P1/pixel comparison |
| `BITMAP_FILL_P1` | Bitmap fill | Placeholder gray; P1 |
| `SYMBOL_NOT_FOUND` | `libraryItemName` not in library | Check spelling and Include table |
| `SYMBOL_CYCLE` | Symbol reference cycle | Runtime depth guard; fix content if unintended |
| `SYMBOL_NO_GEOMETRY` | Filter-only/empty symbol | Inspect the symbol contents |

Levels: `error` should block delivery; `warn` is a known approximation or
fallback; `info` records intentional P0 behavior..

## “It compiles but looks wrong”

1. Render the shape/character with SVG at the exact frame:
   `pnpm xfl2svg ... --character "..." --frame 29`.
2. Compare bounds in the IR:
   `node -e "..."` over `project.shapes`.
3. Check whether the difference is a **fill region** (wrong topology), a
   **stroke** (width/join/variable outline), a **gradient** (matrix/ramp), or a
   **transform** (tween/group/pivot).
4. If the whole character is displaced, check group matrix and tween
   decomposition before touching Pixi.
5. If a single layer/filter is wrong, inspect frame filters vs element filters.

## “It plays but frames jump / reset”

- Graphic symbol child frames are parent-local. Ensure the backend passes the
  parent `frame`, not the stage frame.
- Movieclips use the stage frame and loop independently.
- A new keyframe creates new `startFrame` values; that is expected reset
  behavior for a replaced instance.
- Tween endpoints must share element IDs; if not, the evaluator treats them as
  different instances.

## “Pixi crashes or screenshots hang”

- Check `window.__xfl.player` in the demo; pause before readback.
- Scenes with many stacked glow filters can be slow under
  SwiftShader. Load a local IR with filters removed for canvas readback, or
  character mode for the filter path.
- Low-res screenshots (around 420×320) are more stable than full HD.
- Run Playwright scripts with Node from the repo root; importing Playwright via
  `tsx` can fail with `ERR_REQUIRE_ASYNC_MODULE`.

## “pnpm / demo / E2E won’t start”

```bash
corepack enable pnpm
pnpm install
pnpm sample:assets
pnpm demo                 # http://localhost:5173
pnpm e2e                  # separate terminal
```

If the demo overlay says the IR is missing, `apps/demo/src/generated/sample.ir.json`
was not generated. If E2E cannot connect, start the demo first. If Playwright
has no browser, run `npx playwright install chromium` (network required).

## Regenerating artifacts

```bash
pnpm sample:assets     # generate the built-in demo IR
pnpm sample:svg        # write out/sample.svg
pnpm exec tsx scripts/render-frame.ts fixtures/semantics/motion-tween.xfl Dot 5  # /tmp SVG
```

Generated `apps/demo/public/*.json` and docs PNG/SVG are outputs; do not
hand-edit them. Commit/replace the source `.fla`/`.xfl` and regenerate.
