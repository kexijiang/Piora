# Intelligent UI 同步 beta44 验证记录

日期：2026-10-28。分支 `codex/intelligent-ui`。本记录补充 [首次实现验证](intelligent-ui-2026-10-28.md)，不覆盖其历史结果。

## 同步结果

- 已执行 `git fetch --all --prune`。本地 `main` 和 `origin/main` 当时仍为 `37959a18`；最新主线在 `upstream/main`，为 `ba8d2022`（`0.5.5-beta.44`）。
- 新主线包含 `0eb6f7e9` 的运行中引导与排队改动，以及 `ba8d2022` 的 beta.44 版本元数据。
- 将全部未提交修改和新增文件保存到专属 stash 后，执行 `git rebase upstream/main` 并恢复工作内容。同步前 53 个修改或新增文件全部保留；备份 stash `25dd4f0d33f532ef2ff4af564f0b00ac08512a4a` 仍保留。
- 唯一文本冲突是 `CHANGELOG.md`：Intelligent UI 留在 `Unreleased`，beta.44 既有版本说明保持独立。当前没有未解决冲突，没有提交或推送功能代码，也没有修改其他工作树。

## 语义整合

主线新增的运行中提交通过 `ChatWindow` 直接进入命令队列，会绕过旧的发送保存检查。现已接入通用保存与取消检查：

- 新的“引导／排队”提交，以及已有队列的引导、恢复执行和单条转排队，都先等待当前界面的参数保存。
- 等待期间停止、撤回、切换会话或启动新一轮会取消旧提交；失败交回原有草稿恢复路径，不覆盖后来输入的新草稿。
- 删除和仅暂停的整队撤回仍立即可用，不因参数保存失败而阻塞取消。
- 保留主线按输入 ID 操作队列的规则，重复文本与附件不会被错误合并。Beta 设置与运行中发送模式分别保存。

## 环境与依赖

Windows，Node.js 22.19.0。锁文件的主线差异只有根包与桌面包版本号，依赖版本和解析图未变，因此沿用此前通过锁文件安装的依赖。

执行了 `npm run build:harmony-worker` 和 `npm run build:desktop` 测试夹具编译。没有运行 `next build` 或构建发布包。

完整测试进程设置空 `PSModulePath`、进程级 `PSExecutionPolicyPreference=Bypass`，并将已安装 DevEco JBR 配入该进程的 `JAVA_HOME` 和 PATH。没有修改系统环境或执行策略，没有启用资源测试跳过开关。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，含桌面包 |
| `npm run lint` | 0 错误；两个未修改脚本的既有警告与首次记录一致 |
| `npm run harmony:docs:check` | 通过，39 actions、6 templates、17 entrypoints |
| `npm run verify:hygiene` | 通过 |
| `npm run licenses:check` | 通过，1379 packages |
| `npm run verify:backgrounds` | 通过，37 backgrounds |
| `npm run audit:runtime` | 通过，0 vulnerabilities |
| `npm run perf:check` | 最终复测通过，10000 条聊天记录处理 7.09 ms，预算 100 ms |
| `node scripts/diagnose-sharp-electron.mjs` | 6/6 通过 |
| `git diff --check` | 通过 |

运行时相关回归 132/132 通过，无跳过：

```powershell
node --test --test-reporter=spec hooks/useAgentSession.test.mjs lib/beta-features-runtime.test.mjs lib/queued-input-recall.test.mjs lib/rpc-manager-behavior.test.mjs lib/rpc-workflow-extensions.test.mjs lib/extension-reload.test.mjs
```

发送、设置与浏览器相关回归 49/49 通过，无跳过；最终 ChatWindow 8/8 复测通过：

```powershell
node --test --test-concurrency=1 components/ChatWindow.performance.test.mjs components/ChatInput.test.mjs components/SendShortcutPreference.test.mjs lib/settings-search.test.mjs components/ChatInput-layout.browser.test.mjs components/intelligent-ui-browser.test.mjs lib/composer-send-browser.test.mjs
```

各组与完整测试有重叠，数量不相加为总覆盖数。

完整枚举使用 `node scripts/run-tests.mjs`，共 3219 tests：3194 pass、1 fail、24 skipped，耗时约 35 分钟。唯一失败为 `lib/shell-surface-browser.test.mjs` 的真实终端交互用例，在第 126 行刷新后等待 `Read-Host` 提示 `TYPE_PROOF` 超时 60 秒；尚未进入后续交互。该次完整枚举不能称为全绿。

24 项跳过逐项核对为：符号链接权限不足 5 项、Windows 不适用的目录分页 1 项、未设置 `PIORA_TEST_7ZA` 的便携包用例 1 项、缺少原生 C++ 编译器的 H.264 用例 17 项。均不计通过。没有使用 `PIORA_SKIP_RESOURCE_TESTS=1`。

先前读取到编辑中间状态的另一轮运行已停止，不作为最终验证证据。上述完整枚举以固定的合并内容开始，并留存源文件与测试文件哈希。随后审核发现等待保存期间原消息缺少独立恢复副本的问题，最终修复和受影响回归另列于下方，不能将完整枚举宣称为该修复后的零失败全套结果。

### 终端失败复测

同一 Node.js 和 PowerShell 进程环境，原样独立运行整个文件两次，均 1/1 通过、0 跳过，退出码 0（用例约 6.84 秒和 5.96 秒）：

```powershell
node --test --test-concurrency=1 --test-reporter=spec lib/shell-surface-browser.test.mjs
```

该测试及 `TerminalSurface`、`useSmartShell`、`lib/shell` 在本次功能修改和主线同步中均未改动。夹具直接挂载终端，不加载聊天发送和 Intelligent UI，未发现直接影响路径。失败日志仅证明刷新后等待提示超时，缺少当次 PTY 输出和截图，根因尚未确定；不能将资源竞争或时序猜测作为已确认原因。两次复测未复现，不改写完整枚举的原始失败结果。

### 原消息恢复与新会话回归

最终审查发现：在 `ChatWindow` 外层等待参数保存，会使原输入尚未获得独立的恢复记录。此时取消后输入新草稿再刷新，可能只保留新草稿。现已把保存等待移到统一命令提交内部：同步捕获会话与取消身份，先等待原文、图片、文件的 `PendingPrompt` 写入并确认 `onDurable`，再保存参数、准备会话和投递。失败或取消保留恢复副本；发送前再次验证原身份。新对话只允许绑定本次实际创建的会话，不把切换聊天当成正常推进。

真实 IndexedDB、输入框和命令 hook 的新浏览器测试，验证原文与附件和新草稿并存，并覆盖取消、保存失败、等待期间刷新三种恢复路径。真实 HTTP/router/SDK 流程补充新会话提交。直接回归 10/10 通过，hook 完整回归 74/74 通过。最终统一重跑以下 35 个受影响测试文件：

```powershell
$tests = @(
  'components/ChatCommands.browser.test.mjs', 'components/ChatInput-layout.browser.test.mjs',
  'components/ChatInput-retry.test.mjs', 'components/ChatInput.test.mjs',
  'components/ChatWindow.performance.test.mjs', 'components/intelligent-ui-browser.test.mjs',
  'components/intelligent-ui-state.test.mjs', 'hooks/useAgentSession.test.mjs',
  'lib/agent-client.test.mjs', 'lib/agent-prompt-command-state.test.mjs',
  'lib/answer-output-route.test.mjs', 'lib/answer-output-server.test.mjs', 'lib/answer-output.test.mjs',
  'lib/chat-command-activity.test.mjs', 'lib/chat-command-archive.test.mjs',
  'lib/chat-command-events.test.mjs', 'lib/chat-command-flow.browser.test.mjs',
  'lib/chat-command-input.test.mjs', 'lib/chat-command-router.test.mjs', 'lib/chat-command-views.test.mjs',
  'lib/chat-send-scroll-browser.test.mjs', 'lib/clipboard-drafts-browser.test.mjs',
  'lib/composer-acknowledgement.test.mjs', 'lib/composer-files-browser.test.mjs',
  'lib/composer-send-browser.test.mjs', 'lib/draft-store.test.mjs', 'lib/intelligent-ui.test.mjs',
  'lib/prompt-recovery-browser.test.mjs', 'lib/prompt-recovery.test.mjs',
  'lib/queued-answer-recovery.browser.test.mjs', 'lib/queued-input-recall.test.mjs',
  'lib/reply-suggestions-browser.test.mjs', 'lib/session-message-prompt-cancellation.test.mjs',
  'lib/session-message-router.test.mjs', 'lib/slash-command-recovery.test.mjs'
)
node --test --test-concurrency=1 --test-reporter=tap @tests
```

结果：**268/268 通过，0 失败、0 跳过，约 210 秒**。运行期间源文件与测试文件哈希均保持不变。最终 `npm run typecheck`、`npm run lint` 和 `npm run perf:check` 重新通过；Lint 仍为 0 错误、2 个未修改脚本中的既有警告。最终文档和 PDF 更新后，仓库卫生及差异格式检查通过；七页 PDF 已逐页渲染检查，无缺字、遮挡或溢出。

## 启动检查与手工验收

使用临时独立 Pi 数据目录，执行开发准备后，在 `127.0.0.1:30145` 启动 Next 开发服务。服务就绪，首页返回 HTTP 200，`GET /api/beta-features` 返回 HTTP 200 和默认关闭状态。检查完成后已停止该服务，未调用真实模型或更改用户的实验偏好。

用户验收步骤见 [第一阶段手测指南](../intelligent-ui-testing.md)，包含固定采购清单、96 元到 192 元的本地计算、保存刷新追问，以及开关、引导排队、取消与分支测试。

Linux、真实供应商模型端到端、桌面发行包及正式发布仍未验证。本次的启动检查不替代这些验收。
