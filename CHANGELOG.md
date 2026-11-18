# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

- 静态 Demo 随构建生成内置语义样本，支持部署到站点子路径。

## [0.1.0] - 2026-11-16

首个公开版本：FLA/XFL → Character IR → PixiJS v8 的完整 P0 管线，含 P1 位图支持。

### Added

- **输入与解析**：容错 ZIP/FLA reader（store/deflate、data descriptor、ZIP64、
  损坏 EOCD、重复 entry、CRC、zip-slip、大小限制），支持 `.fla` / `.zip` /
  未压缩 XFL 目录 / 内存 bytes；`saxes` 流式 XFL XML 与类型化 AST。
- **几何编译**：Edge 解码（`!`/`|`/`[`/`/`、十六进制定点、`S<n>` 跳过）、
  fill/hole 拓扑、渐变（linear/radial）、描边、VariablePointWidth 转轮廓、
  DOMGroup 扁平化、BitmapFill/bitmap instance、XFL mask。
- **时间线**：关键帧、instance run、motion tween 插值、graphic 同步、
  movieclip 时钟、图层/实例滤镜（含 GlowFilter knockout）。
- **Character IR 1.0**：版本化 JSON Schema、结构校验、纯函数求值器、`ir-bake`、
  稳定 shape hash 去重。
- **PixiJS v8 运行时**：`GraphicsContext` 共享、容器树、帧时钟、滤镜、mask、
  `CharacterAssembly` 元素树组装（不播放 authored timeline）。
- **CLI**：`flaforge` / `xfl2ir` / `xfl2svg` / `ir-validate` / `ir-bake`。
- **Demo**：Vite + PixiJS 预览器，支持播放/暂停、逐帧、缩放、场景选择、
  诊断面板与角色预览。
- **位图**：Animate `bin/M *.dat` 解码（8-bit paletted ARGB）。
- **工程化**：单元与集成测试、Playwright E2E、`pnpm release:check`、
  GitHub Actions CI、素材索引 `prep` 元数据。

### Changed

- 项目正式命名为 **Flaforge**，npm scope 从 `@xfl/*` 改为 `@flaforge/*`；
  CLI 新增 `flaforge` 入口（`xfl2ir` 保留）。
- 仓库采用 MIT 许可证，补充 CHANGELOG、发布说明与 CI。

### Fixed

- 预乘 ARGB 边缘导致位图出现淡边。
- 帧混合模式与退化渐变填充。
- 损坏 EOCD / 重复 entry 等异常 ZIP 的容错读取。
- 批量解析与缩略图尺寸记录。

### Known limitations

- `cubics`、文本、声音、shape tween 尚未实现（P1）。
- IK、3D、按钮、ActionScript、TLF 未实现（P2）。
- 渐变 spread/interpolation、描边 scaleMode、Glow 参数为近似映射；
  详见 README “已知限制 / P1+”。
