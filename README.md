# Flaforge

**Flaforge** 把 Adobe Animate 的 **FLA / XFL** 工程编译成引擎无关的
**Character IR**，再用 **PixiJS v8** 原样播放——像铁匠铺一样，把动画工程锻造成可在
Web / 游戏引擎里直接驱动、可组合、可复现的运行时数据。

> 版本 **0.1.0** · MIT · Node 20.19+（20.x）或 22.12+ · pnpm 9

核心链路：

```text
.fla/.xfl/.zip ──► @flaforge/container ──► @flaforge/xml ──► @flaforge/compiler
                                                                  │
                                                        Character IR (JSON)
                                                                  │
                     @flaforge/cli ◄── 调试 SVG / 校验 / bake     └──► @flaforge/pixi
```

实现方案：[docs/xfl-to-pixi-implementation-plan.md](docs/xfl-to-pixi-implementation-plan.md)
实现状态与验收记录：[docs/implementation-status.md](docs/implementation-status.md)
当前状态：**P0 已实现并通过样本验证；P1 位图支持已落地**。
`.dat` 位图、bitmap instance、BitmapFill 和 XFL mask 已实现；
P1 剩余文本/声音/shape tween，以及 P2（IK/3D/按钮/ActionScript/TLF）仍是规划项。

## 快速开始

```bash
pnpm install --frozen-lockfile

# 编译内置 XFL 样本并检查 IR
pnpm xfl2ir fixtures/semantics/motion-tween.xfl -o out/project.ir.json --pretty
pnpm ir-validate out/project.ir.json

# 导出第 5 帧并展开插值矩阵
pnpm xfl2svg fixtures/semantics/motion-tween.xfl -o out/frame5.svg --frame 5
pnpm ir-bake out/project.ir.json -o out/baked.json --frames 0,5,10
```

## Demo

```bash
pnpm demo  # http://localhost:5173
```

Demo 启动时会编译内置的 11 帧位移动画，支持播放、逐帧、缩放和查看诊断。
打开 `?character=Dot&frame=5` 可预览指定角色帧。开发模式下，把自己的 IR
放入 `apps/demo/public/` 后，可用 `?ir=my-project.ir.json` 加载。

```bash
pnpm release:check
pnpm exec playwright install chromium
pnpm e2e  # 另一个终端需运行 pnpm demo
```

E2E 覆盖播放、画布绘制、帧跳转、角色预览和播放器重建。
测试输入见 [Fixtures](fixtures/README.md)。

## 已实现范围（P0）

| 模块 | 状态 | 说明 |
|---|---|---|
| ZIP 容器 | ✅ | 自写容错 ZIP reader：store/deflate、data descriptor、ZIP64、EOCD 尺寸错误、重复 entry、CRC、zip-slip、大小限制 |
| 输入形态 | ✅ | `.fla` / `.zip` / 未压缩 `.xfl` 目录 / 内存 bytes |
| XML AST | ✅ | `saxes` 流式解析 + 显式类型；保留 unknown 节点；禁用 DTD/ENTITY |
| 符号 / 场景 / Include | ✅ | itemID、libraryItemName、name/href 解析；前向引用先建表再编译 |
| 图层 / 帧 / 关键帧 | ✅ | 0-based frame、duration、folder/mask/guide、绘制顺序 |
| 组扁平化 | ✅ | 按 §5.2 忽略 `DOMGroup.matrix`，成员矩阵视为绝对矩阵 |
| Edge 解码 | ✅ | `!`/`|`/`[`、`#HEX.HEX` 负数二补码、`S<n>` 跳过、twips→px |
| 填充拓扑 | ✅ | fillStyle0/1 半边 + 切线转角；外轮廓/洞；自交/开链降级 |
| 渐变 | ✅ | linear / radial、focalPointRatio、spread/interpolation 近似；IR 保留 XFL 矩阵 |
| 描边 | ✅ | 实线、虚线/点线近似、cap/join/miter、scaleMode diagnostic |
| 变宽描边 | ✅ | `VariablePointWidth` → 自适应细分 → 左右偏移 → 填充轮廓 |
| 时间线 | ✅ | keyframe span、instance run、motion tween 分解插值、graphic 同步、movieclip 时钟 |
| Character IR | ✅ | 版本化 1.0、JSON Schema、结构校验、纯函数求值器、bake |
| PixiJS v8 | ✅ | `GraphicsContext` 共享、Container 树、帧时钟、图层/实例滤镜、GlowFilter knockout、mask 基础 |
| `.dat` 位图 | ✅ | Animate `bin/M *.dat` 位图解码（ARGB → PNG） |
| BitmapFill / bitmap instance | ✅ | SVG `<pattern>`/`<image>` + Pixi `FillPattern`/`Sprite` |
| XFL mask | ✅ | `layerType="mask"` + `parentLayerIndex`，SVG luminance mask / Pixi stencil mask |
| 调试 SVG | ✅ | 形状/角色/场景渲染，渐变与滤镜近似，用于几何排查 |
| CLI | ✅ | `xfl2ir` / `xfl2svg` / `ir-validate` / `ir-bake` |
| Demo | ✅ | Vite + PixiJS 预览器：播放/暂停、逐帧、缩放、场景选择、诊断面板、角色预览 |

---|---|
| 舞台 | 1920×1080 @ 30fps，xflVersion 23.0 |
| 符号 | 40（全部 graphic） |
| 图层 / 帧 | 59 / 87 |
| DOMShape | 178（去重后 120 个 ShapeIR） |
| DOMGroup | 194 |
| DOMSymbolInstance | 111 |
| Edge 元素 | 27,036（4,851 个 `edges`，22,185 个 `cubics`） |
| 路径段 | 22,957 move / 691 line / 22,266 quadratic |
| FillStyle / StrokeStyle | 457 / 240 |
| VariablePointWidth | 74（600 条变宽路径转轮廓） |
| GlowFilter | 14 |
| rigPropagationMatrix | 12（保留 + diagnostic，不应用） |
| `S<n>` 标记 | 97（跳过 + diagnostic） |
| 编译耗时 | 约 0.6 s（本机 Node 22 / 冷启动） |

---

## 仓库结构

```
packages/
  xfl-container/    # @flaforge/container — 容错 ZIP / 目录读取，安全与诊断
  xfl-xml/          # @flaforge/xml — XFL XML AST + 类型化 parser
  xfl-compiler/     # @flaforge/compiler — Resolver + GeometryCompiler + TimelineCompiler + SVG
  character-ir/     # @flaforge/ir — IR 类型、JSON Schema、校验、tween/graphic 求值（纯函数）
  pixi-backend/     # @flaforge/pixi — IR → PixiJS v8：ShapeContext 缓存、场景树、播放器、滤镜
  cli/              # @flaforge/cli — flaforge / xfl2ir / xfl2svg / ir-validate / ir-bake
apps/
  demo/             # Vite + PixiJS 预览器（默认加载 sample IR）
fixtures/
  semantics/        # 最小语义 XFL（fill/hole、变宽描边、motion tween）
docs/
  xfl-to-pixi-implementation-plan.md
  implementation-status.md
tests/              # 跨包 JSON Schema / CLI 集成测试
scripts/            # demo 资源、E2E、SVG 渲染辅助
.dsh/skills/        # 本仓库自用的 agent skill（xfl-pipeline）
```

## Agent skill

仓库自带一个项目级 skill，供后续 agent 会话直接加载：

- 入口：`.dsh/skills/xfl-pipeline/SKILL.md`
- 详细参考：`references/pipeline-internals.md`、`references/troubleshooting.md`
- 内容：命令、仓库地图、几何/时间线不变量、调试与验收流程、常见坑。

DSH 会从 `<projectRoot>/.dsh/skills` 自动发现它；会话里可直接调用
`skill("xfl-pipeline")`，或让任务描述命中它的 `whenToUse`。

---

## IR 约定

- 矩阵：XFL/SWF 约定 `x' = a*x + c*y + tx`，`y' = b*x + d*y + ty`。
- 坐标：px；Edge 的 twips 在编译期统一 `/20`。
- 填充/描边索引：IR 内部 0-based，`-1` = none；XFL 的 1-based 只在 compiler 内转换一次。
- 时间线：frame 0-based；IR `layers` 数组顺序是**绘制顺序（底→顶）**，`layer.index` 保留 XFL 原始 index。
- Shape 内容按稳定 hash 去重；`id = shape:<fnv1a64>`。
- `transformationPoint` 只作为 `pivot` 元数据保留，渲染时不再次应用（矩阵已经是最终变换）。
- `rigPropagationMatrix` 保留在 frame/element 元数据中，P0 不应用。

JSON Schema：[packages/character-ir/schema/project-ir.schema.json](packages/character-ir/schema/project-ir.schema.json)

---

## 自定义元素树组装（CharacterAssembly）

`@flaforge/pixi` 新增 `CharacterAssembly`，用于“不播放 FLA authored timeline，只取元素树”的
外部导演场景：

```ts
import { buildCharacterAssembly } from "@flaforge/pixi";

const assembly = await buildCharacterAssembly(project, {
  characterId: "symbol:fixture-dot",
  frame: 0,
});
assembly.player.pause();
assembly.layers.get("Layer 1")?.rotation = 0.1;
// assembly.root 直接加入你的 Pixi stage
```

- 每个 pose 一个 assembly；`layers` 是顶层 `Container`，key 为 `data-layer`/图层名；
- 不自动播放、不启动 ticker；需要时调用 `seek(frame)`；
- `XflPlayer.layerContainers` 也公开了同样的图层映射；
- 实现：`packages/pixi-backend/src/assembly.ts`。

## 已知限制 / P1+

- **`cubics`**：P0 忽略，用 `edges` 的二次曲线；与 Animate 参考帧的像素差待验证。
- **`/` edge 命令**：额外样本中为 2 参数 lineTo；4/6 参数按 Q/C 兜底，语义仍待官方文档确认。
- **渐变**：`reflect`/`repeat`、`linearRGB`、一般仿射 radial 均为近似；Pixi `FillGradient` 不支持 skew。
- **描边**：`scaleMode` 的 `none/horizontal/vertical`、dash/dotted 仍未精确映射。
- **滤镜**：GlowFilter 的 `blur/strength/quality` 是近似映射；`knockout` 已实现。
- **文本/声音**：IR/容器已保留入口，渲染在 P1。
- **shape tween / motion object tween**：diagnostic，不插值。
- **BitmapFill 矩阵单位**：样本实测 scale 为 twips（`/20`）、`tx/ty` 为 px；仍需更多样本复核。
- **headless 截图**：SwiftShader 下多角色 + 多滤镜的 canvas 回读可能超时；E2E 用去滤镜 IR 做画面校验，
  单角色 + 滤镜可正常构建播放。这是测试环境限制，不是 IR 结构问题。
- **SVG 调试渲染**：glow 用 SVG filter 近似；像素基线以 Pixi/真实浏览器为准，
  `xfl2svg --no-filters` 用于纯几何排查。

---

## 下一步（P1）

1. 用 Animate 1:1 导出参考帧，关闭 §10 的 `cubics` / `S<n>` / 变宽描边 / 渐变 / Glow 参数问题。
2. 文本转轮廓；声音事件；更多 BitmapFill 矩阵样本。
3. shape tween、motion object tween。
4. 动画 mask、颜色矩阵精确化、高级混合模式。
5. 视觉回归流水线：Pixi 截图 vs Animate PNG，SSIM/pixel diff。

---

## 发布（Release）

0.1.0 的发布物为源码和静态 Demo。构建和发布步骤见
[发布手册](docs/release.md)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## License

[MIT](LICENSE) © 2026 Flaforge contributors

本项目与 Adobe 无关；Adobe、Animate、Flash 是 Adobe Inc. 的商标，
XFL/FLA 仅作为输入格式被解析。
