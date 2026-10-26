# Mermaid 布局与预览验证（2026-10-26）

基于 `origin/main` 的 `19ff18c4ac54780fbe8ddf64fb1a747e4a16af9b`，独立分支 `fix/mermaid-stable-preview-20261026`。未包含引导消息修复或用户工作区中的未提交内容。没有合并、发布或本地生产构建。

## 根因与修复

- 会话切换及 VirtualList 回收会销毁 MermaidBlock 的局部 SVG 状态；重新挂载先显示 120px 加载占位，再重新解析/渲染。现在按源码和明暗主题保留最多 32 项、4 百万字符的内存缓存，首次 React 渲染即复用完成的 SVG/尺寸。并发相同请求复用同一个 Promise，过期请求不会更新新的代码实例。主题首次重绘可用另一个主题的已知宽高保留占位。
- Mermaid 的全局主题配置与异步渲染需要作为整体串行执行。临时 SVG 现在在离开文档流的隐藏容器内布局；成功或失败都清理容器。复用图形时重写每个实例的 SVG ID、样式引用、箭头及无障碍引用，避免多张相同图和弹窗之间串用引用。
- 打开弹窗原来会移除行内图，造成聊天高度塌缩。现在保留原图；关闭后恢复焦点且不滚动。真实基线测量：普通图聊天块由 **520.875px 降为 33.375px**，重新挂载出现 **153.375px** 加载块；修复后的测试要求开关前后块高、后续消息坐标和 scrollTop 完全相同，缓存重挂载不出现 loading。
- 旧弹窗为整个视口大小，初始缩放只取百分比宽度。现在面板受图形尺寸及视口双向约束，初始/重置同时按宽高适配、不放大小图，resize 自动重新计算；用户仍可放大、缩小、拖动和滚动，Escape/关闭按钮可关闭。
- 实际 SVG 检查也发现某些 Mermaid 生成结果的 viewBox 不包含最终节点变换后的边界。仅当最终内容溢出时，根据完成后的 getBBox 修正 framing，避免把图形外框适配正确而节点仍被裁切。弹窗首帧直接在 layout effect 中计算适配，避免以零尺寸隐藏 SVG 再显示产生空白绘制。

## 实际验证

Windows 11，Node.js **24.5.0**，npm **11.9.0**；使用锁文件 `npm ci`。浏览器夹具通过仓库现有 webpack/TypeScript 工作流运行实际 React 组件、真实 Mermaid、实际 globals.css 与实际 VirtualList，Edge headless 独立实例。没有调用模型、修改真实聊天数据或复用其他任务进程。

`node --test components/MermaidBlock.browser.test.mjs` 覆盖：

- 普通/24 节点超宽/24 节点超高/小流程图、时序图和饼图；SVG 实际内容边界、纵横比、完整可见性。
- 1100×800、360×600、800×360 及往返 resize；普通图、超高图和小图初始 fit、放大、重置；超高图拖动。断言内部视口和每一个工具栏按钮也位于弹窗边界内，避免 CSS Grid 的隐式最小列宽造成窄窗口裁切。
- 同一图重挂载、源码/预览切换、VirtualList 真正回收再挂载、连续四次会话 key 切换；不重现 loading 高度变化。
- 延迟真实 Mermaid render 返回后快速换代码/主题，旧结果不覆盖新图；重复图及弹窗 SVG ID 唯一。
- 20 个现有主题；无效语法显示错误且导出禁用；PNG 真实下载成功。
- 重复双击/开关、Escape/关闭按钮、原图和后续消息位置、关闭后滚动及焦点恢复、桌面标题栏留白。

相关回归命令（92 tests，0 failed，0 skipped）：

```powershell
node --test --test-concurrency=1 components/MermaidBlock.test.mjs components/MarkdownBody.test.mjs components/MessageView.test.mjs components/ChatWindow.performance.test.mjs lib/chat-history.test.mjs lib/compact-chat-history.test.mjs lib/virtual-row-state.test.mjs lib/ui-performance-browser.test.mjs lib/chat-layout-browser.test.mjs lib/chat-bottom-browser.test.mjs lib/chat-send-scroll-browser.test.mjs lib/room-message-layout-browser.test.mjs lib/desktop-window-style.test.mjs lib/mermaid-preview.test.mjs lib/i18n/*.test.mjs
```

质量检查：`npm run lint`（无错误；两个未修改 scripts 文件的既有 warning）、`npm run typecheck`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run audit:runtime`（0 vulnerabilities）、`npm run perf:check`。最终核心 Mermaid/Markdown/desktop-style/cache 单测也单独复跑。

## 截图

这些是实际浏览器截图，使用合成图形数据。基线图展示全屏放大及裁切；修复后普通、宽、高、小图均完整显示。

| 场景 | 证据 |
| --- | --- |
| 修复前，全屏且图形被截断 | [before.png](before.png) |
| 普通图 | [normal.png](normal.png) |
| 超宽图 | [wide.png](wide.png) |
| 超高图 | [tall.png](tall.png) |
| 小图，不默认放大 | [small.png](small.png) |
| 360px 窄窗口 | [narrow.png](narrow.png) |
| 深色主题和重复实例 | [theme-dark.png](theme-dark.png) |

## 范围和限制

- 本地为聚焦的相关回归，未声称完整 `npm test` 全量分片通过。未修改 Harmony/原生图片加载器/Shell/打包/website；这些独立子系统的专项用例、原生图片诊断及生产构建交由原有 CI。没有降低任何门禁。
- 未运行完整 Electron 安装包或 Linux 实机；标题栏边界以浏览器模拟桌面 bridge 验证。CI 使用 Node 22.19.0，与本地 Node 24.5.0 不同。
- 缓存仅在当前页面内存中存活。首次遇到未缓存图（或超出缓存预算被淘汰）仍需一次异步布局；未用固定大高度隐藏这个过程。重新打开页面不承诺缓存持久化。
- 不是每种 Mermaid 语法的穷举测试；未检查真实系统图片剪贴板，PNG 导出已有真实浏览器验证。
