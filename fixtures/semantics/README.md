# Semantics fixtures

这些是最小 XFL 工程，用来锁定**结构/几何语义**，并作为未来 Animate 1:1 参考帧的挂载点。

| fixture | 覆盖 | 当前断言 |
|---|---|---|
| `basic-shape.xfl/` | 未压缩 `.xfl` 目录、符号解析、实心填充、描边、实例矩阵 | 1 region、1 stroke path、bounds 12×12、scene instance tx/ty |
| `variable-width.xfl/` | `VariablePointWidth` → 填充轮廓 | 74 类语义中的最小样本；1 outline region、0 stroke path、bounds 约 50×4 |
| `motion-tween.xfl/` | 经典 motion tween、keyframe 端点实例匹配 | frame 5 matrix tx≈50、frame 10 tx=100、两端 element id 相同 |
| `bitmap-data.xfl/` | `bitmapDataHRef` 的 chunked-zlib ARGB `.dat`、`frameRight/frameBottom` twips 尺寸 | 解码出 10×5 RGBA、PNG data、FaceSymbol bounds 10×5、`BITMAP_DAT_DECODED` |

运行：

```bash
pnpm exec vitest run packages/xfl-compiler/src/compiler.test.ts
pnpm xfl2ir fixtures/semantics/basic-shape.xfl -o /tmp/basic.ir.json --pretty
pnpm xfl2svg fixtures/semantics/basic-shape.xfl -o /tmp/basic.svg --character Shape
```

---

## 与方案 §7.1 的关系

方案要求每个待验证语义配一个 Animate 导出的参考 PNG。当前仓库没有 Animate 环境，
因此这里的 fixture 只做**结构级**断言；`docs/implementation-status.md` §6 列出了仍未关闭的问题。

新增一个语义 fixture 的建议结构：

```text
fixtures/semantics/<case>/
  case.xfl/                 # 未压缩 XFL，含 DOMDocument.xml + LIBRARY
  reference.png             # Animate 以 1:1 导出的参考帧（待补）
  reference.json            # 可选：导出参数（帧号、裁切、DPR）
```

然后在 `packages/xfl-compiler/src/compiler.test.ts` 或 `tests/` 下添加结构断言，
并在后续视觉回归脚本中用 `reference.png` 做 pixel diff/SSIM。

---

## 当前最小 fixture 的关键语义

### `basic-shape.xfl`

- 外框边：`!0 0|200 0|200 200|0 200|0 0`，`fillStyle1="1"`（右填充）。
- twips → px：`/20`，所以填充是 10×10 px。
- 描边 weight=2 px，IR bounds 向外扩 1 px → 12×12 px。

### `variable-width.xfl`

- 线段 `!0 400|1000 400`，即 50 px 水平线。
- `weight=4`，marker 0：`left/right=0.5` → 两侧各 2 px；marker 1：`0/0` → 0。
- IR 输出一个左/右偏移围成的填充轮廓，而不是 stroke。

### `bitmap-data.xfl`

- `DOMBitmapItem` 的 PNG `href` 不存在，真实数据在 `bin/M 1.fixture.dat`，通过 `bitmapDataHRef` 指向。
- `frameRight=200`、`frameBottom=100`（twips）→ 10×5 px。
- `.dat` 内容由 `make-dat-fixture.mjs` 生成：chunked zlib + ARGB。
- 验证 asset path、bitmap 尺寸、PNG data、bitmap element 的 symbol bounds、`BITMAP_DAT_DECODED` 诊断。

### `motion-tween.xfl`

- `Dot` 的 `Ball` 实例在 frame 0 与 frame 10 各一个 keyframe。
- 两端 `libraryItemName + name` 相同，compiler 复用同一个 element id。
- frame 5 用分解矩阵插值：tx 0→100、ty 0→50，得到 tx=50、ty=25。
