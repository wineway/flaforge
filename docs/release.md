# Flaforge 发布手册

0.1.0 发布源码与静态 Demo。工作区包供源码开发使用，保持私有。

## 构建与验收

```bash
pnpm install --frozen-lockfile
pnpm release:check
pnpm exec playwright install chromium
```

在两个终端分别启动生产预览和浏览器测试。

```bash
pnpm --filter @flaforge/demo preview --host 127.0.0.1 --port 4173 --strictPort
```

```bash
DEMO_URL=http://127.0.0.1:4173/ pnpm e2e
```

CI 会对提交和版本标签执行同样的检查，并在版本标签上把 `apps/demo/dist` 保存为静态 Demo 构建产物。
将该目录的内容部署到静态服务器即可，根路径和仓库子路径均使用同一份构建。
部署后打开首页，确认内置动画可播放，并检查 `?character=Dot&frame=5` 能打开指定角色帧。

## 源码与版本标签

旧 Git 历史和本地已有的 `v0.1.0` 标签包含第三方样本。发布前，从整理后的源码快照在新目录
初始化独立 Git 仓库，并确认文件清单。以整理后的初始提交建立公开的 `v0.1.0` 标签。
将新仓库推送到目标 GitHub 仓库，再创建 Release，引用 [CHANGELOG.md](../CHANGELOG.md)
的 0.1.0 记录，并附上通过 CI 的静态 Demo。旧仓库和旧标签可以作为本地开发记录保留。

IR 采用独立的 `irVersion`。后续发布前应核对根项目版本、标签与 CHANGELOG，
并记录 CLI 或 IR 的兼容性变更。
