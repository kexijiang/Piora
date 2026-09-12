<p align="center">
  <img src="desktop/build/icon.png" alt="Piora 应用图标" width="112" height="112">
</p>

<p align="center">
  <strong>Piora</strong><br>
  本地优先的开源 AI 桌面工作台
</p>

<p align="center">
  <a href="https://github.com/kexijiang/Piora/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kexijiang/Piora/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="desktop/README.md"><img alt="Windows x64" src="https://img.shields.io/badge/Desktop-Windows%20x64-2563eb.svg"></a>
  <a href="docs/release.md"><img alt="Linux x64" src="https://img.shields.io/badge/Desktop-Linux%20x64-f59e0b.svg"></a>
</p>

# 项目介绍

Piora 是基于 [Pi](https://github.com/earendil-works/pi) 构建的开源 AI 桌面工作台。它把模型对话、项目文件、终端、Git 审阅、网页浏览、多 Agent 协作和设备控制放进同一个窗口，让 Agent 能在你看得见、可检查的本机环境中完成工作。

项目由 [pi-web](https://github.com/agegr/pi-web) 演进而来，沿用 Pi 的 AgentSession、JSONL 会话、模型接入和扩展机制，由社区独立维护，不隶属于 Pi、pi-web、OpenAI 或 Codex。

本文对应源码版本 `0.4.41-beta.36`。可下载版本以 [GitHub Releases](https://github.com/kexijiang/Piora/releases) 为准。

## 能做什么

- 在项目会话或无项目聊天中使用不同模型，支持思考等级、图片、Markdown、Mermaid、数学公式和长会话。
- 浏览和编辑项目文件，查看 Git 差异，执行暂存、提交、推送等常用操作。
- 使用交互终端和内置浏览器，并让 Agent 调用相应工具完成任务。
- 创建多 Agent 群聊，配置协调者、执行者和审查者，查看成员活动与共享产物。
- 管理定时任务、Skills、扩展和插件，按项目或会话选择 Agent 可用能力。
- 连接 OpenHarmony 设备进行投屏、UI 树观察和自动化；在 Windows 上可选启用桌面控制。
- 使用随身舱中的待办、专注时钟、JSON 工具和带文件标签页的 Markdown 中转站。
- 启用透明桌宠，在桌面显示任务和专注状态；桌宠移动受屏幕工作区约束。

## 设计原则

- **本地优先**：会话、配置和工作区状态默认保存在本机，没有统一账号服务和默认遥测。
- **过程可见**：回复、思考、工具调用、文件差异和运行状态都可检查。
- **能力可控**：模型、项目工具、扩展和设备操作由用户配置；敏感凭据不会通过状态接口返回。
- **兼容 Pi**：保留 Pi 的会话与资源加载方式，避免把 Piora 变成封闭的专用格式。

# 新手指南

## 1. 下载与安装

前往 [Releases](https://github.com/kexijiang/Piora/releases)，展开目标版本的 Assets：

| 文件 | 用途 |
| --- | --- |
| `Piora-<版本>-win-x64-setup.exe` | Windows 安装版，支持选择目录和应用内更新，推荐日常使用 |
| `Piora-<版本>-win-x64-portable.exe` | Windows 单文件便携版，升级时手动替换 |
| `Piora-<版本>-win-x64.zip` | 稳定版免安装目录，解压后运行 `Piora.exe` |
| `Piora-<版本>-linux-x64-portable.AppImage` | 稳定版 Linux x64 包 |
| `SHA256SUMS.txt` | 安装包校验值 |

Windows 目标系统为 Windows 10/11 x64。安装包已包含 Piora 运行时，普通使用不需要另外安装 Node.js。开发工具、Git、编译器以及第三方 Skills 所需程序仍需按任务准备。

未发布源码已接入内置 PowerShell 7：下一次 Windows 安装版、便携版和 ZIP 构建会携带完整 PowerShell 与 .NET 运行库，默认直接使用随包版本，无需额外安装。具体发布状态以 Releases 为准。

## 2. 配置第一个模型

1. 启动 Piora，打开 **设置 → 模型**。
2. 为模型服务填写 API Key，或使用服务支持的 OAuth / 设备码登录。
3. 使用自定义服务时填写地址、模型 ID 和接口参数，并运行模型测试。
4. 选择默认模型；新会话会使用该模型，也可以在输入框附近临时切换。

Piora 不提供统一模型订阅或内置 API Key。请求费用、额度和数据处理规则由你选择的模型服务决定。

## 3. 完成第一个任务

1. 在左侧添加项目并选择本机目录，或直接新建无项目聊天。
2. 写清目标和验收方式，例如：“检查登录页布局，修复后运行相关测试”。可用 `@` 引用文件，或拖入图片和文本附件。
3. 在对话中查看执行过程。运行期间可以补充要求，必要时停止任务。
4. 打开右侧面板查看文件、Git 差异、终端或浏览器，确认修改与验证结果。
5. 对自己发出的消息使用 **重试** 可直接重新发送原文和图片；无需复制粘贴。群聊中的用户消息也支持重试。

## 4. 常用入口

| 入口 | 用途 |
| --- | --- |
| 项目 / 聊天 | 新建与继续会话、搜索、重命名、置顶、归档和恢复 |
| 右侧加号 | 打开文件、Git 审阅、终端、浏览器、设备和其他工具面板 |
| 群聊 | 创建多 Agent 协作空间，配置成员、职责、并发与共享工作区 |
| 随身舱 | 待办、专注、Markdown 中转站、JSON 工具、桌宠和记忆设置 |
| 设置 | 模型、外观、快捷键、语音、扩展、Skills、插件、通知与更新 |

中转站是一套本地 Markdown 编辑器：每个文件显示为顶部标签页，支持即时排版、源码模式、自动保存、草稿恢复、导入导出和图片插入。切换标签页不会丢失正在编辑的内容。

## 5. 可选能力

- **Windows 电脑控制**：在电脑控制设置中点击连接即可启用扩展并连接 Windows-MCP。需要本机安装 `uv`；新建编码会话后 `computer_control` 会进入可用工具列表。
- **OpenHarmony 设备**：安装 DevEco Studio 或 Command Line Tools，开启设备 USB 调试并完成授权，然后在鸿蒙设备面板选择 HDC 和目标设备。
- **定时任务**：可创建沿用当前会话的周期跟进，或针对项目独立运行的任务。调度依赖 Piora 在本机保持运行。
- **桌宠**：在设置中启用。透明区域会穿透点击，实际宠物区域可拖动和交互；窗口会保持固定尺寸并被校正到可见屏幕内。

# 目录说明

```text
Piora/
├─ app/                    Next.js 页面与 API 路由
│  └─ api/                 会话、Agent、群聊、文件、Git、设备等接口
├─ components/             对话、侧栏、设置、随身舱和工作区组件
├─ hooks/                  会话流、任务状态、设备画面和界面状态 Hooks
├─ lib/                    会话运行时、存储、安全、Git、群聊和模型逻辑
├─ extensions/             Piora 自带的 Pi 扩展
├─ desktop/                Electron 主进程、预加载脚本与打包配置
├─ public/                 静态资源、主题和桌宠素材
├─ scripts/                验证、打包、发布、许可证和资源生成脚本
├─ docs/                   架构、设备、协作、发布和兼容性文档
├─ .github/                CI、发布工作流和贡献模板
├─ AGENTS.md               开发约束、架构边界与易错点
└─ CHANGELOG.md             版本变更记录
```

主要代码入口：

| 文件或目录 | 职责 |
| --- | --- |
| `components/AppShell.tsx` | 主界面、URL、项目、会话与工作区组合 |
| `components/ChatWindow.tsx` | 对话展示、输入与会话控制 |
| `hooks/useAgentSession.ts` | Agent 命令、SSE、运行恢复和滚动跟随 |
| `lib/rpc-manager.ts` | AgentSession 生命周期、工具与扩展绑定 |
| `lib/session-reader.ts` | 只读加载 Pi JSONL 会话与上下文 |
| `lib/room-*.ts` | 多 Agent 群聊、路由和协调 |
| `lib/harmony/` | OpenHarmony 设备、HDC、审批、UI 树与视觉能力 |
| `desktop/src/main.ts` | Electron 窗口、本地服务、更新、托盘和桌宠窗口 |

深入阅读可从 [多 Agent 协作](docs/multi-agent-collaboration.md)、[Worktree 指南](docs/worktrees.zh-CN.md)、[OpenHarmony 自动化](docs/HARMONYOS_DEVICE_AUTOMATION.md)、[扩展兼容说明](docs/open-source/EXTENSION_COMPATIBILITY.md) 和 [发布流程](docs/release.md) 开始。

# 贡献者指南

提交问题前请搜索现有 Issues 和 Pull Requests。缺陷报告应包含操作系统、Piora 版本、复现步骤、期望结果和实际结果；日志需要删除 API Key、私人路径、提示词和会话内容。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

提交代码时：

1. 从最新 `main` 创建聚焦的分支，避免混入无关格式化。
2. 先阅读 [AGENTS.md](AGENTS.md)，尤其是 AgentSession、分叉、SSE、文件访问、认证和扩展相关约束。
3. 为行为变化补充有意义的测试，并更新用户可见文档。
4. 运行适合改动范围的检查；提交前至少完成 Lint、类型检查和相关测试。
5. Pull Request 说明应写清问题、最终行为、验证结果、安全或隐私影响；界面变化附截图或录屏。

完整约定见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [行为准则](CODE_OF_CONDUCT.md)。贡献遵循仓库的 [MIT License](LICENSE)，请保留适用的上游版权与许可声明。

# 开发者指南

## 环境要求

- Node.js 22.19.0 或更高版本，建议使用仓库 `.nvmrc` 指定的版本。
- npm 与仓库提交的 `package-lock.json`。
- Git；在 Windows 上运行 Pi 编码工具时建议安装 Git for Windows。

## 本地开发

```powershell
npm ci
npm run dev
```

开发服务器监听 `http://127.0.0.1:30141`。开发期间不要运行 `next build` 或包含它的打包命令；它会污染 `.next/` 并影响正在运行的开发服务。桌面联调使用：

```powershell
npm run dev:desktop
```

该入口已实现 [Issue #46](https://github.com/kexijiang/Piora/issues/46)：自动启动带桌面认证的开发服务器、Electron TypeScript 监听与桌面窗口，无需生产构建或打包。React/CSS 修改热更新；`desktop/src` 修改后重新编译并重启 Electron。首次打开页面需要编译，后续修改只更新受影响的模块。

日常验证流程：启动一次 `npm run dev:desktop`，在打开的桌面窗口中选择要检查的会话，修改并保存代码，直接查看热更新效果；按本次修改范围检查相关交互和测试即可。在终端按 Ctrl+C 停止开发进程。

桌面窗口数据与日志位于 `.piora-data/desktop-dev`，Pi 会话与模型配置仍沿用当前用户的数据目录。浏览器开发与桌面开发共用 30141 端口，二者择一运行；桌面需要改端口时设置 `PIORA_DESKTOP_DEV_PORT`。桌面开发带临时认证令牌，应在自动打开的 Electron 窗口中查看，普通浏览器直接访问同一地址会被认证拦截。

开发入口显式使用 Webpack，以兼容共享桌面 TypeScript 模块中的 `.js` 导入，并保留现有 React/CSS 热更新能力。

## 质量检查

```powershell
npm run licenses:check
npm run verify:hygiene
npm run lint
npm run typecheck
npm test
npm run perf:check
npm run verify:backgrounds
```

只修改小范围代码时可以先运行相关测试；准备合并或发布时应执行完整检查。CI 在 Windows 和 Linux 上运行源码检查，并在 Windows 上生成和验证解包应用。

## 数据与运行边界

| 位置 | 内容 |
| --- | --- |
| `~/.pi/agent/sessions/` | Pi JSONL 会话和分支上下文 |
| `~/.pi/agent/settings.json`、`models.json`、`auth.json` | Pi 设置、模型与凭据 |
| `~/.pi/agent/piora/` | Piora 扩展、群聊、随身舱和其他本地状态 |
| Windows `%APPDATA%\Piora` | Electron 配置、浏览器资料和日志 |

`/api/files` 受允许根目录限制，不是通用文件浏览器。AgentSession 生命周期、fork 后销毁、全局热重载状态和运行中 SSE 恢复都有明确约束；修改这些区域前必须阅读 [AGENTS.md](AGENTS.md)。

## 桌面打包与发布

发布安装包统一由 GitHub Actions 构建，不在本地打包。Beta 使用 `vX.Y.Z-beta.N` 标签触发 `.github/workflows/harmony-preview.yml`，生成 Windows x64 安装版、便携版、更新元数据和校验文件。稳定版使用 `vX.Y.Z` 标签，另生成 Linux x64 AppImage。

版本发布前需要同步 `package.json`、`desktop/package.json`、`package-lock.json`、`CHANGELOG.md` 和本文版本说明。请遵循 [完整发布流程](docs/release.md)，不要移动已经发布的标签，也不要手工上传绕过验证的安装包。

# 已知问题

- 当前 Beta 是预览通道，可能存在尚未覆盖的设备、显示器、缩放比例和第三方模型兼容问题。
- Windows 安装包暂未启用代码签名，首次下载或启动时可能出现系统信誉提示。
- Beta 自动构建当前只发布 Windows x64；Linux x64 AppImage 由稳定版流程生成。Linux 不包含 Windows 专用电脑控制和本地 Whisper 运行时。
- Windows 电脑控制依赖 `uv` 和首次连接时下载的固定版本 Windows-MCP/Python 环境；无障碍树质量会影响桌面读取和操作效果。
- OpenHarmony 投屏与自动化依赖官方 HDC、设备开发者选项和 USB 授权；不同设备与系统版本需要实机验证。
- 定时任务、后台 Agent 和本地更新调度需要 Piora 进程保持运行；电脑关机、休眠或应用完全退出后不会继续执行。
- 关闭主窗口通常会收起到系统托盘。需要完全退出时，请使用托盘菜单中的退出命令。
- 便携版不支持安装版的覆盖更新流程，需要手动替换程序。更新前仍建议备份重要项目和 Pi 数据目录。
- Skills、插件和外部扩展可能依赖 npm、Git、编译器、原生模块或其他本机程序，其兼容性由各自运行环境决定。
- 桌宠、启动动画、透明窗口和多显示器行为虽然有自动回归保护，特殊显卡驱动或远程桌面环境仍可能需要单独反馈与复现。

遇到无法启动、黑屏或安装问题，请查看 [黑屏排查指南](docs/open-source/BLACK_SCREEN_TROUBLESHOOTING.md) 并在 [Issues](https://github.com/kexijiang/Piora/issues) 提交可复现信息。
