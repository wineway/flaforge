# XFL → Character IR → PixiJS 实现方案

> 实现状态与验收记录见 [implementation-status.md](implementation-status.md)。
> 本文保留为设计/语义依据；代码与测试是当前事实来源。

> 目标：把 Adobe Animate 的 XFL（`.fla` 解压后的 XML 工程）解析成引擎无关的 **Character IR**，
> 再由 PixiJS v8 后端实例化、播放。本文是工程实现方案，不是 API 文档。
>
> 原则：**不猜 XFL / PixiJS 语义**。每条关键结论标注“已验证 / 样本实测 / 待验证”，
> 待验证项必须在实现前用最小 XFL + Animate 导出的参考帧确认。

---

## 1. 结论先行

1. **分层**：`XFL Container` → `XFL XML AST` → `Resolver` → `Character IR` → `Pixi Backend`。
   IR 不出现任何 Pixi 类型，后续可接 Unity / Cocos / 自研渲染器。
2. **几何在编译期解析干净**：`Edge.edges` 的 `! | [` 指令 + `fillStyle0/1` 左右填充语义，
   在编译期重建为“填充区域（外轮廓 + 洞）+ 描边路径”，IR 里不保留原始 edge 字符串。
3. **时间线保留 keyframe + tween 元数据**，运行时用统一求值器展开；也可离线 bake 成逐帧矩阵做校验。
4. **PixiJS 只做三件事**：把 IR 形状编译为可复用的 `GraphicsContext`；把符号/图层/元素映射为
   `Container` 树；用帧时钟更新 transform / 可见性 / 遮罩 / 滤镜。
5. **解析兼容点**：ZIP EOCD 损坏、Animate 23 的 `cubics`、未文档化的 `S<n>` 标记、
   `VariablePointWidth`、`DOMGroup.matrix` 重复、`rigPropagationMatrix`。方案中逐项给出处理策略。
6. **P0 范围**：容器读取、符号/时间线/图层/帧、组、形状、纯色/渐变填充、
   实线/变宽描边、经典 motion tween、graphic 符号循环、GlowFilter（含 `knockout`）、1920×1080 舞台。
   **渐变、普通描边、变宽描边、GlowFilter 都在 P0，不是 spike 的省略项，也不是 P1 的可选美化。**
   P1：位图、遮罩、颜色变换、混合模式、shape tween、文本、声音。P2：IK/rig、3D、按钮、ActionScript、TLF。

---

## 2. 验证范围

仓库使用合成 XFL fixture 验证解析、编译、渲染和时间线行为。

## 3. 总体架构

```
.fla / .xfl 目录
   │
   ▼
┌──────────────────────┐
│ XflContainerReader   │  ZIP（容错）/ 目录 / 编码 / zip-slip / 大小限制
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ XflXmlReader         │  DOMDocument / DOMSymbolItem / DOMTimeline / ...
│ (typed AST)          │  保留 unknown 节点，不做“通用 XML→JSON”
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ XflResolver          │  符号引用、itemID/name/href、场景、资源、组扁平化
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ GeometryCompiler     │  edges → 归一化路径；fill 环 + 洞；stroke 路径/变宽轮廓
│ TimelineCompiler     │  keyframe → span；tween；instance run；layer 层级
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ Character IR (JSON)  │  引擎无关、版本化、可序列化、可 diff
└─────────┬────────────┘
          ▼
┌──────────────────────┐
│ PixiBackend          │  GraphicsContext 缓存、Container 树、帧时钟、遮罩/滤镜
└──────────────────────┘
```

推荐仓库结构（pnpm workspace + TypeScript）：

```
packages/
  xfl-container/      # ZIP/目录读取，容错、编码、zip-slip
  xfl-xml/            # XFL XML AST + 类型定义 + 版本差异
  xfl-compiler/       # Resolver + GeometryCompiler + TimelineCompiler
  character-ir/       # IR types、JSON Schema、校验、tween evaluator（纯函数）
  pixi-backend/       # IR → PixiJS v8 场景/播放器
  cli/                # xfl2ir / ir-validate / ir-bake
apps/
  demo/               # Vite + PixiJS 预览器
fixtures/
  semantics/          # 合成 XFL 测试 fixture
  semantics/          # 每个待验证语义的最小 XFL + 参考 PNG
docs/
```

---

## 4. 模块设计

### 4.1 容器读取（XflContainerReader）

必须支持三种输入：

1. `.fla` ZIP；
2. 未压缩 XFL 目录（`.xfl/`，含 `DOMDocument.xml`）；
3. 普通 `.zip`（内容同上）。

要点：

- 中央目录大小异常时，按条目校验并记录诊断。
  自写 ~200 行读取器：扫描 EOCD → 读 central directory → 遇到 magic/offset 不一致时回退扫描 local file header；
  支持 store/deflate、UTF-8 flag、data descriptor、ZIP64。
- `mimetype` 校验：`application/vnd.adobe.xfl`。二进制 FLA 要报明确错误，不要尝试当 ZIP 读。
- 路径：`decodeURIComponent`、`\` → `/`、大小写、中文/空格。
- 安全：zip-slip（`..`/绝对路径）、解压炸弹、XML 大小上限、DTD/外部实体禁用（XXE）。
- 重复 entry、CRC 错误、缺失 entry：记录 diagnostic，按策略 fail-fast 或继续。

### 4.2 XFL XML AST（XflXmlReader）

不要用“通用 XML→JSON”再 `any` 访问。为 XFL 建立显式类型：

```ts
interface XflDocument {
  width: number; height: number; frameRate: number;
  backgroundColor?: string;
  symbols: XflSymbolItem[];       // <Include href> 解析后的 DOMSymbolItem
  timelines: XflTimeline[];       // <DOMTimeline>
  media: XflMediaItem[];          // bitmap/sound/video/font
  scripts?: string;
  raw: XmlNode;                   // 调试/未知节点
}
```

覆盖到 P0/P1 的元素：

- `DOMDocument`、`DOMSymbolItem`、`DOMTimeline`、`DOMLayer`、`DOMFrame`、`elements`
- `DOMShape`、`DOMGroup`、`DOMSymbolInstance`、`DOMBitmapInstance`
- `DOMStaticText` / `DOMDynamicText` / `DOMInputText`、`DOMMorphShape`
- `fills/FillStyle`（SolidColor / LinearGradient / RadialGradient / BitmapFill）
- `strokes/StrokeStyle`（SolidStroke / DashedStroke / DottedStroke / RaggedStroke / ...）
- `edges/Edge`（`edges` 与 `cubics` 两个属性）
- `matrix/Matrix`、`transformationPoint/Point`、`color/Color`、`filters/*`、`frameFilters`
- `sound`、`frameLabel`、`Actionscript`（只保留，不执行）

实现建议：`saxes` 流式 parser + 手写 builder。原因：

- 单文件可达 1 MB、27k Edge，DOM 也能做，但流式更稳；
- 需要保留子元素顺序（绘制顺序、fill/stroke 顺序）；
- 需要保留未知节点用于诊断；
- 避免 `fast-xml-parser` 的 `preserveOrder` 结构污染业务代码。

AST 层只做“XML → 类型化对象”，不做语义解释；语义全部放到 compiler。

### 4.3 Resolver

- `Include href` → `LIBRARY/xxx.xml`；`libraryItemName` → 符号；`itemID` 作为稳定 ID。
- 组扁平化：**忽略 `DOMGroup.matrix`**，成员矩阵视为父级绝对矩阵，按 `members` 顺序展开。
  依据见 §5.3。
- 场景：`<timelines>` 可能多个；默认第一个，全部保留。
- 资源：`DOMBitmapItem href` / `sourceExternalFilepath` / 内嵌数据；声音/字体同理。
- 循环引用检测（符号 A 内嵌 A）：运行时允许吗？Flash 允许 movieclip 自引用（通过实例递归），
  但静态解析要限制深度并记录；P0 遇到环直接 diagnostic + 空实现。

### 4.4 GeometryCompiler

输入 `DOMShape`，输出 `ShapeIR`：

```ts
interface ShapeIR {
  id: string;                 // 内容 hash，便于跨帧/跨实例复用
  bounds: Rect;
  fills: FillStyleIR[];       // 0-based，IR 内部索引
  strokes: StrokeStyleIR[];
  regions: FillRegionIR[];    // 已解析的填充区域
  strokePaths: StrokePathIR[];
}

interface FillRegionIR {
  fill: number;               // -> fills
  outer: ContourIR;
  holes: ContourIR[];
}

interface ContourIR {
  start: Vec2;
  segments: (
    | { k: 'L'; to: Vec2 }
    | { k: 'Q'; c: Vec2; to: Vec2 }
    | { k: 'C'; c1: Vec2; c2: Vec2; to: Vec2 }
  )[];
  closed: boolean;
}
```

#### 4.4.1 解析 `Edge.edges`

已确认的语法（来自 JPEXS `XFLConverter.convertShapeEdge` + 样本）：

| 指令 | 含义 | 参数 |
|---|---|---|
| `!` | moveTo | `x y` |
| `\|` | lineTo | `x y` |
| `[` | quadraticCurveTo | `cx cy x y` |
| `/` | （样本未出现；JPEXS 不写） | 待查 |
| `S<n>` | Animate 23 私有标记；仅出现在 `!` 后 | 忽略，保留诊断 |

- 坐标单位是 **twips（1/20 px）**；入口统一 `/20`。
- 数字可以是 `#HEX.HEX` 形式（JPEXS `numEdgeToString`），不能只 `parseFloat`。
- 样式属性（`fillStyle0/1/strokeStyle`）作用于该 `<Edge>` 内所有段；`S<n>` 不改变样式。
- 每个 Edge 元素可含多个子路径（多个 `!`），要保留。
- 解析后做一次 cleanup：合并重复点、去掉零长段、容差 1e-4 px 合并端点。

#### 4.4.2 `fillStyle0/1` → 填充区域

XFL 的填充不是“每个 fill 一个 path”，而是 SWF 风格的**平面图**：

- 每条有向边左侧是 `fillStyle0`，右侧是 `fillStyle1`；0 表示无填充。
- 对每个 fill `F`，收集所有 `F` 在左侧的有向半边，沿“面”的边界走：

```
从半边 h(A→B) 出发
在 B 点，取所有从 B 出发、且 F 在左侧的半边
按统一公式选下一条：`d = (angle(B→A) - angle(B→C)) mod 2π`，取 `d` 最小的一条
（tangent 用曲线在端点的切线；不要用弦方向代替曲线切线）
继续直到回到起始半边
```

- 环的方向会自然区分外轮廓/洞：同一个 fill 的所有环放进一个 SVG/Canvas path，
  用 nonzero winding 即可挖洞；Pixi 后端则需要把洞显式 `cut()`。
- 洞归属：对每个环做 point-in-polygon，挂到包含它的最小外轮廓；无包含关系的独立环是多个区域。
- 共享边界会被两个 fill 各走一次，这是正确的。
- 失败兜底：
  - 开链（走不回起点）→ diagnostic，尝试按端点最近邻串成闭合环；
  - 自交/退化 → 记录并降级为“按子路径闭合填充”，不要静默丢形状。

#### 4.4.3 `cubics`

样本中 `cubics` 是**独立 Edge 元素**，没有 fill/stroke 样式，不能单独决定填充拓扑：

- 22,185 个 cubics vs 22,266 个二次曲线，接近 1:1；每个 cubics 带 `q/Q` 流，保留原二次曲线信息。
- **P0：忽略 `cubics`，用 `edges` 的二次曲线**。差异通常在几个 twip 量级，缩放后 <1 px。
- P1：按端点/顺序把 cubics 对齐到对应二次段，用 cubic 替换几何；仅当参考帧显示可见差异时启用。
- 不要把 cubics 当成“另一套独立 shape”去重建填充，否则会得到重复/错误拓扑。

#### 4.4.4 描边

- 按 `strokeStyle` 分组，保留每个子路径的连续性（不要逐段 `stroke`）。
- `SolidStroke` 映射到 Pixi `stroke({ width, cap, join, miterLimit, alignment: 0.5 })`。
- `scaleMode`：
  - `normal`：Pixi 默认行为（随容器缩放）；
  - `none` / `horizontal` / `vertical`：Pixi **没有直接等价物**。P0 记录 diagnostic；
    P1 用“反向缩放描边宽度”或“把描边转成填充轮廓”实现。
- `VariablePointWidth`：
  - 样本语义（待官方/参考帧确认）：`left/right` 是 `weight` 的比例，`position` 是沿路径的 0..1；
    例如 `weight=2, (0.5,0.5)@0, (0,0)@1` 表示从 2 px 渐细到 0。
  - Pixi 不支持变宽 stroke，必须**转为填充轮廓**：把路径自适应细分，按 arc-length 插值左右宽度，
    生成 left/right 偏移点，首尾按 cap 规则封口，作为 `FillRegionIR` 输出。
  - 变宽轮廓的 joins/caps 需要单独的几何测试。
- 虚线/点线/粗糙线/hatched：Pixi 无原生 dash，P1 用“沿路径采样 → 小段 stroke”或“转填充”。

#### 4.4.5 渐变

- XFL 渐变矩阵的坐标空间是 SWF 的 `[-16384, 16384] twips = [-819.2, 819.2] px`。
- 线性：`start = M(-819.2, 0)`，`end = M(819.2, 0)`。
- 径向：`center = M(0,0)`，`outerRadius = 819.2 * scale`，`focalPointRatio` 映射到内圆偏移。
- Pixi `FillGradient` 的 `textureSpace: 'global'` 使用 Graphics 本地坐标，正好对应 XFL 的 shape 本地 px。
- 径向带旋转/非均匀缩放/剪切：Pixi 的 `scale`/`rotation` 只覆盖椭圆，不覆盖一般仿射；
  兜底是离线把渐变 ramp 烘成纹理，再用 `texture + matrix` 填充。
- `spreadMethod`：`pad` → clamp；`repeat` → repeat；`reflect` 无直接等价，烘纹理或近似。
- `interpolationMethod=linearRGB`：Pixi 默认 sRGB，必要时离线烘纹理。
- 渐变包含 alpha 时，滤镜需要用带透明度的源几何生成效果。

### 4.5 TimelineCompiler

```ts
interface TimelineIR {
  id: string;
  name: string;
  frameCount: number;
  layers: LayerIR[];          // 顺序 = 绘制顺序（底→顶；以 XFL 实际顺序为准）
  labels: { name: string; frame: number }[];
}

interface LayerIR {
  index: number;
  name: string;
  type: 'normal' | 'folder' | 'mask' | 'guide';
  visible: boolean;
  parentIndex?: number;       // folder/mask/guide 层级
  frames: FrameIR[];          // keyframe 列表，按 index 升序
}

interface FrameIR {
  index: number;
  duration: number;           // 覆盖 [index, index+duration)
  elements: ElementIR[];
  tween?: TweenIR;            // 仅 motion/shape
  filters?: FilterIR[];
  colorTransform?: ColorTransformIR;
  label?: string;
  sound?: SoundEventIR[];
  script?: string;            // 原样保留，不执行
}
```

关键语义：

- **frame index 0-based**；`duration` 缺省 1；最后一个 keyframe 可以没有 duration。
- 帧 `f` 的激活 keyframe：满足 `index <= f < index + duration` 的最后一个。
- **motion tween**（`tweenType="motion"`）：
  - 起点 keyframe 有 matrix，终点 keyframe 在 `index+duration`；
  - 中间帧不存储，运行时插值；
  - 插值不是对 `a,b,c,d,tx,ty` 直接线性插值，而是分解后插值（见 §5.4）。
- **instance run**：把相邻 keyframe 中“同一实例”合并为一条 track。
  - 匹配键：`libraryItemName + name + 同层序号`；tween 两端通常是同一实例。
  - 匹配失败则视为不同实例（在关键帧处替换），不要强行合并。
- **graphic 符号播放**：子时间线相对父时间线同步推进；`loop` / `play once` / `single frame`；
  `firstFrame` 为起始偏移。具体公式见 §5.5。
- **movieclip**：独立时钟；父时间线暂停不影响；默认循环。

### 4.6 Character IR

建议拆成“定义（library）”和“引用（element）”，shape 内容按 hash 去重：

```ts
interface ProjectIR {
  irVersion: '1.0';
  meta: {
    source: string;
    xflVersion?: string;
    generator: string;
    generatedAt: string;
  };
  stage: {
    width: number; height: number; frameRate: number;
    backgroundColor?: string;   // 无则透明
  };
  library: Record<string, CharacterIR>;  // 符号/位图/文本/声音
  shapes: Record<string, ShapeIR>;       // 内联 shape 去重表
  scenes: SceneIR[];
  assets: AssetIR[];
  diagnostics: Diagnostic[];
}

type CharacterIR =
  | { kind: 'symbol'; id: string; name: string; symbolType: 'graphic' | 'movieclip' | 'button';
      timeline: TimelineIR; bounds: Rect; linkage?: LinkageIR }
  | { kind: 'bitmap'; id: string; name: string; assetId: string; width: number; height: number }
  | { kind: 'text'; id: string; name: string; text: TextIR }
  | { kind: 'sound'; id: string; name: string; assetId: string };

interface SceneIR {
  id: string; name: string; frameCount: number;
  // 主时间线直接复用 TimelineIR
  timeline: TimelineIR;
  elements: ElementIR[];   // 场景根层元素（或放在 timeline.layers 里）
}

interface ElementIR {
  id: string;              // 稳定 ID，跨帧复用
  kind: 'instance' | 'shape' | 'group' | 'bitmap' | 'text';
  matrix: MatrixIR;        // local -> parent，XFL 的 [a,b,c,d,tx,ty]
  pivot?: Vec2;            // transformationPoint，仅元数据；渲染时不额外应用
  colorTransform?: ColorTransformIR;
  blendMode?: BlendModeIR;
  filters?: FilterIR[];
  visible?: boolean;
  cacheAsBitmap?: boolean;
  // instance
  characterId?: string;
  firstFrame?: number;
  loopMode?: 'loop' | 'play once' | 'single frame';
  // shape
  shapeId?: string;
  // bitmap/text
  assetId?: string;
  text?: TextIR;
}
```

`MatrixIR` 就存 `{a,b,c,d,tx,ty}`，不要过早分解；求值器/后端需要时再分解。

**内部索引约定**：XFL 的 fill/stroke 是 1-based，0 = none；IR 内部改为 0-based，
`-1` = none。转换只在一处做，避免全链路混淆。

### 4.7 Pixi Backend

#### 4.7.1 场景树

```
stage (Container)
└── sceneRoot (Container)              // 舞台缩放/适配
    └── sceneTimeline (Container)      // 主时间线
        ├── layer[0] (Container)       // 每个 XFL layer 一个
        │   ├── element (Container)    // 每个实例一个
        │   │   └── Graphics / Sprite / Text
        │   └── ...
        └── layer[n]
```

- **layer 容器**承载：图层可见性、帧级 filters、遮罩分组。
- **element 容器**承载：matrix、alpha、color、blend、实例级 filters。
- **shape** 用 `Graphics`；**bitmap** 用 `Sprite`；**text** 用 `Text` 或预转轮廓。

#### 4.7.2 形状缓存

- 每个 `ShapeIR` 编译一次 `GraphicsContext`，所有实例共享：

```ts
const ctx = new GraphicsContext();
for (const region of shape.regions) {
  ctx.beginPath();
  emitContour(ctx, region.outer);
  ctx.closePath();
  ctx.fill({ color, alpha });        // 或 FillGradient / texture
  for (const hole of region.holes) {
    ctx.beginPath();
    emitContour(ctx, hole);
    ctx.closePath();
    ctx.cut();
  }
}
for (const sp of shape.strokePaths) {
  ctx.beginPath();
  emitContour(ctx, sp);
  if (sp.closed) ctx.closePath();
  ctx.stroke({ width, cap, join, miterLimit, alignment: 0.5 });
}
const g = new Graphics(ctx);
```

- **Pixi 的洞**：`cut()` 会把 hole 挂到最后一个 fill/stroke 指令；多个 hole 会累加。
  因此“每个外轮廓一次 fill + 多个 cut”是可行的；不要把多个外轮廓塞进同一个 fill 再 cut。
- `GraphicsContext` 共享后，`new Graphics(ctx)` 是廉价操作；销毁 `Graphics` 不会销毁 ctx，
  统一由资源管理器在节目卸载时销毁。
- 复杂/自交形状若 earcut 失败：检测后走预三角化 `Mesh`（earcut/libtess）或拆简单多边形；
  记录 diagnostic，不要静默丢。

#### 4.7.3 transform

- XFL 与 Pixi 的矩阵约定一致：

```
| a c tx |
| b d ty |
```

- `container.setFromMatrix(new Matrix(a,b,c,d,tx,ty))`；Pixi 会分解为 position/rotation/skew/scale。
- 负行列式（镜像）会变成负 scale；不要自己“修正”。
- 不要在运行时对每一级容器重复乘父矩阵；让 Pixi 的 transform 链工作。
- 对同一元素只更新变化的矩阵；缓存上一次帧的 `a..ty`。

#### 4.7.4 帧时钟与播放器

不要用 `AnimatedSprite` 管所有东西；XFL 是“时间线 + 层 + 嵌套符号”，需要自定义 `XflPlayer`：

```ts
class XflPlayer {
  private frame = 0;
  private accumulator = 0;
  update(dtMs: number) {
    this.accumulator += dtMs;
    const frameDuration = 1000 / this.fps;
    while (this.accumulator >= frameDuration) {
      this.accumulator -= frameDuration;
      this.frame = (this.frame + 1) % this.totalFrames; // 或播放模式
      this.applyFrame(this.frame);
    }
  }
  seek(frame: number) { this.frame = frame; this.applyFrame(frame); }
}
```

- 以“帧”为唯一时间单位，避免每个元素各自 `Ticker` 造成漂移。
- 跳帧时直接 `applyFrame`，不要补间；Flash 的时间线语义本来就是离散帧。
- movieclip 的独立时钟也用帧号推导：`childFrame = (currentFrame - startFrame) % childLength`。
- `loop` / `stop` / `gotoAndPlay` 等 API 预留；ActionScript 不执行。

#### 4.7.5 遮罩、滤镜、混合、颜色

| XFL | PixiJS v8 | 说明 |
|---|---|---|
| `layerType="mask"` + `parentLayerIndex` | `container.mask = maskContainer` | 模板遮罩；mask 本身不直接绘制 |
| `GlowFilter` | `pixi-filters` `GlowFilter` | `knockout=true` 时必须隐藏源对象、只输出 glow；参数近似，需像素对比 |
| `BlurFilter` | `BlurFilter` | 直接 |
| `DropShadowFilter` | `pixi-filters` `DropShadowFilter` | 直接/近似 |
| `BevelFilter` | `pixi-filters` `BevelFilter` | 近似 |
| `AdjustColorFilter` | `ColorMatrixFilter` | 可精确构造 4x5 矩阵 |
| `blendMode` | `container.blendMode` + `pixi.js/advanced-blend-modes` | `layer/alpha/erase/invert` 需特殊处理 |
| `color/Color` | `ColorMatrixFilter` 或 `tint`+`alpha` | 纯乘法可 `tint`；有 offset 用矩阵 |

- 帧级 `frameFilters` → layer 容器的 `filters`；实例级 `filters` → element 容器。
- 滤镜会改变 bounds/padding；缓存 render texture 时要把 padding 算进去。
- Pixi 的 `ColorMatrixFilter` offset 量纲要在实现时核对源码，不要按 0..255 猜。

#### 4.7.6 静态缓存

- 单帧、无动画、无滤镜/遮罩的符号：首次渲染后 `cacheAsTexture()` 或 `renderer.generateTexture`。
- 多帧但无嵌套动画的符号：每帧一个 `GraphicsContext`，切帧时 `graphics.context = ctx`（Pixi 文档明确这是廉价操作）。
- 有嵌套动画的符号：不要整体缓存，按“静态子层”缓存。
- 大字符优先缓存；但要先测首次编译耗时。

---

## 5. 关键语义（已验证 / 待验证）

### 5.1 坐标与单位

| 项 | 结论 | 依据 |
|---|---|---|
| 舞台原点 | 左上，y 向下；与 Pixi 一致 | XFL 常规 |
| 矩阵 | `x'=a*x+c*y+tx`, `y'=b*x+d*y+ty` | XFL schema / Pixi `Matrix.ts` 完全一致 |
| Edge 坐标 | twips，`/20` 得 px | JPEXS `XFLConverter`；样本 bbox 验证 |
| stroke weight | px（不是 twips） | schema `weight` 文档 |
| transformationPoint | px，编辑器 pivot 元数据；静态渲染**不使用** | 样本数值与 `t = p - R*p` 吻合；无论其坐标空间如何，matrix 已是最终变换 |
| gradient matrix | 源空间 `±819.2 px`（16384 twips），映射到 shape 本地 px | 样本 bbox/中心/半径验证 |
| bitmap fill matrix | 单位待验证（`tw` 项目除以 20，存疑） | 以最小 bitmap fixture 复核 |

**transformationPoint 的处理**：静态渲染时**完全忽略**，只用 matrix。它是编辑器 pivot 元数据；
XFL 在旋转时已将 `T(p) R T(-p)` 烘入实例矩阵。

### 5.2 组的 matrix

**结论：忽略 `DOMGroup.matrix`，成员的 matrix 视为父级绝对矩阵，按 members 顺序扁平化。**

成员矩阵已表达位置与旋转，叠加组矩阵会重复施加变换。用 Animate 参考帧检查组变换。

### 5.3 `S<n>` 标记

- 处理：解析时跳过 `S\d+`，在 AST 里保留 `subpathStyleId?: number` 供未来研究；记录一次 diagnostic。
- 待验证：在 Animate 里改一个 subpath 的样式，观察 S 是否变化；若它确实表示样式切换，需要重新评估。

### 5.4 经典 motion tween

样本：`tweenType="motion"`、`motionTweenSnap="true"`、`keyMode=22017`、无 `acceleration`。

已验证的分解/插值模型（JPEXS `ClassicTweenDetector`）：

```text
sx = hypot(a,b)
sy = hypot(c,d) * sign(det)          // 把镜像放进 y scale，保持角度连续
angleX = atan2(b,a)
angleY = atan2(-c/sy, d/sy)

对 t in [0,1]，eased = t + acceleration/100 * t*(1-t)
tx,ty,sx,sy,angleX,angleY 各自从起点到终点线性插值
a = sx*cos(angleX); b = sx*sin(angleX)
c = -sy*sin(angleY); d = sy*cos(angleY)
```

- 角度要 unwrap 到最短路径；`motionTweenRotate` 控制方向/圈数（本样本为默认）。
- `acceleration` 与 SWF 的 progress ease 符号相反；JPEXS 在导出时写 `-ease`。
- 终点 keyframe 保留实际 matrix；中间帧用公式算。
- 本样本 `acceleration=0`，公式退化为线性插值。
- **不要**对 `a,b,c,d` 直接线性插值：旋转时会导致缩放收缩。

待验证：

- `acceleration` 非 0 时的符号；
- `motionTweenRotate=clockwise/counter-clockwise` 与 `motionTweenRotateTimes`；
- 新式 `tweenType="motion object"`（带 `<AnimationCore>` / 属性曲线）不在 P0。

### 5.5 graphic vs movieclip 播放

graphic 实例（`symbolType="graphic"`）与父时间线同步：

```text
// parentFrame 是父符号的当前本地帧，不是全局舞台帧
childFrame = firstFrame + (parentFrame - instanceStartFrame)
switch (loopMode) {
  case 'loop':       childFrame %= childLength
  case 'play once':  childFrame = min(childFrame, childLength - 1)
  case 'single frame': childFrame = firstFrame
}
```

- 样本中父帧 duration=30、子符号 30 帧，等价于播放一次。
- 嵌套 graphic 用各自的 `instanceStartFrame` 递推。
- movieclip 用独立时钟，循环播放；父时间线暂停不影响。
- 待验证：父帧 duration 大于子长度时的 loop 重启点；`firstFrame` 是否 1-based（schema 说 0，样本未用）。

### 5.6 颜色 / 混合 / 滤镜 / 遮罩

- `Color` 的 multiplier/offset 是逐通道；`alphaMultiplier` 可直接 `container.alpha`。
- 只有乘法时可用 `tint`；有 offset 时必须 `ColorMatrixFilter`（精确但更贵）。
- GlowFilter 参数与 pixi-filters 不是一一对应：`blurX/blurY` → `distance`，`strength` → `outerStrength`，
  `inner` → `innerStrength`，`quality` 0..3 → 0..1；需要像素对比，不要宣称精确。
- `knockout="true"` 隐藏源对象并保留光晕。用参考帧核对 `pixi-filters` 的混合输出。
- 遮罩层用 stencil mask；mask 内容可能是动画，逐帧更新 `GraphicsContext`。
- `layer/alpha/erase/invert` 混合模式 Pixi 无直接等价；P1 用 mask/自定义 filter/隔离组实现。

### 5.7 rig / 3D / 其他

- `rigPropagationMatrix` 保留为元数据并记录诊断。
- `matrix3D` / `rotationX/Y/Z`：Pixi 2D 不支持；P2 投影或降级。
- `layerDepthEnabled`：P0 忽略。
- `layerType=folder/guide`：folder 不渲染；guide 不渲染（除非作为参考）。
- `parentLayerIndex`：folder/mask/guide 层级；Animate 2019 的 layer parenting 是否复用该字段待验证。

---

## 6. PixiJS 版本与 API 选型

目标：**PixiJS v8.x**（当前文档 8.23），WebGL 优先，WebGPU 后评估。

已验证可用的 API：

- `GraphicsContext` + `Graphics`，共享 context；
- `fill(style)` / `stroke(style)` / `cut()` / `beginPath()` / `closePath()`；
- `FillGradient`（`type:'linear'|'radial'`, `textureSpace:'global'`）；
- `Graphics` 的 `stroke({width, alignment, cap, join, miterLimit, pixelLine})`；
- `Container.setFromMatrix(Matrix)`；
- `Container.mask` / `setMask`；
- core filters：`AlphaFilter`、`BlurFilter`、`ColorMatrixFilter`、`DisplacementFilter`、`NoiseFilter`；
- `pixi-filters`：`GlowFilter`、`DropShadowFilter`、`BevelFilter`；
- `pixi.js/advanced-blend-modes`；
- `cacheAsTexture()` / `renderer.generateTexture()`；
- `Ticker` 作为外部时钟。

已知限制：

- 没有变量宽度 stroke；
- 没有 `scaleMode=none/horizontal/vertical`；
- 没有原生 dash/dotted；
- 径向渐变不支持一般仿射矩阵/`reflect`；
- 遮罩是 stencil（硬边），不是 alpha mask；
- 高级混合模式有 resolution/性能注意事项。

这些限制都在 IR 层用“转填充 / 预烘纹理 / 近似 + diagnostic”兜底。

---

## 7. 验证方案（必须做，不能只靠肉眼）

### 7.1 语义 fixture（最高优先级）

为每个“待验证”建一个最小 XFL + Animate 导出的参考 PNG/帧序列：

1. `cubics` vs `edges`：同一形状，比较 0/14/29 帧的像素差；决定是否启用 cubics。
2. `DOMGroup.matrix`：单成员/多成员 group 各一个；确认忽略。
3. `S<n>`：改 subpath 样式前后导出，确认语义。
4. `VariablePointWidth`：已知 width marker 的直线/曲线，拟合公式。
5. motion tween：非 0 acceleration、顺时针/逆时针、跨 0° 旋转。
6. graphic loop：父帧 60、子 30，确认 loop/play once/single frame。
7. 渐变：linear/radial、focalPointRatio、spreadMethod、linearRGB。
8. GlowFilter：blurX/blurY/strength/inner/knockout 的像素对比。
9. 遮罩：动画 mask、多个 masked layer 的顺序。
10. bitmap fill 矩阵单位。
11. 文本：字体/字号/对齐/抗锯齿。
12. `rigPropagationMatrix`：带 rig 的 XFL，确认是否影响渲染。

### 7.2 结构测试

- 所有 fill 区域闭合；每个 contour ≥ 2 段；无 NaN/Infinity。
- 所有 `libraryItemName` / `assetId` 可解析；无环（或环有 guard）。
- IR 通过 JSON Schema 校验；diagnostic 数量/级别符合预期。

### 7.3 视觉回归

- 每个角色/符号在关键帧渲染 PNG，与 Animate **1:1 导出**的参考图做 pixel diff/SSIM。
- 输出 diff 图，定位是几何、颜色、滤镜还是抗锯齿差异；
- 阈值分级：P0 结构正确（无缺失/错位），P1 像素级接近。

### 7.4 性能

- 解析+编译：样本 < 2 s（目标）；
- 首帧：< 500 ms；
- 播放：1920×1080、4 角色、30 fps 稳定；
- 内存：共享 `GraphicsContext` 后，形状几何不随实例数线性增长；
- 大量实例时用 render texture / 静态缓存。

---

## 8. 里程碑

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| M0 | 容器读取 + XML AST + Edge 解码 + 调试 SVG | 能解包并 dump 一个 shape | 1 周 |
| M1 | GeometryCompiler（fill 环/洞、stroke）+ 原型 | 静态角色正确渲染 | 2 周 |
| M2 | Character IR + 符号/时间线/图层 + Pixi 静态场景 | 4 角色静态合成 | 1.5 周 |
| M3 | tween evaluator + graphic 嵌套 + 播放器 | 播放内置动画 | 1.5 周 |
| M4 | P0 视觉项收尾：渐变、变宽描边、GlowFilter、颜色/遮罩 | 视觉接近参考 | 2 周 |
| M5 | 视觉回归、性能、CLI、文档 | 可交付 MVP | 1.5 周 |
| M6 | P1：位图/文本/声音/shape tween | 生产可用 | 2-4 周 |

单人约 8-10 周到 P0+P1 核心；两人并行可压缩到 5-6 周。MVP约 4 周。

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| fill 平面图重建错误 | 形状缺块/洞错/颜色错 | 半边遍历 + 切线转角；与参考帧逐形状 diff；失败不静默 |
| Pixi earcut 对自交/复杂洞失败 | 三角化异常 | 检测自交；预三角化 Mesh；拆多边形；测试集 |
| `cubics` 语义未确认 | 曲线细节偏差 | P0 用 edges；P1 对齐后 A/B 对比 |
| 变宽描边语义未确认 | 轮廓粗细/端点错 | 最小 fixture 拟合；转填充；逐帧对比 |
| tween 符号/缓动方向 | 动画节奏错 | JPEXS 公式 + 非 0 acceleration fixture |
| GlowFilter 参数不一一对应 | 发光范围/强度差异 | 像素对比；必要时自定义 shader |
| group/rig 语义 | 整体错位 | 参考帧确认；P0 忽略 group/rig 并记录 |
| ZIP 损坏/编码 | 打不开 | 容错 reader + 多 fixture |
| 大型 XFL 性能 | 首帧卡顿 | 流式解析、context 共享、静态缓存、必要时离线烘纹理 |
| 字体/文本 | 排版差异 | 优先转轮廓；fallback Text + diagnostic |
| 颜色空间 | 渐变/混合偏色 | 与 Animate 参考对比；必要时 linearRGB 烘纹理 |

---

## 10. 待验证清单（实现前必须关闭）

- [ ] `cubics` 是否参与 Adobe 渲染；与 `edges` 的像素差。
- [ ] `DOMGroup.matrix` 是否真的忽略（多成员 group 参考帧）。
- [ ] `S<n>` 的确切语义。
- [ ] `VariablePointWidth` 的 left/right/position 公式与 cap/join。
- [ ] `acceleration` 符号、`motionTweenRotate*`。
- [ ] graphic `loop`/`firstFrame` 在父帧长于子帧时的行为。
- [ ] gradient `linearRGB`、`reflect`、focalPointRatio。
- [ ] bitmap fill matrix 单位。
- [ ] GlowFilter 参数映射，尤其是 `knockout`、`strength`、`quality` 的混合方式。
- [ ] layer 绘制顺序（XFL `<layers>` 是底→顶还是顶→底）与 group 内 members 顺序。
- [ ] shape 内 fill 的绘制顺序，以及多个 fill 重叠时的覆盖关系。
- [ ] mask 层与 masked 层的顺序/父子关系。
- [ ] `rigPropagationMatrix` 是否影响渲染。
- [ ] 文本：轮廓 vs Text。

> 关闭方式：每个问题一个最小 XFL + Animate 导出的 PNG/帧序列；测试放入 `fixtures/semantics/`。
> 在这些问题关闭前，相关功能标记为 `approximate`，不对外宣称像素级一致。

---

## 11. 参考来源

- XFL XML Schema（社区，JPEXS 作者维护）：\
  https://github.com/jindrapetrik/xfl-schema\
  `xfl.xsd` 中 `Edge.fillStyle0/1`、`tweenType`、`keyMode`、`layerType`、`parentLayerIndex` 等定义。
- JPEXS Decompiler（XFL 导出/经典 tween 检测/Edge 序列化）：\
  https://github.com/jindrapetrik/jpexs-decompiler\
  `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/ClassicTweenDetector.java`\
  `libsrc/ffdec_lib/src/com/jpexs/decompiler/flash/xfl/XFLConverter.java`
- PixiJS v8 Graphics 指南：\
  https://pixijs.com/8.x/guides/components/scene-objects/graphics
- PixiJS v8 Graphics Fill（渐变/纹理）：\
  https://pixijs.com/8.x/guides/components/scene-objects/graphics/graphics-fill
- PixiJS v8 Filters：\
  https://pixijs.com/8.x/guides/components/filters
- PixiJS 源码：\
  `src/scene/graphics/shared/GraphicsContext.ts`\
  `src/scene/graphics/shared/utils/buildContextBatches.ts`\
  `src/scene/graphics/shared/utils/triangulateWithHoles.ts`\
  `src/scene/graphics/shared/fill/FillGradient.ts`\
  `src/maths/matrix/Matrix.ts`
- pixi-filters GlowFilter：\
  https://github.com/pixijs/filters/blob/main/src/glow/GlowFilter.ts

> 我们尝试的 Adobe 官方 XFL File Format Specification PDF 链接当前返回 404；
> 因此本文对 XFL 语义的依据是社区 XSD + JPEXS 实现 + 样本实测。
> 如团队有官方文档或 Animate 安装目录内的 XFL schema，应以其为准再核对一遍，
> 尤其是 `cubics` / `S<n>` / 变宽描边。

---

## 12. 附：IR 片段示例

```json
{
  "irVersion": "1.0",
  "stage": { "width": 1920, "height": 1080, "frameRate": 30 },
  "library": {
    "symbol:example": {
      "kind": "symbol",
      "id": "symbol:example",
      "name": "Example character",
      "symbolType": "graphic",
      "timeline": {
        "frameCount": 30,
        "layers": [
          {
            "index": 0,
            "name": "图层_1",
            "type": "normal",
            "visible": true,
            "frames": [
              {
                "index": 0,
                "duration": 30,
                "elements": [
                  {
                    "id": "e:0:0",
                    "kind": "instance",
                    "characterId": "symbol:part",
                    "matrix": { "a": 1, "b": 0, "c": 0, "d": 1, "tx": 20.75, "ty": 464.6 },
                    "pivot": { "x": 179.7, "y": 182.3 },
                    "loopMode": "loop",
                    "firstFrame": 0
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  },
  "shapes": {
    "shape:9f3c...": {
      "id": "shape:9f3c...",
      "bounds": { "x": 0, "y": 0, "w": 930, "h": 1110 },
      "fills": [{ "kind": "solid", "color": "#CDC8CF", "alpha": 1 }],
      "strokes": [{ "kind": "solid", "color": "#000000", "alpha": 1, "width": 2,
                    "cap": "round", "join": "round", "scaleMode": "normal" }],
      "regions": [
        {
          "fill": 0,
          "outer": { "start": { "x": 0, "y": 0 }, "closed": true, "segments": [] },
          "holes": []
        }
      ],
      "strokePaths": []
    }
  }
}
```

> 注：示例中的 `segments` 省略；生产 IR 会包含完整 Q/C 段。

---

## 13. 建议的第一步

1. 建 monorepo + `xfl-container` + `xfl-xml`，先做到“样本能解包、能列符号/图层/帧”。
2. 写 Edge 解码器 + 调试 SVG 输出，并用合成形状验证。
3. 搭 `fixtures/semantics/`，先把 §10 的 12 个问题逐个关闭。
4. 再实现 GeometryCompiler/TimelineCompiler/IR；Pixi 后端最后接，避免被渲染细节带偏。

**不要先从 Pixi 渲染开始**。先把 XFL 的几何/时间线语义固定成 IR，Pixi 只是第一个消费者；
这样后续换渲染器、做离线烘帧、做 diff 都不会返工。
