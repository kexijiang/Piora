# DevEco Testing 实时触控链路调查（2026-11-08）

## 当前状态

目标仍为输入发出至投屏画面出现响应不超过 50 ms。用户随后已授权操作手机，
本轮已实机测试并接入正式前端、HTTP、manager、worker 和持久触控通道。
目标尚未达到：不提交、不推送、不打标签、不触发 beta 发布。已有本地 beta.14 准备提交不代表已发布。
主开发目录的其他修改未动；本轮工作位于独立的安装包验证工作区。

## 样本和工具

- 安装目录：`G:\softwore\DevEco Testing`。这是独立 Testing，不是 Studio 插件。
- 实时投屏组件：`app/resources/tools/demoWithoutRecord.jar`。
- JAR SHA-256：`2ac513e608f9f54cec1dc4e8ddb185023ce5b16b9f3fbfdec54226a63b6f0107`。
- 该 JAR 包含 `hosScrcpy-1.0.17.12-java21-SNAPSHOT-shaded.jar`、`MyWebSocketServer`、`HosRemoteDevice` 和 `UitestServer`。
- REA 6.8.0 + Ghidra 12.1.4，使用独立 Node 24.22.2；均位于 G 盘。入口为 `G:\Piora-tools\rea\rea.ps1`。
- Ghidra 下载来自 NSA 官方 GitHub Release，核对官方 SHA-256 后解压。
- REA doctor 的 Ghidra 显式检查为 healthy=true；通过 REA 对 Windows 启动程序进行了实际反编译，不只是安装检测。
- REA 当前 Windows 适配不接收 ARM64 ELF。因此手机端 `uitest_agent_v1.2.2.so` 另外使用 Ghidra 原生 headless 接口分析，不能称为 REA 对 ELF 的支持。
- Java 使用 javap 读取已安装字节码，前端读取已安装的 app.js；未将第三方实现或二进制复制进 Piora 产品。

证据位于 `.verification/deveco-control-research/`，其中 `Testing-*` 来自独立 Testing，早先未加此前缀的 Studio 调查不得混用。

## 已确定的静态调用关系

### 实时视频路径

`L5ScreenCasting.vue` 注册 mousedown、mousemove、mouseup 和 mouseleave。
其 `doMouseDown / doMouseDrag / doMouseUp` 直接写入常驻 WebSocket：

```text
前端鼠标事件
  → ws://127.0.0.1:<port>/<serial>
  → {type: "touchEvent", message: {event: "down|move|up", x, y}}
  → MyWebSocketServer.onMessage
  → HosRemoteDevice.onTouchDown / onTouchMove / onTouchUp
  → UitestServer.doTouchEvent
  → 常驻 TCP socket（TCP_NODELAY=true）
  → HDC fport → localabstract:uitest_socket
```

最后一段发送普通 UTF-8 JSON：

```json
{"module":"com.ohos.devicetest.hypiumApiHelper","method":"Gestures","params":{"api":"touchDown","args":{"x":100,"y":200}}}
```

对应移动和抬起 API 为 `touchMove`、`touchUp`。`sendRequest` 写入后读取响应，
不是无确认的 UDP，也不是每次创建 HDC shell 进程。
前端在鼠标按下时立即发送 DOWN，不等待完整点击结束。

该版本服务端存在坐标乘 2 的逻辑，这是它自身缩放约定，不能直接照搬进 Piora。
Piora 必须继续根据已验证的原生尺寸、显示器、旋转和画面几何进行坐标转换。

视频使用另一条 `scrcpy_grpc_socket` 转发与 gRPC `onStart` 流，
Java 回调将视频字节转换为 Base64，再经 WebSocket 给前端 JMuxer。
前端 JMuxer 配置含 `flushingTime: 0`、`fps: 60`。
这些是实现/配置证据，不是它实际达到 50 ms 的证据。

### 另一条控制路径

`ScreenMirrorServiceImpl` 将事件格式化为 `uinput` / `input` shell 命令，
经 `AbstractDevice.execute → executeAsync → ProcessBuilder` 执行。
旧 canvas 分支在 mouseup 后判断 click、longClick 或 swipe。
因此此前仅看到 uinput 不能代表整个应用的实时控制链路。

### 手机端分发

Ghidra 已定位 `OHOS::uitest::RpcServer::ExtractAndDispatchRequests`、
`OHOS::uitest::HandleGesture`、`Driver::injectMultiPointerAction` 和 `PointerMatrix::setPoint`。
`HandleGesture` 中的 API 分发使用跳转表；当前伪代码明确提示跳转表未完整恢复。
已补充对应汇编和引用导出。尚不能据此声称所有系统输入调用、权限条件或等待均已查清。
本机随包 agent 也不能直接等同于连接手机正在加载的 agent。
实测手机是 Mate 60，UITest 7.0.0.1；本轮持久 Gestures 的 DOWN/MOVE/UP 已收到手机测试页事件确认。

## Piora 当前差异与改造

改造前的控制在鼠标抬起后补发完整手势。几何查询包含旋转、尺寸、旋转三次 RPC，
实验脚本的双重几何观察会执行两轮。此前 PointerMatrix 短点击只是缩短脉冲，
仍未消除这些 RPC 和手势结束前的等待。

本轮实现：

- `gesture-channel.ts`：独立常驻本地转发连接，TCP_NODELAY，单请求在途，
  UTF-8/JSON 分片重组、64 KiB 回包上限、超时关闭、异常回包拒绝；不重放输入。
- `live-touch.ts`：分离 DOWN/MOVE/UP，移动积压只保留最新点，
  按住超时自动释放；几何/epoch 失效后仍执行 UP；原通道失效时显式调用恢复释放。
  无法确认恢复释放时必须报告不确定，不能报告成功。
- `verify-harmony-mirror-performance.mjs --direct-touch=true --input=true`：
  接入原型进行真实设备对比，保留几何观察和测试页前台心跳。
  此模式禁止与 `--manager=true` 混用，避免将实验结果标为生产 manager 验收。
- 测试验收阈值由 200 ms 收紧到最大值 ≤50 ms，并保留不少于 25 样本、30 秒和无超时条件。
- `useMirrorInput → /api/harmony/pointer → HarmonyDeviceManager → Hypium worker` 已接通。
  DOWN 前准备租约和几何；整个按住期间占有设备操作队列。MOVE/UP 在 worker 中不等待只读几何队列，
  但仍校验 gesture ID；其他写操作不能插入按住过程。
- `ManualPointer` 负责租约撤销、设备代际、画面新鲜度、方向变化与超时释放。
  释放不受已经撤销的租约阻挡；失败保留 uncertain 状态并阻止后续写操作。
  worker 丢失手势状态时仅允许 parent 明确请求 UP，不重放 DOWN/MOVE，也不释放其他活动手势。
- 浏览器切换设备、失焦、取消捕获时释放原设备；准备最长 3 秒，迟到的几何/租约响应不能补发旧点击。
  只读几何预热不获取操控租约、不发送输入。正式视频采集仍保持 scale=1 的原有默认值。

## 实机结果与测量边界

全部原始数据位于 `.verification/deveco-control-research/<实验名>/result.json`。
手机停留在专用本地测试页；前台心跳过期即停止后续注入。结束时通知测试页停止动画和心跳并清理本次转发。
测试包含真实 HDC、手机事件、手机绘制、原生 H.264、WebCodecs 和 OffscreenCanvas，
采用主机收到 GPU 像素确认的保守耗时。它不是光学屏幕刷新测量，也不包含 React/Next HTTP 入口。
manager 模式包含正式租约、帧新鲜度、代际、坐标转换和队列；direct/prepared 模式不能作为生产验收。

| 实验 | 反馈指标 | 中位数 / 最大值 | 结论 |
| --- | --- | --- | --- |
| `clock-scale2-real` | prepared 直连完整短点击 | 最大 94.0ms | 绕过 manager，未达标 |
| `manager-pointer-scale2-real` | 生产 manager 松开到画面 | 60.7 / 74.7ms | 29 次，无超时，未达标 |
| `manager-move-warmed-real` | 3 次 MOVE 后松开到画面 | 60.4 / 651.4ms | 29 轮，手机确认全部 87 个 MOVE；存在长尾 |
| `edge-lowrate-pointer-real` | 8Mbps、repeat=8ms，松开到画面 | 76.6 / 94.1ms | 重复帧增多，没有收益 |
| `electron-phases-real-2` | 按下到按下反馈 | 131.8 / 174.6ms | 29 次，包含几何准备，未达标 |
| `electron-phases-real-2` | 松开到松开反馈 | 57.1 / 66.7ms | 29 次，无超时，未达标 |

最后一项使用 Electron **45.0.0**，不是目标依赖 45.2.1；scale=2、bitrate=8Mbps、repeat=1000ms，
这些是诊断变量，不能描述成正式默认配置的验收。45.2.1 官方 Windows x64 API 下载未完成，未通过校验，
中断文件以 `.zip.partial` 保留于 G 盘。早先 Electron 启动/首帧超时的轮次均不计为通过。

`--pointer-manager` 的原始完整指标含人为按住 80ms；因此另列 releaseToDrawAckMs，不能混淆。
新增 `--phase-feedback=true` 在按下和松开各自改变颜色，分别从对应输入开始测量；
每一阶段都要求至少 25 个样本，所有反馈最大值仍须 ≤50ms，不排除慢样本。
部分单次移动 ACK 约 6–9ms，只证明传输/确认快，不证明画面反馈达到 50ms。

`--scale` 经反编译确认是 **1–5 的整数除数**；0.5 会回退为 1。
`clock-scale2-real` 及后续记录实际视频尺寸 608×1344；早先 `direct-half-real` 不算半分辨率实验。
Testing JAR 的 6.5 捕获库在本机测试未产生帧；缺失路径意外回退到 bundled 6.4 的轮次是无效对比，
不得声称已验证 DevEco Testing 的实际运行效果。本轮工作的捕获库来自 Studio 6.6，来源在结果中记录。

## 原生路径的可行性调查

Studio 6.6 `ScreenEncoder::Setup / initFormat` 使用 Rosen 虚拟屏和 OH_VideoEncoder surface 编码。
可见配置含码率、关键帧和重复帧间隔，编码帧率常量 120；未发现显式低延迟编码选项。
不能据此断言系统内部没有低延迟处理。

OpenHarmony 的 [UITest 扩展接口](https://github.com/openharmony/testfwk_arkxtest/blob/master/uitest/addon/extension_c_api.h)
提供 atomicTouch 和 callThroughMessage；后者有机会将三次 USB 几何 RPC 合并到设备进程内。
在 G 盘使用 SDK 编译了只读探针，并使用官方 binary-sign-tool 自签名。
手机日志明确报 `Xpm check failed`、`errno for mmap is: 13` 和 `Dlopen ... Permission denied`。
因此该探针没有执行，不能声称手机支持这条新原生实现。没有关闭系统校验或改动安全设置。
LD_PRELOAD 编码配置探针也没有加载日志；对应数据不能用来判断低延迟编码 flag 是否有效。

独立 DevEco Testing 的客户端登录已由用户完成；当前仍需核对流畅模式的完整运行基线。

## 2026-11-09：加载失败的定位与 6.8 实测

- 对下载资源的 6.9 ELF 做独立启动观察，设备日志明确报缺失
  `_ZN6google8protobuf8internal14UntypedMapBase14ClearTableImplEb`，即 Protobuf 内部符号不兼容。
  这是动态链接失败，不是帧率或编码参数导致。证据：`diag69-start.log`。
- 换用同一资源的 6.8 ELF，在新唯一文件名下成功启动 `scrcpy_grpc_socket`。
  第一次向之前的文件覆盖上传被设备拒绝，该轮 `diag68-start.log` 实际仍为 6.9，不能作为 6.8 结果。
  有效证据使用新的 `diag68-owner.txt` / `diag68-fresh-start.log` 和匹配进程。
- 真实 Java 字节码 `HosRemoteDevice.tryToPollingSO` 表明客户端会尝试其他捕获库，
  已有库还会按 MD5 识别，并有 5 秒无帧后的切换逻辑。Piora 仅按版本排序的选择不能保证 ABI 兼容。
- `testing-runtime68-phases/result.json`：Edge、scale=2、真实 6.8 进程，Piora manager 分阶段反馈测试。
  按下 29 次：中位数 129.3ms、最大 445.5ms；松开 29 次：中位数 59.5ms、最大 68.6ms。
  无超时和脚本错误，仍不满足 50ms；不是 DevEco 原生 UI、完整 Piora UI 或发布安装包验收。
  本轮复用已确认属于本任务的 6.8 探针 socket；结束后匹配唯一进程并终止、删除探针，确认转发列表为空。
- 仍未提交、推送或发布。需要继续解决宿主握手及采集/编码延迟，不能以选库成功代替性能通过。

### 同日补充：分段诊断与流畅模式重试

- `capture68-format.c` / `capture68-pipeline.c` 来自 Ghidra 对当前实际资源 6.8 的反编译。
  `initFormat` 仍将编码帧率设为 120，未见显式低延迟编码字段；`ScreenEncoder::Loop` 等待结束条件，
  不能误读为逐帧 sleep。采集使用 Rosen 虚拟屏及编码器 surface，输出回调直接进入发送路径。
- 当前 Java `UitestServer.doTouchEvent` 仍发送 `hypiumApiHelper / Gestures / touchDown|touchMove|touchUp`，
  可选带 displayId。布局通道的 HEAD/TAIL 封装不应误套到这条触控通道。
- 对 `testing-runtime68-phases/result.json` 按顺序配对手机事件与画面，
  手机 draw 上报到电脑 canvas 提交的中位差值：DOWN 32.9ms、UP 32.4ms；
  这是包含手机上报传输误差的诊断差值，不是纯编码耗时，也不参与通过判定。
  DOWN 的首轮几何准备中位 25.4ms，DOWN 确认中位 74.7ms。
- 只读实机对照 `geometry-transport-comparison.json`：交错各 25 次，保留方向—尺寸—方向三次读。
  SDK 读取中位 11.49ms、最大 17.54ms；额外直连读取中位 10.60ms、最大 14.28ms。
  约 0.9ms 的中位改善不足以解决反馈瓶颈，未把额外通道接入产品。实验代码仅保留于 `.verification`。
  首轮在 SDK agent 初始化前开额外连接导致连接被重启关闭；该失败轮次不是性能样本。
- 修正分阶段测量的 `inputAckMs`：DOWN 只记 DOWN 确认，UP 单独记 UP 确认；
  不再把等待画面与整个按住周期算成 DOWN 指令确认。新增 sequence 供后续事件核对；
  完整画面反馈的 50ms 门槛保持不变。
- 05:14 再次通过真实客户端选择“流畅”，仍显示“投屏加载中”，同时间日志再次出现 `token match failed`。
  通过正常关闭程序并重启后，客户端没有保留登录状态，现停在华为账号登录页，已请求用户自行重新登录。
  正常退出没有清除旧 java PID 29996；当前信息仍不足以确认它就是端口占用者，未强杀或提权。
  此轮不宣称 DevEco 流畅模式恢复、50ms 达标或发布完成。

## 已执行检查与剩余门槛

发布决定更新：用户在上述结果之后明确要求“就这样吧，提交推送打 beta 包”，
因此本版可在如实披露未达到 50ms 的前提下发布。以下性能与完整 UI 验收缺口继续保留，
不将这次发布决定解释为性能达标，也不再以 DevEco 客户端登录阻塞打包。

### 登录后的运行时补充

- 实际客户端 26.0.0.500 加载下载资源 `E:\ProgramData\DevEco Testing\common\resources\screenCastingResource\screenCastingResource.jar`，
  SHA-256 `541797bd57b3168ff57473fa5208d2381de9aa3b4a1e0cd240be9b32fdae1457`。
  它包含 6.8/6.9 捕获库及 1.2.5 agent，不能用安装目录里的旧 JAR 代表当前运行实现。
- launcher 的 `DevEcoTesting_2_0.log` 记录 23:49:02 `Address already in use: bind`，
  23:50:07、23:51:37 `token match failed`。Main 字节码确认默认服务端口 9523，启动参数传入会话 token。
  日志支持投屏请求未通过服务握手，但当前端口查询没有确定冲突进程，不能归因于 Piora。
  曾尝试结束与历史启动时间匹配的 java PID 29996，系统拒绝访问；未提权或修改系统安全设置。
- 此后实际观察到“标准”模式显示手机设置画面；这是另一条路径，不能作为“流畅”视频模式恢复或 50ms 通过的证据。
- 对实际资源中的 6.9 捕获库进行独立实验 `testing-runtime69-phases`，启动失败，没有延迟样本，不能记为通过。
- 用户要求隔离端口后，Piora 自有桌面服务、视频及输入转发改为 20000–65535 可用端口；
  Hypium 的 CJS 内部 allocator 在 Piora 初始化时替换，避免其原有 9000–9999 范围。
  公共 HDC 服务 8710 保持共享。新增分配器检查通过，控制回归 15 项通过，类型及 worker 编译通过。
  初版依赖 OS 连续分配 0 端口的策略在此 Windows 环境测试失败，已改为指定范围随机候选并实际 bind 检查，复测通过。

- 32 项定向检查通过：持久连接、分片、异常回包、超时、租约/方向/代际、释放不确定、worker 恢复、
  HTTP 身份与参数校验、真实浏览器指针事件及迟到准备响应。
- 13 项视频核心与 worker 回归通过；任务范围类型检查、定向 lint、控制 worker 编译、diff 检查通过。
- 浏览器交互测试使用真实 hook 和模拟 HTTP；route 测试使用真实校验与模拟 manager。
  它们不代替完整 Next/Electron UI、发布安装包和真实手机的联合验收。
- 待完成：DevEco Testing 登录后的运行基线、低延迟采集路径、正式 Electron 45.2.1 全入口测试，
  以及实际 UI 输入到画面 ≤50ms 的验收。这些仍是后续优化目标；本次按用户更新后的决定，
  披露限制后由 GitHub Actions 构建 Windows x64 NSIS beta。
