# Dev scripts

| 脚本 | 用途 |
|---|---|
| `build-demo-assets.ts` | 编译内置位移动画，生成 Demo 构建所需的 IR |
| `build-material-index.ts` | 从 `MATERIAL_SOURCE_DIR` 读取自备素材，将索引写入 `MATERIAL_OUTPUT_DIR` |
| `validate-samples.ts` | 批量编译任意 `.fla`，输出 IR/SVG/摘要到 `/tmp/xfl-validation`，用于抽样验证 |
| `render-frame.ts` | 接收 `INPUT CHARACTER [FRAME]`，将角色和场景的 SVG 输出到 `/tmp` |
| `make-dat-fixture.mjs` | 生成 `bitmap-data.xfl` 的 10×5 `.dat` fixture |
| `e2e-demo.mjs` | Playwright E2E：播放、画布绘制、角色预览与播放器重建 |

```bash
pnpm demo                 # 另一个终端
pnpm e2e
```
