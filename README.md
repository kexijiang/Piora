<p align="center">
  <img src="desktop/build/icon.png" alt="Piora 应用图标" width="112" height="112">
</p>

<h1 align="center">Piora</h1>

<p align="center">本地优先的开源 AI 桌面工作台</p>

<p align="center">
  <a href="https://github.com/kexijiang/Piora/releases/tag/v0.5.4"><img alt="稳定版 0.5.4" src="https://img.shields.io/badge/release-0.5.4-2563eb.svg"></a>
  <a href="https://github.com/kexijiang/Piora/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kexijiang/Piora/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="#下载与安装"><img alt="Windows / Linux x64" src="https://img.shields.io/badge/Desktop-Windows%20%7C%20Linux%20x64-555.svg"></a>
</p>

Piora 把 AI 对话、项目文件、代码编辑、Git 审阅、终端、浏览器和设备操作放进同一个窗口。你可以让 Agent 修改项目，也可以随时打开文件检查改动、运行命令、查看结果，继续手动完成工作。

项目基于 [Pi](https://github.com/earendil-works/pi)，由 [pi-web](https://github.com/agegr/pi-web) 演进而来，保留 Pi 的会话、模型接入与扩展机制。Piora 由社区独立维护，不隶属于 Pi、pi-web、OpenAI 或 Codex。

最新正式版为 `0.5.4`，当前源码版本为 `0.5.5-beta.9`。此 beta 集中提供鸿蒙设备的应用、文件、SQLite 与终端工作台；安装包须经 GitHub Actions 构建，并在真实 Piora 桌面端与手机上验收同批字节后才会出现在[所有发布](https://github.com/kexijiang/Piora/releases)。beta.9 候选 Windows 包只携带由同次来源和真机验收收据约束的 unsigned 投屏 HAP；只有用户明确初始化时，Piora 才调用本机已登录的 DevEco CLI 生成或更新设备调试 Profile，生成并验签设备绑定副本后安装。真机支持范围和待验项目见[鸿蒙设备验收矩阵](docs/harmony/atlas-acceptance.md)，完整版本变化以 [CHANGELOG.md](CHANGELOG.md) 为准。

[下载与安装](#下载与安装) · [开始使用](#开始使用) · [主要功能](#主要功能) · [鸿蒙设备工作台](#鸿蒙设备工作台) · [开发与贡献](#开发与贡献) · [文档索引](docs/README.md)

## 下载与安装

日常使用推荐 **Windows 安装版**。以下链接均对应已发布的 [Piora 0.5.4 正式版](https://github.com/kexijiang/Piora/releases/tag/v0.5.4)：

| 平台与形式 | 下载 | 使用方式 |
| --- | --- | --- |
| Windows x64 安装版 | [下载 setup.exe](https://github.com/kexijiang/Piora/releases/download/v0.5.4/Piora-0.5.4-win-x64-setup.exe) | 安装后启动，支持选择目录和应用内更新 |
| Windows x64 单文件便携版 | [下载 portable.exe](https://github.com/kexijiang/Piora/releases/download/v0.5.4/Piora-0.5.4-win-x64-portable.exe) | 直接运行，升级时手动替换 |
| Windows x64 免安装目录 | [下载 ZIP](https://github.com/kexijiang/Piora/releases/download/v0.5.4/Piora-0.5.4-win-x64.zip) | 解压后运行 `Piora.exe` |
| Linux x64 | [下载 AppImage](https://github.com/kexijiang/Piora/releases/download/v0.5.4/Piora-0.5.4-linux-x64-portable.AppImage) | 赋予执行权限后运行 |
| 文件校验 | [SHA256SUMS.txt](https://github.com/kexijiang/Piora/releases/download/v0.5.4/SHA256SUMS.txt) | 核对下载文件的 SHA-256 |

Windows 支持 Windows 10/11 x64。桌面包已包含应用运行时，普通使用不需要另装 Node.js；Windows 包还内置 PowerShell 7 和离线听写资源。Git、项目编译器以及第三方工具需要的程序，请按实际任务安装。

Linux 下载后可在文件属性中允许执行，或运行：

```bash
chmod +x Piora-0.5.4-linux-x64-portable.AppImage
./Piora-0.5.4-linux-x64-portable.AppImage
```

其他版本和 Beta 预览版见 [所有发布](https://github.com/kexijiang/Piora/releases)。目前正式版提供 Windows 和 Linux x64，Beta 提供 Windows x64；没有 macOS 安装包。Windows 安装包尚未启用代码签名，首次启动可能出现系统信誉提示。

## 开始使用

1. **配置模型**：打开“设置 → 模型”，填写 API Key，或使用服务支持的 OAuth / 设备码登录。自定义服务可配置地址和模型 ID，测试连接后选择默认模型。
2. **选择工作位置**：添加本机文件夹作为项目，或新建无项目聊天。项目会话中的文件、终端和 Git 操作围绕所选目录展开。
3. **描述任务**：写清目标和验收方式，例如“修复登录页布局，运行相关测试，并说明改动”。可用 `@` 引用文件，也可添加图片和文本附件。
4. **检查过程与结果**：对话中查看工具调用和运行状态；右侧加号可打开文件、审阅、终端、浏览器、SSH、设备等面板。
5. **继续或调整**：任务运行时可以补充要求或停止。对自己发送的消息使用“重试”可重新发送原文和附件，也可从历史消息分叉继续。

Piora 不提供统一模型订阅或内置 API Key。模型费用、额度及服务端数据处理由你选择的服务决定；可用模型、图片能力和思考等级随服务配置而变化。

## 主要功能

### 对话与模型

- 项目会话和无项目聊天，支持图片、Markdown、Mermaid、数学公式、长会话、历史搜索与 HTML 导出。
- 查看思考、工具调用、执行耗时、重试和上下文压缩状态；刷新页面后恢复运行状态。
- 发送前保存文本和附件的本地恢复副本，发送失败时恢复原稿，避免覆盖之后输入的新内容。
- 在设置中调整超时、重试和压缩参数；可选开启模型故障回退，在服务不可用时尝试其他已启用且已认证的兼容模型。回退默认关闭。

### 文件编辑与改动审阅

右侧文件区支持文件树、多文件标签、编辑、源码、差异和预览视图。切换文件保留未保存草稿及各自的浏览位置，Markdown 与 HTML 可并排编辑和预览。

- **改动定位**：每个文本文件工具栏显示改动计数和“上一处改动 / 下一处改动”按钮。连续修改按区块跳转，首尾循环，覆盖 Git 改动及未保存编辑。
- **自动展开目标**：跳转时展开目标所在的折叠代码或差异段；从预览跳转会显示编辑区域，长差异也可定位到尚未展示的部分。
- **代码编辑**：语法高亮、代码折叠、括号匹配、查找替换；ArkTS、TypeScript 和 JavaScript 支持定义跳转、补全等语义能力。服务不可用时显示基础模式。
- **本轮结果**：按任务查看本轮文件净变化，直接打开对应文件或差异。
- **Git 审阅**：逐文件或逐区块暂存，查看分支和目标后提交、推送；管理远程仓库与 worktree。GitHub、GitLab、Gitee 的浏览器授权需配置[授权服务](services/git-oauth/README.md)。

### 终端、浏览器与 SSH

交互终端保留 Shell 的原生提示符、输入编辑和历史记录。Windows 默认优先使用随包提供的 PowerShell 7；也可选择已安装的 Git Bash、命令提示符、WSL 等，在终端设置中保存默认值。切换默认 Shell 只影响新建标签。

PowerShell 的 PSReadLine 支持历史建议：在行尾按 `→` 接受建议，`↑` / `↓` 翻阅历史，`Ctrl+R` 搜索，`Tab` 补全，`Ctrl+C` 中断。拖动终端面板时，内容会随宽度重新换行。

内置浏览器面板用于打开网页。Agent 的浏览器工具使用独立的无头浏览器环境，不继承你日常浏览器的登录状态。

[SSH 工作台](docs/SSH_WORKBENCH.md)支持多主机标签、密码或私钥认证、连接测试、远程终端及 SFTP 文件传输。已连接主机可关联当前 AI 任务，Agent 使用独立的 SSH 工具操作指定主机；本地终端仍执行本地命令。桌面端通过系统安全存储加密凭据，独立网页运行或系统加密不可用时需设置主密码。

### 多 Agent、定时任务与扩展

- **多 Agent 群聊**：为同一项目配置成员、角色和职责，管理协调者、并发、任务分派与共享产物。详见[协作工作台](docs/multi-agent-collaboration.md)。
- **定时任务**：在当前聊天中周期跟进，或每次为项目创建独立会话；可查看执行记录、暂停、恢复和手动运行。调度需要 Piora 在本机保持运行。
- **Skills、插件与扩展**：管理 Pi 资源包、技能和扩展，并按项目或会话配置可用能力。第三方资源所需的依赖由其运行环境决定。
- **Goals / Plans**：可选的第一方扩展，默认关闭。在“设置 → 扩展”启用后可使用 `/goal` 和 `/plan`；Goals 保存目标进度，不会自行连续启动新的模型回合。

### 截图、听写与随身舱

Windows 全局截图快捷键默认为 **Ctrl+Alt+A**，可在设置中修改，也可从应用菜单、命令面板或聊天附件菜单打开。截图支持跨屏框选、放大镜、形状、箭头、画笔、文字、马赛克及撤销重做；完成后可复制、另存或加入当前聊天草稿。

Windows 桌面包内置 **SenseVoiceSmall INT8** 模型和 **sherpa-onnx** 运行时，在语音设置中开启后可本地听写，无需额外下载识别资源。语音转文字在本机进行；发送文字到模型仍遵循所选模型服务的配置。

随身舱提供待办、专注时钟、JSON 工具和 Markdown 中转站。中转站支持文件标签、源码模式、自动保存、草稿恢复、导入导出及图片插入。可选桌宠以独立透明窗口显示任务与专注状态，并支持导入兼容的本地宠物素材。

## 鸿蒙设备工作台

设备面板以完整手机画面为主，投屏画布只用于观看：可以缩放和平移视野，但鼠标点击、拖动、长按和键盘输入都不会发送到手机。应用、测试、语音、日志和记录放在默认收起的“工具”抽屉中；宽面板从侧边展开，窄面板从底部展开，诊断与校准收进设备设置。

### 连接与操作

1. 在支持 HDC 的 OpenHarmony / HarmonyOS 设备上开启开发者选项和 USB 调试，并在手机确认电脑授权。
2. 打开右侧设备面板，选择 HDC 和目标手机。Windows 包带有备用 HDC，也可使用 DevEco Studio / SDK 中适合设备的版本；多设备连接时明确选择目标。
3. 缺少投屏服务时，先安装 HarmonyOS API 26 SDK、运行 `devecocli auth login`，连接并解锁目标手机，再点击面板中的“初始化投屏服务”。Piora 会在私有缓存调用随包 DevEco CLI 自动生成或更新设备调试 Profile，核对随包 unsigned HAP 的发布收据，为当前手机生成并官方验签私有副本，然后以普通安装命令部署；不会使用 `-r` 覆盖安装。登录、适用 Profile 或 API 26 工具链缺失时会直接说明配置问题。
4. 画面和设备能力就绪后即可持续观看、截图或录屏，无需停止投屏或中断正在运行的 AI 任务。需要操作手机时，从 AI、应用或测试工具发起；后台会按设备状态串行执行动作。

**仅观看投屏不会自动安装服务、唤醒或解锁手机，也不会占用设备动作队列。** 截图和录屏使用独立的只读媒体通道；切换设备、关闭面板或停止任务后，等待中的旧动作不会继续派发。

### 测试与开发

- 按应用名称或包标识查找已安装应用，选择场景和验证内容后运行；提供六种场景模板、步骤预览、执行记录和检查点恢复。
- 手机已通过 HDC 连接后，Agent、应用和测试工具可直接派发设备动作，不再要求应用范围授权或单次批准。需要坐标的后台动作按最新画面自动校准与重试；投屏画布仍只读，实际不支持的能力按设备情况提示。
- 查看设备日志、保存截图和录屏；录屏保存当前投屏的视频流。
- 集成 DevEco 工程检查、ArkTS 与 Linter 诊断、文件定位和修复复查。工程检查仍需本机安装并配置 DevEco Studio 及对应 SDK。
- 提供本地 WAV 校验、声学输出预览、语音校准和按住说话流程；手机实际识别结果匹配后才记录为通过。

设备自动化和声学输入仍需逐机型、逐系统验证。软件回归通过不代表所有手机或真实麦克风链路已验收；不可用、需校准和未完成状态会按实际结果显示。

详见[首次连接](docs/harmony/quickstart.md)、[观察与停止](docs/harmony/controls.md)、[语音输入](docs/harmony/voice-input.md)、[能力目录](docs/harmony/capabilities.md)与[实测范围](docs/harmony/compatibility.md)。

## Windows 电脑控制

在电脑控制设置中连接后，可让 Agent 操作本机应用。Windows 桌面包内置 winapp CLI，优先通过 UIA 控件执行点击、输入、读取和滚动；需要截图定位时使用视觉模型与 Windows-MCP。

Windows-MCP 需要本机安装 `uv`，首次连接会下载对应运行环境。设置分别显示两种后端的状态；停止或超时后不会自动重放可能已经生效的操作。此能力不覆盖锁屏、UAC 安全桌面及权限高于 Piora 的应用。

## 数据与隐私

Piora 没有统一账号服务或内置遥测。会话、设置和工作区状态默认保存在本机；向模型提问、登录服务、安装扩展、检查更新或使用联网工具时，会连接相应服务。

| 位置 | 内容 |
| --- | --- |
| `~/.pi/agent/sessions/` | Pi JSONL 会话与分支上下文 |
| `~/.pi/agent/settings.json`、`models.json`、`auth.json` | Pi 设置、模型与认证资料 |
| `~/.pi/agent/piora/` | Piora 扩展偏好、协作、定时任务等本地数据 |
| Windows `%APPDATA%\Piora\runtime\normal\` | 桌面设备配置、执行记录与恢复信息 |
| Windows `%APPDATA%\Piora` | 桌面配置、浏览器资料、草稿及运行日志 |

Windows 中的 `~` 通常指 `%USERPROFILE%`。便携版的数据也保存在用户目录，替换程序不会把会话清空，也不代表所有数据都跟随 EXE 移动。

“设置 → 数据与诊断 → 运行日志”可查看、复制实际日志路径或打开所在文件夹。反馈问题前请删除日志中的凭据、私人路径、提示词和会话内容。

## 开发与贡献

### 本地运行

需要 **Node.js 22.19.0 或更高版本、npm 和 Git**；建议采用 [.nvmrc](.nvmrc) 指定的版本。Windows 上运行 Agent 的 Bash 工具时还需 Git for Windows 等兼容环境。

```powershell
git clone https://github.com/kexijiang/Piora.git
cd Piora
npm ci
npm run dev
```

浏览器访问 `http://127.0.0.1:30141`。需要 Electron 桌面联调时，停止浏览器开发服务，改为：

```powershell
npm run dev:desktop
```

桌面开发入口自动启动带认证的服务、监听桌面代码并打开窗口。React/CSS 修改热更新，桌面主进程或预加载脚本编译后重启 Electron；按 `Ctrl+C` 停止。桌面开发资料位于 `.piora-data/desktop-dev`，Pi 会话仍沿用当前用户目录。

两种开发入口默认共用 30141 端口，应择一启动；桌面改端口可设置 `PIORA_DESKTOP_DEV_PORT`。桌面服务应通过自动打开的 Electron 窗口访问，普通浏览器没有桌面认证令牌。

**开发期间不要运行 `next build`、`npm run build` 或本地发布打包命令**，以免污染 `.next/`、破坏开发服务。安装包统一由 GitHub Actions 构建。

### 目录与架构

桌面层使用 Electron，本地 Next.js 服务提供页面和 API，Pi `AgentSession` 在服务进程中执行任务；浏览历史直接读取会话文件，不会为每次查看启动 Agent。

```text
Piora/
├─ app/           页面与 API：会话、Agent、文件、Git、设备、SSH、定时任务
├─ components/    聊天、设置、文件编辑、群聊、随身舱及工作区面板
├─ hooks/         会话流、任务状态、设备画面与交互状态
├─ lib/           会话运行时、数据存储、模型、设备与各子系统
├─ extensions/    第一方 Pi 扩展
├─ desktop/       Electron 主进程、预加载脚本与打包配置
├─ public/        静态资源、主题和桌宠素材
├─ scripts/       验证、资源生成、许可证与发布脚本
├─ tests/         测试辅助工程与设备验收材料
├─ docs/          使用、架构、兼容性与发布文档
└─ .github/       CI、发布工作流和贡献模板
```

主要入口为 `components/AppShell.tsx`、`components/ChatWindow.tsx`、`hooks/useAgentSession.ts`、`lib/rpc-manager.ts` 和 `desktop/src/main.ts`。改动会话生命周期、分叉、SSE、文件权限或设备控制前，请先阅读 [AGENTS.md](AGENTS.md)。

### 检查与发布

```powershell
npm run licenses:check
npm run verify:hygiene
npm run harmony:docs:check
npm run lint
npm run typecheck
npm test
npm run perf:check
npm run verify:backgrounds
```

`npm test` 会先编译 Harmony worker 和桌面 TypeScript，再运行完整测试，不创建发布安装包。CI 在 Windows / Linux 上分组执行测试，Windows 高资源 Shell 测试单独运行。beta 标签构建会从随包的同一 unsigned HAP 输入生成仅供门禁使用的私有 DevEco device-signed 副本；该副本完成官方验签和真机门禁后删除且不上传。候选生成后还须安装同批 Piora，并验证用户明确初始化时的本机签名与手机安装；软件测试不能代替这两层硬件验证。

发布前同步根包与桌面包版本、锁文件、README、许可证清单和带日期的 CHANGELOG。每次提交及推送前先更新远端状态，处理分支变化并重新验证。推送未占用的 `vX.Y.Z-beta.N` 标签后，GitHub Actions 只构建并上传候选；安装同批 Piora 并完成手机验收后，再由独立工作流发布这些原始字节。`vX.Y.Z` 稳定流程在接入同一 bundle 的 AGC release identity 前保持失败关闭。不要移动已发布标签或本地制作发布包。

**CHANGELOG 是唯一更新说明来源**，Release 正文和 `beta.yml` / `latest.yml` 的更新说明由同一版本记录生成，并在发布前校验。具体步骤见[发布流程](docs/release.md)。

提交问题或代码前请阅读 [贡献指南](CONTRIBUTING.md)与[行为准则](CODE_OF_CONDUCT.md)。问题报告应说明版本、系统、复现步骤及实际结果；安全问题按 [SECURITY.md](SECURITY.md) 私下报告。

## 使用边界与帮助

- Linux AppImage 不包含 Windows 专用电脑控制和随包离线听写运行时；鸿蒙设备的兼容性以设备诊断和实测记录为准。
- 定时任务和后台 Agent 依赖应用进程；电脑关机、休眠或应用完全退出后不会继续执行。
- 关闭主窗口通常收起到托盘，完全退出请使用托盘菜单。便携版升级需要手动替换程序。
- 特殊显卡、多显示器、缩放比例及远程桌面环境仍可能存在兼容差异；无法启动或黑屏时见[排查指南](docs/open-source/BLACK_SCREEN_TROUBLESHOOTING.md)。

更多说明见[文档索引](docs/README.md)、[扩展兼容说明](docs/open-source/EXTENSION_COMPATIBILITY.md)、[Worktree 指南](docs/worktrees.zh-CN.md)和 [GitHub Issues](https://github.com/kexijiang/Piora/issues)。

## 许可证与致谢

Piora 使用 [MIT License](LICENSE)。感谢 Pi、pi-web 及各上游项目；第三方组件和素材保留各自许可证，详见 [NOTICE](NOTICE)、[第三方许可证清单](THIRD_PARTY_LICENSES.md)与[第三方声明](THIRD_PARTY_NOTICES.md)。
