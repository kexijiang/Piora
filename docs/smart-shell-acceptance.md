# Smart Shell 验收对应表

状态：已完成。核心功能、当前工作区类型检查、双平台最终构建和安装包运行验证均已通过。

这份表用于核对原始范围。详细结果、失败记录及修复过程见 [实施记录](smart-shell-implementation.md)，视觉规则见 [设计规范](design/smart-shell/README.md)。

| 原始要求 | 实现与直接验证 | 证据边界 |
| --- | --- | --- |
| 自然语言与命令共用入口 | ShellComposer；真实 Agent 执行测试、输入识别与补全测试 | 自动识别可显式覆盖；不把接受补全当成执行 |
| 历史命令联想与自然语言查询 | 本地 SQLite/FTS、增量导入、基于真实记录 ID 的语义检索 | 来源没有保存的命令、日期或目录不会被编造 |
| 全机可读取的已有历史来源 | PSReadLine、Bash、Zsh、Git Bash、Pi 会话和当前 Shell 记录；解析、轮换、续读与删除墓碑测试 | cmd 等没有持久历史的来源无法补回未保存的旧命令 |
| 设置页配置模型 | 复用模型目录与凭据；Shell 默认、终端覆盖和推理强度；设置浏览器/API 测试 | 不把某个账号无权使用的模型视作可用模型；实时探针记录在实施记录 |
| 多个独立、持久终端 | 真实 PS7、Windows PowerShell、Git Bash、Bash、Zsh 测试 | 分别验证变量、目录、退出码及提交身份；普通 sh/cmd 走诚实的原生回退 |
| 交互程序、停止和接管 | xterm 浏览器实测、Agent 接管与取消竞态测试 | 完成来自 Shell 生命周期事件，不依靠一段时间没有输出 |
| 刷新与崩溃恢复 | 提交恢复、幂等重试、时间线游标、强制结束服务后恢复测试 | 未知结果保持未知，不自动重放已接收的命令 |
| Agent 独立上下文与受控执行 | 独立 transcript、具体命令审批、后台终端与延迟失败测试 | 审批绑定命令和环境；30 步或三次相同失败会暂停 |
| 文件/聊天/输出上下文与交接 | 显式引用、引用恢复、输出文件链接、实际页面打开文件 | 交给主聊天只填草稿，不自动发送 |
| 按生图模型设计开发 | 三张设计稿及实现规范；浅色/深色生产工作区和设置截图 | 图中的示例数据替换为实际状态；窄面板另有 360/480/640px 浏览器断言 |
| 中文输入可靠 | Chromium 中测试 isComposing 与 keyCode 229 两条路径 | 选字回车保留草稿、不提交；普通回车仍可执行 |
| 性能 | 10 万条记录与导入期间的完整基准 | Linux复测：常规 P95 40ms、导入中 P95 49ms；首轮波动失败保留，未降低 100ms 门槛 |
| 双平台交付 | 原生 ASAR 依赖检查、独立 Next/桌面构建、打包后真实服务验证 | 最新退出修复已通过 Windows 与 Linux 的完整打包服务验证 |

## 对应测试文件

- `lib/shell-runtime.test.mjs`：协议分片、真实终端状态、幂等、原生回退及自然退出。
- `lib/shell-agent.test.mjs`：真实 Agent 循环、确认、取消、接管、后台失败、步数上限。
- `lib/shell-history.test.mjs`、`lib/shell-history-search.test.mjs`：导入与性能、真实检索结果及并发删除。
- `lib/shell-recovery.test.mjs`、`lib/shell-migration.test.mjs`、`lib/shell-legacy.test.mjs`：崩溃、旧历史迁移与旧接口。
- `lib/shell-ui.test.mjs`、`lib/shell-surface-browser.test.mjs`：浏览器交互、IME、布局、草稿及原生终端。
- `lib/shell-settings.test.mjs`、`lib/shell-completions.test.mjs`、`lib/shell-timeline.test.mjs`、`lib/shell-risk.test.mjs`：设置来源、补全、输出链接、历史分页与执行策略。
- `lib/shell-packaging.test.mjs`、`lib/terminal-packaging.test.mjs`：真正的 Electron 原生依赖与打包资源。
- `scripts/verify-packaged-shell.mjs`：打包服务中执行、跨命令变量、独立终端、收藏、退出后的重试。

## 最新修复的复验状态

Windows 自然退出清理修复后，完整运行时测试已正常退出且全部通过；隔离源码和当前工作区的全量 TypeScript 检查、相关 ESLint 检查均已通过。两端已重新构建同一份运行时代码并通过完整包验证。

最新 Windows 包报告见 `G:/Piora-artifacts/smart-shell-final-23b77a10/verification/packaged-runtime-final-result.json`，退出码 0；最新 Linux 包报告见 `G:/Piora-artifacts/smart-shell-linux-23b77a10/conpty-final-build-result.json`，七个阶段全部退出码 0。两端都实际启动打包后的 Electron 服务，验证终端变量、独立会话、收藏和退出后的幂等重试。

最终源码审计确认 Windows 57 个相关源文件、Linux 39 个生产源文件与当前工作区一致。生产界面的真实命令执行与设置导航均通过，截图已按设计规范目视检查；历史失败记录单独保留。
