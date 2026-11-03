# Intelligent UI 第一阶段 PR 提交验证

日期：2026-10-28。基线：`upstream/main` 的 `d4dd66cd`（beta.48），分支 `codex/intelligent-ui`。范围是默认关闭的实验功能、八类可信组件、本地计算、状态保存恢复、追问及分支隔离；不包含后续阶段的小程序、任意代码或业务动作执行。

## 同步与验证环境

提交前 fetch 后同步最新主线，恢复全部功能修改。唯一文本冲突在 CHANGELOG，保留主线版本记录并将功能说明放入 Unreleased。模型刷新调用和新增翻译自动合并后复核。锁文件仅版本元数据变化，复用此前按锁文件安装的依赖。

本地 Windows、Node.js 22.19.0。检查来源为 `.github/workflows/ci.yml` 和 `test-suite.yml`。未运行 `next build` 或本地发布打包。

## 本次结果

- 对 47 个相关测试文件运行 `node --test --test-concurrency=1`：388 tests，385 pass、3 fail、0 skip，约 238 秒。
- 三项失败均为测试未隔离当前用户实验偏好：`extension-reload` 出现多余模块加载，`rpc-manager-behavior` 的工具选择和系统提示重载断言受额外重载影响。用户已开启 Intelligent UI，真实 SDK 专用 Beta 测试通过。为这两个旧夹具增加独立 Pi 配置目录及恢复清理，不修改生产逻辑、不降低断言。
- 修复后完整重跑两个受影响文件及 Beta 运行时文件：45/45 pass、0 fail、0 skip，约 13 秒。与初轮有重叠，不相加为总数；不能称为一次完整套件全绿。
- `npm run typecheck`、`npm run lint`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run audit:runtime`、`npm run perf:check` 均通过。Lint 0 错误、两个未修改脚本中的既有警告；运行时审计 0 漏洞；10000 行聊天处理 6.40 ms，预算 100 ms。
- 最后两处测试修改另跑 ESLint；文档完成后复查仓库卫生与差异格式。

修复后命令：

```powershell
node --test --test-concurrency=1 lib/rpc-manager-behavior.test.mjs lib/extension-reload.test.mjs lib/beta-features-runtime.test.mjs
node node_modules/eslint/bin/eslint.js lib/rpc-manager-behavior.test.mjs lib/extension-reload.test.mjs
```

## 未覆盖范围

此前 beta.44 的完整枚举、终端超时及两次独立复测、24 项环境跳过见 [历史验证记录](intelligent-ui-rebase-2026-10-28.md)，不能冒充本基线全量通过。本次重跑覆盖所有功能相关入口，并加入主线模型刷新回归；未重跑未改动的全量终端、Harmony 设备和发行打包测试。原生图片诊断之前 6/6 通过，本次未变更对应实现或依赖。website 未改动，未执行其安装、审计和构建。Linux、真实模型端到端、真实设备及发行包验收仍未完成，跨平台完整测试由 PR CI 执行并另行检查状态。

## 初轮测试文件

以下文件作为上述 Node 测试命令的参数：

- `components/ChatCommands.browser.test.mjs`
- `components/ChatInput-layout.browser.test.mjs`
- `components/ChatInput-retry.test.mjs`
- `components/ChatInput.test.mjs`
- `components/ChatWindow.performance.test.mjs`
- `components/intelligent-ui-browser.test.mjs`
- `components/intelligent-ui-state.test.mjs`
- `hooks/useAgentSession.test.mjs`
- `lib/agent-client.test.mjs`
- `lib/agent-prompt-command-state.test.mjs`
- `lib/answer-output-route.test.mjs`
- `lib/answer-output-server.test.mjs`
- `lib/answer-output.test.mjs`
- `lib/chat-command-activity.test.mjs`
- `lib/chat-command-archive.test.mjs`
- `lib/chat-command-events.test.mjs`
- `lib/chat-command-flow.browser.test.mjs`
- `lib/chat-command-input.test.mjs`
- `lib/chat-command-router.test.mjs`
- `lib/chat-command-views.test.mjs`
- `lib/chat-send-scroll-browser.test.mjs`
- `lib/clipboard-drafts-browser.test.mjs`
- `lib/composer-acknowledgement.test.mjs`
- `lib/composer-files-browser.test.mjs`
- `lib/composer-send-browser.test.mjs`
- `lib/draft-store.test.mjs`
- `lib/intelligent-ui.test.mjs`
- `lib/prompt-recovery-browser.test.mjs`
- `lib/prompt-recovery.test.mjs`
- `lib/queued-answer-recovery.browser.test.mjs`
- `lib/queued-input-recall.test.mjs`
- `lib/reply-suggestions-browser.test.mjs`
- `lib/session-message-prompt-cancellation.test.mjs`
- `lib/session-message-router.test.mjs`
- `lib/slash-command-recovery.test.mjs`
- `hooks/model-error-recovery.test.mjs`
- `lib/model-save-refresh-browser.test.mjs`
- `lib/beta-features.test.mjs`
- `lib/beta-features-runtime.test.mjs`
- `lib/agent-runtime-isolation.test.mjs`
- `lib/rpc-manager-behavior.test.mjs`
- `lib/rpc-workflow-extensions.test.mjs`
- `lib/extension-reload.test.mjs`
- `lib/session-trash.test.mjs`
- `components/MessageView.test.mjs`
- `lib/compact-chat-history.test.mjs`
- `lib/settings-search.test.mjs`
