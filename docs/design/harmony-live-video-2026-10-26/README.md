# 鸿蒙投屏与 Pi 默认能力验收记录（2026-10-26）

原有截图来自生产组件的浏览器测试，设备名称、手机画面、文件及接口响应为测试数据。新增 `actual-mirror-toolbar.png`、`actual-media-notice.png` 来自连接真实手机的 Electron 窗口，仅保留标题栏和通知，不包含手机私人内容。性能数据来自下方单独记录的真机采样。

## 已实现

- 投屏可在独立悬浮窗与设备工作区内切换；非当前显示端不订阅视频，录屏任务保持独立。
- 成功结果使用不抢焦点、自动消失的轻提示；需要选择和错误仍使用通用窗口。
- 修复设备设置内容被裁切；标题优先展示设备提供的可读产品名，不根据认证型号猜机型。
- 保留 H.264 依赖帧解码，显示阶段只呈现最新帧；JPEG 解码保留一个最新待处理帧；被动观看不执行输入坐标校准。
- 首次 HTTP 视频连接等待 30 秒，覆盖可选 SDK 20 秒初始化及服务器首包探测；数据停滞仍有独立看门狗。
- 无首包和提前断开尽量返回结构化错误，桌面记录视频请求的 Chromium 网络失败原因。
- 普通任务恢复 Pi 原生 MCP、codemode、models 和默认工具行为，详见 [Pi GUI 默认能力](../../pi-native-defaults.md)。

## 界面证据

- [设备设置正常显示](settings-visible.png)
- [设备工作区内投屏](sidebar-mirror.png)
- [75% 投屏](mirror-75.png)、[25% 投屏](mirror-25.png)
- [轻量成功通知](media-notice.png)
- [真机动态画面与长录屏中的悬浮窗](actual-live-video-recording.png)：手机浏览器运行专用动态测试页，来自实际 Electron 窗口，不是界面模型图。

## 验证范围

平台为 Windows，Node.js 22.19.0。全仓 lint 通过（两条既有警告、零错误）；根包与桌面类型检查通过；Pi、窗口、设备名称和视频启动等 59 项相关回归通过（包含 Windows 100% 至 200% DPI 窗口检查）；45 项视频生命周期、解码、启动和错误用例通过；工作台及独立投屏两个浏览器测试通过；Harmony 文档校验、性能预算和仓库卫生检查通过。隔离 Pi 生产依赖探针通过，包含原生 codemode 的 models API。

这些是相关回归，不能称为全量 CI 通过。没有在本地执行 Next 生产构建或发布打包。

## HDC 实时视频真机检查

后续已连接 HUAWEI Mate 60，设备 API 26、UiTest 7.0.0.1。本机 DevEco Studio 26.0.0.461 的 `hosScrcpy-1.0.17-beta.jar` 包含 6.6 视频库；旧 6.4 库在此系统创建虚拟屏失败，新库可通过 HDC 的 Unix gRPC 通道输出 AVC。实际画面为 1216 × 2688。

- 编码数据接收：动态桌面滑动测试收到 719 帧，首末帧跨度 28.318 秒；包含后段静止区间，约 25.4 FPS。
- Electron 实际呈现：统计生产画布的 `VideoFrame` 绘制调用，连续滑动的完整第 1–14 秒共 447 帧，平均 31.9 FPS。静止后主动减少出帧，不能将静止帧率当作卡顿。
- 悬浮窗 → 侧栏 → 悬浮窗 → 侧栏通过，均恢复实时视频；录制期间切换保持同一录屏任务。切换等待前一观看连接清理完成，避免误判视频通道被占用。
- 独立后端录屏：关闭观看后继续录制，得到 8.862 秒、1216 × 2688、356 个视频包的 MP4。Chromium 播放解码 29 帧，并成功跳转至 6.647 秒；未新增音轨。
- 实际界面完成录屏保存与截图复制，均显示小型自动关闭通知。浮窗标题显示“HUAWEI Mate 60”。设备设置实际显示 720 DIP 宽内容及 16 个表单控件，不再是空黑模态框。
- 最后关闭后确认无 `piora_video_*` 采集进程，无本次 HDC 转发。用户解锁后测试；按用户要求测试期间使用系统调试保亮命令，不修改原有 600000 ms 自动息屏设置，完成后恢复自动息屏。
- 此通道未调用手机 HAP 的屏幕共享授权接口，也不需要启动手机 Piora 页面；USB 调试授权仍需保留。另一台电脑需要同样安装兼容手机系统的 DevEco Studio。Piora 不重分发此 SDK 库，也不保证所有系统都没有提示。

新增服务、SPS、隔离握手、重连、录屏回退和播放链路相关回归共 187 项通过。`@grpc/grpc-js` 由已有间接依赖明确为直接依赖，版本保持 1.14.5，运行时审计无已知漏洞。上述短测当时尚未覆盖长时间性能、30 分钟录屏和异常恢复；后续结果见下节。没有提交、推送或构建新发布包。

## 2026-10-27 连续动态画面验收

同一手机通过 USB 运行浏览器 Canvas 动画，手机 RAF 约 60 FPS。HDC 反向转发只承载测试网页与时钟同步；实际投屏仍走生产 H.264 → WebCodecs → Canvas 链路。查看窗口处于 75%，录屏始终使用 1216 × 2688 原始视频。

- 前 600 个完整采样秒共呈现 17520 帧，平均 **29.2 FPS**。5894 个有效时间标记样本，校验失败 0；5 ms 分箱的 P50 上界 180 ms、P95 上界 220 ms、P99 上界 250 ms，最大相邻绘制间隔 370 ms。详见 [原始汇总](ten-minute-metrics.json)。
- 延迟方法：手机画面逐帧编码 32 位同步时间戳、固定头与异或校验；电脑在生产画布绘制后每三帧读取一次。12 次往返中取最小往返的中点校时，测试期估计误差约 ±4–6.3 ms。结果包含手机生成画面至电脑 Canvas 绘制，**不包含电脑显示器扫描和发光延迟**，不能冒充外部相机测得的玻璃到玻璃延迟。
- 10 分钟基准完成后开始并行完整回归。随后开发环境负载上升且发生源码热重编译，观看端短暂超时、自动重连；后台原生流录屏仍持续写入同一文件。这段压力数据与前述正常负载基准分开，不用于提高或稀释基准结论。
- 同一个录制任务达到 30 分钟自动停止并保存，文件 317377840 字节（约 302.7 MiB），有效视频 1797.023 秒（约 29 分 57 秒），AVC、1216 × 2688。Electron 实际播放开头、50%、98% 三个位置，各解码 70、66、31 帧，无解码错误。不能把准备与收尾时间当作有效视频时长。
- 强制结束拥有视频的测试主机进程后，确认手机仍有其随机名称的采集服务；新进程恢复后旧服务消失，3 秒内收到 103 帧。随后主动结束本次视频服务，连接确实报 `UNAVAILABLE: Connection dropped`；已收到的 3.686 秒内容保存为 719964 字节 MP4，Edge 实际解码 75 帧并跳转至 3.133 秒。另设的一条 HDC 反向转发保留，成功清理后本次所有权记录为空。此项是主机进程崩溃和视频服务中断，**不是物理拔 USB 线**。
- 记录期间持续监测：画布 JS 堆约 9–11 MiB；后端 Buffer/外部内存反复回落，没有保留整段 303 MiB 视频。Next 开发服务总堆受热重编译和并行回归影响，不能将本轮数据作为发布版稳态内存验收。后半段同时运行多项检查导致主机内存不足，已停止额外 lint、类型检查并改为串行补跑；这些中断不计通过。
- 新增所有权、断连保留清理记录与单调时间戳回归 14 项通过。数值与播放结果见 [录制及恢复汇总](recording-and-recovery-metrics.json)。
- 最终后端再次同时开启原生流、录屏并截图：读取 219 帧，原始截图为 1216 × 2688、完成约 955 ms，录屏得到可解析的 5.993 秒 MP4。截图耗时没有变成视频刷新间隔。

仍未覆盖：外部相机测量的玻璃到玻璃延迟、物理拔线、录制中主机崩溃后的 MP4 恢复、发布版 30 分钟稳态内存、其他手机/系统、真实 2 GiB 或磁盘耗尽；边界自动化测试不能替代这些硬件与发布验收。

## 完整本地回归与补跑（2026-10-27）

Windows x64，Node.js 22.19.0；使用现有锁文件对应依赖，按仓库 CI 的串行测试方式执行。未运行 `next build`，未构建或发布安装包。

- `PIORA_SKIP_RESOURCE_TESTS=1 npm test` 完整结束：3085 项，首次 3063 通过、3 失败、1 超时取消、18 跳过，约 55 分钟。没有把首次失败运行记作全绿。
- 已修正 Native MCP 的旧默认文案断言、独立投屏切换后的旧源码断言，以及模拟 HDC 测试意外发现本机 DevEco 的环境耦合。`node --test components/NativeMcpConfig.browser.test.mjs` 通过 1 项；设备后端、桌面契约与运行时契约组合复测通过 57 项。测试继续验证连接操作、权限边界、侧栏切换和清理记录，没有删除相关行为断言。
- `node --test --test-name-pattern='isolated DevEco 1.3.6' lib/harmony-packaging.test.mjs` 低负载复测通过（约 25 秒）；保留原 120 秒上限和依赖完整性断言。首次复制超时发生在主机高负载阶段。
- 取消资源跳过标记后，`npm run test:shell-resource` 通过 6 项；另外单独串行运行 `harmony-command-shortcuts-browser`、`harmony-device-terminal-browser`、`harmony-device-terminal-lifecycle-browser`、`harmony-workbench-tree-resize-browser`、`harmony-transfer-jobs-browser` 五个测试文件，通过 14 项（含子用例）。这五个文件不在现有 `test:shell-resource` 命令内，已明确补齐。
- 其余 7 项没有计作通过：5 项需要当前 Windows 账户不具备的符号链接权限，1 项仅适用 Unix 文件分页脚本，1 项需要发布专用 `PIORA_TEST_7ZA` 提取器。此次未修改这些路径；对应平台和发布环境仍须运行。
- 最终源码的 `npm run lint` 通过（零错误、两条既有警告），`npm run typecheck` 根包与桌面均通过。`npm run build:harmony-worker` 重编译后，worker、HDC 后端、DevEco 视频、所有权恢复和时间戳五个测试文件串行通过 59 项。
- `npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run perf:check` 及 `npm run audit:runtime` 通过；运行时审计为 0 个已知漏洞。`node scripts/diagnose-sharp-electron.mjs` 的 Node/Electron 原生图片与 ASAR 诊断通过。

真机测试完成后已关闭测试采集服务、移除本次 HDC 转发并恢复正常自动息屏；用户原有 10 分钟设置保持不变。源码与证据同步至当前 Codex 工作区。

## 设备界面提交前复查（2026-10-27）

- 用户反馈的设置空白、无法选择侧栏以及认证型号标题，来自尚未包含以上未提交修复的旧开发实例。确认正在运行的实例来自原 `F:\Piora`，本轮修复及验收在隔离工作树中进行。
- 对连接手机重新执行实际 `HdcBackend.listDevices()`：`model` 为 `BRA-AL00`，`product` 和最终浮窗标题均为 `HUAWEI Mate 60`。没有根据认证型号硬编码营销名称；缺少产品名时保持明确回退。
- 标题栏采用不透明中性色并随浅色／深色主题切换，按钮、选项、焦点和录屏标记使用配对颜色。禁用文字与背景的独立渐变，避免主题切换期间出现短暂低对比度。
- 生产组件浏览器测试加载真实主题和 SVG 图标，逐一验证 20 套主题的文字、按钮和图标对比度至少 4.5:1，并检查缩放焦点。浅色、彩色深色及 Dream 的界面证据分别见 [浅色](toolbar-light.png)、[Anime Neon](toolbar-anime-neon.png)、[Dream](toolbar-dream.png)；手机内容为测试数据。
- 工作台测试覆盖 380 DIP 窄侧栏下的投屏位置选择、设置入口、设置内容尺寸、横向边界和滚动；保留悬浮／侧栏互切、缩放及原有工具操作断言。
- 提交前同步 `origin/main` 的停止引导恢复修复（`47a4713f`），保留其 CHANGELOG 和运行逻辑；重新验证合并后的会话生命周期、队列恢复、Pi 默认能力与本次界面差异。此前完整套件和资源补跑记录保留在上一节，不以增量复测冒充新的全套运行。
- 合并后的增量回归 257 项全部通过，零跳过：`node --test --test-concurrency=1 hooks/useAgentSession.test.mjs lib/rpc-*.test.mjs lib/queued-input-recall.test.mjs lib/session-message-router.test.mjs lib/native-mcp.test.mjs lib/tool-presets.test.mjs lib/session-capabilities.test.mjs lib/theme.test.mjs lib/contrast.test.mjs lib/harmony-window.test.mjs lib/harmony-desktop-profile.test.mjs hooks/useHarmonyLiveFrame.test.mjs components/HarmonyPanel.browser.test.mjs components/HarmonyMirror.browser.test.mjs components/NativeMcpConfig.browser.test.mjs`。
- 最终合并内容再次通过 lint、根包及桌面 typecheck、Harmony 文档、仓库卫生、许可证、背景资源、性能预算和运行时依赖审计；lint 两条既有警告、审计零已知漏洞。website 无改动，未重跑其独立检查；其他操作系统和安装包验证交由远端 CI。


