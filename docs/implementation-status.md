# 实现状态与验收记录

> 对应方案：[xfl-to-pixi-implementation-plan.md](xfl-to-pixi-implementation-plan.md)

---

## 1. 结论

P0 范围已实现；P1 的 `.dat` 位图 / BitmapFill / bitmap instance / XFL mask 已落地。
仓库的合成 fixture 覆盖容器、XML、编译与 IR 校验，Demo 端到端测试覆盖 PixiJS 播放。

---

## 2. 里程碑

| 阶段 | 方案内容 | 状态 | 产出 |
|---|---|---|---|
| M0 | 容器读取 + XML AST + Edge 解码 + 调试 SVG | ✅ | `xfl-container`、`xfl-xml`、Edge parser、`xfl2svg` |
| M1 | GeometryCompiler（fill 环/洞、stroke） | ✅ | `xfl-compiler/topology.ts`、`shape.ts`；简单/洞/渐变/变宽测试 |
| M2 | Character IR + 符号/时间线/图层 + Pixi 静态场景 | ✅ | `character-ir`、`pixi-backend`、demo |
| M3 | tween evaluator + graphic 嵌套 + 播放器 | ✅ | `matrix.ts`、`timeline.ts`、`XflPlayer` |
| M4 | 渐变、变宽描边、GlowFilter、颜色/遮罩 | ✅（近似） | gradient/width-outline/filters/color matrix |
| M5 | 视觉回归、性能、CLI、文档 | ✅（结构级） | CLI、schema、e2e、本文档；像素基线待 Animate 1:1 导出 |
| M6 | P1：位图/文本/声音/shape tween | 🟡 位图 ✅；文本/声音/shape tween ⏳ | `.dat`/BitmapFill/bitmap instance/mask 已实现 |

---

## 3. 模块验收

### 3.1 `xfl-container`

- 自写 ZIP reader，不依赖严格 ZIP 实现。
- 中央目录大小不一致时记录 `ZIP_EOCD_SIZE_MISMATCH`，并尝试继续读取。
- 支持 store/deflate、data descriptor、ZIP64 基础、UTF-8 flag、`\`/`%` 路径、
  大小写回退、重复 entry、CRC 校验。
- zip-slip / 绝对路径拒绝；解压炸弹与条目大小限制；DTD/ENTITY 拒绝在 XML 层。
- 目录输入支持 `.xfl/`，也支持指向包含单个 `.xfl` 子目录的父目录。
- 二进制 `FWS/CWS/ZWS` 给出明确错误，不尝试当 ZIP 读取。
- 测试：`packages/xfl-container/src/container.test.ts`。

### 3.2 `xfl-xml`

- `saxes` 流式 parser + 手写 builder，保留元素顺序和未知节点。
- 覆盖方案 §4.2 的 P0/P1 元素：Document/Symbol/Timeline/Layer/Frame、Shape/Group/Instance/
  Bitmap/Text/Morph、FillStyle/StrokeStyle/Edge、Matrix/Point/Color/Filters、sound/label/script。
- `rigPropagationMatrix` 在 frame 上解析并保留。
- XML 错误/DTD 严格报错。
- 测试：`packages/xfl-xml/src/parse.test.ts`。

### 3.3 `xfl-compiler`

- **Edge 解码**：`!` / `|` / `[`，`#HEX.HEX` 负数二补码，`S<n>` 跳过，twips→px。
  `/ x y` 在额外样本中确认为 2 参数 lineTo（JPEXS 文档未覆盖）；4/6 参数仍按 Q/C 兜底。
- **填充拓扑**：半边 + 端点切线转角；外轮廓/洞按包含深度分类；单环也统一为 CCW。
  开链/自交/洞无法归属都有 diagnostic，不静默丢形状。
- **渐变**：保留 XFL 矩阵；linear/radial/focal/spread/interpolation 转 IR。
- **位图**：`.dat`（bitmapDataHRef）→ chunked zlib → 32-bit ARGB（depth 05）或 8-bit BGRA 调色板（depth 03）→ PNG；BitmapFill 的 scale 按 twips `/20`，tx/ty 保持 px。
- **普通描边**：按 chain 输出，保留闭合性；scaleMode/dash 近似。
- **变宽描边**：`VariablePointWidth` → 细分 → 左右偏移 → 填充轮廓。
- **组**：忽略 `DOMGroup.matrix`（方案 §5.2）。
- **引用图**：编译期检测符号循环引用并记录 `SYMBOL_CYCLE`；运行时另有 32 层 depth guard。
- **媒体**：`DOMBitmapItem` 的 `href` / `bitmapDataHRef` 与 `frameRight/frameBottom`
  （twips）会解析为 asset path 和尺寸；`.dat` 解码为 PNG 并写入 IR asset（两种 DAT 布局均支持）。
- **时间线**：keyframe span、tween 端点 ID 复用、graphic/movieclip 求值、图层反向为绘制顺序。
- **诊断**：`CUBICS_IGNORED_P0`、`EDGE_SUBPATH_STYLE_MARKER`、`VARIABLE_STROKE_TO_FILL`、
  `RIG_PROPAGATION_IGNORED`、`FILL_HOLE_UNASSIGNED` 等。
- 测试：`packages/xfl-compiler/src/compiler.test.ts`。

### 3.4 `character-ir`

- IR 1.0 类型、矩阵分解/插值、轮廓几何、tween 求值、graphic/movieclip 帧解析。
- JSON Schema：`packages/character-ir/schema/project-ir.schema.json`。
- 结构校验：索引、闭合、NaN/Infinity、引用、tween 端点、图层 index 唯一。
- 测试：`matrix.test.ts`（8）、`timeline.test.ts`（9）、`tests/schema.test.ts`。

### 3.5 `pixi-backend`

- `ShapeContextCache`：每个 shape 编译一次 `GraphicsContext`，实例共享。
- 洞：每个外轮廓一次 fill，多个 `cut()`。
- `FillGradient`：XFL 源空间 ±819.2 px + 矩阵 → `textureSpace:'global'`。
- 变宽描边已由 IR 转成 region，不再走 stroke。
- `XflPlayer`：帧时钟、播放/暂停/seek/loop、场景/角色预览。
- Container 树：scene → layer → element → Graphic/Text/Sprite；元素和图层滤镜。
- Filters：GlowFilter（含 knockout）、BlurFilter、DropShadow、Bevel、ColorMatrix。
- ColorTransform：纯乘法用 tint+alpha；带 offset 用 ColorMatrixFilter（offset /255）。
- Bitmap：`Assets.load` 预加载 data URL PNG，`Sprite` / `FillPattern` 渲染。
- Mask：SVG luminance mask + Pixi stencil mask；有测试覆盖。
- E2E：`scripts/e2e-demo.mjs`（内置 11 帧动画的播放、帧跳转、画布渲染、角色预览及播放器重建）。

### 3.6 CLI / demo

- CLI：`xfl2ir`、`xfl2svg`、`ir-validate`、`ir-bake`。
- 测试：`tests/cli.test.ts`。
- Demo：Vite + PixiJS，播放控制、帧滑条、缩放、场景选择、诊断面板、`?character=` 角色预览。
- `pnpm demo:build` 成功。

---

## 4. 诊断与近似

| 项 | 处理 | 级别 |
|---|---|---|
| `cubics` | 忽略，用二次 edges | info |
| `S<n>` | 跳过，保留统计 | info |
| 变宽描边 | 转填充轮廓；cap/join 近似 | info |
| rigPropagationMatrix | 保留字段，不应用 | info |
| 渐变 reflect/repeat/linearRGB | 近似 clamp/sRGB | warn |
| radial focal | 映射内圆 | warn |
| stroke scaleMode | 按 normal | warn |
| bitmap fill | 贴图 + pattern；scale `/20` | info |
| GlowFilter | pixi-filters 参数近似 | 运行时 warning |
| 洞无法归属 | 降级为外轮廓 | warn |
| 空/纯滤镜 symbol | 记录无几何 | info |

---

## 5. 方案 §10 待验证清单

| 问题 | 当前实现 | 状态 |
|---|---|---|
| `cubics` 是否参与渲染 | P0 忽略，用 edges | ⏳ 缺 Animate 参考帧 |
| `DOMGroup.matrix` 是否忽略 | 忽略 | ✅ 样本实测；待官方参考帧复核 |
| `S<n>` 语义 | 跳过并记录 | ⏳ 缺样式切换 fixture |
| `/` edge 命令 | 2 参 → lineTo；4/6 参 → Q/C 兜底 | 已实现 |
| `VariablePointWidth` 公式/cap/join | 按方案 0.5/0.5=满宽、转填充；cap/join 直线近似 | ⏳ 缺精确参考帧 |
| `acceleration` 符号 / rotate | 按方案公式；cw/ccw 支持 | ⏳ 缺非 0 fixture |
| graphic loop/firstFrame | 按方案公式；fixture 覆盖 loop/play once/single | ✅ 逻辑测试 |
| gradient linearRGB/reflect/focal | 近似 | ⏳ 缺像素 fixture |
| bitmap fill 矩阵 | scale `/20`、tx/ty px；已渲染 | 待更多参考帧复核 |
| Glow knockout/strength/quality | knockout 已实现；参数近似 | ⏳ 像素对比 |
| layer 绘制顺序 | XFL layers 反转为底→顶 | ⏳ 多样本验证 |
| shape 内 fill 绘制顺序 | 按 fill 遍历顺序 | ⏳ 缺参考帧 |
| mask 顺序 | SVG/Pixi 均实现 | ✅ 已实现 |
| rigPropagationMatrix | 忽略 | ✅ 保留元数据 |
| `.dat` 位图 | chunked zlib + ARGB 解码 | ✅ DAT 解码测试 |

> 这些问题的关闭方式仍是方案 §7.1：最小 XFL + Animate 1:1 导出参考 PNG。
> 当前仓库的 `fixtures/semantics/` 是**结构/几何 fixture**，不是 Animate 像素基线。

---

## 6. 验证命令

```bash
pnpm typecheck
pnpm test
pnpm demo:build
pnpm xfl2ir fixtures/semantics/motion-tween.xfl -o /tmp/sample.ir.json --pretty
pnpm ir-validate /tmp/sample.ir.json
pnpm e2e        # 需要另一个终端先运行 pnpm demo
```

E2E 结果示例：

```text
E2E OK
```

---

## 7. 已知环境限制

- 无头 Chromium + SwiftShader 下，多层 glow 滤镜叠加时，`page.screenshot` /
  `canvas.toDataURL` 可能超时或导致 renderer 退出；单角色 + 滤镜、或去滤镜场景稳定。
- 因而不把“滤镜场景的像素回归”放进默认 E2E；默认 E2E 使用内置位移动画校验画面、播放和单角色预览。
- SVG 调试渲染的 glow 是近似；像素基线以 Pixi/真实浏览器为准。`--no-filters` 只用于几何排查。

---

## 8. 后续工作

1. 在 Animate 中导出 §7.1 的 12 组参考帧，建立 `fixtures/semantics/<case>/reference.png`。
2. 像素 diff/SSIM 流水线：Pixi 截图 vs Animate 1:1 PNG；先验收渐变/Glow，再验收几何。
3. P1 剩余：文本转轮廓、声音、shape tween；更多 BitmapFill/mask 样本。
4. 性能：静态 symbol `cacheAsTexture`、按帧/图层脏标记、滤镜共享与降采样。
5. 多渲染器消费者：验证 IR 不依赖 Pixi（可接 Unity/Cocos/Canvas2D）。

---

## 9. 编译器回归修复

### 9.1 单帧符号在 frame >= 1 时渲染为空

- `characterToSvg` / `projectToSvg` 直接把外部帧传给 `evaluateTimelineFrame`；frame 1 已越过最后一帧，`activeKeyframe` 返回 `undefined`，SVG 只剩空 `<defs>`。
- 修复：新增 `wrapTimelineFrame(timeline, frame)`，SVG 预览按 `timeline.frameCount` 循环；`parentFrame` 同步使用循环后的局部帧。`XflPlayer` 本身有 `seek` clamp，不受影响。

### 9.2 motion tween 结束帧重置嵌套动画起点

- XFL 在补间两端重复同一个 `DOMSymbolInstance`；编译器把每端的 `startFrame` 写成该关键帧 index。
- 嵌套 graphic/movieclip 的相位由 `parentFrame - startFrame` 计算，于是补间结束时相位跳回 0。
- 修复：`preserveTweenStartFrames` 在图层编译后把补间终点的 `startFrame` 继承为起点值（链式补间一并传播）。

### 9.3 符号 bounds 把引导层/蒙版层/隐藏层算进去

- `computeSymbolBounds` 原先把所有 layer/frame/element 都并入 bounds；walk 动作的 motion guide 常横跨整个舞台，导致 bounds 从 ~350px 撑到 ~1150px。
- 修复：bounds 计算跳过 `guide` / `mask` / `visible=false` 的 layer 和 `visible=false` 的 element；`sceneContentBounds`、`XflPlayer.fitContent` 同步过滤。

### 9.4 回归测试

- `packages/xfl-compiler/src/compiler.test.ts`：
  - SVG 单帧符号 frame 0/1/5 均输出 `<path>`；
  - 补间终点与链式补间的 `startFrame` 保持；
  - bounds 忽略 guide/mask/hidden/invisible。
- `packages/character-ir/src/timeline.test.ts`：`wrapTimelineFrame` 的 0/越界/负数/单帧用例。
- `packages/xfl-compiler/src/compiler.test.ts`：layer rig id 父链组合 / 链式 rig 的世界矩阵断言。

### 9.5 layer rigging：按 rig id 组合父级矩阵（已修复）

- 语义（由 Animate JSFL `getRigParentAtFrame` / `getRigMatrixAtFrame` 确认）：
  - `LayerIR.riggingIndex` 是**层的 rig id**；
  - frame 的 `parentLayerIndex` 指向**父层的 rig id**，不是 layer 数组下标；
  - `rigPropagationMatrix` 只缓存父级旋转/缩放，平移由父级世界矩阵补上。
- `applyRigParenting` 先建立 rig id → layer 映射，再按 `world = parentWorld * local` 组合；先算完所有世界矩阵再写回，避免父级被二次变换。
- 已知近似：在关键帧上烘焙；若父层是 motion tween，子层在关键帧之间仍按自己的 tween 插值，不跟随父层的帧间插值。
