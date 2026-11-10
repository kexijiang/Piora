<p align="center">
  <img src="desktop/build/icon.png" alt="Piora 应用图标" width="96" height="96">
</p>

<h1 align="center">Piora</h1>
<p align="center">把 AI 对话、项目文件、终端、浏览器与设备操作放在同一个桌面工作台。</p>

<p align="center">
  <a href="https://github.com/kexijiang/Piora/releases/tag/v0.5.10-beta.15"><img alt="预发布 0.5.10-beta.15" src="https://img.shields.io/badge/beta-0.5.10--beta.15-2563eb.svg"></a>
  <a href="https://github.com/kexijiang/Piora/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/kexijiang/Piora/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/License-MIT-green.svg"></a>
  <a href="#下载与安装"><img alt="Windows x64" src="https://img.shields.io/badge/Desktop-Windows%20x64-555.svg"></a>
</p>

Piora 是本地优先、开源的 AI 桌面应用。选一个项目，描述要完成的工作，让 Agent 阅读文件、修改代码、执行命令或操作网页；你可以同时查看过程、审阅差异、接手浏览器，并继续手动编辑。日常问答、写作和资料整理也可以使用无项目聊天。

基于 [Pi](https://github.com/earendil-works/pi)，由 [pi-web](https://github.com/agegr/pi-web) 演进而来，保留 Pi 的会话、模型和扩展机制。项目由社区独立维护，不隶属于 Pi、pi-web、OpenAI 或 Codex。Piora 不提供统一模型订阅或内置 API Key；使用自己的模型服务账号，费用与额度由服务商管理。

**当前源码 / 本次 Beta：`0.5.10-beta.15`（2026-11-09）**，重写鸿蒙投屏链路，并包含聊天、模型及工作区改进；测试版需手动下载安装更新。稳定版仍为 [`0.5.8`](https://github.com/kexijiang/Piora/releases/tag/v0.5.8)。新版本是否已可下载，以 [GitHub Release](https://github.com/kexijiang/Piora/releases/tag/v0.5.10-beta.15) 的实际附件为准；完整变化见 [CHANGELOG](CHANGELOG.md)。

[下载安装](#下载与安装) · [首次使用](#第一次完成任务) · [功能导览](#功能导览) · [更新与内网部署](#更新与内网部署) · [开发贡献](#开发与贡献) · [中文手册](docs/user-manual.zh-CN.md)

<!-- SCREENSHOT: 01-workspace -->
![待补截图 01：Piora 完整工作区](docs/images/readme/01-workspace.svg)
*图 01 待补：左侧项目与聊天、中间任务对话、右侧文件差异。所有编号图的拍摄步骤和替换路径见[截图清单](docs/readme-screenshots.md)。占位图不是产品界面；现有历史截图均单独注明。*

## 下载与安装

目前发布 **Windows 10/11 x64 安装版**。安装包包含应用运行时与 PowerShell 7，普通使用无需另装 Node.js；Git、项目编译器和第三方工具按任务需要安装。

| 版本 | 安装包 | 校验与说明 |
| --- | --- | --- |
| 本次 Beta `0.5.10-beta.15` | [下载 setup.exe](https://github.com/kexijiang/Piora/releases/download/v0.5.10-beta.15/Piora-0.5.10-beta.15-win-x64-setup.exe) | [SHA256SUMS.txt](https://github.com/kexijiang/Piora/releases/download/v0.5.10-beta.15/SHA256SUMS.txt) · [发布说明](https://github.com/kexijiang/Piora/releases/tag/v0.5.10-beta.15) |
| 稳定版 `0.5.8` | [下载 setup.exe](https://github.com/kexijiang/Piora/releases/download/v0.5.8/Piora-0.5.8-win-x64-setup.exe) | [SHA256SUMS.txt](https://github.com/kexijiang/Piora/releases/download/v0.5.8/SHA256SUMS.txt) · [发布说明](https://github.com/kexijiang/Piora/releases/tag/v0.5.8) |

下载后运行安装器，选择安装目录并启动。安装包尚未启用 Windows 代码签名，系统可能显示信誉提示。后续版本不再构建便携 EXE、ZIP 或 Linux AppImage；旧包可在[历史发布](https://github.com/kexijiang/Piora/releases)中查找。

## 第一次完成任务

1. **连接模型**：进入“设置 → 模型配置”，添加服务商，通过 API Key、OAuth 或设备码登录；自定义服务填写 Base URL、API 格式和模型 ID。识别到模型后，主动运行连接测试。
2. **选择项目**：从侧栏添加本地文件夹；问答或写作可直接新建无项目聊天。
3. **检查模型与权限**：在输入框选择模型、思考等级和工具权限。新聊天默认使用渠道 / 模型排列中第一个可用项，长按拖动渠道可以调整顺序，已有聊天保留自己的选择。
4. **发送具体任务**：例如“阅读这个项目，说明用途、启动方法和主要目录，先不要修改文件”。支持 `@` 引用文件以及图片、文本附件。
5. **核对结果**：打开回复引用的文件，查看工具过程；需要实现时继续说明改动目标和验收方式。右侧工作区加号可以打开文件、终端、浏览器、SSH 和设备面板。

<!-- SCREENSHOT: 02-models -->
![待补截图 02：配置模型与调整渠道顺序](docs/images/readme/02-models.svg)
*图 02 待补：保留渠道列表、连接配置、模型列表与测试入口；隐藏 API Key 和企业接口地址。*

<details>
<summary>已有模型配置截图（历史测试界面，仅作入口参考）</summary>

![模型配置历史测试截图，使用示例地址且没有真实密钥](docs/images/settings-wallpaper/models.png)

截图中的服务商与地址是测试数据；默认模型以当前渠道排序行为为准。
</details>

## 功能导览

### 对话、任务与工具权限

在对话里查看思考过程、工具调用、命令输出、任务总用时和实时生成速度。支持 Markdown、代码、Mermaid、数学公式、图片缩放、历史搜索与 HTML 导出。用户消息和已完成回复可“从此处新建分支”，复制包含该消息的历史到独立聊天。

发送前保存文本和附件的本地恢复副本，失败时恢复原稿；运行中可补充要求、停止或恢复排队消息，刷新后重新连接运行状态。超时、重试、上下文压缩在“运行策略”中管理；模型故障回退默认关闭，开启后可在服务不可用时尝试其他可用兼容模型。

| 输入框权限 | 谁处理需要批准的工具操作 |
| --- | --- |
| 请求批准 | 由你确认 |
| 帮我批准 | 使用本轮所选模型独立审核，失败时转人工确认 |
| 完全访问 | 工具操作不再逐次请求批准；普通提问和用户接管仍保留 |

未保存过偏好时新聊天初始为完全访问；手动选择同时成为后续新聊天的默认值。这是应用级审批机制，详见[工具权限](docs/tool-permissions.md)与[独立审核](docs/tool-review.md)。

<!-- SCREENSHOT: 03-chat-permissions -->
![待补截图 03：任务状态与工具权限](docs/images/readme/03-chat-permissions.svg)
*图 03 待补：用演示项目展示一次工具调用、任务耗时与输入框权限菜单。*

**可选输入预测**默认关闭：根据有效会话上下文提供下一轮消息占位提示，按 `Tab` 采纳为草稿，手动输入后隐藏，不会自动发送；支持独立模型和项目覆盖。

### 项目文件、代码编辑与 Git

文件区支持文件树、多文件标签、编辑、源码 / 差异 / 预览切换，保留未保存草稿和浏览位置。Markdown、HTML 可以并排编辑和预览；代码支持高亮、折叠、查找替换，TypeScript / JavaScript 支持语义定义跳转和补全，ArkTS 提供基础符号能力。

“上一处 / 下一处改动”按区块定位 Git 变更和未保存编辑；本轮结果显示任务产生的文件净变化。Git 面板支持逐文件或逐区块暂存、提交和推送；聊天右上角“Git 工具”集中管理更改、分支和 worktree。浏览器方式的 GitHub / GitLab / Gitee 授权需要部署[授权服务](services/git-oauth/README.md)。

<!-- SCREENSHOT: 04-files-git -->
![待补截图 04：文件差异与 Git 审阅](docs/images/readme/04-files-git.svg)
*图 04 待补：展示演示仓库的文件树、增删差异、改动导航和暂存入口。详见 [Worktree 指南](docs/worktrees.zh-CN.md)。*

### 终端、浏览器与 SSH

**本地终端**保留原生 Shell 提示符、历史和交互行为，支持多标签。Windows 优先使用随包 PowerShell 7，也可选择已安装的 Git Bash、命令提示符或 WSL；改变默认 Shell 只影响新标签，拖动面板时内容重新换行。

**桌面内置浏览器**默认供 Agent 与用户协作：Agent 操作当前聊天所属的标签页，打开右侧面板就能看到并接手。登录资料保存在 Piora 自己的浏览器环境，不自动继承日常 Chrome / Edge。遇到需要手动处理的页面，对话显示等待卡片，完成后点击继续。登录能保持多久仍由网站策略决定。

**后台浏览器模式及网页版**使用独立的无头浏览器，与桌面内置浏览器的页面和登录资料分开；可以查看跟随画面，但不具备同样的手动接管体验。

<!-- SCREENSHOT: 05-browser -->
![待补截图 05：浏览器与用户接管](docs/images/readme/05-browser.svg)
*图 05 待补：同屏显示等待操作卡片、浏览器标签和“我已完成，继续”入口，使用无个人信息的演示页面。*

**SSH 工作台**支持多主机标签、密码 / 私钥认证、连接测试、远程终端和 SFTP 文件传输。连接后可关联当前 AI 任务，让 Agent 使用独立 SSH 工具；本地终端仍在本机执行。凭据存储方式及步骤见 [SSH 指南](docs/SSH_WORKBENCH.md)。

<details>
<summary>SSH 多主机、远程终端与文件截图（历史本地测试环境）</summary>

![SSH 多主机终端和 SFTP 文件面板的历史测试截图](docs/assets/ssh-multihost-wide.png)

图中为回环地址上的测试主机，包含测试环境提示，不代表本次安装包的连接验收。
</details>

### 多 Agent 协作与定时任务

**群聊工作台**为同一项目配置成员、角色、职责、协调者与并发，通过 `@` 选择成员，查看实际响应模型、任务分派和共享产物。成员使用独立会话，群聊内可以处理各成员的工具批准和提问；发送状态持久保存，成果可以直接下载。详见[多 Agent 协作](docs/multi-agent-collaboration.md)。

<!-- SCREENSHOT: 06-rooms -->
![待补截图 06：多 Agent 群聊](docs/images/readme/06-rooms.svg)
*图 06 待补：用虚构成员展示角色、@ 选择、一次协作回复和成果下载。*

**定时任务**可以在当前聊天周期跟进，或每次为项目创建独立会话；支持执行记录、暂停、恢复和手动运行。调度依赖 Piora 在本机持续运行，电脑关机、休眠或完全退出应用后不会继续执行。

<!-- SCREENSHOT: 07-schedules -->
![待补截图 07：定时任务与执行记录](docs/images/readme/07-schedules.svg)
*图 07 待补：展示任务周期、关联项目、下次执行时间及一条历史记录，使用演示内容。*

### Skills、插件、MCP 与桌面扩展

- **技能**：从内置市场、精选仓库、自定义 Git 或兼容市场发现和安装，管理来源、启停和更新。见[技能来源](docs/skill-sources.md)。
- **Pi 插件与扩展**：管理全局 / 项目资源包，按需要启用能力；禁用扩展会从会话加载计划中移除。
- **MCP**：配置外部工具服务，查看连接及工具状态。能力、依赖和认证取决于所接服务，见[用户手册](docs/user-manual.zh-CN.md#mcp-外部工具)。
- **桌面扩展**：可选安装 [DSH Pet](docs/dsh-pet.md) 和 [DSH Meme](docs/dsh-meme.md)。前者提供独立桌宠，后者提供图库与 AI 表情工具；图库管理在设置中，聊天输入栏没有表情包发送按钮。

<!-- SCREENSHOT: 08-skills -->
![待补截图 08：技能与扩展管理](docs/images/readme/08-skills.svg)
*图 08 待补：展示技能发现、已安装状态和来源管理，使用公开示例技能。*

<details>
<summary>已有桌面扩展截图（历史 DSH Pet 设置界面）</summary>

![DSH Pet 桌面扩展历史截图](docs/images/dsh-pet/settings.png)

此图拍摄早于 DSH Meme 加入，仅说明入口；首次安装需要下载独立运行资源，上游素材另有许可证要求。
</details>

### 鸿蒙设备工作台

通过 HDC 连接兼容的 OpenHarmony / HarmonyOS 设备，选择目标后查看画面、截图和录屏，并通过应用、测试、语音、日志与记录工具处理任务。兼容设备优先使用 Windows 包内的 Hypium 原生采集库；需要手机端 HAP 的兼容路径仍需签名工具和明确初始化。

**投屏画布只用于观看**：缩放和平移不会向手机发送触摸或按键。手机操作从 AI、应用或测试工具发起，按设备状态串行执行；仅观看不会自动安装服务、唤醒或解锁设备。

<!-- SCREENSHOT: 09-harmony -->
![待补截图 09：鸿蒙设备与只读投屏](docs/images/readme/09-harmony.svg)
*图 09 待补：需要真实设备，展示完整画面、设备选择与工具抽屉；隐藏设备序列号、通知和个人内容。*

设备型号、系统录屏、原生画质 / 延迟、平板及长期稳定性以[验收矩阵](docs/harmony/atlas-acceptance.md)为准；CI 通过不等于真实手机全部验收通过。连接步骤见[鸿蒙设备指南](docs/HARMONYOS_DEVICE_AUTOMATION.md)。

### 随身舱、听写与外观

随身舱集中放置待办、专注时钟、JSON 工具和 Markdown 中转站；中转站支持多文件、源码编辑、自动保存、恢复及导入导出。可选桌宠以独立窗口展示任务状态，也支持兼容素材导入。

本地听写首次开启时下载 SenseVoiceSmall INT8 与 sherpa-onnx 资源，也支持手动导入；资源就绪后语音转文字在本机完成。发送转写文字到模型仍使用所选服务。外观设置提供主题、背景、字体与字号，快捷键可以自定义。

<!-- SCREENSHOT: 10-companion -->
![待补截图 10：随身舱与日常工具](docs/images/readme/10-companion.svg)
*图 10 待补：展示虚构待办、专注计时和示例 Markdown，保持窗口控制栏可见。*

### 数据、凭据与诊断

会话和应用资料保存在本机；模型请求把任务所需内容发送给你配置的服务。项目源码需独立使用 Git 或文件备份。应用提供备份 / 迁移和数据目录管理，覆盖范围见[备份说明](docs/user-manual.zh-CN.md#数据备份与迁移)。

桌面[本地凭据库](docs/credential-vault.md)在系统加密支持下保存网站账户，提供主密码验证及加密备份。自动填写默认关闭，仅对匹配的可信 HTTPS 表单填写，不自动提交；填写时暂停并隔离浏览器 Agent 的页面读取。普通会话 / 设置备份不包含凭据库的独立数据文件。

<!-- SCREENSHOT: 11-vault -->
![待补截图 11：本地凭据库](docs/images/readme/11-vault.svg)
*图 11 待补：只使用虚构账户或空列表，保持敏感字段遮盖，不展示真实凭据。*

运行日志支持调整目录、级别、单文件大小及备份份数。遇到启动或黑屏问题，参考[排查指南](docs/open-source/BLACK_SCREEN_TROUBLESHOOTING.md)；反馈时附版本、系统、复现步骤和脱敏日志。

## 更新与内网部署

**更新来源**和**版本更新资格**相互独立；只有正式安装版启用自动更新。在设置中搜索“更新来源”，选择 GitHub 或内源，再检查更新。切换会清除旧来源的可安装状态；网络失败注明来源，允许手动切换重试。不会自动降级，也不会静默换源。

| 设置 | 当前 GitHub 发行版行为 |
| --- | --- |
| GitHub 来源 | 默认值，从本仓库 Release 获取安装包和更新说明 |
| 内源 | 已有选择与持久化能力；地址为源码占位，未配置时提示“内源更新地址未配置” |
| 稳定渠道 | 只选择稳定版 |
| Beta 测试版 | 仅手动下载安装，不检查、下载或静默安装更新 |
| 旧 Alpha / 开发版 | 不提供自动更新；Alpha 流水线已下线，请手动迁移到正式版或 Beta |

<!-- SCREENSHOT: 12-updates -->
![待补截图 12：更新来源与版本](docs/images/readme/12-updates.svg)
*图 12 待补：在安装版展示当前版本 `0.5.10-beta.15`、更新来源和检查入口；内网截图在配置真实地址后补拍。*

内网维护者可将默认来源设为内网，并配置内部 HTTPS 发布镜像。配置点、Atom 列表、安装包目录和元数据格式见[桌面更新来源说明](docs/desktop-update-sources.md)。公网仓库不包含公司内网地址或凭据。

内外分发使用同一套版本与标签格式，例如 **`0.5.10-beta.15` / `v0.5.10-beta.15`**；同一批更新应在两端同步版本号。相同版本号不会触发升级，切换来源不会重装同版本包；以后分发新代码时，应在两端同步递增版本号，并提供对应更新说明。版本号对齐不代表两个独立维护分支的代码和安装包自动相同。

安装包由 GitHub Actions 构建和校验，Beta 候选全部自动检查通过后，由独立发布工作流上传同一批产物。Release 正文与 `beta.yml` / `latest.yml` 的更新说明统一来自 CHANGELOG。关闭主窗口通常收起到托盘，完全退出或重启使用托盘菜单。

## 开发与贡献

使用 [.nvmrc](.nvmrc) 指定的 **Node.js 22.19.0**、npm 和 Git。Windows 上执行 Agent Bash 工具还需要 Git for Windows 等兼容环境。

```powershell
git clone https://github.com/kexijiang/Piora.git
cd Piora
npm ci
npm run dev
```

浏览器访问 `http://127.0.0.1:30141`。桌面联调先停止上述服务，改用 `npm run dev:desktop`；该入口启动带认证的本地服务和 Electron，监听前端与桌面代码变化。两个入口默认共用端口；桌面端可用 `PIORA_DESKTOP_DEV_PORT` 修改。

**开发目录不要运行 `next build` / `npm run build`，也不要在本地构建发布包。** 测试所需的桌面 / worker 夹具编译可以运行；发布安装包只由 GitHub Actions 构建。Linux 源码开发的 GLib 工具要求见[桌面开发说明](desktop/README.md)。

| 目录 | 职责 |
| --- | --- |
| `app/`、`components/`、`hooks/` | 页面 / API、聊天与工作区、实时交互状态 |
| `lib/`、`extensions/` | Pi 会话运行时、模型、存储、第一方扩展 |
| `desktop/` | Electron 主进程、预加载、浏览器和更新器 |
| `scripts/`、`tests/`、`.github/` | 验证脚本、测试夹具与 CI / 发布 |
| `docs/`、`public/` | 使用及架构文档、静态资源 |

提交前阅读 [AGENTS.md](AGENTS.md) 和[贡献指南](CONTRIBUTING.md)。按改动选择相关快速检查，完整验证交给 GitHub Actions；如实记录未运行、跳过或失败的项目。常用入口：

```powershell
npm run typecheck
npm run lint
npm test
npm run licenses:check
npm run verify:hygiene
```

`npm test` 先编译桌面与 Harmony worker，再执行测试，不创建安装包。真实桌面交互测试另见[自动化测试说明](docs/desktop-automated-testing.md)。CI 在 Windows 上以六分片执行测试，另有质量、官网及发布包校验；真实设备和外部服务效果需要相应环境验收。

每次提交、推送前更新远端状态；发布同步根 / 桌面版本、锁文件、许可证清单、README 和带日期的 CHANGELOG。使用未占用的新标签，不移动已发布标签。完整步骤见[发布流程](docs/release.md)。

## 文档与反馈

- [完整中文手册](docs/user-manual.zh-CN.md) · [文档索引](docs/README.md) · [版本更新](CHANGELOG.md)
- [README 截图清单与替换方法](docs/readme-screenshots.md)
- [GitHub Issues](https://github.com/kexijiang/Piora/issues) · [行为准则](CODE_OF_CONDUCT.md) · [安全问题报告](SECURITY.md)

## 许可证与致谢

Piora 使用 [MIT License](LICENSE)。感谢 Pi、pi-web 及各上游项目。第三方组件、模型与素材保留各自许可证，详见 [NOTICE](NOTICE)、[第三方许可证清单](THIRD_PARTY_LICENSES.md)及[第三方声明](THIRD_PARTY_NOTICES.md)。
