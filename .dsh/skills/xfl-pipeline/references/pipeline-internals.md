# Pipeline internals

This is the long-form map behind the runbook. Use it when changing a stage or
debugging a semantic mismatch.

## Stage 1 — `@flaforge/container`

`readXflContainer(input)` accepts a path (`.fla`/`.zip`/directory), bytes, or an
ArrayBuffer. It returns an `XflContainer` plus diagnostics.

The ZIP reader is intentionally tolerant:

1. Find EOCD from the end (with/without a valid comment length).
2. Read the central directory by count, not by the declared byte size.
3. If that fails, scan central-directory headers; if still empty, scan local
   headers.
4. Use central-directory sizes when a data descriptor hides local sizes;
   inflate raw deflate via `fflate`.
5. Normalize names (`\`→`/`, percent-decoding), reject `..`/absolute paths,
   dedupe names, verify CRC when present.

A mismatched central-directory size is reported as `ZIP_EOCD_SIZE_MISMATCH`.
Directory entries are dropped; the container key is the normalized file path.
The `mimetype` check lives in `container.ts`, not in the ZIP reader.

## Stage 2 — `@flaforge/xml`

`parseXml` uses `saxes` with `xmlns: false` and strips namespace prefixes. It
keeps child order and text/CDATA, rejects DTD/ENTITY and malformed XML, and
enforces size/depth limits. `parseDocument` / `parseSymbolItem` turn that tree
into the typed AST in `ast.ts`.

Important AST details:

- `XflDocumentAst.symbols` only carries `<Include>` records; the compiler
  resolves `href` to `LIBRARY/<href>` (with fallbacks).
- `XflShapeAst.edges` keeps `edges` and `cubics` separately. P0 reads `edges`.
- `XflFrameAst` keeps `tweenType`, `acceleration`, `motionTweenRotate*`,
  `frameFilters`, `label`, `sound`, `script`, and `rigPropagationMatrix`.
- `XflSymbolAst.warnings` carries parser warnings (unknown element/filter/stroke
  kind) to the compiler.

## Stage 3 — `@flaforge/compiler`

### Resolver / project (`project.ts`)

1. Parse `DOMDocument.xml`.
2. Parse every `Include`; build `characterIdByName` **before** compiling any
   timeline, so forward references work.
3. Add media (`bitmap`/`sound`) to the library/assets.
4. Compile every symbol timeline and every scene timeline into IR.
5. Detect symbol cycles (`SYMBOL_CYCLE`).
6. Compute symbol bounds by fixpoint over the timeline elements, then attach
   diagnostics and stats.

### Edge parser (`edges.ts`)

Tokens: `!` move, `|` line, `[` quadratic, `/` cubic/quadratic fallback.
`#` numbers are hex fixed-point; six-digit integer parts in
`0x800000..0xFFFFFF` are sign-extended 24-bit values. `S<n>` after `!` is
skipped and counted. All coordinates are divided by 20 at parse time.

### Fill topology (`topology.ts`)

Each directed chain carries `fillStyle0` on its left and `fillStyle1` on its
right. For each fill, the compiler creates half-edges with the fill on the left
(reversing `fill1` edges), groups them by vertex, and walks the face by choosing
the smallest clockwise turn from the reverse incoming tangent. Curves use
endpoint tangents, not chords.

Loops are classified by containment depth: even depth = outer, odd = hole. Holes
attach to the immediately enclosing shell (depth − 1). Outer loops are
normalized CCW and holes CW. Open chains close with a straight segment; if no
loop can be built, the compiler falls back to per-chain closed regions and
emits a diagnostic.

### Shape (`shape.ts`)

- Fills/strokes are mapped from XFL 1-based indices to IR 0-based arrays.
- Gradients keep the XFL matrix; linear/radial/focal are converted in the
  backend.
- Variable-width strokes are flattened by arc length, offset left/right by
  `weight * markerFraction`, closed, and added as a **fill region**. They are
  removed from `strokePaths` so the backend does not draw them twice.
- Shape IDs are a stable hash of fills, strokes, regions, and stroke paths.

### Timeline (`timeline.ts`)

- XFL layers are reversed into bottom→top draw order.
- Keyframe duration covers the span to the next keyframe (or timeline end).
- Element IDs are `e:<layer>:<hash(instance key|occurrence)>`, so the two ends
  of a tween share an ID.
- A motion tween stores `toFrame`, acceleration, and rotate direction; the IR
  evaluator interpolates decomposed matrices.
- A `tweenType` on the final keyframe is ignored because there is no
  destination keyframe.
- Group elements are flattened; group matrices are ignored.
- `rigPropagationMatrix` is retained on frames/elements but not applied.

## Stage 4 — `@flaforge/ir`

`evaluateLayerFrame(layer, frame)` finds the active keyframe, interpolates
motion tweens, and returns `ResolvedElementIR` with `resolvedMatrix`.

`resolveGraphicFrame` implements the plan’s parent-local formula:

```text
rel = parentFrame - instanceStartFrame + firstFrame
loop:        rel mod childLength
play once:   clamp(rel, 0, childLength - 1)
single:      firstFrame
```

`resolveMovieclipFrame` uses the global stage frame. `validateProjectIR` checks
keys, indices, finite geometry, closed fill outers, tween endpoints, and
references. The JSON Schema is the external contract.

## Stage 5 — `@flaforge/pixi`

Scene tree:

```text
stage
└── player.root
    └── scene TimelineView.container
        └── LayerView.container (filters, mask)
            └── ElementView.container (matrix, alpha/tint, element filters)
                ├── Graphics (shape) or
                └── child TimelineView (symbol instance)
```

- `ShapeContextCache` builds one `GraphicsContext` per shape; regions emit
  `fill` then `cut` for each hole; strokes emit `stroke`.
- `FillGradient` uses `textureSpace: 'global'`, with XFL source space ±819.2 px
  transformed by the gradient matrix. Radial uses inner/outer centers, radius,
  scale, and rotation; skew is approximate.
- Element updates are reconciled by ID; unchanged nested timelines skip work.
- Frame filters live on the layer container; element filters on the element
  container. `GlowFilter({ knockout })` relies on the pixi-filters shader.
- Color transform: pure multipliers become `tint` + `alpha`; offsets use a
  `ColorMatrixFilter` with offsets `/255`.
- Masks are stencil masks (`container.mask`); both `parentLayerIndex` directions
  are supported.
