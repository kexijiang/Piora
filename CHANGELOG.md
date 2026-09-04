# Changelog

All notable changes to Piora are documented here. The project follows [Semantic Versioning](https://semver.org/) after the first tagged public release.

## [Unreleased]

## [0.4.40-beta.13] - 2026-09-04

### 优化

- 完善设置页与侧栏的布局一致性，优化设置页内容占位和面板宽度控制。
- 支持模型回复中标题、要点、重点词与普通文本的主题化配色，以提升可读性。

### 升级

- 应用版本由 `0.4.40-beta.12` 升级到 `0.4.40-beta.13`。

## [0.4.40] - 2026-09-04

### 新增

- 新增项目级工具设置：同一项目中的会话共享工具选择，运行中的会话会在当前任务结束后安全应用变更，并限制工具定义占用的提示词预算。
- Design to Harmony 完整支持 Figma 与 Octo 结构化设计稿导入、确定性 ArkUI 生成、隔离预览、补丁审阅和设备视觉验收。
- 新增统一搜索、文件夹附件、应用内更新、内测更新通道，以及多套可保存的界面主题和桌宠能力。

### 优化

- 重构 Agent 停止与运行阶段处理：准备中、模型等待、工具执行、压缩和停止状态保持一致，取消请求会清理队列与扩展交互，避免迟到事件重新激活任务。
- 模型回复中的标题、重点文字和行内代码使用主题感知配色；全局字体设置新增常规、中等、加粗与实时预览，并兼容旧设置和设置导入导出。
- Mermaid 支持高清 PNG 导出与图片复制，代码块保持独立语法配色；JSON 工作台改进标签和操作菜单，桌面内嵌浏览器的收起、恢复与尺寸同步更加稳定。
- 整理项目侧栏、新建会话和项目操作，让项目选择、折叠和诊断路径更清晰。

### 修复

- 修复停止任务时异步认证、输入钩子或压缩仍可能启动后续模型请求，以及终止后界面状态恢复不及时的问题。
- 修复桌面浏览器收起或切换后残留原生视图、迟到尺寸消息重新显示页面，以及模型回复代码块切换明暗主题时出现背景样式冲突的问题。
- 修复部分主题重启后丢失、语音包中断后重复下载、缓存输入重复计入上下文等问题。

### 升级

- 应用版本由 `0.4.40-beta.11` 升级到首个 `0.4.40` 正式版；依赖版本保持不变。

## [0.4.40-beta.11] - 2026-09-03

### 修复

- 修复部分主题在应用重启后恢复为默认主题的问题，统一启动初始化与主题设置的持久化读取逻辑。
- 修复语音包下载中断或应用重启后必须重新下载的问题，保留已校验文件和部分下载，并在重试时恢复下载进度。

### 升级

- 应用版本由 `0.4.40-beta.10` 升级到 `0.4.40-beta.11`，依赖版本保持不变。

## [0.4.40-beta.10] - 2026-09-02

### 新增

- 新增统一搜索面板：同一入口可搜索最近会话、聊天内容和具体设置项，支持键盘上下选择、回车直达对应会话或设置页面。
- Design to Harmony 新增 Octo Designer 结构化 JSON 导入；与 Figma 共用分析、ArkUI 生成和验证管线，并对文件大小、UTF-8、节点数量、重复 ID 与树深度做有界校验。
- 对话附件支持同时添加文件和文件夹；项目菜单新增“在资源管理器中打开”。

### 优化

- 随身舱移除冗余标题说明，改为会随窗口宽度响应的简洁标签页；JSON 工具升级为 CodeMirror 6 编辑器，支持行号、代码折叠、JSON 语法能力、快捷格式化和标签双击重命名。
- 上下文占用提示新增系统提示词、项目指令、工具定义、对话消息和其他运行时开销的分项估算，并以模型供应商返回的总量为准进行校准。
- 主对话思考内容改为 Markdown 渲染并统一为更圆润的 Codex 风格；Mermaid 图默认显示预览，滚动轨道会随对话列宽移动并与正文保持间距。
- 左侧项目区可拉宽到屏幕的大半区域；项目行的新会话按钮改用候选 B 的消息气泡图标。
- 新建会话先选择目标项目，不再默认落入聊天工作区；桌面菜单的新建会话也复用同一选择流程。

### 修复

- 修复运行中的会话发送引导或跟进消息后，输入框上方不再立即显示排队横条的问题；发送失败时会正确撤回对应状态。
- 修复部分模型把缓存输入与总输入重复计入上下文、导致新会话显示约 52K 占用的问题。
- 修复语音识别模型分开下载后，带浏览器重复下载后缀（如 `model.int8 (1).onnx`）的文件无法拖入识别，并补充逐文件导入反馈。
- 修复 JSON 标签双击重命名失效，以及随身舱最大化后快捷键只激活窗口、无法正常收起的问题。

### 升级

- 应用版本由 `0.4.40-beta.9` 升级到 `0.4.40-beta.10`。
- 新增 CodeMirror 6 JSON 编辑依赖：`codemirror 6.0.2`、`@codemirror/lang-json 6.0.2`、`@codemirror/state 6.7.2`、`@codemirror/view 6.43.10`；既有 Pi、Electron、Next.js 和 Hypium 版本未变。

## [0.4.40-beta.9] - 2026-09-02

### 修复

- 收紧 Hypium 已审查双重身份校验：即使锁文件被改成 tarball 内部误写版本，也不得绕过发布版本与完整性哈希约束。

## [0.4.40-beta.8] - 2026-09-02

### 修复

- 记录 `hypium-driver@6.1.210` 不可变 npm tarball 内部误写为 `6.1.0210` 的双重身份与完整性哈希，使最终包的许可证清单和 SBOM 精确反映实际分发字节。

## [0.4.40-beta.7] - 2026-09-02

### 修复

- 修复 Windows 干净检出将 ArkUI golden fixture 转为 CRLF 后稳定生成测试误报的问题；测试现在规范化参考文件并继续强制生成器输出 LF。

## [0.4.40-beta.6] - 2026-09-02

### 修复

- 修复 Electron Builder 按第三方包 `files` 清单裁剪 Hypium 根清单后，Windows 内测包无法完成许可证与 SBOM 审计的问题。
- 修复 npm alias 依赖按安装别名而非真实包名进入运行时许可证闭包的问题，确保 `xmldom` 安全替代项可被精确验证。

## [0.4.40-beta.5] - 2026-09-02

### 新增

- 新增完整 Figma 设计稿转 HarmonyOS ArkUI 工作台：支持文档树、流程可达页面、Design IR、组件/变量/交互映射、真实图片资源、确定性代码、隔离预览、补丁审阅和原子应用。
- 新增影子工程 Hvigor 编译、诊断到设计节点映射，以及可选的 Harmony 设备安装、启动、稳定截图、并排/叠加/差异视觉验收。
- 新增受限的“把当前运行交给 Codex”上下文交接；只插入运行、节点、问题和目标文件摘要，不包含设计凭据或完整设计内容。

### 优化

- 设计稿同步现在按完整 IR 和依赖根计算最小影响范围；长任务支持 SSE 进度、统一取消、终态恢复和有界缓存回收。

### 修复

- 修复设计验证取消后界面可能停留在中间状态，以及不同设备屏幕安全区导致视觉对比被拉伸的问题。
- 修复完成的设计长任务仍保留父级取消监听，以及视觉产物读取范围过宽的问题。

## [0.4.40-beta.4] - 2026-09-02

### 新增

- 新增模型优先使用的 `harmony_run_scenario`：一次调用可完成最多 64 步语义操作、条件等待、断言、滚动查找、应用安装/启动/停止/清理/卸载和最终状态观察。
- 新增按设备持久复用的 Hypium UiTest RPC 驱动，支持稳定选择器、关系定位、歧义拒绝和显式索引；输入正文、租约令牌与截图字节不会写入自动化摘要。

### 优化

- Harmony 自动化改为同设备严格串行、多设备并行；UI 树是模型默认观察结果，仅在确实需要视觉判断时附带截图。现有投屏、录屏、截图和 HDC 文件链路保持不变。
- Hypium 无法建立连接时，对尚未发生写操作的请求安全降级到现有 HDC/UiTest；已发出的 RPC 失败不会盲目重放，避免重复点击或重复输入。
- 打包流程现在携带并验证 Hypium 的完整生产依赖、原生 UiTest agent 与受审查的 `xmldom` 安全覆盖，同时强制关闭第三方遥测。

### 修复

- 修复 HDC verbose 无设备输出 `[Empty] hdc` 被误识别为在线设备的问题。
- 修复设备操作取消后队列 lane 残留、共享设备发现被单个调用方取消，以及异常场景参数可能在部分设备写入后才失败的问题。

## [0.4.40-beta.3] - 2026-09-01

### 新增

- 新增正式与内测两种桌面更新身份。首次运行内测安装包会在本机永久保留内测身份，可同时接收正式版和 beta 内测版；首次运行正式版则只接收正式更新，覆盖安装不会静默改变身份。
- 内测发布现在同时提供 Windows 安装版、便携版、差分更新文件和 `beta.yml` 更新元数据，安装版支持选择安装目录。

### 优化

- 将随身舱整体重构为更克制的 Codex 风格，移除暖色渐变、厚重阴影和胶囊式导航，统一为中性色、细分隔线和紧凑层级。
- 将 JSON 工具的创建文件区改为编辑器式标签栏，简化锁定、新建、操作栏和编辑器状态的视觉表达。
- 仅为内测身份在桌面标题栏显示“内测版”标识，正式身份不显示额外版本标签。

### 修复

- 修复鸿蒙 Agent 长任务中因截图引用过期导致点击持续报 `snapshot no longer current` 的问题；动作执行前会用实时 UI 树重新验证目标。
- 修复桌宠自主移动时气泡读取到上一帧原生窗口坐标而横向拖尾的问题，宠物与气泡现在共享同一帧计划坐标。
- 修复鼠标悬停在桌宠上时自主移动仍会继续或重新启动的问题。

## [0.4.39] - 2026-09-01

### 新增

- 新增 5 套原创二次元一键风格，覆盖青空校园、樱海列车、星法图书馆、雨夜霓虹与星舰机库；同时支持把用户自己的本地背景、主题配色和透明度参数保存为自定义一键风格。
- 新增会话标记未读与跨项目移动、桌面端开机自启动、随身舱资料架 JSON 工具，以及可配置的随身舱本地数据存储路径。
- 新增会话输出自动跟随开关：默认持续显示最新输出，用户手动滚动后暂停，点击一键到底即可恢复跟随。

### 优化

- 重新设计快捷键设置页，并统一项目菜单、模型选择器、项目新建入口、会话滚动条和新对话布局的交互与视觉细节。
- 项目文件夹菜单改为悬浮显示；随身舱最大化后保持可见，手动关闭或再次使用快捷键后恢复失焦自动隐藏。
- 桌宠点击与拖动区域会按当前动画帧的实际非透明轮廓自适应，切换不同体型的内置或自定义宠物时不再沿用固定矩形。
- 离线语音包始终提供手动下载与拖放导入入口，并为 `model.int8.onnx` 校验失败提供更明确的文件、版本和摘要诊断。
- 随身舱会直接显示笔记、命令、待办、资料、记忆和心智数据的实际文件路径，并在切换目录前复制校验现有数据。

### 修复

- 修复超大自定义背景直接参与全屏渲染时可能导致界面消失的问题；高分辨率图片会在本地自动优化到安全渲染尺寸。
- 修复鸿蒙截图与录屏保存路径因配置接口误判缺省字段而无法持久化的问题，并将路径修改开关移到输入项上方。
- 修复浏览器面板恢复尺寸、终端运行按钮、随身舱模型状态同步、新对话输入框对齐和主会话滚动跟随等问题。
- 移除桌宠在每轮会话结束后重复显示的“已准备好接收下一条消息”提示。

## [0.4.38] - 2026-09-01

### 新增

- 新增首次使用引导，从配置模型、创建项目到发送第一条消息逐步完成初始设置，并保持与现有界面一致的视觉风格。
- 新增应用网络代理设置，支持系统代理、手动代理和直连模式；离线语音包始终提供手动下载入口，并支持选择目录或直接拖放导入。
- 新增随身舱全局呼出快捷键，默认可用 `Ctrl+Space` 切换显示，点击其他区域后自动隐藏。
- 桌宠自主移动升级为带屏幕边界保护的二维轨迹，支持任意角度直线、竖向、斜向、弧线和椭圆绕圈。

### 优化

- Harmony 设备观察与 Agent 执行状态解耦，任务运行期间仍可持续查看手机画面；视频流不可用时会自动降级为可中断的低延迟截图观察。
- 改进系统提示词模板的编辑、选择和管理界面，增强模板信息展示与交互反馈。

### 修复

- 修复桌宠升级后点击识别范围过大、拖动向右下角漂移以及边缘运动容易退化为横向移动的问题。
- 修复随身舱已保存互动模型后部分页面仍显示未配置的问题，并改善模型状态的跨窗口同步。
- 修复语音包在受限网络中下载失败后缺少备用导入路径的问题。

## [0.4.37] - 2026-09-01

### 新增

- 新增独立持久工作区终端，命令不再依赖聊天任务状态，支持连续输出并保留 `cd` 与环境变量变化。
- 新增 Kitty 糖果屋与云朵小熊工坊两套原创卡通一键风格，内置背景总数增至 32 套。

### 修复

- 修复原生浏览器最大化后恢复时页面层仍停留在旧尺寸的问题，尺寸更新会串行合并并在布局动画结束后最终校准。
- 修复随身舱“心智”已保存互动模型，但主页面和宠物设置仍显示未配置的问题。

## [0.4.36] - 2026-09-01

### 优化

- 将新增的 10 套内置背景补充为完整的一键风格，点击后会同步应用主题配色、背景遮罩、模糊度以及项目侧栏和文件面板透明度。

## [0.4.35] - 2026-09-01

### 修复

- 修复桌宠番茄钟气泡页面在正式打包预渲染时缺少语言上下文、导致 Linux 和 Windows 桌面包无法生成的问题。

## [0.4.34] - 2026-09-01

### 新增

- 新增可复用的系统提示词模板库；新建对话和已有对话均可独立选择模板，选择结果以快照保存，后续修改模板不会影响历史对话。
- 新增 10 套内置背景，覆盖超现实、Riso 印刷、液态铬、软陶、量子科技、白色未来、青玉修仙、赤月剑境、月华人物和高山镜湖风格；内置背景总数增至 30 套。
- 新增跨会话全文搜索、可自定义应用快捷键，以及一条命令同时启动 Web 与桌面端的开发模式。

### 优化

- 将 Goal 和 Plan 从核心提示模式中移除，改为默认关闭、可在扩展设置中按需启用的第一方扩展。
- 改进本地语音包后台安装生命周期、桌宠番茄钟显示与跨窗口运行状态，并增强独立桌面包的资源分层和发布校验。

### 修复

- 修复审阅视图和对话文件变更卡片中超长代码被右侧遮挡的问题，现在可稳定横向滚动查看完整内容。
- 修复桌宠气泡字号未随界面缩放、开发桌面端认证传输以及快捷键菜单同步等问题。

## [0.4.33] - 2026-08-31

### 优化

- 桌宠窗口改用跨窗口状态广播与可见时短轮询，避免多个长期连接占满浏览器连接池；宠物状态请求也增加明确超时，异常时不再无限锁住随身舱。
- 清理桌面包中被错误追踪的 Git 历史、开发缓存和旧发布产物，将打包运行资源从约 2 GB 缩减到约 270 MB。

### 修复

- 修复随身舱按钮无响应、互动模型无法保存以及番茄钟点击开始后不计时的问题。
- 修复正式桌面包无法从 ASAR 运行时加载内置宠物资源的问题，同时保留用户导入宠物的路径与竞态安全校验。

## [0.4.32] - 2026-08-31

### 新增

- 桌宠图库新增 Azure、柯基侦察员、狐狸、Patchi、企鹅、猫头鹰教授、兔子和 Shadow Kit 等内置精灵包，并为所有内置桌宠补充打包清单、来源与许可证校验。

### 优化

- 重新设计桌宠设置与随身舱交互：精灵预览会播放真实待机动画，导入区域支持拖放，任务、资料和记忆输入拥有独立草稿与更明确的保存状态。
- 重构 Git 审阅和命令工作区，使用聚焦式文件导航、按需差异加载、终端式输出与搜索，并改善键盘操作和窄面板布局。
- 系统性拆分首屏依赖：Markdown、原生 HTML、KaTeX、代码高亮语言、模型图标、非默认语言包和次级工作区按需加载，减少应用启动时的脚本解析与无效渲染。

### 修复

- 修复桌宠任务、记忆和资料输入可能共用草稿或在保存失败后提前清空的问题，并确保性格编辑使用最新状态持久化。
- 修复大规模 Git 变更审阅时同时加载多份差异造成的额外内存和渲染开销。

## [0.4.31] - 2026-08-30

### 新增

- 离线语音包改由 Piora 的 GitHub Release 分发，模型与词表使用固定版本和 SHA-256 校验，降低 Hugging Face 在部分网络与 Windows 代理环境下的下载失败率。
- 能力包导入导出补充取消操作、边界校验与回归测试，让大体积能力包的预览和安装流程更可控。

### 优化

- 重构新建会话首页为统一启动器：项目、模型、推荐任务和真实输入框在同一条发送链路中协作，并完善窄屏项目选择、空模型恢复及项目切换状态重置。
- 分离对话宽度调节与历史滚动控制条，避免可选文字、调宽热区和滚动交互互相干扰。
- 优化桌宠随身舱的任务状态、番茄专注反馈和运行时同步，并增强鸿蒙设备实时画面的恢复与轮询稳定性。

### 修复

- 修复首次发送消息前可能重复重置模型的问题。
- 修复外观设置变化后设置页背景未及时同步的问题。
- 修复鸿蒙设备断连、实时画面超时及 HDC 命令输出处理中的若干边界问题。

## [0.4.30] - 2026-08-30

### 新增

- 新增“能力包”导入导出：可将扩展、插件、技能及其启用状态打包为 `.piora-bundle`，在另一台 Piora 中预览后合并安装；本地能力会携带源码，在线来源保留可重装信息。
- 新增本地语音包管理与离线转写设置，支持下载、校验、选择和清理语音模型，并针对不同设备选择合适的本地运行策略。
- 鸿蒙工作区新增截图与录屏保存位置、视频录制、媒体产物管理和完整的 Windows x64 HDC/录屏运行时，可在打包版中直接使用。
- 桌宠新增番茄专注计时、任务记录、自动捕获完成事项和更自然的桌面漫游；随身舱可查看真实工作节奏与近期任务成果。
- 设置中新增本地使用统计，按天汇总 Token、工作时长、连续活跃天数和高峰记录，不保存聊天正文。

### 优化

- 浏览器能力改为由桌面主进程托管持久会话，并通过受限 RPC 与网页端协作，改进书签导入、浏览状态恢复及打包环境稳定性。
- 模型目录加载增加扩展发现超时和核心模型回退，单个扩展启动异常不再长期阻塞模型选择。
- 优化会话切换、历史预取、后台任务状态同步和完成通知，减少重复请求、陈旧事件回写及大列表渲染开销。
- 统一设置页、新建会话页、项目侧栏、插件页、外观与桌面更新界面的视觉层级、键盘操作和窄屏布局。
- 扩充鸿蒙设备队列、实时画面、UI 引用失效、日志与录屏流程的边界处理，并将产物统一保存到用户配置的目录。

### 安全

- 能力包导出会排除凭据库、环境文件、私钥、Git 历史、`node_modules` 和本地缓存；导入会校验 ZIP 路径、体积、来源、跨站请求及嵌入式凭据。
- 桌面浏览器、语音包、鸿蒙媒体与远程接口继续使用同源令牌、路径白名单、固定参数数组、内容上限和校验和约束。

### 修复

- 修复外观背景、桌面窗口状态和设置页在跨窗口或延迟更新后可能不同步的问题。
- 修复本地模型发现、语音录制、鸿蒙设备离线、录屏下载和浏览器视图重建中的多处超时、竞争与恢复问题。
- 修复桌面便携版快捷方式、更新提示、托盘启动和打包依赖在部分 Windows 环境下不稳定的问题。

## [0.4.29] - 2026-08-29

### 新增

- 新增按 Session 管理工具的界面。旧 Session 和新 Session 默认启用全部已注册工具，可在输入框旁逐项关闭，并随时重新开启；工具选择会随 Session 持久保存，复制或派生会话时一并继承。
- 浏览器与鸿蒙设备工作区现在会显示当前 Session 对对应工具的访问状态，部分启用和全部关闭都有明确提示。

### 优化

- 对话内容宽度支持从左右两侧拖动调整，并在新会话、历史消息、提示通知和输入区之间保持一致。
- 优化新会话启动界面、宽表格横向浏览和会话切换时的布局稳定性。

### 修复

- 修复旧 Session 缺少工具配置时可能套用限制性预设的问题；现在会兼容迁移旧版分组配置，并默认保留全部工具能力。
- 修复快速切换会话时旧请求和延迟事件可能覆盖当前会话状态的问题。

## [0.4.28] - 2026-08-29

### 新增

- 左侧项目会话、无项目聊天和分支子会话支持按住鼠标左键后拖动排序，并显示拖动前后的插入位置。

### 优化

- 会话排序在本地持久保存，刷新页面或重启 Piora 后仍保持；新会话自动追加，已失效会话自动从保存顺序中清理。
- 拖动只调整同一项目、同一分支层级以及相同置顶状态内的显示顺序，不改变项目归属、父子关系或会话文件内容。

### 修复

- 修复会话排序接入后，Linux 发布门禁仍检查旧版未排序会话树调用而导致打包提前终止的问题。

## [0.4.27] - 2026-08-29

> 此版本标签的 Linux 源码门禁未通过，未生成正式 Release；请使用 v0.4.28。

### 新增

- 左侧项目会话、无项目聊天和分支子会话现在都支持按住鼠标左键后拖动排序；拖动前后会显示清晰的插入位置提示。

### 优化

- 会话排序会在本地持久保存，刷新页面或重启 Piora 后仍保持；新会话会自动追加且失效会话会从已保存顺序中清理。
- 拖动仅调整同一项目、同一分支层级内的显示顺序，不会改变会话所属项目、父子关系或会话文件内容；短按、右键菜单、重命名和删除等原有操作保持不变。

## [0.4.26] - 2026-08-29

### 新增

- 桌宠重构为三个互不干扰的桌面界面：固定透明命中区的宠物窗口、鼠标穿透的独立提示气泡，以及可长期停靠的“Piora 随身舱”。双击桌宠或使用右键菜单即可打开随身舱。
- 随身舱新增“现在、任务、资料、记忆、心智”五个工作区，可查看桌宠刚才的判断、模型引用的事实、下次观察时间、正在运行的 Piora 任务与个人待办进度。
- 资料架支持保存和复制笔记、代码、命令，或导入本地图片；个人记忆可由用户明确添加并随时删除。
- 心智设置支持选择互动模型、调整性格与自主程度、暂停自主观察，以及控制工作上下文、主动发言和桌面移动权限。

### 优化

- 点击、双击、任务开始/完成/失败和定时唤醒统一进入模型决策接口；模型返回受约束的情绪、展示摘要、气泡文字、动作列表和下次唤醒时间，不再依赖预制台词。
- 桌宠状态改为服务端版本化持久化，并提供跨窗口事件流；旧版浏览器本地任务、资料与模型选择会在首次使用时平滑迁移。
- 模型只接收经过字段白名单处理的任务标题、状态、进度、工作时长和 Token 汇总；内部思维链不会保存或展示，任务文字和记忆始终按不可信数据处理。
- 主进程增加桌宠动作限频、屏幕工作区边界、安静时段与主动行为策略；气泡窗口始终鼠标穿透，桌宠窗口的透明区域也会动态穿透到下层应用。

### 修复

- 修复全局按钮悬浮样式在透明桌宠上叠加矩形底纹、内阴影和按压缩放的问题。
- 修复任务气泡扩大桌宠原生窗口后，透明区域仍拦截鼠标并影响其他桌面应用的问题。
- 修复桌宠反复点击只轮换少量固定文字、无法结合当前任务、休息时长、完成量与 Token 使用情况生成新互动的问题。
- 扩展主对话推理折叠兼容：除 DeepSeek/OpenRouter 字段和显式标签外，也识别 Gemini thought、OpenAI reasoning summary、camelCase 兼容字段及带 analysis/reasoning channel 的网关消息。

## [0.4.25] - 2026-08-28

### 新增

- 新聊天首页增加三步使用引导：描述目标、按需选择项目、发送后持续跟进。
- Pi 运行时升级为 0.84.3，并将 Pi 相关依赖统一锁定为同一版本；Dependabot 每日检查并合并呈现 Pi 更新，便于及时评估兼容性。
- 桌宠设置新增独立的互动模型选择和工作上下文授权；每次点击都会根据正在运行的任务、计划步骤进度、连续工作时长、完成/失败数量与 Token 汇总实时生成新的提示语。
- 桌宠升级为个人工作台：个人任务支持项目归属、完成状态和百分比进度，资料库支持保存、搜索、置顶和复制笔记、代码、命令与本地图片。

### 优化

- 桌面启动页改为支持明暗模式的极光玻璃视觉，并根据系统语言显示中文或英文启动文案。
- 未选择项目时直接进入独立聊天工作区；选择项目后再进入对应项目会话。
- 独立桌宠会同时展示 Agent 任务和未完成的个人任务，并显示结构化计划的步骤进度；工作节奏只统计 Piora 内活动，不监视其他应用。
- 桌宠模型请求采用服务端字段白名单，只允许发送有界的任务标题、状态、进度、工作时长与统计数字，不发送聊天正文、文件内容、图片或资料库内容。

### 修复

- 模型目录加载失败会显示可操作的错误信息，支持强制重新加载和快速打开模型设置；部分模型可用时不再被单个异常配置阻断。
- 兼容 DeepSeek、OpenAI、OpenRouter、Gemini 及常见兼容网关的推理字段和显式思考标签，避免思考内容误显示为正式回答。
- 修复 Pi 0.84.3 主题构造变化导致的会话接口启动失败，并增加运行时兼容回归测试。
- 移除桌宠全部预制互动台词，修复反复点击只能出现固定几句话的问题；未配置模型、模型调用失败和空响应现在都有明确提示。
- 移除浏览器停靠宠物和独立桌宠在悬浮、点击时出现的背景底纹、内阴影与黑色投影，保留透明命中区域和键盘焦点提示。

## [0.4.24] - 2026-08-28

### Changed

- Rebuilt desktop-pet movement around the native Electron window: pets now
  wander within the active monitor, can be dragged directly without losing
  click-to-poke reactions, face their travel direction, and respond to task
  starts, completions, failures, approvals, thinking, tools, commands, retries,
  and compaction through a shared Agent-state presentation layer.
- Anchored the sprite in a dedicated transparent stage so task bubbles and
  controls no longer shift or obscure the pet image.

### Removed

- Removed the companion care loop entirely, including feeding, water, affection
  levels, real-time decay, nagging speech, controls, translations, and persisted
  timestamps. Existing v1/v2 preferences migrate without losing todos, quick
  phrases, the selected pet, or idle behavior settings.

### Fixed

- Prevented the Next.js development indicator and first-paint wallpaper from
  appearing as unexplained background artifacts in the frameless pet window.

## [0.4.23] - 2026-08-28

### Fixed

- Kept the standalone website TypeScript project outside the desktop app's
  root typecheck so clean release runners no longer require website-only build
  dependencies while packaging Piora.

## [0.4.22] - 2026-08-28

### Added

- Companion pets gained a Codex-style interaction layer: random idle tricks
  while nothing is running, click-to-poke reactions with localized speech
  bubbles, milestone lines for task starts/completions/failures, and a
  lightweight care loop (feed, water, pet) whose needs decay in real time and
  nag gently from the desktop pet window. Preferences migrate to schema v2
  keeping existing todos and phrases, and the sidebar dock pet supports poking
  too. A new "Idle tricks and chatter" setting toggles the ambient behavior.
- Added a complete product website with capability guides, quick-start recipes,
  machine-readable discovery files, responsive download cards, and official
  GitHub release fallbacks.
- The visual-agent settings now include a real image connectivity test against
  the selected model and current workspace configuration.
- Pending native user-input cards can raise privacy-safe desktop notifications,
  and select questions now accept a bounded custom “Other” answer.

### Changed

- Simplified custom-channel settings by keeping the common provider and image
  fields visible while moving compatibility, reasoning, token-window, and cost
  controls into an optional advanced section.
- New conversations remain unselectable until an explicit model is chosen, and
  compaction progress now uses a quiet status row with a dedicated stop action.

### Fixed

- Visual sidecar requests now reuse the active session model registry and its
  exact workspace, authentication, custom-provider proxy, headers, and extension
  overlays. Project-scoped or proxied vision models previously appeared valid
  in the main session but could be bypassed or unavailable to the sidecar.
- The image-input toggle in Settings > Models can now force a catalog model
  that declares image support to be treated as text-only. Unchecking a model
  whose endpoint cannot actually accept images previously snapped back to the
  catalog default, which permanently locked the visual agent out of handling
  its images; the visual-agent settings panel now explains this override.
- Custom OpenAI-completions models expose compat overrides (reasoning_effort,
  store, max-tokens field) in the model editor, document how the declared
  context window drives both the per-request reply cap and the auto-compaction
  threshold, and failed auto-compaction errors now include recovery guidance.
  Strict local endpoints that rejected summarization requests previously left
  every auto-compaction attempt silently unsuccessful, so replies kept getting
  truncated by the shrinking per-request output cap.
- Room-shared replies are now authorized against the exact active Room dispatch,
  preventing a direct Session prompt from writing into shared Room history.
- Session creation now reports stable client/retry errors, cleans up failed
  post-start runtimes, and retries only explicitly transient startup failures.

## [0.4.21] - 2026-08-27

### Fixed

- Explicitly included the scheduled-task recurrence runtime and its helpers in
  packaged standalone builds so the first-party automation extension loads on
  both Windows and Linux.

## [0.4.20] - 2026-08-27

### Added

- Added a first-party structured user-input tool that lets models request
  single-choice, multiple-choice, and free-form answers in a native in-chat
  card, with submitted answers persisted in conversation history.
- Added an in-app desktop update dialog that shows the version's release notes,
  download percentage, transferred and total size, and current download speed.

### Changed

- Replaced the title-bar update text badge with a compact Codex-style download
  icon and changed the completed-update action to “Install and restart”.
- New-chat landing pages now explain projectless conversations more clearly and
  require an explicit model selection instead of silently using an automatic
  model choice.
- Room timeline navigation now indexes user prompts only, keeping agent and
  system messages out of the compact jump list.
- Kept project and projectless-chat sections transparent over custom sidebar
  backgrounds for a consistent appearance.

### Fixed

- GitHub releases now publish the matching CHANGELOG section as their release
  notes, allowing installed clients to show exactly what changed before an
  update is installed.

## [0.4.19] - 2026-08-27

### Added

- Added projectless chats backed by a managed Piora workspace, with a dedicated
  fixed Chat section in the sidebar and model selection before starting a
  conversation without choosing a project.
- Added a full-screen image viewer for images in current and historical chat
  messages, including keyboard and accessible close controls.

### Changed

- Raised individual and per-message image limits to 100 MB and raised attached
  text-material limits to 100 MB with matching client and server validation.
- Refined Codex-style new-chat controls across the primary navigation, project
  rows, and scheduled-task editor.
- Made Piora's native scheduled-task runtime explicit to models and preferred
  for reminders, monitors, follow-ups, and recurring work while retaining
  operating-system schedulers for explicitly system-level requests.

### Fixed

- Kept text-plus-image and image-only user messages visible when delivery
  fails, including their image previews and retryable failure state.
- Restored scheduled-task cards from canonical tool results so native tasks
  consistently appear in conversation history without duplicate messages.

## [0.4.18] - 2026-08-27

### Added

- Added persistent scheduled tasks with RRULE and timezone-aware recurrence,
  pause/resume, run-now controls, missed-run recovery, bounded execution history,
  and configurable desktop completion notifications.
- Added chat-scoped heartbeat tasks that continue an existing conversation and
  project-scoped tasks that create a new conversation for each run.
- Added a first-party automation tool so agents can create and manage tasks when
  users explicitly request reminders, monitors, or recurring work.
- Added Codex-style scheduled-task cards in conversations plus a complete
  Settings page and right-side task editor for creating, opening, editing,
  deleting, and inspecting runs.

## [0.4.17] - 2026-08-26

### Fixed

- Avoided reselecting an unchanged credential-less placeholder model while
  restoring a session, allowing packaged Windows and Linux smoke verification
  to complete without an invalid API-key lookup.

## [0.4.16] - 2026-08-26

### Fixed

- Run the Windows drive-root migration preflight test only on Windows, avoiding
  an invalid write-permission check against the Linux filesystem root in CI.

## [0.4.15] - 2026-08-26

### Fixed

- Made image-input capability an explicit per-model setting for both custom
  and managed channels. The selected capability now drives direct image
  delivery, visual-agent model selection, and SDK session startup.
- Restored qwen-token-plan-cn models to the visual-agent discovery path by
  using the same configured model services as the app runtime.
- Keep locally submitted text and image messages visible when delivery fails,
  with an actionable in-chat failure status instead of silently removing them.

### Changed

- Clarified the model settings flow so channel connection, model capability,
  connection testing, and visual-agent selection are easier to configure.

## [0.4.14] - 2026-08-26

### Added

- Added a configurable visual-agent sidecar: text-only primary models can now
  use a selected, authenticated image-capable model to understand attached
  images without changing the conversation's primary model.
- Added dynamic model-capability routing in Settings → Models → Visual Agent.
  Models that declare image input receive original images directly; only
  text-only models invoke the configured visual sidecar.

### Fixed

- Preserved image safety and privacy across current and historical context:
  original images remain local in the session, while text-only models receive
  bounded, cached visual observations or an explicit no-guess fallback.
- Improved data-directory migration diagnostics and Windows drive-root
  handling, so preflight failures remain actionable and existing target drives
  do not fail directory creation.

### Changed

- Refined settings cards for system prompts, title generation, and prompt
  optimization to make model and instruction fields easier to understand.

## [0.4.13] - 2026-08-26

### Fixed

- Normalized packaged ASAR entry paths before checking the Windows updater
  runtime, so the release source gate verifies the same archive correctly on
  both Windows and Linux runners.

## [0.4.12] - 2026-08-26

### Added

- Added an assisted Windows installer with a selectable installation directory,
  Desktop and Start Menu shortcuts, and persistent user data outside the
  installation directory.
- Added stable GitHub Release update checks for installed Windows builds. The
  Help title-bar menu advertises an available version, shows download progress,
  and offers an explicit safe restart and installation action.
- Added release verification for `latest.yml`, installer SHA-512 metadata,
  blockmaps, silent NSIS installation, and startup of the installed runtime.

## [0.4.11] - 2026-08-26

### Fixed

- Validated migration destinations and permissions before stopping the local
  runtime, so deterministic failures remain visible in Settings instead of
  reloading the conversation page.
- Kept the existing Settings renderer alive when migration recovery restarts
  the service on the same origin, preserving the actionable error message.
- Warned when a newly downloaded portable release updates the Desktop shortcut
  but an older Piora instance is still resident in the system tray.
- Added persistence coverage proving a migrated Pi directory survives later
  desktop window and server-port state updates.

## [0.4.10] - 2026-08-26

### Changed

- Accelerated conversation switching with immediate hover/pointer prefetch,
  a bounded version-aware client cache, coalesced server projections for
  unchanged session files, and lazy materialization of only visible history.

### Fixed

- Updated General settings with the migrated Pi data directory as soon as the
  verified migration succeeds, while preserving that path after restart.
- Invalidated prefetched history whenever a session becomes active so cached
  switching cannot hide newly streamed messages.

## [0.4.9] - 2026-08-26

### Changed

- Made Pi data-directory migration an explicit, disabled-by-default setting,
  preserving the current directory unless the user opts in and confirms the
  destination before restart.
- Extended migration to cover first-party extension data under the configured
  `PI_CODING_AGENT_DIR`, with staged copy verification, source stability checks,
  atomic activation, and the original directory retained as a backup.

### Fixed

- Resolved relative file paths from conversation change cards against the
  originating session workspace, preventing valid file jumps from failing with
  `Access denied`.

## [0.4.8] - 2026-08-25

### Added

- Added a desktop setting for moving Pi's complete data directory, with an
  optional safe copy of existing sessions and configuration before restart.
- Added a persistent pin control to the group-chat message navigator.

### Changed

- Reduced perceived session-switch latency by prefetching a hovered session
  after a short debounce and consuming only version-matched responses.

### Fixed

- Refreshed newly saved custom models into the visible provider scope and added
  a connection test action while a new model is still being configured.

## [0.4.7] - 2026-08-25

### Added

- Added collapsed per-file change cards to the main conversation, including
  running/completed state, added and removed line totals, and expandable inline
  diffs for edit and write operations.
- Added local conversation preferences for choosing Enter or Ctrl+Enter as the
  send shortcut and for optionally sending running-task messages directly with
  a default Steer or Queue action.

## [0.4.6] - 2026-08-25

### Fixed

- Gave the Linux packaged-runtime smoke test a bounded 30-second cold-start
  budget, accounting for its measured 9.5-second service bootstrap before the
  renderer marker while retaining the stricter Windows and cached-launch gates.

## [0.4.5] - 2026-08-25

### Fixed

- Forwarded the narrowly scoped Xvfb display contract into the isolated Linux
  AppImage smoke-test process, while continuing to strip credentials, proxies,
  host npm state, and unrelated session-bus variables.

## [0.4.4] - 2026-08-25

### Fixed

- Made packaged-runtime verification use the Linux Piora executable and PNG tray
  icon, so the AppImage runtime is tested through Electron's ASAR-aware Node mode
  instead of an incompatible host Node process.

## [0.4.3] - 2026-08-25

### Fixed

- Fixed Linux AppImage generation for the scoped desktop workspace by assigning
  a portable-safe executable name, stable desktop identity, and deterministic
  `linux-x64` artifact filename.

## [0.4.2] - 2026-08-25

### Added

- Added a Linux x64 AppImage to the stable release pipeline, including packaged
  runtime smoke tests and a shared SHA-256 manifest with the Windows artifacts.
- Added a persistent pin/unpin control to the right-side conversation timeline.

### Changed

- Replaced structural outline boxes with floating surfaces across the main,
  settings, Room, and workspace panels, and let active wallpapers remain visible
  through both the project sidebar and the file/review area.
- Reduced the new-conversation screen to the project picker and composer, removing
  the obsolete Piora/model-configuration guide and redundant dropdown arrow.

### Fixed

- Made managed Room Agent creation atomic and resilient when a selected folder is
  not a Git repository or has no `HEAD`, falling back to the shared workspace
  instead of failing with `could not reset index file to revision HEAD`.
- Persisted newly provisioned Agent sessions before their first reply and restored
  their exact Team tool/model policy after a server restart.
- Corrected Team scheduling so reviewer Agents can own ordinary tasks without
  incorrectly entering a second review cycle, while review-required work still
  passes through independent approval and final coordinator synthesis.

## [0.4.1] - 2026-08-25

### Added

- Added explicit Harmony phone tools for observing the screen, tapping,
  double-tapping, long-pressing, swiping, flinging, dragging, entering text,
  pressing navigation keys, launching apps, waiting for UI state, and reading
  structured or raw device logs.

### Changed

- Improved Team orchestration for large prompts with durable prompt materials,
  clearer composer flows, and more reliable Room message routing.
- Turned Harmony automation into an observe-act-verify Phone Operator loop that
  automatically returns fresh UI references and semantic changes after each
  state-changing action.
- Prioritized real Harmony product names and certified hardware models in the
  device selector while keeping user-defined device nicknames as supplemental
  labels.

### Fixed

- Fixed Harmony live-view polling competing with foreground device actions,
  incorrect hilog arguments and false-success HDC responses, incomplete UiTest
  tree parsing, stale semantic taps, and actions silently reporting success
  without checking the resulting UI.
- Updated model-configuration guidance to the current Settings → Models path,
  simplified the new-conversation project picker, and removed persistent fill
  backgrounds from project headings and selectors. Active wallpapers now also
  continue through the project and file areas without stacked opaque washes.
- Added a task-row pin/unpin control that stays visible for pinned conversations
  and returns to the right-edge hover actions after unpinning.

## [0.4.0] - 2026-08-24

### Changed

- Flatten Chrome bookmark imports so the contents of each Chrome bookmarks bar
  appear directly in Piora, without profile or bookmarks-bar wrapper folders.
- Make the global system prompt editable from the conversation controls and
  settings, then reload every idle Session immediately and every busy Session
  as soon as its active task finishes.
- Promote the verified `v*` release pipeline from preview publishing to stable
  GitHub Releases, with the newest successful release marked as latest.

### Fixed

- Keep the model submenu attached to its parent menu, align every provider icon
  with its model name, and truncate long model ids without compressing labels.
- Open a project-bound new conversation immediately after the native folder
  picker validates a newly selected project directory.

## [0.3.9] - 2026-08-24

### Added

- Added Chrome bookmark import to the built-in browser, preserving the complete
  bookmark folder hierarchy in its bookmark bar and folder browser.

### Changed

- Reworked the new-conversation guidance around configuring a model first and
  then opening a project folder, and removed the unsupported local/cloud label.
- Simplified the Projects sidebar by removing its redundant task search field
  and keeping unselected project rows visually transparent.

### Fixed

- Kept the composer model selector inside the visible viewport and removed the
  misleading help cursor from MCP tool status.
- Restored the intended onboarding and browser bookmark experience after
  concurrent interface work had overwritten parts of those changes.

## [0.3.8] - 2026-08-24

### Fixed

- Fixed packaged Plan Mode and Agent Team runs failing because first-party
  extensions could not resolve newly added runtime support modules from
  `runtime.asar`.
- Strengthened packaged-app verification to fail the release when any
  first-party extension reports a load diagnostic or any core Piora tool is
  missing or inactive.

## [0.3.7] - 2026-08-24

### Fixed

- Prevented the built-in browser's download-directory setup from aborting
  desktop startup when Windows does not expose a shell Downloads folder; Piora
  now falls back to an app-owned Downloads directory.

## [0.3.6] - 2026-08-23

### Added

- Added a production Agent Team runtime with durable plans, dependency-aware
  scheduling, bounded retries, evidence and artifact tracking, independent
  review, recovery after interruption, and authenticated Room APIs and events.
- Added first-class Team progress, questions, approvals, and final results to
  Room chat, plus a floating activity card, a complete message navigator, and
  one-click navigation to the latest message.
- Added AI-assisted editing for team descriptions, Agent responsibilities,
  prompts, constraints, and collaboration conventions, with a separately
  configurable optimization model.

### Changed

- Publish verified release artifacts as public GitHub prereleases immediately
  instead of leaving each version in a maintainer-only draft state.
- Simplified Team setup and goal submission, defaulted the interface and
  optimization instructions to Simplified Chinese, and aligned icons, buttons,
  hover feedback, activity controls, and status surfaces with the Codex visual
  language.
- Reused the normal Target execution path for approved Team plans, while
  automatically starting user-authored plans without an extra approval step.

### Fixed

- Fixed silent Room submissions, missing user-question prompts, non-responsive
  resume controls, capability mismatch dead ends, stale hot-reload coordinator
  instances, and legacy English error messages.
- Fixed long-conversation navigation, misleading status icons, inaccessible
  progress placement, and forms that previously required unexplained manual
  detail before a Team could start.

## [0.3.5] - 2026-08-22

### Fixed

- Regenerated the deterministic third-party license inventory after the
  application version update so the release source gate can complete.

## [0.3.4] - 2026-08-22

### Added

- Added a dedicated model preference for automatic Session title generation,
  including safe cancellation while a title request is in progress.
- Added a native Windows folder chooser for selecting a new-conversation
  project in the packaged desktop application.

### Changed

- Redesigned the new-conversation landing screen, composer model and reasoning
  controls, extension status indicator, and common action buttons around a
  quieter Codex-inspired visual language.
- Moved MCP and extension runtime status into a compact composer control instead
  of reserving a full-width bar below the input.

### Fixed

- Kept the model menu anchored above the composer on both desktop and narrow
  layouts, with no unsupported speed setting.
- Prevented background Session refreshes from leaving the Projects area in a
  permanent loading state when Rooms and Projects are both present.

## [0.3.3] - 2026-08-22

### Added

- Added runtime MCP Server and cached tool-capability discovery to the
  `pi-mcp-adapter` plugin details view without exposing credentials or tool
  input schemas.
- Added real idle-frame thumbnails for installed and locally discovered
  companion pets.
- Added an introductory comparison of Pi extensions, skills, and plugins to
  each capability settings page.

### Changed

- Redesigned plugin package details and resource cards to separate packaged
  resources from runtime MCP capabilities.
- Extended the validated companion-pet spritesheet route so local Codex pets
  can be previewed safely before import.

### Fixed

- Removed the modal-backdrop styling that incorrectly rendered plugin resource
  groups as large gray blocks.

## [0.3.2] - 2026-08-22

### Added

- Added remote HTTP APIs for creating Sessions, discovering core capabilities,
  reading Session history, and listing the tools available to a Session.
- Added archived-conversation management directly in Settings.
- Added configurable automatic Session naming with a dedicated title prompt.

### Changed

- Redesigned the Windows application menu and Settings workspace around a
  compact four-menu desktop layout and grouped, capability-aware navigation.
- Made the bundled Browser and Harmony integrations discoverable in packaged
  builds without making their successful startup a hard Session requirement.
- Expanded remote-control capability metadata and packaged-runtime verification
  for third-party HTTP extensions.

### Fixed

- Improved task-list density, status rendering, and Session title consistency.
- Kept packaged runtime extension and server startup behavior aligned with the
  development environment.

## [0.3.1] - 2026-08-21

### Added

- Added an explicit project picker for new conversations, including project
  search and a system-folder chooser instead of silently inheriting the active
  Session's project.
- Added Room mention completion for manually typed `@`, keyboard selection,
  immediate Agent processing presence, and automatic reply projection back
  into the shared conversation.
- Added persistent pin indicators to pinned Sessions.
- Windows portable and ZIP-extracted releases now create a `Piora` Desktop
  shortcut on launch. Later versions advance the shortcut target, older
  versions cannot downgrade it, and missing targets are repaired to the newest
  available version that the user launches.

### Changed

- Room creation now supports cross-project Session selection with grouped
  project labels and a fixed action footer that remains reachable for long
  Session lists.
- Room shared workspace paths can be edited or selected from the desktop folder
  chooser and may live within any member Session's project.
- Browser and Harmony extensions now advertise their exact built-in tool names
  and invocation shapes to every compatible Agent prompt.
- Redesigned the new-conversation landing screen around the composer, with an
  anchored searchable project menu and draft handoff after project selection.

### Fixed

- Conversation chrome and Room workspaces now preserve the configured artwork
  instead of covering it with opaque white surfaces.
- Removed the inactive sidebar-header search button while retaining functional
  Session search.
- Room replies now remain correlated with the addressed message and are shown
  in the Room even when an Agent omits the explicit shared-reply tool call.
- Restored the right workspace toggle while a new conversation is waiting for
  its explicit project selection.
- Added a confirmed delete action for collaboration rooms and synchronized the
  active workspace, URL, and sidebar immediately after deletion.

## [0.3.0] - 2026-08-20

### Added

- Added reliable target-Session message routing with per-Session FIFO queues,
  cross-Session parallelism, idempotency, tracked command/run lifecycle events,
  restart recovery, and bounded JSONL journals.
- Added scoped remote control over HTTP/SSE with Bearer capability tokens,
  revocation, rate limiting, command status, state, steer, abort, and event
  subscription endpoints.
- Added a process-level outbound WebSocket connector and remote-control settings
  UI with English and Simplified Chinese translations.
- Added Room fan-out correlation, bounded parallel dispatch, and routing loop
  protection.

### Changed

- Isolated AgentSession extension runtimes and service caches per Session, with
  deterministic runtime resolution for cold Session restoration.
- Routed UI, Room chat, and Coordinator prompt delivery through the unified
  SessionMessageRouter.

## [0.2.9] - 2026-08-20

### Added

- Added a DevEco-style Harmony log workspace with process selection, log-level
  and text filters, bounded live polling, and the same read-only process/log
  actions exposed to the agent.
- Added proactive discovery hints so browser and Harmony troubleshooting
  requests reliably select their bundled extension tools.

### Changed

- Restyled Goal and Plan panels, running-message steer/queue controls, queued
  messages, slash-command results, notices, extension prompts, and workspace
  alerts to use the compact neutral Codex visual language.
- Reduced the conversation toolbar to Git changes, history, and the right-panel
  toggle, with live tracked-change totals.
- Improved Harmony frame polling responsiveness while avoiding screenshot/log
  contention, and preferred the user-visible device name over the product model.

### Fixed

- Strengthened Target Mode instructions so active goals must record progress,
  evidence, or an explicit terminal/waiting state before a turn can settle.
- Removed the slash-command palette's accent selection rail and aligned command
  completion feedback with the rest of the application UI.

## [0.2.8] - 2026-08-18

### Added

- Harmony device operations execute directly: acquiring AI control no longer
  shows a per-run confirmation dialog, while the bounded lease keeps the same
  automatic release guarantees.
- Collaboration rooms can add sessions from any project; the agent picker
  labels every session with its project path.
- Builtin slash-command results (compact, reload, name, copy, session) echo
  into the conversation area as readable rows instead of transient notices.

### Changed

- The slash command palette uses a Codex-style single-column list with
  grouped rows, source badges, and keyboard hints.
- The streaming-action menu (steer vs. queue) supports arrow-key navigation
  and Enter/Escape, and both the menu and queued-message rows follow the
  Codex visual style.

### Fixed

- Confirmation dialogs opened from the settings models page now appear above
  the settings dialog instead of behind it.

## [0.2.7] - 2026-08-18

### Added

- The project area and the right file panel now share the selected background
  artwork, each with an independent opacity control in appearance settings.
- Render isolation boundaries keep one malformed chat message or workspace
  panel from taking down the whole application; the Harmony device panel
  recovers automatically as soon as a fresh poll delivers valid data.

### Fixed

- Fragmented streaming tool calls (common with DeepSeek responses) and
  malformed sessions restored across versions can no longer crash the chat
  renderer with "Cannot read properties of undefined" errors.
- The Harmony device panel validates every poll and event payload before
  rendering, so an open panel can no longer trigger the global reload screen.
- Session creation and selection no longer navigate through the Next.js
  router in production, avoiding Suspense remount loops and renderer crashes.
- Mounting a running session no longer tries to mutate its active tool set.
- Client assets are versioned per release and the packaged runtime is
  validated, preventing stale assets from mixing across upgrades.
- The bundled dependency patch no longer fails with EEXIST on newer Node.js.

## [0.2.6] - 2026-08-16

### Fixed

- Removed obsolete PWA service workers and Cache Storage from the persistent
  Electron partition before loading the desktop UI, preventing older Next.js
  assets from resurfacing after an upgrade when opening workspace tools such as
  the Harmony device panel.
- Added recoverable application error screens and desktop renderer diagnostics
  so an unexpected client failure can be reloaded and traced from the Piora log.

## [0.2.5] - 2026-08-16

### Added

- Added structured Plan Mode artifacts with editable drafts, explicit approval,
  dependency-ordered execution, step evidence, verification coverage, and
  recoverable interrupted-run state.
- Added a unified extension inventory and per-extension controls backed by the
  same resolved load plan used when agent sessions start.
- Added a second unsigned Windows release format: an extract-and-run ZIP beside
  the existing single-file portable executable.

### Changed

- Expanded task and room runtime state so planned and executing TaskRuns remain
  visible and consistent across polling, SSE updates, and restored sessions.

## [0.2.4] - 2026-08-15

### Changed

- Polished the unified Harmony device workspace with a clearer settings switch,
  less crowded quick controls, and reference screenshots for visual review.

## [0.2.3] - 2026-08-15

### Added

- Added a Codex-style composer add menu with mutually exclusive, one-shot target
  and plan modes. Plan mode temporarily limits the agent to read-only inspection
  tools and restores the session configuration after the response.
- Added multi-session collaboration rooms with shared tasks, artifacts, messages,
  and optional coordinator-driven dispatch.
- Added bounded Harmony automation waits for fixed delays, richer UI-node state
  conditions, and locally sampled PNG screen stability with optional regions.
- Harmony wait results now report elapsed time and polling evidence, while timeouts
  include bounded diagnostics without forwarding additional frames to a model.
- Redesigned the Harmony workspace around a full, proportionally fitted phone
  screen, compact primary controls, progressive settings, and shorter copy.

### Changed

- Refined the Harmony device workspace into a compact Codex-style control surface
  with progressive settings and a larger live device frame.

## [0.2.2] - 2026-08-15

### Changed

- Unified the main Piora desktop release and HarmonyOS NEXT automation preview
  into one `0.2.2` version and one standard Windows release artifact.
- Existing ordinary sessions now load `harmony_device` directly without a
  device-control profile switch or standalone-service restart.
- Made device projection polling abortable, non-overlapping, visibility-aware,
  generation-bound, and failure-backoff aware to reduce HDC load and stale input.
- Added capability-aware device controls, recoverable manual ownership, and
  immediate lease cleanup when a device becomes unavailable.

### Security

- Removing the dedicated device-control runtime also removes its tool/resource
  isolation; per-run confirmation, leases, stale-state checks, sensitive-action
  limits, and emergency stop remain as misuse guards rather than a sandbox.

- UI-reference taps now re-read and uniquely match a fresh device tree before
  execution; every write invalidates cached references.
- HDC selections must pass a real read-only probe before replacing the working
  configuration, and vision screenshots/output have explicit size and format bounds.
- Phone UI and perception output are delimited as untrusted data, while AI
  coordinate actions require the current device generation.

## [0.2.1] - 2026-08-14

### Added

- Added automatic Harmony SDK/HDC candidate discovery, a visible installation
  chooser, and native Windows pickers for either an SDK folder or `hdc.exe`.
- Added split-model phone perception: a configured image-capable model receives
  screenshots and returns structured observations while the action model receives
  the UI tree and observation text. Raw screenshot forwarding stays off by default.
- Added persistent target mode to the composer. Target-mode prompts continue across
  model turns until the agent verifies completion, reports a concrete blocker, the
  user stops the run, or the continuation safety limit is reached.

### Security

- Phone screenshots sent for perception use an explicit model selection, no prompt
  cache retention, and contain no conversation history, device input text, lease
  tokens, or credentials.
- The device-control profile admits only the first-party Harmony and target-mode
  tools; target completion is bound to the active server-generated prompt run.

## [0.2.0] - 2026-08-13

### Added

- Added a desktop-only HarmonyOS NEXT device workspace with USB/HDC runtime
  discovery, connection diagnostics, a visible local device projection,
  UI snapshots, structured manual actions, and an emergency stop.
- Added a restricted AI device-control runtime with explicit per-run consent,
  device leases, serialized actions, stale-snapshot protection, and no raw HDC
  shell surface.
- Added a dedicated GitHub Harmony preview pipeline that verifies and publishes
  an independently versioned Windows portable prerelease.

### Security

- Harmony device APIs fail closed outside the packaged desktop runtime and the
  restricted device-control profile.
- Screen data sharing, write actions, process timeouts, output bounds, and
  device identifiers use explicit local policy and data-minimization rules.

## [0.1.7] - 2026-08-14

### Added

- The desktop companion can optionally stop floating above every window while
  preserving the always-on-top behavior as the default.
- Appearance settings include a restrained Codex-inspired dark preset without
  requiring a background image.
- Mandarin dictation normalizes Traditional Chinese output to Simplified
  Chinese and supplies Whisper with a Simplified Chinese transcription hint.

### Changed

- Secondary settings and management dialogs load on demand so the first usable
  desktop frame parses less client code.
- The desktop uses Pi's standard data directory unless an explicit
  `PI_CODING_AGENT_DIR` is configured, removing the first-launch migration
  prompt and its duplicate data-copy path.
- The Dream skin uses quieter surfaces, borders, shadows, and focus treatments,
  and the startup shell uses a short reduced-motion-aware progress pulse.
- Pi SDK packages moved to 0.84.1, with compatible Next.js, React, Tailwind,
  Electron, icon, and document-reader maintenance updates.

### Fixed

- Windows worktree removal now compares normalized paths, allowing dirty
  worktrees to return the intended HTTP 409 response and explicit force retry.
- The headless extension UI adapter now supplies the complete background-color
  contract required by Pi SDK 0.84.1.

### Security

- Updated vulnerable `nanoid`, `undici`, and `brace-expansion` dependency paths;
  production `npm audit` now reports zero known vulnerabilities.
- CI now gates high-severity production dependency findings and enforces the
  existing performance budgets.

## [0.1.6] - 2026-08-12

### Added

- Local headset dictation now records from the composer and transcribes fully
  offline with a checksum-pinned Whisper Base Q5 model and whisper.cpp runtime
  bundled inside the Windows executable.
- First desktop launch can select a persistent Pi data directory and safely
  migrate existing sessions, credentials, model settings, and skills while
  retaining the old directory as a verified rollback copy.
- Review now provides a Codex-style commit-or-push menu with optional staging
  of working-tree changes, amend, commit, commit-and-push, and upstream push.
- Added a HarmonyOS NEXT device-automation architecture design for future
  cross-device control work.

### Changed

- Review file rows use compact colored status markers, path-based expansion,
  and lightweight open-file actions instead of leading disclosure arrows and
  textual status pills.
- The desktop companion interaction and animation behavior is more resilient
  across compact and expanded window states.

### Fixed

- Review can load omitted unchanged source lines on demand, including context
  after the final diff hunk.
- Conversation Git line totals exclude untracked file contents while keeping
  untracked files visible in the changed-file count and Review.

## [0.1.5] - 2026-08-12

### Changed

- The Windows portable executable now removes duplicate runtime trees and
  unused Chromium locale packs, uses a smaller compressed first-run payload,
  prepares an artifact-isolated runtime cache once, and enforces that cached
  launches replace the bootstrap splash with the Electron-owned shell within
  three seconds.
- The built-in Browser workspace now matches Chromium's viewport to the panel
  size and forwards hover, pointer-button, drag, wheel, keyboard, and cursor
  feedback instead of behaving like a stretched clickable screenshot.

### Fixed

- Right-workspace tool tabs can be reordered by dragging.
- The right-workspace add-tool menu is rendered at the viewport level and
  stays fully visible when the panel or remaining screen space is narrow.
- Conversation Git line totals exclude untracked file contents while keeping
  those files visible in Review and Files.

## [0.1.4] - 2026-08-12

### Added

- Project folders can be reordered directly with a long-press drag gesture,
  and the chosen order persists across restarts without adding a separate
  drag handle.
- Review can list and safely switch between local Git branches while retaining
  uncommitted changes whenever Git can apply them.
- Destructive and unsaved-change flows now use an accessible, application-owned
  confirmation dialog instead of browser-native prompts.

### Changed

- The right workspace keeps multiple opened tool tabs available, improves the
  Review layout for large change sets, and uses more consistent panel styling.
- Clicking a project folder now selects it and toggles expansion in the same
  interaction instead of requiring a second click.
- Browser tool execution stays in the background until the user explicitly
  opens the Browser workspace.

### Fixed

- Switching conversations reliably lands at the real message bottom and stays
  anchored while Markdown, diagrams, fonts, and lazy media finish laying out.
- Unsaved editor tabs are preserved or discarded consistently when closing
  tabs and switching projects.

## [0.1.2] - 2026-08-12

### Added

- The Windows desktop process now has a reliably packaged system-tray icon
  with actions to restore Piora, start a task, inspect the running-task count,
  and quit the application completely.
- The right workspace now uses a Codex-style tool launcher and single-tool tab
  flow for Review, Terminal, Browser, and Files, including matching shortcuts,
  maximize/restore behavior, and a browser start page.

### Changed

- Closing the main desktop window now hides Piora to the system tray instead
  of stopping active sessions and the bundled local service.
- Desktop startup reuses its immediately visible shell for the real app instead
  of allocating a second Chromium window, installs the tray before the service
  is ready, reacts directly to the Next.js runtime-ready signal instead of
  waiting on a sequential cold health route, and records startup timing.
- The desktop companion now collapses into a running-task count, stays within
  its compact pet-sized window while idle, and omits the status dot and voice
  control.
- The empty conversation screen and composer no longer show obsolete starter
  prompts, package versions, or the outdated model-settings location.

## [0.1.1] - 2026-08-11

### Added

- A configurable prompt-optimizer system instruction in Agent settings, with
  local persistence, restore-default controls, and preview-before-apply flow.
- A Codex-style Browser workspace panel with interactive page frames, tabs,
  navigation controls, direct keyboard input, and a dedicated persistent Piora
  profile that keeps website sign-ins across application restarts.
- File tabs can be reordered by drag-and-drop or keyboard-accessible actions,
  closed in groups, and reopened from the tab menu or with
  `Ctrl/Cmd+Shift+T`, while preserving unsaved-change confirmation.
- Open file tabs, the active file, and expanded file-tree directories restore
  per workspace after refresh without persisting unsaved editor contents.

### Changed

- The portable desktop app now presents an immediate lightweight startup shell
  while the bundled service loads, packages with store compression for faster
  extraction, and enforces a three-second process-to-window smoke-test budget.

### Fixed

- Selected projects and sessions use a neutral Codex-style highlight without
  the previous blue accent rail.
- Review diffs start collapsed and expand independently instead of opening all
  files when one file is selected.
- Desktop companion bubbles stay close to the pet when idle and stack active
  task bubbles above the base status bubble.
- Review and diff typography now follows the configured UI font scale.

## [0.1.0] - 2026-08-01

### Added

- An original Piora application mark with transparent PNG and multi-resolution
  Windows ICO assets, wired into the portable Electron executable and matching
  browser/PWA icons, with generation and MIT-license provenance retained in the
  repository.
- The sidebar project section reveals a `+` action on hover to open a local
  folder as a new project, and each project row reveals a `+` to start a new
  conversation in that project.
- The directory picker now surfaces sibling Windows drive roots so folders on
  other disks can be selected directly.
- Model settings can hide an entire built-in or extension-provided channel and
  restore it from the Add Provider panel. Custom providers can still be
  deleted and configured again, while stored API-key/OAuth credentials have a
  separate confirmed "Remove configuration" action.
- The composer model pill moved into the input's bottom-right corner and now
  opens a Codex-style panel that combines model selection, reasoning effort,
  and compact-context controls.
- A single `+` attach button in the composer accepts both images and text
  files; file chips embed readable contents into the next message.
- A settings hub dialog is reachable from the sidebar's bottom-left model
  chip, which also hosts quick links to model, skill, plugin, appearance, and
  language settings.
- Appearance settings include app-wide interface-font choices and the existing
  color/background presets. The selected interface font covers the sidebar,
  top bar, chat, composer, settings, and file workspace; code remains on a
  dedicated monospaced stack.
- Model settings expose an explicit availability test for every loaded Pi,
  OAuth, API-key, extension, and custom model, with latency, HTTP status, and
  actionable failure details.
- CI and tag releases enforce a redacting release-hygiene scan for sensitive
  files, private absolute paths, and high-confidence credentials.
- The conversation header's project name opens a Codex-style project menu for
  starting a task in the current folder, switching projects through the safe
  directory picker, copying the working path, and revealing projects/files.
- Direct text and code editing in the right-hand file workspace, including
  optimistic save conflicts and external-change protection.
- Local background presets and user-selected background images, independent
  from the existing color themes.
- Text files open directly in Edit; source, preview, and diff remain optional
  views.
- Workspace project folders contain their conversations, show three recent
  root conversations by default, and persist expansion state.
- A discoverable appearance panel exposes theme controls and thumbnails for
  all 20 bundled backgrounds.
- The wide desktop shell uses restrained rounded project/chat/editor surfaces,
  and the Windows app integrates its web top bar with native window controls
  instead of showing a duplicate title row.
- Windows Electron packaging, local desktop authentication, package
  verification and open-source project governance.
- An optional local companion panel with Pi run status, TODOs, configurable
  quick phrases, and declarative Codex pet import compatibility.

### Changed

- Removed the top sidebar `New` button; creating a project now flows through
  the project section `+` entry, matching the Codex-style workspace model.
- Removed the sidebar refresh button, the redundant Open project dropdown, and
  the low-value Open repository root action. Project creation is handled by
  the projects-section `+`.
- Aligned the default interface typography with Codex on Windows: the system
  UI font stack renders at 14px, while chat content uses a compact 22px line
  height without scaling panel geometry.
- Switching away from a project while its conversation is still responding
  asks for confirmation instead of dropping the streaming view instantly.
- Reasoning-effort and compact-context controls no longer sit in the bottom
  meta bar; they moved into the model settings panel.
- Removed the standalone `Piora` label from the upper-left application chrome
  and aligned the right file-workspace toggle with both the closed top bar and
  the open file-tab strip, including the Electron safe area.
- The custom text-size setting now scales navigation, project/session rows,
  the file tree, top bar, settings, chat, and the complete right file workspace
  instead of affecting only conversation text.
- Historical reasoning blocks preserve their raw Pi block index, isolate
  in-flight loads by session/entry, time out safely, and recover from rapid
  collapse/reopen or live-message reconciliation without remaining stuck on a
  loading placeholder.

### Preserved

- Pi's native session, runtime, extension, skill, package and configuration model.
- The existing conversation rendering and left-side project file tree.

### Known limitations

- Windows binaries are unsigned until a reproducible signing process is configured.
- Package installation still relies on `npm`/`npx`/Git available on the user's system.
- Native Node extension modules may require an ABI-compatible build.
