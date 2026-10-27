# Mermaid 布局与预览验证（2026-10-26）

基于 `origin/main` 的 `19ff18c4ac54780fbe8ddf64fb1a747e4a16af9b`，独立分支 `fix/mermaid-stable-preview-20261026`。未包含引导消息修复或用户工作区中的未提交内容。没有合并、发布或本地生产构建。

## 2026-10-27 主线再次前进后的复验

前一轮提交 `18de944b3d1e46fc21e7c5c6729fcf6dd490dc44` 的 [CI #783](https://github.com/kexijiang/Piora/actions/runs/40470951340) 已全部成功。随后主分支前进到 `7481f3b5d166a886b4eae2c0f67cd00f3e1e2317`，修改了主对话直接展示、设置及本地化、鸿蒙共享视频和工作区展开逻辑；没有把旧 CI 当成本次合并内容的验证。

本轮以 `18de944b3d1e46fc21e7c5c6729fcf6dd490dc44` 和 `7481f3b5d166a886b4eae2c0f67cd00f3e1e2317` 为合并父提交，仅解决 `Unreleased` 新增章节冲突，保留双方说明和所有已发布说明。逐文件核对：所有新引入的主线运行逻辑及 CompactProcess 浏览器测试与主线相同；Mermaid 源码、浏览器断言及缓存测试未更改；主线已删除的轻量过程设置语言项未被重新加入，`fitToView` 语言项继续保留。锁文件未变，复用本工作树此前经 `npm ci` 安装和修补的依赖。

Linux x64 / Node.js **22.19.0** / npm **10.9.3** / patchelf **0.19.2**，独立测试 HOME，未设置资源测试跳过开关。本轮以下检查重新执行并通过：

- **216 项相关测试，0 失败、0 跳过**；除 Mermaid、Markdown、消息、聊天历史和虚拟行回归外，加入主线受影响的设置检索、工作区以及鸿蒙共享观看、所有权恢复、视频启动、HDC、数据包、错误和实时帧回归：

  ```sh
  node --test --test-concurrency=1 components/MermaidBlock.test.mjs components/MarkdownBody.test.mjs components/MessageView.test.mjs components/ChatWindow.performance.test.mjs components/workspace/RightPanel.test.mjs lib/chat-history.test.mjs lib/compact-chat-history.test.mjs lib/virtual-row-state.test.mjs lib/desktop-window-style.test.mjs lib/mermaid-preview.test.mjs lib/settings-search.test.mjs lib/i18n/*.test.mjs lib/harmony-deveco-video.test.mjs lib/harmony-video-ownership.test.mjs lib/harmony-video-start.test.mjs lib/harmony-hdc-backend.test.mjs lib/harmony-hos-packets.test.mjs lib/harmony-runtime-contracts.test.mjs lib/harmony-request-error.test.mjs hooks/useHarmonyLiveFrame.test.mjs
  ```

- `npm run lint`（0 错误、两个未修改脚本的既有 warning）、`npm run typecheck`（根包及桌面包）、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run audit:runtime`（0 vulnerabilities）、`npm run perf:check`。
- `node scripts/diagnose-sharp-electron.mjs`：修补后的 Node、Electron Node 模式和 ASAR 三项图片探针全部通过，未修补 Electron 基线继续给出预期的 GLib 失败诊断。
- `git diff --check origin/main`、受影响浏览器测试语法、验证文档本地链接和已发布更新记录完整性检查通过。

浏览器启动仍受下节记录的云端 socket 权限限制；沿用用户已明确批准的例外，不声称本地浏览器或全量测试通过。Harmony 实际设备共享兼容性与流畅度仍未实机验证；未修改的 Shell、website、其他独立子系统和发布包专项不重复本地运行。没有运行 Next 生产构建或发布包构建。**本轮新提交仍必须通过新的完整远端 CI 后才允许合并；上一轮成功不替代本轮检查。**

## 2026-10-27 云端同步验证

在独立云端工作树将 PR 头 `f73ccf760ef91980a40e4820b49d5306bd3f96c2` 与主分支 `d1324cfde43362373821c9fab4ec576de726e1c5` 同步。唯一文本冲突 `CompactProcess.browser.test.mjs` 采用主分支完整版本，保留 PR #228 移除内层工具分组后的外层展开、键盘、命令卡片与搜索定位断言；该测试与主分支逐字节相同。修复自动合并误把 Mermaid 说明放进 beta.43、覆盖停止队列说明的问题：所有主分支已发布章节逐字节保留，Mermaid 说明仅列入 `Unreleased`。未修改 PR #229 的模型设置代码；锁文件与主分支相同。

平台为 Linux x64，Node.js **22.19.0**、npm **10.9.3**，原生修补工具 patchelf **0.19.2**；Node 和 patchelf 使用已验证官方摘要的版本。独立 `npm ci` 正常执行全部安装生命周期及仓库依赖修补，未共享其他工作树的 node_modules。

本次拟提交代码已通过：

- 下列相关非浏览器回归 **88 项通过、0 失败、0 跳过**，覆盖 Mermaid 缓存与适配、Markdown/消息、聊天和轻量历史、虚拟行状态、桌面样式及本地化：

  ```sh
  node --test --test-concurrency=1 components/MermaidBlock.test.mjs components/MarkdownBody.test.mjs components/MessageView.test.mjs components/ChatWindow.performance.test.mjs lib/chat-history.test.mjs lib/compact-chat-history.test.mjs lib/virtual-row-state.test.mjs lib/desktop-window-style.test.mjs lib/mermaid-preview.test.mjs lib/i18n/*.test.mjs
  ```

- `npm run lint`：0 错误，两个未修改脚本的既有 warning；`npm run typecheck`：根包和桌面包通过。
- `npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run audit:runtime`（0 vulnerabilities）、`npm run perf:check` 通过。
- `node scripts/diagnose-sharp-electron.mjs` 通过：修补后的 Node、Electron Node 模式及 ASAR 三项图片探针通过。未修补 Electron 基线仍产生预期的 GLib 诊断；仅基线失败，不是修补后检查失败。系统未安装 glib pkg-config 开发元数据，但运行时图片探针均已实际执行。
- `git diff --check origin/main` 通过；浏览器测试脚本语法通过。默认云端 HOME 恰好与未修改 Skills 测试的合成路径重名，首次 hygiene 报路径匹配；改用独立可写测试 HOME/XDG 缓存后，未修改的完整扫描器通过，未删规则或忽略文件。

**未覆盖范围与授权例外：** 当前云端 Chromium 在页面加载前因 `process_singleton_posix.cc` 的 `socket() failed: Operation not permitted (1)` 退出（134），因此未重复启动已知被阻止的 Mermaid、CompactProcess 及其他浏览器回归，也不声称本地全量 `npm test` 或 Windows 验证通过。用户已明确授权本批 PR 先完成云端可执行检查并记录缺口，再由推送后的 GitHub CI 补齐浏览器与 Windows 验证，全部必要 CI 通过后才允许合并；没有修改或放宽门禁。独立 Harmony、Shell、真实设备、website 及发布包专项未因本次 Mermaid 同步在本地重跑；这些模块相对主分支未更改。没有运行 `next build` 或构建发布包。以下 2026-10-26 的 Windows 截图和浏览器结果是历史证据，不替代这次同步后的远端 CI。

## 根因与修复

- 会话切换及 VirtualList 回收会销毁 MermaidBlock 的局部 SVG 状态；重新挂载先显示 120px 加载占位，再重新解析/渲染。现在按源码和明暗主题保留最多 32 项、4 百万字符的内存缓存，首次 React 渲染即复用完成的 SVG/尺寸。并发相同请求复用同一个 Promise，过期请求不会更新新的代码实例。主题首次重绘可用另一个主题的已知宽高保留占位。
- MermaidBlock 内的主题配置与异步渲染作为整体串行执行。临时 SVG 现在在离开文档流的隐藏容器内布局；成功或失败都清理容器。复用图形时重写每个实例的 SVG ID、样式引用、箭头及无障碍引用，避免多张相同图和弹窗之间串用引用。队列只保留完成信号，不额外持有缓存预算外的大图结果。
- 打开弹窗原来会移除行内图，造成聊天高度塌缩。现在保留原图；关闭后恢复焦点且不滚动。真实基线测量：普通图聊天块由 **520.875px 降为 33.375px**，重新挂载出现 **153.375px** 加载块；修复后的测试要求开关前后块高、后续消息坐标和 scrollTop 完全相同，缓存重挂载不出现 loading。
- 旧弹窗为整个视口大小，初始缩放只取百分比宽度。现在面板受图形尺寸及视口双向约束，初始/重置同时按宽高适配、不放大小图，resize 自动重新计算；用户仍可放大、缩小、拖动和滚动，Escape/关闭按钮可关闭。
- 实际 SVG 检查也发现某些 Mermaid 生成结果的 viewBox 不包含最终节点变换后的边界。仅当最终内容溢出时，根据完成后的 getBBox 修正 framing，避免把图形外框适配正确而节点仍被裁切。弹窗首帧直接在 layout effect 中计算适配，避免以零尺寸隐藏 SVG 再显示产生空白绘制。

## 实际验证

Windows 11，Node.js **24.5.0**，npm **11.9.0**；使用锁文件 `npm ci`。浏览器夹具通过仓库现有 webpack/TypeScript 工作流运行实际 React 组件、真实 Mermaid、实际 globals.css 与实际 VirtualList，Edge headless 独立实例。没有调用模型、修改真实聊天数据或复用其他任务进程。

`node --test components/MermaidBlock.browser.test.mjs` 覆盖：

- 普通/24 节点超宽/24 节点超高/小流程图、时序图和饼图；SVG 实际内容边界、纵横比、完整可见性。
- 1100×800、360×600、800×360 及往返 resize；普通图、超高图和小图初始 fit、放大、重置；超高图拖动。手动放大到 300% 后往返 resize，实际比例、图形宽高和上限不变；自动适配模式仍随视口变化。断言内部视口和每一个工具栏按钮也位于弹窗边界内，避免 CSS Grid 的隐式最小列宽造成窄窗口裁切。
- 同一图重挂载、源码/预览切换、VirtualList 真正回收再挂载、连续四次会话 key 切换；不重现 loading 高度变化。
- 延迟真实 Mermaid render 返回后快速换代码/主题，旧结果不覆盖新图；重复图及弹窗 SVG ID 唯一。
- 弹窗打开后，源码 A→B→A、明→暗→明以及流式 false→true→false，旧弹窗均不会在没有点击时自动重开。
- 20 个现有主题；无效语法显示错误且导出禁用；PNG 真实下载成功。
- 重复双击/开关、Escape/关闭按钮、原图和后续消息位置、关闭后滚动及焦点恢复、桌面标题栏留白。

相关回归命令（92 tests，0 failed，0 skipped）：

```powershell
node --test --test-concurrency=1 components/MermaidBlock.test.mjs components/MarkdownBody.test.mjs components/MessageView.test.mjs components/ChatWindow.performance.test.mjs lib/chat-history.test.mjs lib/compact-chat-history.test.mjs lib/virtual-row-state.test.mjs lib/ui-performance-browser.test.mjs lib/chat-layout-browser.test.mjs lib/chat-bottom-browser.test.mjs lib/chat-send-scroll-browser.test.mjs lib/room-message-layout-browser.test.mjs lib/desktop-window-style.test.mjs lib/mermaid-preview.test.mjs lib/i18n/*.test.mjs
```

质量检查：`npm run lint`（无错误；两个未修改 scripts 文件的既有 warning）、`npm run typecheck`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run audit:runtime`（0 vulnerabilities）、`npm run perf:check`。最终核心 Mermaid/Markdown/desktop-style/cache 单测也单独复跑。

Linux CI 暴露了两个读取 React 提交前旧状态的浏览器测试时序：Mermaid 重置后仍暂时读到放大比例、CompactProcess 按 Enter 后仍暂时读到 0 个展开项。两处增加对实际目标状态的等待，继续保留“不放大小图”和“恰好 3 项”的原断言；CompactProcess 未修改产品代码，只增加等待，与引导消息任务无关。

Linux 的后续回归在 300% 标签更新后读取到了旧画布尺寸（477.921875px，resize 后为 504px）。现在记录基线前还必须确认实际宽高均等于 viewBox 的 3 倍；resize 后仍严格要求宽高不变，不放宽比例或上限断言。修正后本地真实 Edge 回归通过（1 项，17.7 秒）。

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
- 此队列只协调 MermaidBlock 请求；MarkdownEditor 和 markdown-export 中独立的 Mermaid 初始化路径尚未统一，不宣称这些跨界面路径的并发主题配置已隔离。
