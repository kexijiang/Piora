# Pi 1.5.2 升级与回归验证

日期：2026-11-14（Asia/Shanghai）。Windows，Node.js 24.5.0，npm 11.9.0。

## 升级与适配

五个直接 Pi 依赖由 1.5.0 精确升级为 1.5.2；锁文件与实际安装中的
`pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-codemode`、`pi-mcp`、
`pi-schema`、`pi-telemetry`、`pi-tui` 八个包全部一致。下载和安装使用
官方 npm registry。应用版本保持 `0.5.11-beta.5`，这不是安装包发布。

- [Pi 1.5.2 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.2)
- [Pi 1.5.1 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.1)
- [官方 npm 元数据](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.2)

先验证官方 tarball 的 SHA-512，再从未经 postinstall 修改的文件计算源码树
摘要，保存为 `scripts/pi-source-profile-1.5.2.json`。旧证书保留用于历史追溯。

| 审查项 | 1.5.2 |
| --- | --- |
| package.json SHA-256 | `18b422b7d80f2caa2551d253c0a8409e1caa54b954bfb7d18252e507bb8a0318` |
| 非 bundle 的 dist 文件 | 1057 |
| 非 bundle 的 dist SHA-256 | `f0ae44826d1db9af122dcefeea30c1bd6ce8e9bed72c7d518b4eacea8334080e` |
| 原始 bundle 文件 | 84 |
| 原始 bundle SHA-256 | `ddf91f30aada62defa241be1ef9561be0e4dc56d43b0ccfa1c8904a9cf94e7bc` |
| 官方 Bash 源码 SHA-256 | `afc4f829b3da2e7d8cc31296ccceb26bbc8e35018eb3f352791b651866cc2040` |
| 上游 Undici / 实际解析 | 8.12.3 / 8.12.4（项目 override） |

上游 Bash 新增 `ShellTimeoutError`，记录主 Shell 在超时之前的退出码和时刻。
Windows 补丁更新原始文件摘要与 timeout 替换锚点，保留这些新字段和诊断文案，
继续等待子进程清理后再结算取消。没有放宽源码、反向还原、符号链接或额外文件检查。
postinstall 已成功应用新证书、源码入口与 Windows 补丁。

锁文件只改变 Pi 八个包及其 Mermaid 依赖替换（`grok-mermaid` → `lovely-mermaid`）。
npm 在 Windows 安装时删除的 12 个未变更 Linux 可选包 `libc` 字段已精确恢复，
保留原有平台约束。许可证清单重新生成并验证，去重包数为 1271。

新版默认 `cacheWarming` 为 `idle`：在预计收益为正时于空闲期间维持提示缓存，
最多 30 分钟。显式 `off` 或 `streaming` 全局设置仍由 SDK 读取，未改写用户配置。
项目没有自定义 `GrepOperations.readFile` 上下文适配，因此不需要迁移该弃用接口。

## 回归结果

日志保存在 `.verification/pi-1.5.2/`。以下为去重后的用例数，中间复测不重复累计。

| 分组 | 最终结果 | 日志 |
| --- | --- | --- |
| SDK 会话、版本对齐、大参数流式、工具权限、模型审查与新版协议 | 40 通过 | `sdk-protocol.log`、`sdk-152-protocol-retest.log` |
| Windows Bash、Shell Agent、超时守卫、模型 stall/sampling | 56 通过，1 项 Linux 专用夹具跳过 | `windows-shell.log`、`windows-abort-retest.log` |
| 源码完整性、独立依赖闭包、CLI/RPC、WASM、MCP、压缩与启动 | 61 通过 | `integration-provenance.log` |
| 重试、失败上下文、队列恢复、模型 scope/fallback、群聊隔离与 Plan/Goal | 115 通过 | `runtime-regression.log` |
| 聊天界面、原生浏览器菜单、设置、Plan/Goal、IndexedDB 恢复与滚动 | 93 通过 | `ui-regression.log` |

累计 **365 项通过，1 项平台跳过**。Web 与 desktop 类型检查、改动文件定向
ESLint、许可证一致性、changelog 片段格式和 `git diff --check` 通过。

新增 `lib/pi-1.5.2-compatibility.test.mjs` 使用实际安装的 SDK：

- 本地 OpenAI HTTP/SSE：工具执行后禁用工具，历史结果仍然完整，而请求不再发送
  空 `tools`；开启旧网关兼容参数后仍按要求发送空列表。会话落盘恢复保留原工具结果。
- 本地 Anthropic HTTP/SSE：线程过期与不支持线程两种 400 响应均回退完整历史；
  过期后重建线程、不支持时后续关闭线程；改变工具集合会正确重新发送上下文。
- 已安装、已打补丁的 Shell 实现与真实 stdio 结算器：注入受控子进程边界，验证
  主命令先以 7 退出、后台持续输出直到超时的诊断仍同时保留退出码与超时原因。
  该用例不代表真实 OS 管道验收；实际 Windows 子进程另由 Bash 测试覆盖。

实际 Windows Bash 覆盖主动取消、超时、嵌套管道、exec、嵌套 exec、普通退出码
和预先取消；检查目标后代已退出且无关 sleep 仍存活。Shell Agent 使用真实 PTY，
模型响应为受控夹具。完整性测试把独立依赖闭包复制到临时目录，实际运行 CLI/RPC、
codemode WASM 与本地 stdio MCP，并检查篡改、额外文件、缺失文件及符号链接拒绝。

## 首轮失败与复测

- 新增线程测试起初使用空工具白名单，工具根本未注册，无法模拟运行时新增工具。
  改为显式允许该工具、首轮停用、后续启用，并增加启用结果断言后，两种协议场景通过。
- 新增 Shell 诊断用例的真实 Windows Node 后台进程未维持预期的继承输出流，
  SDK 正常返回退出码，未进入超时分支。改用受控 ChildProcess 事件/流，仍运行
  安装后的完整补丁实现和真实管道结算器，保留退出码、超时文案和终止调用断言。
- Windows 主动取消首轮发生 `ps.exe -e` 查询超时，后代未及时退出，测试失败并由
  夹具清理；单独复测通过。未改动进程查询超时，也未降低取消时限或后代存活断言。
- 初次类型检查误用了不存在的 `typescript/bin/tsc`，按项目实际
  `node_modules/.bin/tsc.cmd` 入口重新执行后，Web 和 desktop 均通过。
- 初次审计直接调用脚本缺少 npm 上下文，改为项目要求的 `npm run audit:runtime`
  后通过。命令错误日志与复测日志均保留。

## 依赖审计与验收边界

升级前后 `npm audit --omit=dev --json` 的完整漏洞记录逐项一致：7 项 moderate，
0 high、0 critical。项目 `npm run audit:runtime` 验证实际源码与 override 后通过
high 门槛。未执行自动降级 Hypium 的 `audit fix --force`。

本轮未运行 `next build`、完整 CI 或本地安装包构建。未调用真实收费模型、验证
线上 OAuth、连接物理鸿蒙设备或验收其他操作系统。独立 SDK/MCP 运行检查及浏览器
组件夹具不能代替完整 Electron 安装包验收。现有安装版不会因工作区依赖修改自动升级。
本地改动未提交或发布；升级前已有的 28 个已跟踪文件修改与保存的 diff 字节一致。
