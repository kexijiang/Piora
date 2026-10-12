# HarmonyAtlas 类设备工作台验收矩阵

> 本文按时间保留验收事实和失败证据；旧轮次中的可点击投屏、人工租约或接管描述只记录当时行为，不代表当前界面。现行投屏画布只读，AI/工具动作走独立后台通道，截图和录屏无需停止投屏。

## 原生旋转桥接 1.1.26（本项整轮通过，2026-10-05）

真实 Piora Electron 43.7.7 与 USB API 26 手机使用私有设备绑定 debug 1.1.26 完成一次初始化和一次系统录屏授权后的竖屏、横屏、竖屏切换。三段观察保持同一采集 epoch，横屏和恢复竖屏分别新增 188 与 209 次原生绘制，兼容截图回退增量均为 0；物理方向和原生尺寸最终恢复。原生视频期间截图成功，录屏为 546861 字节，Electron 实际解码 30 帧。停止和卸载均返回 200，两个自有测试应用最终不存在，原生弹窗及页面错误均为 0。匹配报告为忽略的 `.verification/harmony-native-bridge-rotation-20261004-acceptance.json`。

该 HAP 的 SHA-256 为 `fa12a06ce70b2a37b45d926fadab51fc5e1055891a70eefa65eb183a0f49df35`，只用于私有调试，不进入发行包。当前 1.1.27 源码包含同一旋转桥接和后续生命周期修正；正式 SDK 构建、验签、专用手机门禁与同次桌面打包流程已经接入 GitHub Actions，但正式标签任务和最终 installer/portable 的真实安装验收尚未完成，本节不作为 beta 已发布或正式产物通过的结论。

## 独立 Agent B 第十七轮（本项整轮通过，2026-10-04）

二十九项源码于 2026-10-04T01:45:51.133Z 冻结，清单 SHA-256 为 `41dc24ca0e82a12ea9b63f32c0d29609149577e0210c19ade5f7a5ba256df840`，归档器 SHA-256 为 `1eac8cfc783adda0816ad69103c41071471500d960857f68ca42a73cfbee613e`。真实 Piora Electron、Next 16.3.8 与 USB API26 手机 main 于 01:46:01.8722879Z 启动，01:51:56.3874380Z 退出 0；完整 wrapper 实际退出 0，helper 16388 于 01:52:38.338Z 终止后严格归档。固定归档 `.verification/independent-agent-seventeenth-archived-20261004/` 收录六十份文件、排除十二份旧或缺失文件，新鲜必要产物全部满足，整轮 PASS。

真实独立 Agent 的只读等待场景与 GUI 截图、录屏并发，媒体未接管其租约；截图、开始录制、停止录制分别耗时 1334.802 ms、910.285 ms、381.168 ms。并发 MP4 为 17.843715 秒、431713 字节，实际解码 28 帧并 seek 至 2.3 秒；ready 至 stop 为 17560.690 ms，与 MP4 时长误差约 0.2830 秒。后续标准录制 MP4 为 11.829549 秒、222161 字节，实际解码 30 帧并 seek 至 2.095191 秒，时长误差约 0.19175 秒；这是本轮短程证据，不写成二十秒或持续性能通过。

场景按预期超时，prompt 正常、非中止结束并自动释放 Agent 租约；结束后继续观察 6500 ms，实际新增 58 次原生 draw，兼容回退增量为 0，设备 generation 保持 1→1。两自有应用的 GUI 停止、卸载均返回 200，之后分别独立确认已不存在；原生 JS 弹窗及页面错误均为 0。

本轮新增 Next 阶段的有界被动时序观察，原请求期限与正常 GUI 断言保持。有限 HTTP 诊断的 invalid 为 false、观察错误为 0，CDP 与 Node HTTP 记录丢弃数均为 0；Next 层实际记录到 ensure 与 handle，但每进程最多 256 项，主 PID 的 Next 记录丢弃数为 176。不能称全部诊断零丢弃或完整覆盖所有编译与处理阶段，也不能由本轮 PASS 认定第十六轮超时由编译造成或根因已定位；第十六轮及更早失败结论保持。

使用的组件仍是已核对 SHA-256 `729d54952a57f97fb5ed9d28604c8514ee4a6c30d4d3f003394e6e14910459c1` 的私有 debug 1.1.17。当前源码三十分钟、五百次动作长测与独立旋转短测仅完成准备，尚未启动；公开 HAP 的合法 release 构建、适用签名和官方验签，以及最终 CI 同批 installer/portable 的真实桌面、手机验收仍未完成。开发桌面子项 PASS 不作为正式 beta 发布或完整 Atlas 目标完成的结论。

## 独立 Agent B 第十六轮（核心前状态读取超时，整轮未通过，2026-10-04）

本轮保留原始请求期限、正常 GUI 点击及全部媒体断言，仅补充有界被动 HTTP 时间诊断：记录固定路由的请求、响应、结束时间和连接计数，区分浏览器连接等待与服务端处理时间，不保存头、正文、原始查询或用户内容。preload 仅注入隔离 Next 子进程，Electron、HDC 和根进程环境未注入新增诊断设置。诊断与原 proof 辅助函数 27/27 回归通过，限定 lint 和语法检查退出 0，生成器输出一致。

二十九项源码于 2026-10-04T01:30:36.951Z 冻结，清单 SHA-256 为 `d606b0f82d1dcc7f747f59caf1e21d2b2f690daee3fab67bb27f6d2465238e38`，归档器 SHA-256 为 `e8a7a6e0018a23107f747761d7af38fe2ac018ef4723dd73e69e32bf728af89e`。真实 Piora 桌面与 USB API26 手机 main 于 01:30:41.2231579Z 启动，01:34:47.3933094Z 退出 1。USB HDC 通道、物理亮屏与解锁已确认，原生 LIVE 与后台采集 STARTED 均已到达；核心 AI 指令前，`iaState` 对 `/api/harmony/state` 的只读 GET 在原十秒期限内未返回，整轮 FAIL。

有限被动 CDP 与 Node 时序证明该请求已进入服务端，但未在请求期限内获得响应；尚未定位阻塞原因，不能仅归因于浏览器连接等待、设备动作队列或日志存储，也未放宽期限。没有核心 prompt，也没有该核心任务的独立 AI 媒体并发或自然完成证据，不沿用第十五轮已到达的媒体阶段，不把失败清理当作自然结束。

完整 wrapper 实际退出 1，helper 23224 于 01:35:20.623Z 终止；严格归档 `.verification/independent-agent-sixteenth-archived-20261004/` 收录五十九份文件、排除十三份旧或缺失文件，源冻结清单及归档器指纹保持上述原值。当前源码的三十分钟、五百次动作长测仅完成准备，尚未启动；本轮不证明长测、公开组件或正式 beta 已通过。

## 独立 Agent B 第十五轮（进入核心媒体，进度读取超时，整轮未通过，2026-10-04）

旧地址覆盖问题已用 installed Next 的真实 AppRouter、HistoryUpdater、client reducer 与 action queue 复现：正常点击当前会话后 URL 含 SID，后续真实提交回写根地址，SID 丢失，而会话、cwd、sessionKey、挂载计数和草稿仍保持。负面对照为 0/1，失败点是 SID 硬断言，没有用测试准备错误替代功能失败。

修正仅把 AppShell 的现有历史写入统一经过 Next 的原生历史同步：传入数据保留自定义字段，但由 Next 自己复制当前树与内部标记，避免跳过 canonical URL 更新；四个历史 push 入口保持原历史语义。真实 callback 与 Next 浏览器回归 7/7 通过，关联导航和历史回归 6/6 通过；后续提交、迟到旧动作、返回历史、null history state、自定义数据、同会话草稿与挂载均核对，lint、完整 typecheck、diff 检查退出 0。RSC 种子和两自有会话数据是软件夹具，不能据此声称所有 HMR 情况或手机验收已通过。

二十七项源码于 2026-10-03T22:50:52.898Z 冻结，清单 SHA-256 为 `91fcd403392e235068ab04c46df442b875e9ed923b0a8763ab6efafbd9d86ff9`，归档器 SHA-256 为 `97391c3e69b0c141dcd7a5e97eb7a9c562eec509c41f2e76b7fd89d7ad0f7e89`。真实桌面与 USB API26 手机 main 于 22:51:07.1939404Z 启动，22:55:56.4399384Z 退出 1。原同会话 URL 断言已越过，真实核心 prompt、run_scenario 工具与 Agent 租约已到达；截图、开始录制及录制任务断言也已越过。录制十秒后 `iaCheckRunning` 对 `/api/harmony/scenario` 的只读 GET 在原十秒期限内未返回，停止录制由失败清理执行，没有新鲜完整成功报告。

有限失败证据保留六条真实事件（prompt start、两组可选只读工具、run_scenario start），没有自然 tool end/done；不能把清理取消当作自然完成，也不能写 MP4 解码、6500ms 后画面或整轮通过。源码审计确认 GET 不进入设备动作队列或读取 HDC；全量同步读取场景日志的设计负担存在，但没有本轮时序证据证明它就是超时原因，未因此修改产品或放宽期限。

完整 wrapper 实际退出 1，helper 18840 于 22:56:46.326Z 终止。固定归档收录五十九份文件、排除十一份旧或缺失文件，冻结源码与新鲜失败证据保持原值，整轮 FAIL。亮屏维护单独接续；下一轮需补齐被动请求时序诊断，区分浏览器连接等待和服务端处理延迟后再决定修正。

## 独立 Agent B 第十四轮（会话地址再次丢失，核心前失败，2026-10-04）

本轮产品代码与第十三轮相同，仅修正 ignored 验收辅助函数遗漏真实 deviceEpoch 的投影，并补齐相应负例；二十三项辅助函数回归通过。原有同代次、6500ms 继续出画面、零新增回退、正常鼠标点击、独立 AI 操作期间媒体并发与自然结束断言均保留。

二十六项源码于 2026-10-03T22:32:51.105Z 冻结，清单 SHA-256 为 `2e24cb9e7f41f6422754de519fc5bfc76c92b452096047f71573ae3ae40577c0`；真实桌面与 USB API26 手机 main 于 22:32:57.7225055Z 启动，22:36:52.6433495Z 退出 1。准备聊天 accepted、started 与非中止 done 已通过，初始化、原生 LIVE、后台采集和第二个自有应用画面均到达；核心 prompt 前 URL 中的 SID 再次为 null，没有核心 POST、AI 工具或租约，不能归因于设备 AI 执行。

有限导航样本显示会话参数先存在且匹配，真实侧栏点击附近恢复匹配后约 2.6 秒再次消失；第十二轮的小修正没有可靠解决后续导航提交覆盖。这一整轮为 FAIL，不沿用第十三轮媒体结果，也没有放宽 URL 断言。完整 wrapper 实际退出 1，helper 22352 于 22:37:25.971Z 终止；严格归档收录五十八份文件、排除十一份旧或缺失文件，清单和冻结源码保持原值，归档器 SHA-256 为 `1b574353aad22f93ef3fa0ccfebd51ba6754c66dab11cf91dff38123ed847449`。亮屏维护随后单独接续，地址同步修正与下一轮手机验收仍须完成。

## 独立 Agent B 第十三轮（到达 AI 与并发媒体，代次投影读取失败，整轮未通过，2026-10-04）

2026-10-03T22:21:39.6136537Z 至 22:27:25.8279605Z，真实 Piora 桌面与 USB API26 手机 main、完整 wrapper 均退出 1。正常 GUI 同一自有会话的核心 prompt 实际 accepted，匹配的 started、三次允许的只读工具调用及非中止 done 均保留在新鲜失败证据中，observer invalid 为 false；其中唯一 run_scenario 工具约 62.741 秒后自然结束。

冻结 driver 的流程已越过 AI 运行期间截图、录屏、MP4 实际解码与 seek、正常 prompt 结束、租约释放，以及随后 6500ms 新画面和零新增回退的断言；最终在代次比较失败：后态 generation 为 1，基线 `iaLease.deviceEpoch` 为 undefined。完整成功对象及该阶段具体媒体测量值尚未落盘，不写成完整媒体验收通过，也不沿用旧成功报告。

源码核对证明接口没有删除 deviceEpoch：manager 创建原租约时保存设备 generation，公共 state 仅移除 token；ignored assertAgentLease 辅助函数却在返回投影中省略该字段。driver 把该投影作为基线，再读取遗漏字段，形成此处确定的 harness 错误。修正辅助函数验证并保留真实原值、每次对照基线也检查该代次；缺失、非法和换代拒绝用例连同原用例共 23/23 通过，修改范围 ESLint 退出 0。产品代码与原同代次硬断言不变，仍需下一轮独立完整验收。

固定归档 `.verification/independent-agent-thirteenth-archived-20261004/manifest.json` 收录五十七份文件、排除十份旧或缺失文件，二十四源冻结清单保持原哈希，整轮为 FAIL。helper 26284 于 22:28:47.598Z 终止，root 确认完整 wrapper 退出 1 后归档，亮屏维护随后接续。修正后的辅助函数及测试会另纳入新轮的源清单，不回写本轮证据。

## 第十三轮前的窄聊天输入布局验证（随后实机整轮未通过，2026-10-04）

第十二轮的真实布局失败已用实际 ChatInput、实际模型图标与系统提示选择器、生产 globals 和 Tailwind preflight 复现：1440 视口、440px 聊天父容器、正常模型名称下，旧样式的普通发送点击由模型名称拦截。保留原有发送恢复 case 的通过与新增布局 case 的预期失败，不使用 force click。修复只把 footer 改为可按容器换行、模型和发送/停止分组右对齐、模型按钮宽度限制到父容器，保留所有功能节点。

同一浏览器回归修复后 2/2 通过：窄栏普通模型菜单开关、发送与停止各回调一次，模型和按钮矩形不重叠，发送中心实际 hit test 正确；900px 宽栏含系统提示选择器仍单行。相关 ChatInput、重试、真实 mention picker 三十三项回归通过，修改范围 lint、完整 `tsc --noEmit --incremental false` 与 diff 检查退出 0。纯组件 API 数据与回调是测试夹具，这些软件结果不称为手机或最终 beta 通过。

第十三轮于 2026-10-03T22:21:35.428Z 冻结二十四项源码，清单 SHA-256 为 `4273cfd2c918ce538f7aa7c9cb8b14ff52816f0311327ac4587c3b46494bd312`；真实桌面与 USB 手机 main 于 22:21:39.6136537Z 启动。沿用正常 GUI、普通鼠标点击、同会话与精确 receipt 断言、原有期限及媒体严格验收；归档额外要求准备会话真实选中与实际侧栏点击同步 URL 的字段。整轮、完整 wrapper 及正式公开组件仍须独立结算。

## 独立 Agent B 第十二轮（同会话导航通过，发送按钮被布局遮挡，整轮未通过，2026-10-04）

2026-10-03T22:07:49.4430049Z 至 22:12:05.9808641Z，真实 Piora 桌面、USB API26 手机 main 与完整 wrapper 均退出 1。准备聊天完整终结，直接初始化、原生 LIVE、后台采集和另一个自有应用的新画面均到达；核心前自有 SID 的唯一条目仍选中，真实侧栏点击恢复 URL，原同会话 URL 断言通过。

随后核心指令已填入唯一正常 composer，发送按钮 enabled，但真实普通鼠标点击三十秒超时：`model-settings-trigger-label` 的模型名称控件持续拦截发送按钮的点击。没有核心 prompt POST 或 AI 工具执行，本轮不证明 AI 媒体并发、完成后的持续画面或整体验收通过。没有 force click、隐藏模型、扩大期限或删除同会话断言；正在修复实际窄聊天容器的 footer 布局和模型按钮宽度约束。

固定归档 `.verification/independent-agent-twelfth-archived-20261004/manifest.json` 收录五十三份文件、排除十一份旧或缺失文件，二十一源冻结清单保持原哈希，整轮为 FAIL。helper 20668 于 22:13:27.710Z 终止，root 确认 wrapper 退出 1 后归档。首次归档因脚本仍要求十九项源记录而拒绝，未创建归档；修正为严格二十一项后重新归档，未更改实机证据或结论。实际执行归档器 SHA-256 为 `e83a8a2cb18905438b99e7731ac850c23e6e676f0d6d6897e01dd4cb4911fb1a`，与运行前打印的准备值区分。

## 第十二轮前的软件验证与真实入口补充（随后实机整轮未通过，2026-10-04）

第十一轮现场的聊天仍被选中且原文、回复可见，因此 URL 缺参不能作为 selectedSession 已清除的证据。源码核对发现 Piora 使用原生 history marker 绕过 Next restore 后，Next 后续提交仍可能回写自己的 canonicalUrl；该机制与现场吻合，但未记录实际调用栈，不称为逐字段证明完整原因，也不改 cwd 生命周期。最小修正为点击已选中的会话时同步 URL，保持原 return，不重建 ChatWindow；不声称根治所有开发 HMR 地址漂移。

同会话点击的真实 callback 负面对照保留一项预期失败，修复后六项通过。取消入口另补与普通提交一致的 trim，带首尾空白的排队精确取消和取消先于迟到提交的两个真实 handler/router 负例先失败，修复后十六项 API 回归通过。七组相关组合回归共 95/95 通过、零失败和跳过，修改范围 lint、完整 typecheck 及 diff 检查退出 0。

第十二轮于 2026-10-03T22:07:42.054Z 冻结二十一项源码，清单 SHA-256 为 `9c3815ee5cee7803293d26e0d18054ea54a17ae07acae189c9b3b856e0b0e8e0`；main 于 22:07:49.4430049Z 启动。核心 prompt 前，先确认自有 SID 的真实侧栏条目唯一且仍选中，再实际点击同一会话条目，保留原 URL 与后续 prompt receipt SID 一致断言。导航观察只新增有界时间戳与自有会话布尔匹配，不保存其他聊天名、URL、正文或配置。该正常 UI 操作与软件通过仍不代替核心手机整轮、公开组件或最终 CI beta 安装验收。

## 独立 Agent B 第十一轮（准备聊天通过，核心前会话地址变化，整轮未通过，2026-10-04）

2026-10-03T21:55:18.3870613Z 至 21:59:35.3216214Z，真实 Piora Electron 43.7.7 与 USB API26 手机 main、完整 wrapper 均退出 1。正常 GUI 新任务的无害准备 prompt accepted、匹配的 prompt_started 和非中止 prompt_done 全部到达；同一自有会话 GET 实际出现模型标志已结束而 runtime 仍为 running，事件连接保持至 command completed、runtime idle 后关闭。这是本轮真实到达的发送与收尾证据，不改写前两轮 FAIL。

直接安装、初始化、正常采集授权、自动隐藏初始化指引、原生 LIVE 及切换另一自有应用后的新像素均到达。核心 AI 场景前，driver 要求当前 GUI URL 保持原准备会话，但实际 `session` 为 null，断言失败；没有提交第二条核心 prompt，不证明独立 AI 并发截图/录屏或完成后的持续画面通过。正在核对正常 UI 切换与会话导航源码，不删除同会话断言、不扩大期限。

固定归档 `.verification/independent-agent-eleventh-archived-20261004/manifest.json` 收录四十九份文件、排除十三份旧或缺失文件，十九源冻结清单保持原哈希，整轮为 FAIL。helper 16792 于 22:00:08.745Z 终止，root 确认 wrapper 真实退出 1 后才归档。独立亮屏维护接续，物理显示 ON、电源 AWAKE、手机未锁定；手机及最终公开 beta 验收仍须完整独立结算。

## 第十一轮前的软件回归与源码冻结（随后实机整轮未通过，2026-10-04）

针对第九、十轮发现的连接收尾与发送入场竞态，客户端保留正在发送、等待精确 command 入场和服务端 runtime 收尾期间的 SSE；Stop 按原提交标识取消尚未入场、排队或对应运行，迟到的旧响应不得终结或取消新运行。新增 GET 状态投影只返回对应会话的 command 标识与状态；未知提交的取消意图不伪造持久化回执，原文实际落盘后才进入取消终态。队列容量拒绝也写入 failed，避免重启重新执行被拒绝的提交。

真实 hook callback、真实 API handler、真实 router 与临时持久化文件组成的六组回归共 87/87 通过，零失败、零跳过；修改范围 lint、完整 `tsc --noEmit --incremental false` 与 diff 检查退出 0。修复前的行为负面对照和首次失败日志保留，不以最终通过回写历史结果。SDK 中止或取消持久化失败保持失败并拒绝假成功，不声称同进程重试已恢复。

第十一轮于 2026-10-03T21:55:06.795Z 冻结十九项源码，清单 SHA-256 为 `b37f9e7663adf2e499ab99f083aa0794087230dcebc9588764cf4f993a6404ea`；真实桌面与 USB 手机 main 于 21:55:18.3870613Z 启动，随后确认整轮与完整 wrapper 退出 1，结论见上方独立记录。沿用原生 EventSource、正常 GUI 入场和既有严格期限；软件回归不替代手机、公开签名组件或最终 CI beta 安装验收。

## 独立 Agent B 第十轮（发送确认前连接关闭，整轮未通过，2026-10-04）

2026-10-03T21:20:47.7890096Z 至 21:23:28.0105080Z，main 与完整 wrapper 均确认退出 1。真实普通准备 prompt accepted 为 200、预期回复“会话已就绪”可见，但 events 只观察到 connected；等待 prompt_started 六十秒超时，未进入设备并发验收。CDP 显示 agent state GET 返回后八毫秒，同一毫秒开始 history GET 并取消 SSE；prompt accepted 比断开晚约 561 毫秒。本轮保留 FAIL，不写模型未回复，也不沿用旧媒体结果。

源码核对发现发送阶段另有边界：客户端在 await prompt POST 前清除准备标记，服务端持久化和队列入场前可能合法返回 idle；200 receipt 也只表示 queued，不能表示已开始或已完成。该源码竞态确定存在且与现场时序吻合，本轮未保存 GET 状态字段，不能称为现场逐字段证明。后续修复分别跟踪 POST 等待与精确 command 的真实队列状态，并保持 Stop 和迟到响应的既有边界；不放宽期限。

固定归档 `.verification/independent-agent-tenth-archived-20261004/manifest.json` 收录三十四份文件、排除二十三份旧或缺失文件。helper 6512 于 21:24:50.112Z 终止，root 确认 wrapper 退出 1 后归档十四项冻结源码。独立亮屏维护接续，物理显示 ON、电源 AWAKE、手机未锁定。下一轮只补留自有合成会话的 GET 布尔状态、runtime 与 command 状态，不保留聊天、模型配置或工具内容。

## 独立 Agent B 第九轮（普通回复可见，终结事件缺失，整轮未通过，2026-10-04）

2026-10-03T21:07:52.8074309Z 至 21:11:29.1414549Z，main 与完整 wrapper 均确认退出 1。正常 GUI 无害准备 prompt 实际创建自有会话，events 返回 200，prompt accepted 与匹配的 prompt_started 均到达；现场真实桌面已显示预期回复“会话已就绪”。driver 等待 prompt_done 一百二十秒超时，未进入设备工具和媒体并发验收。本轮不能写认证失败、模型未回复或设备功能通过。

有限 CDP 记录显示 prompt_started 后约 1.703 秒 events 被取消，此前三个 agent state GET 均为 200，history GET 在断开前两毫秒开始。源码核对发现模型结束后、文件快照与 PromptRun 收尾期间服务端 runtime 仍为 running，但前端两处 idle 判断未计入该状态，能够提前关闭 SSE。该竞态确定存在且与现场时序吻合；本轮没有保存 GET 响应状态字段，不能称为逐字段证明现场响应。后续修复须由行为回归与新的实机整轮确认，不能回写本轮 PASS。

固定归档 `.verification/independent-agent-ninth-archived-20261004/manifest.json` 收录三十二份文件、排除二十三份旧或缺失文件，整轮为 FAIL。helper 26092 于 21:12:51.257Z 终止，root 确认完整 wrapper 退出 1 后才归档；冻结十二项源清单。独立亮屏维护接续，物理显示 ON、电源 AWAKE、手机未锁定。

后续已修复运行状态轮询、结束等待及刷新恢复三处判定，保留服务端收尾期间的事件连接。真实 callback 行为回归 33/33 通过，修改范围 lint、typecheck 和 diff 检查退出 0；未修复代码上的负面对照分别复现两处提前关闭与刷新不连接。新的实机第十轮尚待独立结算，这些源码验证不改变第九轮 FAIL。

## 独立 Agent B 第八轮（准备入口不提供服务加载，未进入设备验收，2026-10-04）

2026-10-03T20:57:06.9691720Z 至 20:59:08.8072337Z，main 与完整 wrapper 均确认退出 1。真实新任务项目选择页中 `/` 菜单可见，但 driver 等待 `get_commands` 响应六十秒超时；CDP 明确为 `ownSessionId=null`、`requests=[]`、`channels=[]`，没有创建会话或发送命令请求。源码核对确认 `NewSessionProjectPicker` 的独立 ChatInput 没有 `onLoadSlashCommands`，项目选择也不创建 ChatWindow；菜单显示不代表 SDK 命令发现。这是验收准备入口判断错误，不能写服务、认证或设备功能失败，也不能记设备验收通过。

固定归档 `.verification/independent-agent-eighth-archived-20261004/manifest.json` 收录三十二份文件、排除二十三份旧或缺失文件，整轮为 FAIL。helper 27900 于 21:00:30.754Z 终止，真实终态与十二项源清单均冻结。后续准备改为正常 GUI 首次无害 prompt 的真实生命周期，自然结束后保持同一自有会话，再以不同 run 和 command 验证核心设备场景；不修改产品连接期限。

## 独立 Agent B 第七轮（发送前事件连接超时，整轮未通过，2026-10-04）

2026-10-03T20:45:23.2474029Z 至 20:50:06.8679967Z，main 与完整 wrapper 均确认退出 1。原生 EventSource 保持不变，CDP 在正常新任务之前启用；会话创建返回 200，耗时 18.842 秒，正常 `get_commands` 返回 200，耗时 28.683 秒。同一自有会话的 events GET 在 29.533 秒时取消，未收到 HTTP 响应或事件；没有实际 prompt POST。driver 等待 prompt accepted 六十秒超时，不能记模型、设备工具或媒体并发通过。observer 存在且有效，投屏仍为原生 LIVE、新 draw 610；有限日志未确定首次编译、通道或其他服务准备因素的根因，未放宽产品连接期限。

固定归档 `.verification/independent-agent-seventh-archived-20261004/manifest.json` 收录四十四份文件、排除十一份旧或缺失文件，整轮为 FAIL。helper 7340 于 20:50:24.461Z 终止，main 与 wrapper 的真实终态和源清单均冻结；缺少本轮成功报告的事实保留。后续先通过正常 GUI 命令发现流程核对服务准备，再以独立新结果验证实际模型工具和 prompt 完成后的媒体功能。

## 独立 Agent B 第六轮（脚本启动失败，未进入功能验收，2026-10-04）

2026-10-03T20:42:27.8875987Z 至 20:43:25.2315651Z，main 与完整 wrapper 均确认退出 1。验收脚本在实际 Electron 页面取得后调用的 CDP observer 函数位于嵌套块，产生 `ReferenceError`；未进入 GUI 功能、设备工具或媒体验收，不用于判断产品通过或失败。固定归档 `.verification/independent-agent-sixth-archived-20261004/manifest.json` 收录三十二份文件、排除二十三份旧或缺失文件，为整轮 FAIL；helper 19632 于 20:44:14.752Z 终止。后续已将声明移至模块顶层，并由 TypeScript AST 核对声明和调用作用域，新的实机结果须单独结算。

## 独立 Agent B 第五轮（任务启动观察超时，整轮未通过，2026-10-04）

2026-10-03T20:27:22.1528465Z 至 20:33:04.1019921Z，真实 Piora 桌面与 USB 手机运行，main 与完整 wrapper 均确认退出 1。使用已保存的真实 agent 目录，初始化、授权后自动隐藏指引、后台采集与另一自有应用的新原生画面均到达正向断言。正常 GUI prompt accepted 后，等待匹配 commandId 的 `prompt_started` 六十秒超时；本轮有限 observer 的 `events=[]`、`invalid=false`、`drawn=1476`。失败截图中聊天区显示会话加载超时，投屏仍为原生 LIVE、1080×2386，不能将此结果写成模型、设备工具调用或媒体并发已通过，也尚不能仅归因于 observer。

本轮冻结了普通 owner 释放边界修复，相关六组回归 98/98、scoped lint 和 typecheck 通过；实机尚未到达 prompt 完成后的持续画面断言，回归不替代该实机门禁。固定归档 `.verification/independent-agent-fifth-archived-20261004/manifest.json` 收录四十四份文件，完整 wrapper 的实际退出 1 已确认，helper 6400 于 20:33:37.909Z 终止；归档为整轮 FAIL，旧第四轮媒体子阶段报告被排除，缺少第五轮成功报告的事实保留。正在核对新会话加载和事件观察时序。

## 独立 Agent B 第四轮（媒体子阶段通过，整轮未通过，2026-10-04）

2026-10-03T20:08:18.0183394Z 至 20:13:41.5914416Z，真实 Piora 桌面与 USB 手机使用 installed 已保存 agent 目录运行，退出 1。快速隐藏、显示面板后恢复原生画面，正常 GUI prompt 实际调用 `harmony_control`，独立 Agent 执行预期六十秒只读等待。该工具运行期间截图、录屏启动、停止分别为 1617.90 ms、1213.96 ms、507.08 ms；租约保持、媒体不携带操作租约、没有 GUI 接管。并发 MP4 为 17.548212 秒、330896 字节，实际解码 25 帧并 seek 至 2.018976 秒，时长误差约 0.2980 秒。场景按预期超时，prompt 正常结束，独立 Agent 租约自动释放。以上仅为本轮已到达子阶段，不替代整轮结果。

后续标准录屏启动返回 504 `No H.264 keyframe arrived for recording`，整轮仍为 FAIL。prompt_done 为 20:12:48.371Z，原观看 TCP 连接于 20:12:48.397Z 关闭，约五秒后手机停止采集。源码中普通 owner 释放经 physical lock 进入整设备清理，并关闭被动观看连接、改变设备 generation；后续已修正普通输入释放的清理边界，相关回归通过，实机门禁仍须由新的整轮结果确认。固定归档 `.verification/independent-agent-fourth-archived-20261004/manifest.json` 收录四十三份文件，main 与完整 wrapper 均确认退出 1；本轮完整成功报告缺失，不能借普通媒体或旧 B 报告补作通过。自有资源兜底清理不计 GUI 清理通过。

## 独立 Agent B 第三轮（整轮未通过，2026-10-04）

本轮使用真实 installed 已保存 agent 目录，普通实际默认模型可用预检查通过；真实初始化、后台原生画面阶段到达正向断言。匹配 `.verification/harmony-desktop-independent-agent-media-20261004-exit.json` 记录 2026-10-03T19:48:52.5728543Z 至 19:52:41.2908995Z，退出 1。在 AI prompt 提交及工具调用之前，真实 GUI 快速隐藏再显示设备面板，耗时小于四秒的断言通过，manual release 返回 200；随后 driver 第 770 行等待 native LIVE 三十秒超时。实际 UI 为兼容 LIVE、1216×2688，并显示 `Harmony video stopped producing frames`。整轮保留 FAIL，未进入独立 AI owner 的媒体并发验收；这不是已证实的模型 AUTH、聊天 SSE 或 AI 抢租约失败。正在核对 active false→true、stream 和 generation 生命周期，原因尚未证实。

本轮自有 runtime 经 finally 关闭，main 与完整 wrapper 均确认退出 1，归档 `.verification/independent-agent-third-archived-20261004/manifest.json` 收录三十三份文件。缺少本轮成功报告的事实保留；旧两轮 B 的整轮 FAIL 保留，本轮也不顶替下方普通原生第四轮 PASS 或正确目录原生 SSE 第五次普通聊天 PASS。

## 原生 1.1.17 第四轮普通媒体短程（本项整轮通过，2026-10-04）

2026-10-03T19:35:28.0106424Z 至 19:43:23.4216085Z，真实 Piora 桌面、Next 16.3.8 与 USB 手机上完成普通原生媒体短程整轮，fresh short-exit 的 `testExitCode=0`。本轮 fresh 视频及录制报告均接受，`nativeDialogs=[]`、`pageErrors=[]`；两次观看端刷新、系统授权拒绝后再次允许、手机停止共享后正确提示与恢复、观看者持续离开后的有限清理、后台应用的新原生画面均通过。投屏及后台样本由真实 GUI 停止、卸载返回 200，两个自有应用随后独立肯定 absent；初末实际物理显示 ON、电源 AWAKE、手机未锁定。前三轮整轮 FAIL 保留为各轮历史，不用此前部分通过顶替本轮结果。

人工发起的 production 只读 wait 保持原租约时，GUI 截图、开始录屏和停止录屏分别耗时 1208.48 ms、2936.89 ms、416.69 ms，未接管租约或携带媒体 lease token。并发录制 MP4 为 14.140955 秒、324667 字节，实际解码计数 31 帧并 seek 至 2.096267 秒；标准录制为 21.724444 秒、437929 字节，实际解码计数 19 帧并 seek 至 2.496684 秒。标准录制 ready 至 stop 与 MP4 时长差约 0.1161 秒，219 个 packet 时标中亚毫秒间隔为零，稳定阶段兼容回退为零。这些是本轮短程与人工只读等待并发证据，`independentAgentOwnerExercised=false`，不记独立 AI 场景已执行。

固定归档 `.verification/current-native-fourth-instrumented-short-20261004/` 的 STATUS 和 manifest 结算 PASS，复制二十二份、排除十一份文件，`passEvidenceMissing=false`。首次归档时 main 已退出 0，但 wrapper 首次 poll 仍在运行，传入的 wrapper 已确认标志不准确；后续 session 25608 明确确认 wrapper 退出 0，自有 helper 25336 于 19:44:17.851Z 终止。已保留 `post-archive-wrapper-confirmation.json`，并将 manifest 的 `initialArchiveWrapperExitWasNotYetObserved=true` 和 STATUS 时间说明纠正；不能写首次归档已等待并确认 wrapper。该更正不改变 fresh main PASS。

本轮补齐当前组件普通原生短程整轮；真实编码器故障注入、当前源码持续长程观看、独立 Agent 媒体并发及正式 beta 签名包安装仍 pending。此前默认目录探针的 AUTH 分类不代表真实桌面配置；下方第五次普通聊天配置等价性重测已通过，按真实已保存 agent 目录的独立 Agent 媒体验收仍在进行，不能提前记通过，也不能据本轮正常短程结果确定旧断流或 B 第二轮 SSE 超时根因。

## 复用真实桌面目录的原生 SSE 第五次诊断（普通聊天整轮通过，2026-10-04）

`.verification/piora-native-sse-diagnostic-1791056739377.json` 记录实际整轮 PASS、退出 0。按公开桌面优先级复用 installed 已保存目录，安全目录元信息为 `source=installed-desktop-state`、`matchesDefault=false`；目录解析未直接读取、修改或复制 auth/model/settings 内容。原生 `EventSource` 保持不变；prompt accepted 返回 200，真实 GUI 的预期 assistant phrase 可见，自有 state 确认 idle；`prompt_started` 与 `prompt_done` 的相对时标分别为 91131 ms、93388 ms，`aborted=false`，错误计数为零，`unexpectedTools=[]`。自有 Electron PID 17636 的 taskkill 退出 0，自有 Next 已清理；本轮 probe 与目录 resolver 的源码快照保存在 `.verification/piora-native-sse-fifth-source-20261004/`。这是普通聊天配置等价性重测通过，不能代替独立 Agent 的设备工具调用、媒体并发或自有设备资源清理证明；独立 Agent B 第三轮结果见顶部 FAIL 记录，旧两轮 B 与此前四次探针的整轮 FAIL 均保留。

探针目录等价性更正：root 只读确认真实 installed Piora 的 `desktop-state.json` 已保存非空自定义 `piAgentDirectory`，与 `%USERPROFILE%\\.pi\\agent` 默认目录不同；测试启动 shell 未设 `PI_CODING_AGENT_DIR`。以下四次探针使用临时 userData，独立 Next 从父环境选择默认 agent 目录，未复用真实桌面的已保存目录。因此第四次 `AUTH` 仅属于探针默认目录的模型认证错误类别，不能写用户正常 Piora 的模型认证故障，也不要求用户据此补认证；前述四次 FAIL 与各自证据均保留。后续按公开桌面目录优先级复用已有目录重测，不读取、修改或复制 auth/model/settings 内容；AI 实体验收仍 pending，B 第二轮 SSE 超时原因仍未确定。

原生 SSE 探针首次有限诊断：root 实际执行忽略的 `.verification/piora-native-sse-diagnostic-20261004.mjs`，保留原生 `EventSource`，未打开 Harmony；结果为 `.verification/piora-native-sse-diagnostic-1791055224509.json`。GUI 点击发送后约 1.2 秒，探针把正常发送暂态“发送状态待确认”误判为 `SEND_ERROR`，当时本次 `/api/agent/new` 尚未响应，未到 SSE 阶段，整轮探针保留 FAIL。`electronClose` 等待五秒超时也保留为失败记录；root 随后独立只读核查已无 Electron 进程或 30153 listener，不能回写 close 等待成功。本次不能称普通聊天 SSE 复现，也不能排除认证或 observer 因素；正在修订忽略探针的错误分类再诊断，未修复产品，未证明 prompt 接受或模型调用通过。

原生 SSE 探针第二次有限诊断：`.verification/piora-native-sse-diagnostic-1791055386514.json` 保留整轮 FAIL，错误为 `TOTAL_TIMEOUT`。仍使用原生 `EventSource` 且未打开 Harmony；create 返回 200，events 返回 HTTP 200、`text/event-stream`，首字节耗时 9913 ms，CDP 的 `connected` 时标为 9916 ms，prompt accepted 返回 200。本轮 SSE 连接门禁已通过；采集到十三个 SSE message 事件后，约三秒记录 SSE aborted，但未采集 `prompt_done`/`error` 分类，一百二十秒内未确认预期 assistant phrase。旧探针的自有 idle 检查依赖该 phrase，故未取得 state 结果，不能写模型或整轮通过，也不能据此归因 observer、Harmony 超时或认证。自有取消返回 200，自有 Electron PID 21524 的 taskkill 退出 0，自有 server 清理完成；root 另行核查 30153 无 listener、无 Electron 进程。正在补充有限终态及 idle 证据，未改产品 timeout。

原生 SSE 探针第三次有限诊断：`.verification/piora-native-sse-diagnostic-1791055715970.json` 保留整轮 FAIL，错误为 `OWN_STATE_PROMPT_FAILED`。保持原生 `EventSource` 且未打开 Harmony；create 返回 200，events 返回 HTTP 200、`text/event-stream`，首字节耗时 15286 ms，CDP 收到 `connected`，prompt accepted 返回 200。通道仅记录一次 `connected` 后 aborted，未收到终态事件；自有 GET state 最终返回 200、`runtime=idle`、`lastPromptFailed=true`，预期短语未出现，未记录工具开始，本轮未主动取消 prompt。本轮证明会话内部 prompt 失败，但尚未采集原因类别，不能称认证失败，也不能断言模型调用必然发生或失败，更不能套作 B 第二轮连接超时的根因。正在仅补充失败 state 的有限原因枚举，不保存 error 正文或 token；自有 Electron PID 23956 的 taskkill 退出 0，自有 server 已清理，未修改产品 timeout。

原生 SSE 探针第四次有限诊断：`.verification/piora-native-sse-diagnostic-1791055967363.json` 保留整轮 FAIL，错误为 `SSE_TERMINAL_ERROR`。原生 `EventSource` 未替换，未打开 Harmony；create 返回 200，events 返回 HTTP 200、`text/event-stream`，首字节耗时 9167 ms，`connected` 时标为 9170 ms，prompt accepted 返回 200。实际 `prompt_started` 后 1707 ms 收到 `prompt_error`（仅保存有限 `errorCategory=AUTH`，未存原错误正文）及 `prompt_done`、`aborted=false`；未记录工具开始，预期短语未出现。本轮只证明探针默认 agent 目录下的 prompt 终态属于认证错误类别，不能归为真实桌面自定义目录的模型故障，也不能把该原因套给 B 第二轮 SSE 连接超时。必要 AI 验收等待按真实已保存配置重测，不能写模型或全体验收通过；产品三十秒门限未修改。自有取消返回 200，自有 Electron PID 24660 的 taskkill 退出 0，自有 server 已清理。

## 独立 Agent B 第二轮（整轮未通过，2026-10-04）

2026-10-03T19:06:33.9293432Z 至 19:10:35.2744913Z，真实 Piora 桌面与手机上的 B 第二轮退出 1。原生画面、后台录屏及应用前台阶段到达正向断言，随后真实 composer 点击发送后，GUI 报告 `Timed out connecting to the agent event stream. Please try again.`；驱动等待匹配 prompt 的 `acceptedResponse` 六十秒超时。整轮保留 FAIL，尚未证明独立 Agent scenario 调用或 AI 媒体并发。匹配证据归档于忽略的 `.verification/independent-agent-second-source-snapshot-20261004/` 与 `.verification/independent-agent-second-data-preserved-20261004/`（十五份文件），不借旧 report 补作通过。

现有 hook 的三十秒 SSE 连接门禁位于普通 prompt POST 之前；超时提示表示该门禁结算时既未得到 `connected` 成功结果，也未达到 `EventSource.OPEN`。保留 pending 原文属于产品发送恢复语义，不能改称模型认证失败，模型列表预检查通过也不证明实际模型调用。失败证明中的 `requests=[]` 仅统计 Harmony 写请求，`events=[]` 仅筛选 prompt/tool 并忽略 `connected`/`error`，均不能证明完全没有 SSE 或 agent/new 请求。本轮未保存 HTTP 状态、首部/首字节时间及服务准备阶段时序，尚不能确定 Next 冷编译、会话准备、连接或 observer 因素中的实际原因。未加大 timeout、未据此修改产品；独立原生 EventSource 的真实 GUI 连接诊断正在准备，尚无新验证结论。

## 原生第三轮与独立 Agent 首轮（两轮均未整体通过，2026-10-04）

原生 1.1.17 第三轮于 2026-10-03T18:47:16.4961330Z 至 18:54:52.5060652Z 在真实 Piora 桌面与 USB 手机上运行，退出 1。初始化指引在正常授权前可见、native-live 后自动隐藏，手机停止共享后的最终提示、观看者重连、离开与明确授权恢复、另一自有应用前台的新画面，均到达严格正向断言；人工/共享租约的六十秒等待期间，截图、录屏与停止录屏独立完成。并发阶段 MP4 实际时长为 13.526233 秒，标准录制为 21.742743 秒，两者均完成实际解码与 seek。最后驱动在任务页查找应用停止按钮，三十秒超时，整轮保留 FAIL；独立 Agent 为 false，整轮零弹窗的最终断言也未到达，不能外推为完整目标通过。归档 `.verification/current-native-third-instrumented-short-20261004/manifest.json` 收录三十八份文件，`freshSuccessReportIncluded=false`；日志中的已到达阶段不替代新成功报告，归档时的源码快照也不单独证明实际执行版本，不借旧 report 补作本轮通过。

独立 Agent B 第一轮于 2026-10-03T18:58:08.1708779Z 至 19:01:09.5766721Z 退出 1。当次 `.verification/harmony-desktop-independent-agent-media-20261004.log` 记录原生画面、初始化指引自动隐藏、正常后台录屏任务及另一自有应用前台新画面到达正向断言，随后全局“隐藏文件面板”按钮定位匹配两处，发生 strict mode failure。失败在 prompt 提交之前，未调用模型、Agent 未运行，整轮保留 FAIL。遗留 `waitForResponse` 在页面关闭后另打印 page closed，不能替代原始定位错误；固定清单归档另行结算，不引用旧报告。相关 UI 作用域 lint、类型检查及既有 HarmonyPanel/browser 4/4 回归通过，软件回归日志为 `.verification/harmony-native-guidance-regressions-revised-20261004.log`；这些软件结果和本轮前置原生阶段不构成独立 Agent 或发布验收通过。下方既有 FAIL 记录保持原结论。

## 原生 1.1.17 第二轮阶段复验（整轮未通过，2026-10-04）

真实 Piora Electron 43.7.7、Next 16.3.8 与 USB API26 手机的第二轮私有 debug 1.1.17 短测于 2026-10-03T18:31:03.2419396Z 开始，至 18:36:50.7526463Z 退出 1。fresh doctor 的 `encoded-video` 与完整 type3 帧、两次观看者刷新重连、手机明确停止共享后的正确最终提示、观看者离开后的有限停止及显式再次授权恢复，均到达原严格正向断言。这些阶段是本轮实机证据，不能扩大为整轮媒体或持续性能通过。

最终失败发生在驱动等待已关闭工具抽屉中的“应用”页时，等待三十秒超时。失败现场主画面仍为 LIVE、1080×2386，观测记录有新的成功 draw；失败前快照记录成功目标 draw 1354 次、最近 draw 距采样 89 ms。该记录只证明对应方法调用，120 项 samples 是尾窗，不能重建完整历史；本次入口等待失败不能归因于产品视频断流。后台应用及后续 60 秒截图/录屏并发、20 秒 MP4 阶段均未进入。

匹配 STATUS、退出、现场图、fresh doctor attempt、renderer metadata 和源脚本归档于忽略的 `.verification/native-1.1.17-instrumented-tool-entry-failure-20261004/`，保留整轮 FAIL。此次未重现下方 17:43Z 的 doctor 回退失败，仍不能宣布其根因已修复，也不作为独立 AI 或最终 beta 验收通过。下方“待复测”及失败记录保留为各轮当时事实；本轮新增正向结论仅限上述实际到达阶段。

## 应用维护第四轮实机复验（本项整轮通过，2026-10-04）

2026-10-03T18:24:39.6011682Z 至 18:27:17.2879184Z，在真实 Piora Electron 43.7.7、Next 16.3.8、实际桌面 bridge 与 USB API26 手机上完成应用维护整轮，退出 0。仅使用两次独立肯定未安装后安装的自有 `dev.piora.audio.fixture` 1.0.2 / 1000002 调试样本；HAP 元数据与 SHA-256、`replace=false`、安装后的版本和入口回读均匹配，预览详情查询的未知状态不作为未安装证明。

GUI 安装、启动、清缓存、停止、启动、清数据、停止、启动、停止、卸载共十次明确动作，每次请求增量均为一，原生 JS 弹窗及 pageerror 均为零。严格核对实际模块 `entry/cache`、`entry/files` 存在、可读/可遍历且非直接符号链接后，仅写本轮 UUID marker，不创建目录。清缓存后 cache marker 消失，普通 marker 保留且内容匹配；清数据后两类新 marker 和此前普通 marker 均消失。GUI 显式重启产生新的合成导出，实际回读 SQLite 十六字节文件头正确，安装版本保持 1.0.2。以上效果来自独立物理回读，不以 HTTP 200 或 `verification=not-run/effect=unknown` 的 receipt 代替效果证明。

GUI 卸载后独立 `bm` 回读肯定 absent，无需兜底 HDC 卸载；自有 Next 进程的 exit/close 均确认 SIGTERM。首尾及周期实际物理显示均 ON、电源 AWAKE、手机未锁定。匹配报告、退出、源码 manifest 与 cache/data 现场图保存在忽略的 `.verification/app-maintenance-fourth-passed-direct-operations-20261004/`。本项不替代第三方 release 应用沙箱、跨用户、系统 root 使能/禁用、原生视频或最终 CI beta 验收。

前三轮失败保持原结论，不能用第四轮结果回写：

- 第一轮 17:57:36.8917214Z 至 18:00:36.3674474Z 退出 1：脚本把预览“当前列表未发现”文案作为前提而超时；只完成首次独立未安装检查与 HAP 预览，第二次检查、安装及维护均未执行。归档于 `.verification/app-maintenance-first-preview-precondition-failure-20261004/`。
- 第二轮 18:08:56.7069150Z 至 18:12:02.6743977Z 退出 1：安装版本回读及明确启动已到达，等待合成导出超时；脚本固定 `base/files`，与 fixture 的实际 `base/haps/entry/files` 路径契约不符，未保存当次轮询节点值，不能确定唯一原因。缓存/数据维护未执行，精确自有版本兜底清理后肯定 absent。归档于 `.verification/app-maintenance-second-export-readiness-failure-20261004/`。
- 第三轮 18:17:58.7345827Z 至 18:20:18.7637061Z 退出 1：自有模块路径、导出及两类 marker 正向回读完成，随后清缓存得到 502 `INVALID_RESPONSE`；未保存原始 `bm` 回包或清理后的 marker，不能认定当轮缓存已清或保留，清数据未进入。归档于 `.verification/app-maintenance-third-cache-reply-rejected-20261004/`。

官方 [bundle manager 主源码](https://github.com/openharmony/bundlemanager_bundle_tool/blob/master/frameworks/include/bundle_command.h#L207-L210) 分别定义 `clean bundle cache files successfully.` 与 `clean bundle data files successfully.`，cache 确认不能要求 data 成功行。第四轮使用区分两种返回的源码，报告绑定 `hdc-backend.ts` SHA-256 `2a51ad89463d5f96e0b487c7aa8594dc5c7a69574b527d31a664946c1d4655df`。此源码事实不补作第三轮缺失的原始响应证据。

第四轮之后又加固共同回执解析：仅安装/卸载允许去除标准 `[Info]App install/uninstall path:…msg:` 封套，启动、安装、卸载和两类清理均要求完整成功行；拒绝 `expected msg:`、`permission denied msg:` 伪前缀，并保留标准 `queuesize` 封套支持。加固中首次回归失败已修复，最终 apps/backend/contracts 回归 40/40 通过、零失败，修改范围 lint 与 worker 检查退出 0；匹配回归日志为 `.verification/harmony-app-clean-reply-hardened-regressions-20261004.log`。加固后的 `hdc-backend.ts` SHA-256 为 `338366fe423681346dbf046551e930588427cd61e6f024ddd974f9e43899b61b`，与第四轮源指纹不同；这些后续软件验证不能写成同版应用维护实机整轮通过，也不能写整体目标或发布通过。

## 原生 1.1.17 短测诊断失败（整轮未通过，2026-10-04）

停止状态源码修复后的新一轮短测使用真实 Piora Electron 43.7.7、Next 16.3.8 与 USB API26 手机，于 2026-10-03T17:43:02.2010650Z 开始，至 17:48:03.1956024Z 退出 1。设备绑定的私有 debug 组件为 1.1.17 / 1000117，SHA-256 为 `729d54952a57f97fb5ed9d28604c8514ee4a6c30d4d3f003394e6e14910459c1`；它不是公开发行产物。

本轮在 `native-complete-frame` 的严格 doctor 断言失败：预期 `encoded-video`，实际为 `screenshot`，真实桌面已进入兼容截图回退并保留“video stopped producing frames”原因。归属日志中 PID 9986 在 TCP 观看连接关闭后仍生产编码帧，约五秒后记录正常停止；生产帧计数不能证明 TCP 发送成功、订阅者收齐、解码或绘制成功。doctor 按当前设备 epoch 内最近且不超过五秒的 video/screenshot 接收记录选源，选择截图本身不能证明诊断错误。观看中断与连接关闭的根因尚未确定，现有证据不足以归因于三十秒请求期限、后台录屏拒绝或 Next 补丁。

失败发生在手动停止及后续观看者重连、离开与恢复、媒体并发、MP4 录制阶段之前，未进入后续 60 秒并发和 20 秒录制。不能写整轮通过，也不能写本次停止提示修复已实机通过。STATUS、匹配退出、短测日志、失败诊断、PID 归属日志与制品/源码 manifest 等十份匹配证据归档于忽略的 `.verification/native-1.1.17-short-native-doctor-failure-20261004/`；17:12Z 的旧 `native-complete-frame` doctor JSON/PNG 已明确排除。本次该阶段在写出新 JSON 前失败，后续失败路径将保存 fresh attempt 的有限采样元信息；这不能补作本轮新鲜度证据。清理结束后独立亮屏维护接续。

同期同步至 Next 16.3.8 后的软件检查为：完整 Harmony 回归 490 项，488 通过、0 失败、2 项 Windows 条件跳过（目录分页与符号链接）；十四项生产 C++ 行为检查实际执行通过。实际 ETS VM 与 prepare 回归仍为 34/34 通过；类型检查、Harmony worker 构建、修改范围 lint 及 SDK debug build 均退出 0，lint 仅保留两项既有 warning。这些是软件检查，不能替代本轮未通过的真实手机或最终 CI beta 安装验收。下方各轮记录保持其当时结论，旧 PASS 不作为当前版本已通过的证明。

## 原生 1.1.16 短测停止状态失败（源码已修复，实机待复测，2026-10-04）

普通权限私有调试组件 1.1.16 的真实 Piora 桌面与手机短测于 2026-10-03T17:07:58.3757944Z 开始，至 17:13:35.5059340Z 退出 1。初始化、正常授权拒绝后显式再次请求及两次观看者重连已到达正向断言；手机明确点击停止共享后，新鲜状态却被回写为“等待 Piora 重新连接；持续断开将停止共享”，未通过明确停止状态断言。

本轮新进程 PID 63916 的 HiLog 归属记录与原生日志确认 `StopScreenCapture ret=0`、`capture stopped`，但原生停止成功不能替代手机提示正确。测试保留原断言并严格终止，没有把“等待重连”放宽为“已停止”；后续 60 秒并发媒体阶段和 20 秒 MP4 录制尚未执行，整轮未通过。STATUS、匹配退出记录、短测日志、PID 归属和原生日志元信息保存在忽略的 `.verification/native-1.1.16-short-stop-status-failure-20261004/`。清理结束后亮屏维护接续；该私有调试制品不作为发行产物验收。

随后已修复 `CapturePresence.ets`、`CaptureSession.ets`、`EntryAbility.ets` 与 `MirrorPage.ets` 的请求取消及终态保护，防止手动停止、授权失败或系统后台失败后的迟到连接回调和旧计时器覆盖提示，并区分首次空闲观看连接与替换旧共享会话的期限。实际 ETS VM 行为测试与 prepare 回归合计 34/34 通过；尚未进行修复后新的手机与真实桌面复测，源码回归不能写成实机整轮通过。

下方终端第四轮和双应用数据库第六轮的 PASS 均是 Next 16.3.7、且早于本次四个 ETS 源码修复的结果，只保留为当时事实。当前工作树已同步 Next 16.3.8，原生短测及上述工作台整轮都需要在当前版本重新验证，不能沿用旧 PASS 作为现版本通过结论。

## 双应用数据库第六轮与可见性复验（整轮通过，2026-10-04）

2026-10-03T17:00:22.7340678Z 至 17:06:00.4511990Z，在真实 Piora Electron 43.7.7 开发桌面、实际桌面桥接与同一 USB API26 手机上退出 0。原生确认窗口与页面错误均为 0；两个自有应用的安装、启动及版本回读通过，自动扫描列出 312 个应用。各应用分别发现两份同名数据库，四个不透明库 ID 和应用路径身份互不重复。

通过实际桌面 SQL 分别读取独立标记，刷新产生不同快照 ID、更晚采集时间与正确归属的结果，双份 SHA-256 一致验证成立。主应用采集时间由 17:04:07.204Z 更新到 17:04:23.904Z，次应用由 17:04:35.032Z 更新到 17:04:46.347Z。运行查询、刷新后再查询及调整树宽后，首行单元格全部边界均在窗口、结果表格和内容容器内，中心实际命中单元格，没有让驱动强制滚动结果来代替产品定位；现场数据库截图完整可见两个标记，修复后的源码达到该可见性标准。

两个应用均直接输入其实际 `/data/storage/.../piora-atlas-shared.db` 绝对路径，在文件页打开后路径栏中心仍可命中，跳回数据库页归属正确。数据库树 300→364、文件树 317.625→382 像素的实时拖动、键盘最小宽度与恢复默认均通过。四次真实界面诊断的固定共享目录只读 metadata 和已验证快照检查均通过；画面新鲜度来自兼容截图，仍不证明原生完整编码、客户端解码或绘制。

有界被动工具状态记录未出现边界信号、采集错误、记录丢弃、异常关闭或整个工作台重新挂载，四次诊断后仍可返回数据库。它只说明第六轮未复现第五轮问题，不能追溯认定第五轮原因。初末物理显示 POWER_ON、电源 AWAKE、手机未锁定；两个自有应用停止、卸载后分别独立确认已不存在，亮屏维护接续。匹配报告、日志、退出、数据库/文件页及四组诊断截图与 JSON 位于忽略的 `.verification/dual-database-sixth-passed-direct-operations-20261004/`；此前失败记录保留。本轮不替代原生投屏、独立 AI 控制或最终 CI beta 安装验收。

## 终端第四轮与直接操作实机复验（整轮通过，2026-10-04）

2026-10-03T16:51:20.0998092Z 至 16:55:00.4020661Z，真实 Piora Electron 开发桌面、实际桌面桥接与同一 USB API26 手机完成终端整轮，退出 0。明确点击安装、启动、停止和卸载均返回 200；安装版本回读一致，最终独立确认自有测试应用已不存在。原生确认窗口为 0，页面错误为 0；初末实际物理显示均 POWER_ON、电源服务 AWAKE，锁屏服务确认未锁定。

单次沙箱命令、两个不同 PTY 的目录与环境隔离、隐藏标签搜索、关闭一个标签后另一标签继续、剪贴板与终端原生粘贴进入可编辑预览且不提交正文或 Enter、明确插入不自动回车、多行明确执行、原生历史、实际 Ctrl+C 中断均通过。设备 Shell 退出后点击重连获得第三个新 PTY，能查看上次输出而新环境不继承旧变量；清屏后再运行命令、关闭会话均通过。粘贴预览期间实际存在同 PTY 的 ESC[I/O 焦点回应；逐条与此前启用的 focus-tracking 协议及未禁用状态核对，没有把未知 ANSI 或正文当作可忽略输入，不将本轮称为“没有任何终端输入请求”。

匹配的报告、日志、退出记录与真实桌面截图另存于忽略的 `.verification/terminal-tabs-fourth-passed-direct-operations-20261004/`。前三次失败保留原结论；本轮不替代数据库、原生视频、持续性能或最终 CI beta 安装验收。结束后独立亮屏维护接续。

## 点击直接操作与最新回归（2026-10-04，真实桌面复测继续）

按用户最新要求移除工作台应用、文件、草稿和场景操作的原生确认弹窗；明确的按钮或菜单点击直接提交。安装仍检查预览路径与 SHA-256、替换选择和设备安装回执；草稿仍拒绝删除已变化的版本，场景仍先验证结构和当前控制状态，取消后不派发迟到操作。

完整工作台与应用浏览器流程 2/2、文件草稿与场景浏览器流程 3/3、关联动作与桌面契约 10/10 均通过，实际浏览器交互记录的原生确认窗口为 0。前端与桌面端类型检查以及修改范围 ESLint 通过。直接操作变更后的完整 Harmony 回归于 2026-10-03T16:47:58.0324130Z 退出 0：449 项、448 通过、1 项既有 Windows 目录边界跳过、0 失败，其中十四项生产 C++ 行为检查实际执行通过。以上均为本机源码检查，不能替代真实手机或最终 beta 验收。

第五轮真实 Piora Electron 开发桌面与 USB 手机流程从 2026-10-03T16:29:29.4361460Z 运行至 16:34:28.5475751Z，退出 1。两个自有应用经实际安装、启动和回读成功，312 项应用扫描完成；首个数据库打开并完成诊断 API 的元信息核对后，诊断界面的“检查设备”按钮不可见，现场截图显示工具区关闭。该轮尚未执行新增 SQL 结果单元格完整可见条件，不能写成 SQL 条件通过或失败。关闭原因尚未证实，保留日志、退出记录和现场截图于忽略的 `.verification/dual-database-fifth-doctor-panel-closed-20261004/`。两个自有测试应用均已确认不存在，随后独立亮屏维护恢复；下一轮增加被动工具状态诊断，不抑制用户操作或放宽可见性条件。

设计中的安装页及完整功能说明已同步直接操作要求，25 页共 200 个宽度/明暗布局和 8 项本地交互重新检查通过。设计图是示意，不是实际桌面或手机证据。未提交、推送或发布；最终 CI 产物的签名、安装和实机验收仍未完成。

## 双应用数据库第四轮与文件预览定位复验（本项整轮通过，2026-10-03）

第四轮于 2026-10-03T15:37:54.5655018Z 至 15:43:08.6048592Z，在真实 Piora Electron 43.7.7、实际 desktop bridge 与同一 USB API26 手机上退出 0。它在文件预览定位修正后重新执行双应用数据库整轮，不替代终端、原生视频和发布包验收。下方前三轮结果保留为各轮当时事实；第三轮的报告、退出、日志和截图另存于忽略的 `.verification/dual-database-doctor-passed-before-reveal-20261003/`，第四轮当前证据位于 `.verification/harmony-desktop-dual-databases-report.json`、匹配的 `-exit.json`、日志及数据库/文件截图。

两个自有调试应用 `dev.piora.audio.fixture` 与 `com.ohos.scrcpy.server` 的 1.0.4 包安装、启动均返回 200；自动发现各应用的两份同名 `piora-atlas-shared.db`，共四个不透明数据库 ID 和四个应用路径身份互不重复。真实 SQL 查询及桌面 DOM 回读分别确认 `piora-owned-primary`、`piora-owned-secondary` 归属正确；刷新后仍能查询对应标记，双份 SHA-256 一致验证成立。主应用采集时间从 15:41:13.725Z 前进至 15:41:57.029Z，次应用从 15:42:05.436Z 前进至 15:42:13.574Z（均为本日 UTC）。

两个应用均通过直接输入其显示的 `/data/storage/el2/base/haps/entry/files/piora-atlas-shared.db` 完整绝对路径定位文件，预览后路径输入仍可见，文件跳回数据库页仍属于正确应用。实际文件截图 `harmony-desktop-dual-files-primary.png` 与 `harmony-desktop-dual-files-secondary.png` 可见应用选择、面包屑、路径输入、“前往”和数据库打开操作，路径已归一化为沙箱相对表示。数据库截图 `harmony-desktop-dual-database-primary.png` 与 `harmony-desktop-dual-database-secondary.png` 可见更新后的采集时间、SQL 编辑器、“查询结果 1 行”和表头，但首行单元格被工具容器下沿裁切，不能作为截图完整展示独立标记的证据；该视觉限制仍保留，标记与刷新结论来自实际查询和 DOM 回读。

数据库树在鼠标释放前从300增至364像素，文件树从317.625增至382像素；键盘调到最小宽度220/160像素及恢复默认均通过。两个自有应用停止、卸载后分别独立确认已不存在，页面错误为零。

四次诊断均由真实工作台界面触发，固定共享临时目录的只读 metadata 访问为 passed，不返回目录条目；数据库快照检查均为 passed、active=1，包含本机副本建立、验证和到期时间，`realtimeDeviceData=false`。刷新后的建立/验证时间前进。检查结果不包含原始数据库路径、SQL、库 ID 或数据行；这些限制针对诊断输出，不把整个验收报告中的自有样本信息称为脱敏诊断输出。

| 诊断阶段 | 画面新鲜度事实 | 数据库快照首次验证时间（本日 UTC） |
| --- | --- | --- |
| 主应用打开 | unknown；本次诊断约40秒后完成，最近画面已超过五秒，诊断未请求新画面 | 15:41:13.725Z |
| 主应用刷新 | passed；source=screenshot，接收于15:42:01.370Z，age=762ms | 15:41:57.028Z |
| 次应用打开 | passed；source=screenshot，接收于15:42:09.352Z，age=1110ms | 15:42:05.436Z |
| 次应用刷新 | passed；source=screenshot，接收于15:42:17.671Z，age=1116ms | 15:42:13.574Z |

四份 `harmony-doctor-actual-dual-*-20261003.png` 与对应 JSON 保留真实界面和有限 metadata。首个 unknown 未改写为 passed；其余三次来自兼容截图，`provesClientDraw=false`，不证明原生完整编码帧、客户端解码或绘制，本轮也没有用配置或配置路径推断这些能力通过。

本轮四次诊断记录相同的源码 SHA-256，绑定以上现场结果：

| 源文件 | 报告记录的 SHA-256 |
| --- | --- |
| `lib/harmony/device-manager.ts` | `2ec2104fd194547f9eb226c4f0eb353cb871c55ffc24bdb0a617b6d0cc9ce4fd` |
| `lib/harmony/sqlite-inspector.ts` | `d71bb5aa964987e3e0717880ff6a5aefcfda0a5582434d43c5955dd92800c1a2` |
| `app/api/harmony/capabilities/route.ts` | `d74c24b5daaabffca419339868080a5b775ad3154b4bd5d8ca7ce17a0c3fa17c` |
| `components/workspace/harmony/WorkbenchTools.tsx` | `242927026dbe0820d9fa9c75a861c6cf333d50e6a4ac5502676dbfdc5117fd8d` |

## 当前整合与真实桌面复测（整轮未通过，2026-10-03）

双应用数据库的第三轮已于 2026-10-03T15:22:53.580Z 至 15:28:10.930Z 在真实 Piora Electron 43.7.7、实际 desktop bridge 与同一 USB API26 手机上整轮退出 0。自动扫描完成并返回312个应用；两个自有调试应用各发现两份 `piora-atlas-shared.db`，四个不透明 ID 和应用路径身份互不重复。分别通过桌面 SQL 查询实际回读各应用独立标记，刷新生成新快照 ID 与更晚的采集时间，双份 SHA-256 一致校验成立；直接输入应用显示的 `/data/storage/...` 完整路径即可在文件页打开，两个文件跳到数据库页后仍属于正确应用。数据库树300→364像素、文件树317.625→382像素在鼠标释放前实际变化，Home/Enter最小宽度及恢复默认通过。四次真实界面诊断确认固定共享目录 metadata 可读、已验证快照存在和刷新建立时间前进，不返回目录条目、路径、SQL或数据库身份；本轮画面证据来自兼容截图，不称原生编码通过。停止、卸载及独立设备回读确认两个自有应用已不存在，页面错误为零，随后独立维护接续确认亮屏未锁定。报告、退出、日志、实际数据库/文件页及四份诊断截图位于忽略的 harmony-desktop-dual-databases* 与 harmony-doctor-actual-dual-*。

第二轮于15:14:26.160Z至15:18:51.183Z已完成双应用开库/查询/刷新、数据库树调整和首个应用绝对路径定位，但在文件树拖动断言退出1；不能回改为通过。文件预览使较长分隔条顶部滚到固定工具头附近，旧驱动取顶部加80像素，未先验证该点是否能点中分隔条。第三轮改为真实 elementFromPoint 选点，并要求 data-resizing 成立后继续保留严格64像素实时宽度断言，文件树实测通过。第二轮原日志、退出、失败图与数据库图保留在忽略的 dual-database-file-resize-failure-20261003。第三轮实际截图另暴露预览自动滚动带走地址栏的体验问题，正在做最小定位修正；修改后仍需重跑上述完整真实验收。

本轮诊断补齐以连接和设备 epoch 记录完整编码帧的接收时间，配置只作为尺寸元信息；关闭最后一路收到画面的连接后，仍开着但只有配置的连接不能维持“有画面”结论。固定共享目录的只读第一页访问直接使用既有诊断队列，结果不包含设备条目；SQLite 快照只有初次 worker 验证成功才进入可用统计，验证失败或已经关闭后的迟到回复不复活快照。二十三项新增行为测试、九十六项关联回归、四文件 ESLint、diff 检查及最终独占根类型检查通过；上述双应用整轮提供兼容截图、共享目录和已验证快照的现场证据，原生完整编码帧与未收帧基线仍待验，不将本机测试记为通过。

新的终端整轮在真实 Piora Electron 开发桌面端及同一 USB 手机上执行两次。首轮 2026-10-03T14:45:18Z 至 14:49:52Z，展开工具页的截图已保存，测试应用安装、版本回读与启动均成功；等待第一条沙箱命令响应超过三十秒，退出 1。第二轮先通过不派发设备命令的 GET /console 405 编译预热，再于 14:52:12Z 至 14:55:46Z 运行；单次命令、两个独立 PTY 的目录与环境隔离、隐藏标签搜索、关闭一个标签后另一个继续均到达正向断言。粘贴内容确实进入可编辑草稿，但随后全部终端输入请求计数 695 与此前 694 不一致，退出 1；尚未确认新增请求来自剪贴板正文还是 xterm 自动协议回应，不能把这一轮改为通过或笼统忽略 ANSI。两轮均确认自有测试应用已不存在，并接续独立亮屏维护。失败日志、退出、真实界面截图及第二轮请求时序分别保留在忽略的 terminal-tabs-first-command-timeout-20261003 与 terminal-tabs-clipboard-input-count-20261003。

同名数据库双应用的首轮新验收脚本在 14:57:34Z 至 14:59:40Z 运行，产品安装包预览返回 200；脚本错误读取 package 字段，而实际接口返回 preview，因而在进入安装前退出 1。已修正脚本并按真实接口再次梳理后续快照、查询、文件关联和树宽度断言；第三轮以实际运行提供通过证据，上述首轮仍保持失败，脚本修正本身不作为手机数据库通过。

源码整合已补齐文件与数据库树拖动和键盘调宽、按设备宽度记忆及数据库标签隔离；五项独立浏览器检查通过。GUI 截图和录像改为独立只读媒体通道并记录实际任务阶段，134 项相关离线回归通过；投屏同连接的旧解码器输出与错误回调增加配置代际保护，十七项 hook 回归通过。这些检查不替代实机并发录像、横屏、持续性能或最终 beta 验收。25 页设计图及功能说明同步完成，独立设计检查覆盖 200 个布局和八组本地交互，不作为产品或手机验收证据。

发布审查确认当前 beta 流程仍只复制旧 1.0.3 投屏 HAP，不编译新增普通权限源码；发行组件的构建、适用签名、源码与制品关联以及实际 beta 安装验收尚未完成。没有提交、推送、发布新版本或将私有设备调试签名包当作发行包。

## 连接恢复与亮屏维护（已重新核对，2026-10-03）

本日重新连接同一 USB 手机，先核对并清理上一轮中断测试留下的 com.ohos.scrcpy.server 1.1.13 与 dev.piora.audio.fixture 1.0.0，独立确认两者已不存在。随后连接再次短暂离线、通信通道未就绪；没有重试效果不明的第 359 次写动作，也没有重启或提升手机权限。电脑端 HDC 连接恢复后，新的独立维护每十五秒检查并续期三十分钟屏幕超时，持续期限为八小时，交接给实机测试时保留临时超时；它不安装应用、不输入密码、不操作应用控件。

2026-10-03T14:36:08Z 的独立读回确认物理屏幕 Display ID 0 的 ScreenPowerState 为 POWER_ON、PowerManager 为 AWAKE，锁屏服务确认未锁定。维护已连续三十二次取得相同正向状态。本机固件的 ScreenlockService 同时仍报告 screenState=false，与用户确认亮屏和独立物理显示、电源状态不一致；后续验收使用绑定同一真实物理屏幕的显示电源状态及未锁定状态，并保留这个不一致字段，不能把缺失响应或 HDC 零退出错误当作亮屏成功。该准备过程不等于功能整轮通过；此前失败证据仍保留。

最新终端生命周期源码已修复结束尚未确认时重开、重复停止、卸载中的迟到启动及隐藏标签焦点。独立浏览器行为检查与原 PTY 检查合计九项通过，尚未作为真机多标签通过；中文与 JSON 转义粘贴的路由预算及原后端隔离共八项回归通过，完整输入仍保留 16384 字符上限。两个私有同名数据库样本在该准备阶段已成功构建并记录各自 SHA-256，当时仅完成新整轮桌面脚本准备，尚未安装或实机验收；后续实际安装与整轮复验已完成，第四轮结果见本文开头。

## 当前源码持续观看绘制停顿（未通过，2026-10-02）

下一轮时序诊断于 2026-10-01T23:09:05.8968120Z 启动，仍使用同一 1.1.13 产物、真实 Electron 43.7.7、普通授权，以及三十分钟和五百次动作原标准。2026-10-01T23:15:29.228Z 的实际采样显示当前解码器输入及输出各 2171 帧，队列峰值 9；第二次积压后到下一关键帧的实际等待为 3558.4 毫秒，对应最大解码输出间隔 3470.1 毫秒。记录中的关键帧间隔中位数为 5407.5 毫秒、最大 6050.5 毫秒；桌面页面可见，事件循环采样最大间隔 612.9 毫秒。源码在队列超过八帧时停止接收当前依赖帧组，直至下一个关键帧，这些证据支持检查该恢复策略，但不能单凭本轮的时序关联认定上一轮 5732.5 毫秒停顿的原因。

该轮于 2026-10-01T23:53:07.3136404Z 退出 1：持续原生观看 2401.144 秒、完成 358 次精确动作回读后，下一次动作的后置树观察返回 502 / COMMAND_FAILED。最后进度已核对 72 次亮屏、未锁定检查；最大解码输出间隔为 4631.3 毫秒。本轮未触及五秒绘制失败上限，但 USB 随后实际离线，Windows 未检测到手机，不能将这轮记为五百次动作或录像通过。该动作可能已经执行，不自动重试；测试应用清理及随后的独立亮屏维护也未确认，离线后的亮屏状态未知。真实桌面进程已退出，等待 USB 恢复后仅核对并清理本轮安装的两个已知版本，再接续独立维护。

日志、匹配退出、持续进度、原始时序采样、失败和最终渲染器状态，以及分析结果均归档为忽略的 harmony-desktop-video-timing-usb-offline 文件。时序分析合并各次采样中的关键帧时间，避免把已被滚动缓冲淘汰的早期关键帧误当作长等待；只保存时序、计数及窗口状态，不保存视频帧或设备内容。第二次后续积压到下一关键帧的等待为 4732 毫秒，对应最大输出间隔 4631.3 毫秒，支持检查短暂积压后丢弃整个依赖帧组的恢复策略，但不能解释 USB 物理离线原因。

隔离 debug 1.1.13（SHA-256 407712db6d42d9c3019a3d7fc8e8793eb664ca0b4f3587ab5c3a3a471c651246）的真实桌面整轮运行于 2026-10-01T22:48:05.8426145Z 至 2026-10-01T22:55:07.5521898Z，退出 1。拒绝授权后无自动再次请求、明确重新授权、两次观看重连、离开面板后实际停止采集和重新授权恢复、STARTED 后后台任务及另一自有应用前台的像素更新通过。持续阶段严格回读二十一次动作，173.170 秒后检测到最大画布绘制间隔 5732.5 毫秒，超过五秒上限；没有完成三十分钟、五百次动作或录像。

失败时画面已经恢复，仍为真实 1080×2386 原生视频，未发生该阶段的视频重连或兼容截图回退；已确认四次亮屏、未锁定检查。原生每三十帧日志继续到 #3120，桌面服务未报告退出、内存上限或未捕获异常；这些事实不能单独证明停顿来源。保留五秒上限，后续需区分网络输入、解码队列、桌面事件循环和绘制停顿。失败日志、匹配退出、进度和原生/TCP 日志归档为忽略的 harmony-desktop-encoder-cleanup-paint-gap-failure 文件。自有测试应用清理后独立亮屏维护继续运行；此前 1.1.8 长测仍只证明对应旧产物，不能替代当前源码持续性能验收。

## 解码积压与交互终端补齐（源码已实现，真机待验，2026-10-02）

实际时序检查后，投屏改为先等待解码队列退回安全范围，最多一秒；短暂积压继续接收同一依赖帧组，持续积压才丢弃直到新关键帧。等待同时响应当前连接的取消，返回后重新核对连接、解码器及配置状态，旧等待不能恢复旧设备画面；关键帧也遵守积压上限。四项行为回归覆盖短暂恢复、超时丢弃、退出取消及关键帧边界。

设备 Shell 增加最多八个独立会话标签。同一标签重复启动复用自身会话，其他标签保持各自工作目录与环境；关闭和改变范围只影响目标会话，控制失效清理全部对应会话。统一搜索能定位隐藏标签，标签提供键盘导航、状态与明确目标。断线保留输出，明确重连后创建新会话并保留上一份文本；补充清屏与实际 Ctrl+C。复制和粘贴复用 Piora 桌面剪贴板通道。按钮及原生终端粘贴事件均先进入可编辑草稿，单行填入不追加回车，多行执行必须明确点击执行，超长或控制字符文本不直接发送。

源码整合后的 21 项相关回归、根项目类型检查及六个相关源码文件的 lint 通过；随后完整工作台静态与浏览器四项检查也通过，真实 Piora 桌面验收仍待完成。新的双会话验收脚本要求真实环境与目录隔离、隐藏标签搜索、关闭一个后另一个继续、实际桌面剪贴板和原生粘贴事件不自动发送、命令历史、中断、断线文本与新会话状态、清屏后继续执行全部成立。以上不作为真机已经通过的声明。同名库双应用在本日准备及构建阶段仍未安装到手机；后续实际验收见2026-10-03各轮记录。

## 工作台工具布局与测试间亮屏维护（2026-10-02）

截图、录像与停止入口已移至工作台公共工具栏，展开文件、数据库或命令页时仍可访问。所有工具页展开后使用完整工作区，隐藏被遮挡的投屏视野；恢复后重新显示只读画面。数据库尚未选择时应用树使用完整高度；命令范围补充明确的可访问名称。四项浏览器回归、根类型检查及相关 lint 通过，不能替代以下真实桌面验收。

首轮真实沙箱终端验收因“范围”控件可访问名称不明确而失败，未记通过；实际应用及桌面测试进程已清理，原日志、退出记录与界面截图保留为忽略的 harmony-desktop-sandbox-terminal-scope-label-failure 文件。修复后的完整验收要求真实展开宽度、展开时实际截图保存、沙箱单次命令、交互式 Shell 的持续环境与工作目录全部通过。

修复布局后的第二轮运行于 2026-10-01T22:26:24.4079751Z 至 2026-10-01T22:28:59.0672142Z，退出 1。展开命令页、实际截图保存、沙箱单次命令及交互 Shell 环境变量通过；测试将应用内部绝对路径用于 HDC debug 沙箱，实际返回 Permission denied，工作目录保持 debug 挂载根。失败日志、退出记录和真实截图归档为忽略的 harmony-desktop-sandbox-terminal-absolute-path-failure 文件。后续脚本改用沙箱相对路径，并通过真实单次 pwd 回读确定挂载根，继续严格验证持续 Shell 的最终工作目录；不能将该轮记为整轮通过。

正确使用沙箱相对路径后，真实 Piora Electron 43.7.7、desktop bridge 与 USB API 26 手机在 2026-10-01T22:31:01.3217653Z 至 2026-10-01T22:33:31.8723998Z 完成整轮，退出 0。命令工具页及工作区实际宽度均为 1424 像素；展开状态下截图返回 200 且生成非空图片。单次沙箱命令回读真实标记，交互式 Shell 保留环境变量，并独立回读相对目录切换后的完整 debug 挂载路径。关闭 Shell、停止及卸载应用均返回 200，独立检查自有应用已不存在，页面错误为零；手机检查亮屏且未锁定。报告、实际界面截图与匹配运行记录为忽略的 harmony-desktop-sandbox-terminal-report.json、harmony-desktop-sandbox-terminal.png、harmony-desktop-sandbox-terminal.log、harmony-desktop-sandbox-terminal-exit.json。本轮不覆盖无线调试或已发布 beta 安装包。

经用户授权的测试准备恢复亮屏后，独立维护连续二十次确认未锁定。交接时先结束自有维护应用并确认清理，再保留临时亮屏超时供下一轮接续；此前维护失败仍保留在下文。此维护只属于明确授权的实机测试，产品被动投屏不自动唤醒或解锁手机。

## 编码失败后的旧画面连接清理（失败恢复已通过，持续观看待验，2026-10-02）

针对横屏诊断中编码器反复错误而旧画面仍显示实时的问题，正式源码的编码错误回调现进入异步清理队列，合并同一会话的重复错误，核对真实编码器或采集对象以及会话 epoch，避免旧回调结束新会话。停止采集时清除配置并关闭旧视频订阅，由 IO 循环回收连接；不在系统回调内释放资源，不自动再次请求授权。桌面回归确认收到连接结束后立即撤销旧画面的实时状态及坐标校准，遵守重连退避，并只在新连接实际取得新尺寸帧后恢复实时状态。

相关观看、后台任务及隔离源码回归通过。当前源码隔离 debug 1.1.11 的 ArkTS/C++ 编译和签名通过，HAP SHA-256 为 91bf8726a7a0cecd2b13a78eb131410ca66b46ce0c75bab61f3f9dd56c6cdd8f，构建日志为忽略的 ordinary-mirror-encoder-cleanup-debug-build.log。此前 1.1.8 的五百次动作报告只证明改动前的对应产物；新源码必须重新完成真实失败恢复与持续原生观看。新的五百次动作、至少三十分钟观看及录像启动脚本已准备，尚未启动；最初构建时手机锁定，后续测试准备已恢复亮屏并继续维护。

运行中编码尺寸探测另保留在隔离 debug 1.1.10，编译通过，HAP SHA-256 df117df540d755f46f6fbdb88942b133b234d19623bcfc6b8d9120123a90c836。该实验监听实际默认屏幕变化并调用运行中编码器参数接口，记录接口返回值与编码输出描述，不修改 transport 尺寸冒充成功；尚未进行真机旋转验收，也未引入正式源码。

接口边界已重新核对官方 [录屏场景配置](https://github.com/openharmony/docs/blob/master/en/application-dev/media/media/avscreencapture-c-custom-scenarios.md) 与 [视频编码器接口](https://github.com/openharmony/docs/blob/master/en/application-dev/reference/apis-avcodec-kit/capi-native-avcodec-videoencoder-h.md)：跟随旋转策略调整采集虚拟屏幕，不能据此认定固定尺寸编码器同步支持变化；SetParameter 要求已运行且可能因不支持的参数失败。以上为实验必须核对实际编码帧的依据，不是设备支持动态尺寸的结论。

新清理逻辑的首轮真实桌面恢复验收使用隔离 debug 1.1.12（SHA-256 eddfcc5b57aeb630ae1d86e8d8f7c2501475be550c67af38b5c1a8972ad5e29a），运行于 2026-10-01T22:34:37.9200728Z 至 2026-10-01T22:38:32.2669569Z，退出 1。安装、版本回读、正常共享授权及手机前六十帧编码通过；连接随后结束，桌面退回兼容画面，未达到原生实时状态，未进入预期的旋转编码失败检查。检查发现无采集资源的启动前清理也关闭了等待授权的订阅；源码已限制为确实持有采集或编码资源的停止才关闭连接，但该修复仍须新的实机整轮证明。失败日志、退出记录、真实截图及原生/TCP 日志保留为忽略的 harmony-desktop-encoder-bootstrap-disconnect-failure 与 ordinary-mirror-encoder-bootstrap-disconnect-failure 文件。自有应用清理后亮屏维护继续确认未锁定，不记原生恢复通过。

修复启动前清理后的隔离失败探测包 1.1.14 编译及 debug 签名通过，SHA-256 为 9460efa65353fec81951e884bcbe0e7d1ed085c302cae0b95ae4e2558ddfac23；24 项相关回归、根类型检查通过。真实 Piora Electron 43.7.7 与 USB API 26 手机整轮运行于 2026-10-01T22:42:48.7540127Z 至 2026-10-01T22:46:06.9502297Z，退出 0。首次原生观看、普通授权、STARTED 后后台任务及第二个自有应用前台的新像素通过；实际手机旋转至 2688×1216 后，当前编码进程 13048 报告真实错误 10 并停止采集。桌面撤销旧原生实时状态，保留失败原因，随后实际兼容截图恢复。重新恢复竖屏，自有应用清理且独立设备检查均不存在，页面错误为零，手机亮屏且未锁定，随后接续独立维护。

该轮报告明确记录 nativeRotationAccepted=false、recordingAccepted=false，不能作为原生横屏或录像通过。归档报告、日志、匹配退出与原生日志为忽略的 harmony-desktop-encoder-bootstrap-fixed-recovery-report.json、harmony-desktop-encoder-bootstrap-fixed-recovery.log、harmony-desktop-encoder-bootstrap-fixed-recovery-exit.json、ordinary-mirror-encoder-bootstrap-fixed-recovery-native.log。不带旋转实验的当前源码隔离 debug 1.1.13 也已编译和签名通过，SHA-256 为 407712db6d42d9c3019a3d7fc8e8793eb664ca0b4f3587ab5c3a3a471c651246；它将用于新的三十分钟、五百次动作和录像验收，不使用此前 1.1.11 的启动缺陷产物。

## 首台手机上传与下载中途取消（已通过，2026-10-02）

真实 Piora Electron 43.7.7、desktop bridge 和 USB API 26 手机在 2026-10-01T21:32:16.7601554Z 至 2026-10-01T21:35:47.9642921Z 完成整轮，退出 0。使用自有 1 GiB 合成文件，先独立观察设备上传暂存文件实际增长至 12,558,330 字节，再通过桌面取消；任务进入 cancelled，已确认文件及字节均为零，保留中断动作结果不明的说明，设备目标与暂存文件均消失。随后小文件上传完成，独立设备回读内容一致，证明取消后仍可继续传输。

下载阶段独立观察本机未完成暂存文件达到 4,604,721 字节，再通过桌面取消；任务进入 cancelled，本机未发布目标且暂存目录已清理，手机源文件保留。测试结束前确认亮屏、未锁定，页面错误为零；自有设备目录和本机目录清理均确认。原始报告、日志及匹配退出记录为忽略的 harmony-desktop-transfer-cancel-report.json、harmony-desktop-transfer-cancel.log、harmony-desktop-transfer-cancel-exit.json。该轮结束后的独立亮屏维护未成功接续，随后观察到锁屏；不能将测试内亮屏检查扩展成测试间维护已通过。

## 首台手机横屏编码输入错误（未通过，2026-10-02）

补齐手机明确共享确认后，隔离 debug 1.1.9（HAP SHA-256 2950389e8200c488aee450b750faab766e6d8518f1c4874673f46f35a20a8acb）在真实 Piora Electron 与 USB 手机运行于 2026-10-01T21:26:31.0833059Z 至 2026-10-01T21:29:38.2149692Z，退出 1。竖屏原生视频、普通共享授权、实际 STARTED 后后台任务以及另一自有应用前台的画面更新通过。手机实际转为 2688×1216 横屏，但原生画布停在旧的 1080×2386 竖屏帧，严格二十秒横屏尺寸等待失败；尚未进入录像步骤。

原生日志确认跟随旋转策略、应用策略、释放策略及 STARTED 后 SetCanvasRotation 均返回 0；旋转后编码器反复报告错误 10，本机 SDK 定义为 AV_ERR_INPUT_DATA_ERROR，未取得可用的新横屏编码帧，也没有收到已注册的内容区域变化回调。不能以 API 返回成功、CSS 旋转或兼容截图代替原生视频通过。该轮恢复竖屏并清理自有应用。日志与退出记录为忽略的 harmony-desktop-rotation-119-encoder-input-failure.log、harmony-desktop-rotation-119-encoder-input-failure-exit.json、ordinary-mirror-rotation-119-encoder-input-failure-native.log；实际画布和手机截图分别为 harmony-ordinary-mirror-landscape-native-canvas.png、harmony-ordinary-mirror-phone-landscape.png。正式 1.1.8 未引入此实验，后续需解决编码尺寸适配及编码错误后陈旧画面仍显示实时状态的问题。

## 横屏首轮启动脚本遗漏确认（未通过，2026-10-02）

隔离 debug 1.1.9 的首轮真实桌面启动于 2026-10-01T21:20:45.7697467Z，结束于 2026-10-01T21:24:34.8668658Z，退出 1。只读重试、组件安装及版本回读通过，但启动脚本没有设置前台共享确认步骤，未完成手机明确授权，随后兼容截图恢复；实时视频等待超时，未进入横屏检查。已补齐该脚本配置；不能由此判断旋转 API 成功或失败。日志和退出记录归档为 harmony-desktop-rotation-missing-consent-flag.log、harmony-desktop-rotation-missing-consent-flag-exit.json。自有应用清理后恢复亮屏维护，正式 1.1.8 源码没有该旋转实验。


## 首台手机活动数据库拒绝与关闭后恢复（已通过，2026-10-02）

修复零字节 WAL 误拒绝后，使用同一隔离 debug 应用 1.0.1（HAP SHA-256 ba388d4de62e5bcf3c39e59279784fcbfd6b43fc96b5ce2c08cff874513b3bc5）在真实 Piora Electron 与 USB API 26 手机上重跑原先失败的完整流程，2026-10-01T21:12:26.0211556Z 至 2026-10-01T21:17:05.7027517Z，退出 0。按应用自动发现五个数据库条目；产品树引用动作启动实际系统写入，计数从 5 增至 21；非空 WAL 返回 501、没有快照或结果，中文界面显示真实一致性原因。加密数据库发现与拒绝、普通系统备份的表/视图/索引、精确大整数/BLOB SQL、刷新快照时间、JSON 导出、完整路径跳转与文件树数据库关联同轮通过。重新选择失败数据库后，上一份备份的校验状态被清除。

通过产品动作停止写入并关闭数据库，重新打开返回 200，三次日志检查及双份 SHA-256 和 SQLite 校验完成，采集时间为 2026-10-01T21:16:49.442Z；实际桌面 SQL 查询回读 638 次提交并显示对应单元格。自有应用停止及卸载均返回 200，独立设备检查确认不存在，页面错误为零；整轮后独立亮屏维护继续运行。报告、日志、匹配退出记录归档为忽略的 harmony-desktop-active-empty-wal-fixed-report.json、harmony-desktop-active-empty-wal-fixed.log、harmony-desktop-active-empty-wal-fixed-exit.json。原失败记录保留。此结果不代表非空 WAL 已获得通用一致快照支持，也不覆盖另一份正在写入时生成备份的完整桌面流程、跨设备、横屏或最终 beta 安装。


## 首台手机应用数据库扫描三种生命周期（已通过，2026-10-02）

真实 Piora Electron 与 USB API 26 手机从 2026-10-01T20:48:59.7172616Z 至 2026-10-01T20:54:39.8566620Z 完成整轮，退出 0。通过桌面端安装并回读自有 debug 应用 1.1.8；该应用未创建数据库。三次独立重新扫描分别验证：应用未运行时“无法完整扫描”并说明沙箱无法访问；明确启动、确认实际前台后“确认无数据库”；明确停止后再次“无法完整扫描”。每次均核对不同扫描时间、真实桌面状态及独立设备进程，扫描没有新增设备动作或自动启动应用。

三轮扫描时间分别为 2026-10-01T20:50:26.201Z 至 2026-10-01T20:51:33.867Z；2026-10-01T20:51:53.147Z 至 2026-10-01T20:53:19.038Z；2026-10-01T20:53:22.837Z 至 2026-10-01T20:54:23.050Z。应用停止及卸载均返回 200，设备确认自有应用不存在，页面错误为零；退出后恢复独立亮屏维护。报告与运行日志为忽略的 harmony-desktop-database-empty-report.json、harmony-desktop-database-empty.log，匹配退出记录为 harmony-desktop-database-empty-exit.json。此结果仅覆盖该普通权限手机的应用扫描状态，不代替活动 WAL 快照恢复或最终 beta 安装验收。


## 首台手机活动数据库与关闭后 WAL 边界（整轮未通过，2026-10-02）

真实 Piora Electron 与 USB API 26 手机在 2026-10-01T20:42:56.2169668Z 至 2026-10-01T20:47:03.9531361Z 执行隔离 debug 应用 1.0.1（HAP SHA-256 ba388d4de62e5bcf3c39e59279784fcbfd6b43fc96b5ce2c08cff874513b3bc5）。实际产品树引用动作启动系统 RDB 持续写入，观察计数从 5 增加到 20，实际 WAL 存在；自动扫描按应用发现五个数据库条目。加密样本禁止打开；活动 WAL 返回 501 / CAPABILITY_UNAVAILABLE，未产生快照或结果，真实中文界面显示一致性拒绝与备份建议。同轮一致备份的 SQL、表/视图/索引、精确大整数与 BLOB、刷新时间、JSON 导出、完整文件路径跳转和数据库关联通过。再次打开活动库后，上一份备份的校验状态被清除。

通过产品动作停止写入并关闭 RdbStore 后，系统仍保留 WAL，直接重新打开继续返回 501；脚本预期 200，因此退出 1，不记整轮通过，不删除 WAL 或绕过一致性检查。自有测试应用已清理且设备确认不存在，恢复独立亮屏维护。失败日志和匹配退出记录为忽略的 harmony-desktop-active-close-retained-wal-failure.log 与 harmony-desktop-active-close-retained-wal-failure-exit.json。恢复提示已改为明确说明关闭后也可能保留日志文件；8 项相关回归、根类型检查与相关 lint 通过，新的真机恢复整轮仍待验证。

应用一致备份的依据为 [OpenHarmony 数据备份与恢复](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/database/data-backup-and-restore.md) 及本机 SDK 的 RdbStore.backup() 接口。该应用内部能力不是 Piora 对任意第三方应用的备份授权；数据库工作台仍只读。


后续独立 HDC 诊断（2026-10-01T21:07:34.9452793Z 至 2026-10-01T21:07:59.1837294Z，退出 0）仅准备自有合成应用，不替代桌面验收。实际源 WAL 在写入时为 53,592 字节，备份后继续增长为 210,152 字节；关闭后主文件从 4,096 增至 12,288 字节，WAL 保留但大小为 0。标准目录和模块 files 中的系统备份均为 12,288 字节，没有同名 WAL。原始目录事实为忽略的 harmony-owned-wal-physical-facts.json。此前备份桌面轮也退出 1，其等待条件未按请求的数据库 ID 筛选，可能接收恢复标签的另一条 open 响应；已收紧为精确备份 ID，保留 harmony-desktop-active-backup-journal-failure.log 及退出记录，不能把这一假设当作该轮通过。

设备快照现允许三次检查均为已知零字节普通文件的 WAL，仍要求主文件元数据、两份 SHA-256 与 SQLite quick_check；非空或大小不明 WAL、rollback journal、复制期间日志增长均拒绝，不删除或写入设备日志。11 项数据库/错误回归、根类型检查和相关 lint 通过。原先关闭后读取失败的完整真实桌面流程已重新通过，见本页开头；新的备份流程仍需另行完成。依据 [SQLite WAL 工作机制](https://www.sqlite.org/wal.html)，零字节 WAL 不含日志帧；该边界与主文件重复校验结合使用。

## 首台手机持续原生投屏与五百次动作（已通过，2026-10-02）

正式源码 1.1.8 对应隔离 debug HAP `6d09a8161b5816d60dabb5200e71644064ba17224d88aab3b5171ad780e57fff`，在真实 Piora Electron 43.7.7 与 USB API 26 手机上完成整轮，进程退出 0。原生观看 3332.957 秒（55 分 33 秒），产品树引用及 `tap_ref` 派发的 500 次动作全部取得精确新计数 `Actions: 500`，画布实际绘制 36459 次，稳定阶段新增兼容截图回退为零。100 次独立检查全部亮屏、未锁定；最大绘制间隔 2.856 秒包含初次冷编译，后续未增加。动作耗时包含多次树观察与调度内复核，中位数 6.412 秒、P95 6.722 秒、最大 27.409 秒，不能把这些值当成视频帧延迟或仅点击注入耗时。

同轮还通过明确拒绝后再次授权、两次观看连接刷新、关闭面板八秒后实际停止采集及新明确授权恢复、另一自有应用前台时继续观看、视频中截图，以及停止录像后继续观看并再次截图。实际录像准备至停止 20.064 秒，保存 MP4 20.334 秒、576425 字节，差值 0.269 秒；206 个编码包没有小于一毫秒的间隔，实际 Electron 解码 29 帧，跳转后收到约 2.081 秒处的帧。两份自有应用停止、卸载均返回 200，设备分别确认不存在，页面错误为零。

本轮运行时间为 `2026-10-01T19:29:02.3054401Z` 至 `2026-10-01T20:29:09.4343210Z`。原始报告、原生日志、后台任务日志和最终进度分别归档于忽略的 `harmony-desktop-background-final-long-report.json`、`ordinary-mirror-background-final-long-native.log`、`ordinary-mirror-background-final-long-task.log` 和 `harmony-desktop-background-final-long-progress.json`，退出记录与运行时间一致。整轮清理后已恢复独立前台亮屏维护，没有再次请求共享授权。本轮不覆盖横屏、Wi-Fi、其他设备、公开发行签名、随包 HAP 替换或最终安装 beta 包。

## 早期持续投屏失败与排查记录（2026-10-02）

升级依赖后首轮桌面流程退出 1，真实 Electron 版本核对为 43.7.7；画面“重试视频”保留原生失败原因，设备 action 请求未增加。随后初始化返回 409 / `DEVICE_BUSY`，未安装组件或进入连续动作阶段。错误为已取消兼容截图仍未收尾：HDC 暂存文件清理使用独立三秒期限，管理器却套用两秒输入释放期限。管理器现为只读帧采用至少五秒的有限清理等待，保留原输入释放期限；未确认实际结束前不派发动作。新增延迟收尾回归确认等待期间输入为零、完成后才派发；管理器及 HDC 61 项、类型和相关 lint 通过。失败诊断和日志为忽略的 `harmony-desktop-electron4377-frame-cleanup-failure.json` 与同名 `.log`。

修复后真实桌面初始化通过：只读重试、组件安装、版本回读、启动、手机明确授权、第二个自有应用启动和原生像素更新均通过。但长测在 95 次精确计数核对、635.568 秒后退出 1；91 次时原生画布已绘制 6561 次、19 次亮屏及未锁定检查通过，最大绘制间隔约 3.193 秒。失败阶段原生请求先被中断，后续两次重连返回 `net::ERR_EMPTY_RESPONSE`，界面保留 `Failed to fetch`；手机仍产生编码帧，不能认定为手机停止采集。诊断为 `harmony-desktop-sustained-4377-http-failure.json`，设备日志为 `ordinary-mirror-sustained-4377-failure.log`，完整运行日志为 `harmony-desktop-sustained-ready4377.log`。owned 应用清理流程执行后恢复独立亮屏维护。下一轮增加服务退出、内存上限分类及仅含进程元数据的内存采样，不保存令牌或请求正文；此问题仍未通过。

已启动真实 Piora Electron、USB API 26 手机、正式源码 1.1.5 的独占长测，目标为至少三十分钟原生观看与五百次自有应用计数器动作。实际安装和启动测试应用，每次通过产品树接口获取引用、实际 `tap_ref` 调度，再读取新树核对精确计数；不能以 HDC 循环坐标输入代替。记录实际原生画布的绘制次数和最大绘制间隔，每二十五次核对画布内容更新，禁止回退截图轮询，每三十秒独立检查亮屏与未锁定。动作耗时包括前后树观察及调度内部的引用复核，不是单纯点击注入延迟。

本轮进程最终退出 1：约 616.6 秒后失去原生视频状态，兼容截图仍显示自有应用 `Actions: 90`。此前 90 次产品动作均核对精确计数，85 次时已绘制 6337 帧、最大绘制间隔约 711 毫秒，18 次亮屏及未锁定检查通过。手机原生日志在失败后仍生成编码帧，不能认定为手机停止采集，也不能把这一轮称为三十分钟或五百次通过。清理流程停止并卸载两份自有应用，独立亮屏维护进程随后恢复。

失败证据保存在忽略的 `harmony-desktop-sustained-first-failure.json`、`harmony-desktop-ordinary-mirror-sustained.log` 与 `ordinary-mirror-sustained-failed-native.log`。补充桌面视频请求失败、状态和回退原因的诊断；兼容画面恢复后保留原生失败原因，并提供只读重试视频入口。下一轮必须确认请求、解码与绘制的实际失败环节，保留后续录像和设备清理要求，不降低验收标准。

远端 origin/main 从本地基线 `0e6fc8e3` 前进至 `9b6ff119`，包含安全依赖和 Electron 升级。失败长测使用同步前环境；进程终止及设备清理后，以保留全部本地修改的方式快进至远端，保留双方更新说明并重新生成许可证清单。`npm ci`、Electron 43.7.7 桌面源码编译、根类型检查、33 项定向回归、相关 lint 和文档检查通过；这些检查不代表新的真机长测或最终 beta 已通过。横屏诊断隔离 HAP 1.1.6 已完成 debug 构建，但尚未安装验收，其旋转调用没有进入正式源码。

后续十二分钟、一百二十次动作的原因隔离轮同样未通过：实际核对 92 次动作、625.294 秒后断流。91 次时已绘制 6715 次，最大绘制间隔约 656 毫秒，19 次亮屏与未锁定检查通过；兼容截图随后恢复。服务父进程仍在运行、退出码和退出信号均为空，失败前最后一份采样的服务子进程未更换；未出现内存上限或未捕获异常标志，Next 内存阈值重启 trace 为空。子进程内存峰值后回落，渲染器 JavaScript 堆约 130–165 MB；这些证据不能支持内存溢出或服务重启结论。诊断和进程元数据保存于忽略的 `harmony-desktop-sustained-process-failure.json`、`harmony-desktop-sustained-process-failure-samples.json` 及 `harmony-desktop-sustained-process-diagnostic.log`，不含请求令牌或正文。下一步补充 `ScrcpyTcp` 连接日志，并以独立 debug 源码验证普通录屏后台任务；后台策略目前只是待验证假设，正式 1.1.5 源码不含该实验，三十分钟与五百次标准保持不变。

## 普通录屏后台任务对照与后续长测（2026-10-02）

隔离 1.1.7 使用普通 `avPlaybackAndRecord` / `SUBMODE_SCREEN_RECORD_NORMAL_NOTIFICATION`，仅在原生实际 STARTED 后申请带系统通知的录屏后台任务，不使用特权权限或特殊场景授权。调试 HAP SHA-256 为 `78ff0f443dc30a49fb3cf7daca98aa31795f595f6a52cd29aadbbe5342342f7d`。真实 Piora Electron 43.7.7 与 USB API 26 手机整轮退出 0：明确初始化、版本回读、正常共享授权，手机实际返回任务 id 33；第二个自有应用在前台，产品树及 `tap_ref` 完成 120 次精确计数回读，原生观看 805.939 秒、8839 次绘制、最大间隔 344.1 毫秒、兼容回退为零，24 次独立检查全部亮屏、未锁定。录像实际准备至停止 20.032 秒，MP4 20.132 秒、577745 字节，206 个编码包无小于一毫秒间隔；Electron 解码 30 帧并完成跳转，停止录像后投屏和截图仍可用。两个自有应用停止、卸载及不存在回读通过，页面错误为零。报告为忽略的 `harmony-desktop-background-task-120-report.json`，日志为 `harmony-desktop-background-task-diagnostic.log`，实际任务日志为 `ordinary-mirror-background-task.log`。

该对照结果支持后台任务方案，并跨过此前三轮失败区间；单凭该对照不能证明系统断流的精确原因或宣称三十分钟、五百次标准已通过。正式源码 1.1.8 进一步处理任务取消、暂停、申请失败、旧异步返回及组件销毁，12 项生命周期和构建准备回归通过，独立 debug 构建通过；后续更长真实桌面与手机整轮结果见本页开头。该源码目标 API 26，公开发行签名、随包 HAP 和最终 beta 包仍待验证。

1.1.8 首轮组合验收在连续动作阶段前退出 1：明确拒绝后主动恢复、两次观看连接刷新、关闭面板八秒实际停止采集和再授权恢复均完成，任务日志确认旧任务 id 34 停止、新任务 id 35 建立。切换应用后界面仍为原生视频、无失败原因，但脚本把更早的预期兼容恢复请求累计数 7 与最初稳定期的 0 比较而中断。此轮不记整轮通过；后续按独立稳定阶段保存基线，要求切换应用、旋转和长测期间新增兼容回退为零，保留此前恢复阶段的实际计数和断言。日志归档为 `harmony-desktop-background-final-baseline-failure.log`；更长标准仍需重新完成。

修正阶段基线后的重跑保留所有原有恢复检查，并完成至少三十分钟与五百次动作、录像解码及设备清理；对应同一运行时间的最终报告已归档，见本页开头。早期失败日志保留，不用新的成功结果覆盖原始诊断。

## 加密数据库自动发现与拒绝读取（2026-10-02）

独立 debug 样本通过 DevEco CLI 构建，SHA-256 为 `bea7a0baaaeab63027ce5dfdef1d6a5ae9235cba2e765ddc009d23657ca1cc70`。新入口只有明确点击时才通过系统 `RdbStore` 的 `encrypt: true` 创建合成加密库，不由扫描启动或创建。生产样本不复制这些源码；生产 HAP 检查补充拒绝已知计数器、加密样本和方向入口标识。源码排除及授权实现回归 8 项通过。

真实 Piora Electron 与 USB API 26 手机整轮退出 0：安装、版本回读、启动均返回 200；经过产品实际树观察、`tap_ref` 调度及新观察确认样本为 `encrypted-ready`，没有直接 HDC 坐标输入。数据库页自动发现该应用 4 个文件：一份加密库、一份普通库、标准数据库目录与模块 files 目录中的两份一致备份。加密库归属测试应用，显示“未识别 SQLite 文件头：文件可能已加密、损坏或不是 SQLite 数据库”；按钮禁用且标题包含同一原因。实际打开接口返回 501 / `CAPABILITY_UNAVAILABLE`，无快照 ID、查询结果或伪造空表。普通备份仍通过双副本 SHA-256 核验，SQL、结构、完整大整数与 BLOB、刷新时间、JSON 任务导出以及文件路径直达和数据库跳转均通过。最终停止、卸载返回 200，设备确认不存在，页面错误 0；多次亮屏与未锁定检查通过。

报告为忽略的 `harmony-desktop-device-database-encrypted-report.json`，界面图为 `harmony-desktop-device-database-encrypted.png`。这覆盖本机自有应用的一种系统加密数据库，不证明能区分所有损坏文件与加密格式，也不代表任意应用沙箱均可访问。完成独占验收后重新启动前台维护组件，未请求录屏授权，每四十五秒只对新观察到的自有标题进行保活检查与操作。

## 持续离开投屏后的共享恢复（2026-10-02）

1.1.3 的持续离开验收确认关闭面板八秒后手机停止录屏，隐藏期间不轮询截图，但重新开始共享失败。增加有界的授权弹窗等待仍失败；手机日志显示新的共享请求接受后约 0.6 秒又停止，旧断开计时器会终止新请求。失败日志保留在忽略目录中的 `harmony-desktop-ordinary-mirror-absence-stale-deadline.log` 与 `ordinary-mirror-absence-stale-deadline-native.log`，未记为整轮通过。

正式源码 1.1.5 让手机页面和能力共用 presence guard，新明确请求使旧停止任务失效。未连接观看端的新请求最多等待三十秒，连接建立后仍按五秒持续断开期限停止；不自动请求授权或开始采集。旧计时器、无观看端到期及销毁后的旧回调回归通过，独立 debug 构建通过。该隔离 HAP 的 SHA-256 为 `b4a7649009a5640eba3686966872ce8d1fea89e0ca5832eeb0f9a9e2d610c76f`。

真实 Piora Electron、桌面认证及 USB API 26 手机整轮退出 0：首次明确授权后原生视频正常；连续刷新两次，各等待七秒仍无截图回退或再次授权；关闭面板八秒后实际停止录屏，隐藏期间无截图轮询。重新打开面板后显示兼容投屏，通过新观察到的手机按钮明确请求并确认正常系统授权，原生画面恢复，继续七秒不回退。录像准备至停止 20.054 秒，MP4 20.097 秒、382717 字节，差值约 0.043 秒；205 个编码包无小于 1 毫秒间隔，Electron 实际解码 30 帧且跳转成功。录屏停止后继续观看和截图成功；实际应用页停止、卸载返回 200，设备确认不存在，页面错误 0。报告为 `harmony-desktop-ordinary-mirror-absence-recovery-report.json`，日志为 `ordinary-mirror-absence-recovery-native.log`。期间多次独立核对手机亮屏、未锁定；专用维护进程在独占验收前已停止并确认清理。

本轮是专用调试签名与开发桌面的明确流程验收，公开发行签名、随包 HAP 替换、最终 beta 包、横屏完整画面及长期性能仍未通过全部验收。

## 普通权限投屏短暂重连修复（2026-10-02）

横屏调用时机的隔离实验 1.1.2 首轮仍为固定 1080×2386 编码尺寸，未通过横屏；下一轮在初次授权后刷新观看连接时又失去原生画面。实际设备日志显示已启动、旋转 API 返回 0 并生成帧，随后手机主动停止采集，不能把该轮推断为资源锁阻塞。检查到组件把最后一个观看连接的短暂断开立即视为整体停止；桌面刷新恰好先关闭旧连接，再建立新连接。两轮失败日志均保留，实验旋转调用未进入正式源码。

正式源码 1.1.3 增加五秒有限等待，重新连接取消等待，presence epoch 保护新连接，持续断开及能力销毁仍释放采集。对应隔离 debug HAP 的 SHA-256 为 `d0a8d3d60edb99d38748b61122a37070a61997178729583637def28be1fa5ddd`。真实 Piora Electron、实际桌面认证和 USB API 26 手机整轮退出 0：初次授权直接允许，刷新后正常显示原生帧；随后连续刷新两次，各等待七秒超过旧清理期限，仍为原生视频，无截图回退、再次授权或重新初始化安装。录像实际准备至停止为 20.053 秒，MP4 为 20.233 秒、382415 字节，Electron 实际解码 30 帧且跳转成功；204 个编码包无小于 1 毫秒间隔。录像停止后观看和截图仍成功。停止、卸载与不存在回读均通过，页面错误 0。

报告为忽略的 `.verification/harmony-desktop-ordinary-mirror-reconnect-report.json`，日志为 `.verification/ordinary-mirror-reconnect-native.log`。独立 debug 构建、源码准备测试通过；分发 HAP 尚未替换，横屏完整画面及长时间性能仍需继续验收。下方历史记录的版本和失败状态保留其实际发生时的范围。

## 普通权限投屏组件正式源码与初始化核对（2026-10-01）

`third_party/harmony-mirror` 现保存普通前台 EntryAbility、仅 INTERNET 权限的投屏组件源码与上游 MIT 声明；独立构建准备脚本不复制签名材料、不覆盖已有目录。设备初始化先读取 HAP 声明，再安装并回读实际包版本及导出的 EntryAbility，核对后才启动；不再启动未声明的 ScrcpyService。桌面成功提示说明手机端开始共享与正常系统授权步骤。后台关键帧请求只请求编码器 I 帧，不重启录屏；慢客户端等待下一关键帧，断开及原生回调处理避免在持锁路径重复加锁。

隔离设备测试项目完成 debug 编译及签名，HAP 版本 1.1.0、1,588,133 字节、SHA-256 `fb8875d6a9365dfb493490e2e849f1d74bb656211a16949f8b457040305a9064`，包声明仅含 INTERNET。此设备调试签名不等于公开发行签名，正式分发的旧 HAP 尚未替换。构建成功不能证明手机安装、授权、录屏和新生命周期逻辑通过。HDC 后端专项 29 项、结构化错误 6 项、组件与独立源码准备检查 5 项通过。

上午 08:24 检查曾发现 screenState true 但 screenLocked true，说明临时灭屏覆盖不能保证保持解锁；08:28 起设备返回 USB Offline，无法继续维持亮屏或完成实机操作。22:03 重新检查已 Connected，API 26、screenState true、screenLocked false，随后续用临时灭屏覆盖并完成下述真实 Piora Electron 初始化验收；22:27 后续检查仍亮屏、未锁定。测试未输入锁屏密码或修改持久锁屏策略。

第一轮实际初始化返回 200，但授权说明仅在媒体页，应用页不可见，因此整轮失败。已将非文件提示也放入投屏主区域，长文字换行，没有媒体产物时不显示文件路径入口。第二次验证提示已可见，但测试脚本使用不存在的“刷新”按钮而中断；改为实际“搜索或刷新应用”，两次中断均清理仅属于本轮的测试组件，没有把已安装当成整轮通过。

修复后真实 Piora Electron、桌面认证接口与 USB 手机完成 20 秒整轮，退出 0：实际点击“启用实时视频”完成安装、版本回读和 EntryAbility 启动；拒绝系统授权后等待 16 秒没有自动重弹，再主动请求可恢复授权。原生 H.264 画面为 1080×2386，稳定期没有截图轮询回退，视频期间截图返回 200。录屏准备完成至停止请求为 20.056647 秒，保存 MP4 为 20.631424 秒、475,043 字节，差值 0.574777 秒；244 个编码包中 1 个间隔小于 1 毫秒，实际 Electron 解码 23 帧，跳转后获得约 2.000573 秒的帧。停止、卸载均为 200，设备核对组件不存在，页面错误 0。原始报告保留为 `.verification/harmony-desktop-ordinary-mirror-20s-report.json`，设备日志为 `.verification/ordinary-mirror-20s-native.log`。这证明新源码对应调试 HAP 的实机通路，不证明正式 beta 含此组件；45 秒重复录屏和录屏停止后继续观看/截图另行验收。

45 秒复测也完成整轮并退出 0：实际区间 45.065504 秒，MP4 45.215243 秒、876,411 字节，差值 0.149739 秒；516 个编码包中小于 1 毫秒间隔为 0，实际解码 26 帧，跳转后收到约 2.234809 秒的帧。录屏停止后等待 5 秒，观看端仍为原生视频、未回退截图轮询；再次截图返回 200。停止、卸载和不存在核对均通过，页面错误 0，报告为 `.verification/harmony-desktop-ordinary-mirror-45s-report.json`。此前一次 45 秒尝试在无关的 UI 检查回执断言处中断，未记为整轮通过；该检查已删除，其专用 UI 暂存文件已确认清理。跨应用前台切换、旋转和最终发行包仍需单独验收。

跨应用验收随后完成并退出 0：通过真实 Piora 应用页安装、核对并启动第二个专用 debug 应用；设备 UI 树核对其实际前台节点，桌面画布像素更新为该应用。等待 10 秒仍为原生视频、没有兼容截图轮询回退；视频中截图、第二客户端录屏、停止录屏后继续观看及再次截图均成功。实际录屏区间 20.058644 秒，MP4 20.254045 秒、334,315 字节，差值 0.195401 秒；208 个编码包无小于 1 毫秒间隔，实际 Electron 解码 30 帧，跳转后收到 2.1 秒的帧。两个专用应用均从实际应用页停止及卸载，返回 200，设备分别确认不存在，页面错误 0。报告为 `.verification/harmony-desktop-ordinary-mirror-background-report.json`，日志为 `.verification/ordinary-mirror-background-native.log`。这证明普通权限组件可在本机另一测试应用前台时继续投屏，不能扩展为任意设备、长时间后台、旋转或系统中断均已通过。

主区域提示回归补齐主动初始化、切换工具仍可见、无媒体文件不显示路径、被动切换设备不初始化等检查；新增主动初始化后先通过真实组件的停止入口清理测试租约，再验证后续拒绝控制场景。最终组件及源码准备检查 5 项全部通过；此前失败分别由测试租约残留和将主动初始化误算为被动初始化引起，没有删除被动观看不能初始化/唤醒/解锁的约束。

真实桌面进程退出后根 TypeScript、相关 ESLint、39 个共享动作 / 6 个模板 / 15 个文档入口及 1374 项许可证清单检查通过。ESLint 首次发现独立源码准备测试使用保留的 module 变量名，改为 moduleInfo 后重新检查及该测试通过，没有关闭规则。GitHub 目标仓库 kexijiang/Piora 的仓库 secrets 名称列表为空，尚无可核对的鸿蒙发行签名配置；已向用户询问可用工程状态，不请求用户发送私钥或密码。

为满足持续亮屏要求，整轮清理完成后另行安装同一调试 HAP 作为前台待命组件，并启动最多 45 分钟的独立维护进程。这是后续验收的临时环境，不是正式发行安装证明；没有请求屏幕共享。每 45 秒读取锁屏和当前界面，只在本轮专用组件的状态节点及标题实际可见时轻触无操作的标题，刷新临时灭屏覆盖；离线、锁定或前台已变则结束，不输入密码或抢回用户界面。正常结束核对组件身份/版本后停止、卸载并恢复默认灭屏时间；清理失败明确记录未确认。执行新的设备验收前必须先请求该进程停止并等待终态及组件清理，不能并行操作。忽略目录中的 `harmony-owned-phone-keepawake-state.json` 仅记录进程、期限、检查次数和清理状态，不含 UI 内容或凭据。

## 亮屏维持与应用数据库正向真机验收（2026-10-01）

手机已手动解锁，随后只读检查确认 `screenState true`、`screenLocked false`。根据用户要求，在当前实机验收期间用设备明确支持的 `power-shell timeout -o 1800000` 临时延长灭屏时间，并在前台 debug 测试窗口启用保持亮屏；未修改持久锁屏策略、输入密码或提升设备权限。持续测试时刷新临时覆盖，结束验收后可用 `power-shell timeout -r` 恢复默认。

解锁后的两轮数据库验收最初均失败：fixture 页面确认系统备份已生成，但应用扫描显示 empty。对仅属于合成测试应用的目录核查发现，部分 HDC 沙箱命令会破坏脚本引号，`stat` 格式中的管道被解释成命令，旧解析器丢掉错误后返回空列表。已用无引号的 ASCII 脚本传递保护沙箱读写及命令完成标记，批量 stat 失败和格式异常直接报错；同时补充 `base/haps/<模块>/files` 自动发现，仍保持每应用 18 次目录读取上限且不进入模块缓存/资源。设备实际数据库目录为 `data/storage/el2/database/entry/rdb`，文件备份目录为 `data/storage/el2/base/haps/entry/files`，不需要用户提供路径。

修复后真实 Piora Electron 开发桌面端、真实 desktop bridge、实际服务接口及 USB API 26 手机完成整轮验收，未模拟 API 或设备数据：签名安装、版本回读、EntryAbility 启动均返回 200；自动发现并归属 3 个数据库文件，包括标准目录与模块文件目录中的两份同名备份，两者具有不同不透明标识，目录原始路径不进入目录响应。只读打开一致备份，通过双份 SHA-256 校验；显示合成表、视图和索引，2 行 SQL 结果保留中文、正负 `9007199254740993` 的完整值及 BLOB 十六进制；刷新获得不同快照 ID 和更晚采集时间。JSON 导出经真实后台任务写到本机，再读取文件核对内容。最后通过实际应用页停止、卸载，均返回 200，设备确认专用测试应用不存在，页面错误为 0，进程退出 0。

报告为忽略的 `.verification/harmony-desktop-device-database-report.json`，查询与导出界面保存在同前缀 PNG。针对脚本、文件、数据库扫描和测试样本的回归已通过；这轮证明可读取的运行中调试应用正向数据库流程，不代表零售第三方应用都可读取，也不代表视频、长时稳定性或最终 beta 安装包验收完成。未提交、推送或发布。

应用树进一步改为紧凑行，应用名称和状态同排，展开才显示详细失败原因。真实 SQL 界面首次复测发现第二行被挤出可视区：除了重复标题，排序表头继承普通工具按钮间距。已移除重复标题、合并筛选与复制、让表格使用剩余高度，并清除排序按钮的默认高度和外边距。最终真实 Electron 整轮复测退出 0，通过 `elementFromPoint` 核对两行结果实际可见且未滚动结果面板，查询截图能直接看到两行；首轮布局缺失现象在完整重启后未复现，本轮启动时额外核对设备顶栏的实际 flex 布局，不能据此宣称任意开发热更新都无样式问题。

文件页选择该调试应用后，输入模块 files 下数据库文件的完整路径，一键前往；真实目录树已展开并选中文件，顶部“在数据库工作台打开”按钮跳到同一应用的对应自动发现数据库，重新采集返回 200 且包含 `atlas_sample`。第一版测试误将带 datalist 的应用输入框按 textbox 查找而超时，改为实际 combobox 角色后通过；产品无需改成手输数据库路径。报告现包含 `filePathJumpAndDatabaseLink: true`，同前缀 `file-link.png` 为实际文件界面。全部测试样本通过实际应用页停止和卸载后确认不存在，页面错误 0。

相关工作台回归 4 项、独立 SQLite 浏览器回归 1 项及结构化错误提示回归 5 项通过；排序表头增加不超过 32 px 的实际高度检查。根 TypeScript 在这轮真实桌面进程结束后通过，相关组件 ESLint 通过。随后完整 Harmony lib 回归 334 项、333 通过、0 失败、1 项既有跳过，包含跨实例错误提示用例，日志为 `.verification/harmony-ui-final-suite-20261001.log`。设计应用树密度及配套说明同步更新，25 张图重新渲染检查通过。视频验收继续进行，不标记完整目标完成。

## 普通权限视频样本准备与真实桌面安装（2026-10-01）

最新正向通路已使用真实 Piora Electron 开发桌面端、实际接口和 USB API 26 手机通过：独立 debug 样本签名安装、版本回读和启动均为 200；从手机前台测试按钮请求录屏后，系统明确显示仅针对“Piora 只读投屏验收”的正常屏幕授权，确认后原生回调收到 STARTED。桌面实际解码并绘制 1080×2386 H.264 画面，连续 5 秒检查没有截图轮询回退；视频中截图返回 200。实际保存的 MP4 为 195,293 字节，包含 ftyp、avc1、moov、mdat，Electron 读取其实际字节确认尺寸和 10.361111 秒时长。随后从真实应用页停止与卸载均为 200，设备确认样本不存在，页面错误 0，进程退出 0。首次成功报告另存为忽略的 `.verification/harmony-desktop-standard-mirror-initial-success-report.json`；当时回放验证仅等到 loadedmetadata，进一步播放帧与 seek 校验正在补测，不能仅用该报告的 recordingPlayable 字段代替帧解码证据。

后续完整实机复测已退出 0：先从专用测试应用前台按钮请求正常系统授权并选择“不允许”，等待 16 秒确认没有自动重弹，再显式请求并选择“允许”；原生回调先收到 CANCELED、完成清理，后收到 STARTED 并成功设置 30 fps。真实 Electron 页面恢复 1080×2386 视频，稳定期无截图轮询回退，视频中的截图返回 200。保存的实际 MP4 为 299,758 字节；Electron 原生播放器实际解码 12 帧，并跳转后收到约 2.030087 秒的帧。报告另存 `.verification/harmony-desktop-standard-mirror-denial-decoding-report.json`，停止和卸载均为 200，设备确认测试应用不存在，页面错误 0。

这次录制在开始成功后等待约 10 秒，实际媒体时长为 8.033056 秒；进一步读取真实 MP4 的 178 个编码包，发现末尾帧间隔缩到约 0.1 毫秒。因此当前结果证明帧解码、跳转、拒绝后清理和显式恢复，不把录制时长准确性记为通过，正在记录原生 PTS 核对原因。根 TypeScript 在该轮真实桌面进程结束后重新通过。

加入原生 PTS 诊断后，10 秒录制得到 10.162205 秒媒体，但仍有 59 个小于 1 毫秒的间隔，不能因总时长恰好接近就认为问题消失。随后 20 秒复测实际 ready-to-stop 为 20.059585 秒，媒体为 18.947847 秒，279 个编码包中有 158 个异常短间隔；设备日志明确显示重复帧 rawDelta 为 100,000、既定换算 divisor 为 1,000，而回调约每 100 毫秒到达。此设备的静止重复帧使用微秒增量叠加在纳秒 surface PTS 上，是本次时长偏短的直接证据。日志与报告分别保存为忽略的 `.verification/standard-mirror-static-timing-before-native.log` 和 `.verification/harmony-desktop-standard-mirror-static-timing-before-report.json`。

独立调试组件现仅对该设备实际编码的重复帧修正时间间隔，并在真实 surface 帧恢复时回到相对首帧的绝对源时钟，避免重复计算补偿时间；没有在桌面端复制压缩帧或伪造画面。修正后的真实 Piora Electron / USB 手机整轮退出 0：再次拒绝授权、等待无自动重弹、显式恢复，稳定视频无截图轮询回退，视频中截图返回 200。实际 ready-to-stop 为 20.052493 秒，保存的 MP4 为 20.244358 秒、690,827 字节，差值 0.191865 秒；371 个编码包中小于 1 毫秒的间隔为 0。实际播放器解码 14 帧，seek 后收到约 2.000278 秒的帧；设备日志实际触发重复帧修正，并随后出现正常 source PTS 的编码帧。停止与卸载均为 200、样本不存在、页面错误 0。当前报告为 `.verification/harmony-desktop-standard-mirror-video-report.json`，日志为 `.verification/standard-mirror-latest-native.log`；只有同时通过上述时长、帧间隔和真实解码检查，才将这一调试通路的录屏记为通过。

编码器重复帧参数的毫秒单位见 [OpenHarmony 媒体数据键值文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-avcodec-kit/capi-codecbase.md)，本次 raw PTS 差异来自上述实际设备日志，不推断其他设备具有相同问题。该修正仍在独立调试组件中，尚未替换正式随包 HAP；beta 安装包、旋转、来电中断和长时稳定性仍未验收，完整目标保持进行中。

该结果证明当前桌面视频/录屏通路可接收普通权限的已签名调试组件；没有替换正式随包 HAP，也不证明 beta 安装包、旋转、来电中断或长时稳定性已经通过。前期直接从 TCP 连接回调发起录屏虽返回受理，但没有 STARTED 或授权弹窗；手机前台按钮能正常出现授权弹窗，15 秒无帧看门狗会关闭连接并终止等待。最新样本停止连接时结束采集，不在重连时把已有请求误报启动失败；最大帧率设置改为收到 STARTED 后执行。

以下为前期准备与失败记录，最新结果以上述正向通路为准。

在隔离目录 `.verification/standard-mirror-probe-20261001` 构建独立 debug 样本，原生编码及设备回环协议代码来自下文已核对的 HongJing 固定提交，并保留 MIT 许可证。此样本改用普通 UIAbility，仅声明 INTERNET 权限，不包含特权服务、免录屏授权、输入注入或上游签名材料；录屏必须走系统授权流程。移除一次性预采集授权，H.264 启动失败直接失败，不回退 JPEG/图片轮询；取消、停止及来电等终止回调的清理异步执行，按本次采集的 epoch 防止晚到清理停止新会话。这些生命周期行为尚待手机正向验证，不因编译通过记为已验收。

DevEco CLI 为该样本生成匹配本机测试设备的 debug 签名，ArkTS、CMake/Ninja、原生库打包和 signed HAP 构建通过，日志为忽略的 `.verification/standard-mirror-probe-build.log`。真实 Piora Electron 桌面端使用实际安装预览、安装接口及 USB 手机：安装返回 200、版本回读一致、EntryAbility 可选择；启动返回 409 / SCREEN_LOCKED / 10106102，实际视口中可见手动解锁提示；随后停止与卸载均返回 200，设备确认样本不存在，页面错误为 0，整轮退出 0。报告为 `.verification/harmony-desktop-standard-mirror-install-report.json`，明确记录 `videoAccepted: false`、`recordingAccepted: false`。

此样本不是已发布的视频组件，也未替换 Piora 随包的 HAP。正向视频流程仍未通过，以下为待满足的验收条件：先核对手机已手动解锁，再从真实桌面安装并明确启动样本，刷新视频连接；仅在桌面实际解码和绘制视频帧且稳定期没有截图回退时继续测试视频中的截图、录制、停止和保存。保存文件还需由 Electron 原生 MP4 解码器读取实际字节核对尺寸与时长；产品当前录屏使用外部打开入口，测试不假装存在录屏内嵌预览接口。帧率、拒绝授权/通话打断资源释放、旋转和长时稳定性仍需另外验证。上述安装报告属于手机解锁前的负向验收；最新亮屏和数据库正向结果见本页首段。未提交、推送或发布。

前期解锁后视频正向流程曾实际运行：一轮签名安装、版本回读和启动均为 200，但 120 秒内未取得真实解码视频帧，不能验收视频或录屏。测试应用日志仅确认 Start 请求被受理，没有 STARTED 状态或编码帧；已调整窗口初始化后的启动时机并核对原生回调注册返回值，新的 debug 样本构建成功，仍需正向实机验证。另一次运行被其他活跃进程的物理设备占用阻止，未派发安装，不强行删除锁或终止其他操作。测试样本均在结束时卸载并确认不存在。

## 调试签名与应用维护真机验收（2026-10-01）

本机 DevEco CLI 首次登录命令报代理授权错误；在独立命令进程中排除该进程的代理配置后，CLI 确认已有登录，未更改系统或其他应用代理。专用隔离 debug 工程随后成功生成签名材料并构建 signed HAP。签名配置和密钥不提交、不分发，此构建不属于 Piora 发布包。

真实 Piora Electron 开发桌面端与 USB 手机首次安装及版本回读成功，随后发现启动入口未列出。设备实际 bm dump 使用 `visible: true`，原代码仅识别 exported，导致入口被过滤；已兼容两种明确标记，并排除隐藏、禁用、冲突及非布尔声明。修复后真实界面完成安装、版本回读、启动、停止和卸载，各请求返回 200，设备最终确认测试应用不存在，页面错误为 0。测试只使用原先未安装的专用 fixture，未替换手机现有应用。报告为忽略的 `.verification/harmony-desktop-debug-install-report.json`。

扩展后的 debug 样本仅在被明确启动时生成合成表、视图、索引及一致备份，production 样本不包含该入口。新版样本 ArkTS 编译和签名成功，但最新真实桌面数据库流程在启动时收到设备错误 10106102，数据库发现、快照、SQL 与导出未执行，不能记为通过。[官方 aa 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/aa-tool.md)将该错误定义为启动时设备锁屏；已将其转为锁屏状态及对应手动解锁提示，保留命令已发送证据，不自动重试。专项尝试唤醒和滑动后仍未观察到可确认的密码输入页，未尝试输入密码或改变手机安全设置；需要手机手动解锁后继续。测试应用已清理，视频与录屏、正向应用数据库及最终 beta 安装包验收仍未完成。

锁屏提示修复后再跑真实桌面端：签名安装与版本回读通过，启动返回 409 / SCREEN_LOCKED / 10106102。首次检查只证明提示已渲染，随后截图发现反馈位于滚动视口之外；不能将这一轮记为提示可见。反馈改为固定在应用页顶部后重新执行整轮，通过实际元素边界和命中检查确认手动解锁指引可见且未被遮挡，不由测试滚动到提示来代替产品行为。随后停止、卸载均返回 200，设备确认测试应用不存在，页面错误为 0，整轮退出 0。报告为忽略的 `.verification/harmony-desktop-locked-launch-report.json`，包含 `feedbackVisible: true`，同前缀 PNG 保留当前界面。这证明锁屏异常及清理流程，不证明数据库或视频已通过。

本轮所选 Harmony 回归共 338 项：337 通过、0 失败、1 项既有跳过，输出为 `.verification/harmony-signed-apps-suite-20261001.log`；该选择范围与上一轮 349 项不同，不能相加作为独立覆盖数。最后反馈布局变更后，应用页浏览器专项、根 TypeScript、对应 ESLint 与上述真实桌面整轮再次通过。25 张设计图重新渲染检查。

另按已记录的 HongJing 提交 `1d470ea8f571f19fcbb6883cc6118fafed6fe14f` 核对视频服务源码：模块声明了 ServiceExtensionAbility、免录屏授权及输入注入等权限，普通调试签名成功不能证明这些能力在零售手机生效。[官方 ServiceExtensionAbility](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/reference/apis-ability-kit/js-apis-app-ability-serviceExtensionAbility-sys.md)是系统接口；[标准 AVScreenCapture 流程](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/avscreencapture-c-basic-process)提供正常录屏授权流程，可用于评估普通应用方案，但本轮没有实现或验证该替代服务。未安装该上游签名包、复用其私钥或提升手机权限。设备最新只读检查仍为锁屏，正向数据库验收等待手动解锁。

## 只读投屏与文件工作台最新复测（2026-10-01）

当前任务工作树以真实 Piora Electron 开发桌面端、真实认证接口及 USB 手机复测，未模拟设备接口。截图返回 200，整轮设备输入请求为 0，页面错误为 0。文件路径直达、采集原文对照、宽面板布局、草稿导航与刷新、外部修改冲突、设备文件删除后的本机恢复、复制和明确放弃均通过；打开本机恢复副本不读取设备。首次实测发现窄面板的异步文本预览未将保存等操作带入可见区域，修复后重新运行整轮通过，验证主操作可见且设备原文未改变。

应用列表自动发现 309 个应用，均按实际权限标明无法访问，重新扫描更新时间；这不证明正向数据库快照可用。本机 HAP 仅预览，未安装或启动。真实 HiLog 验证暂停查看仍采集、TAG/时间筛选、原生下载及清空恢复；下载内容只在隔离目录核对，未写入本验收文档。临时手机文本文件、桌面配置和下载文件已清理，报告保存于忽略的 `.verification/harmony-desktop-file-recovery-current-report.json`。这是开发桌面验收，视频录屏、可访问应用数据库及最终 beta 包验收仍待完成。

## 步骤截图、执行进度与报告联合验收（2026-10-01）

当前场景支持 21 类步骤，新增只读截图与可选名称。桌面每次运行生成 UUID，服务端以设备和 UUID 查单个持久记录，重复标识拒绝重放；进度读取串行且隐藏时暂停，失败保留最后确认状态与截图。结束截图保存独立媒体文件并在当前结果、历史记录中预览；必选截图缺失或保存失败使总体失败，已完成步骤仍保留。报告记录设备版本、最终 UI 摘要、实际时间与可选日志片段；日志默认关闭，最多 200 行 / 128 KiB，限定字段和正文长度，超限保留较新行并标明截断。设备尾部日志可能包含早于场景和其他应用内容，不是本次运行的完整日志。历史记录不保存图片字节、原始 UI 树、私有输入或租约令牌。

使用当前任务工作树的真实 Piora Electron 开发桌面端、真实认证桥与 USB Mate 60，未模拟接口。四步截图场景与结束截图在手机锁屏状态下均成功保存，五个文件名不同，均为 1216×2688、各 2,599,667 字节。桌面收到 9 次本次进度记录，其中包含运行中步骤；最终 UI 观察返回 200 个节点、质量有效、API 26。用户勾选的日志片段采集 200 行且未触发正文截断，报告仅记录数量，不在本验收文档保留手机原始日志。按钮和快捷键截图返回 200，点击和放大拖动画面未产生设备输入，本地平移为 65×85 像素，页面运行错误为 0。

当前结果与历史记录分别由界面点击导出，均收到 Electron 的真实 `will-download` / `done(completed)` 事件并落盘，再解析 JSON 核对本次记录、四步截图、结束截图、日志数量和设备 API；历史 JSON 无原始快照或租约令牌。测试仅在下载事件中选择隔离临时文件的保存路径，未模拟导出内容或服务端响应。历史记录中的结束截图也通过界面展开并加载为 1216 像素宽。首次等待 Playwright 的 download 事件超时不能证明产品下载失败，后续原生事件核验排除了这一误判；首次历史入口测试写错标签名称而超时，改用实际“任务”后整轮退出 0。端口 30147 已关闭，隔离桌面配置与下载文件清理完成；没有安装、启动应用或增加手机测试数据。原始报告为忽略的 `.verification/harmony-desktop-scenario-current-report.json`，当前历史界面为同前缀 PNG。

完整回归 349 项：348 通过、0 失败、1 项既有跳过，四个并发测试进程；输出为 `.verification/harmony-scenario-artifacts-suite-20261001.log`。定向回归覆盖最终采集缺失、断线和保存失败不误报整体通过，UTF-8 日志字节与行数限制、空结果与不可用的区分、取消不完成、未选日志不读取、持久记录重建和重复请求拒绝。首次 TypeScript 检查发现日志错误字段为 unknown，已转成文本后重跑通过；相关 ESLint、性能预算、39 个共享动作 / 6 个模板 / 15 个文档入口通过。设计新增执行进度与报告两页，共 25 张，重新渲染并检查。

此项证明截图场景及报告在真实桌面端与手机上工作，不证明所有 21 类动作均已通过。正向应用数据库、有效调试签名安装与维护、视频录屏、最新文件恢复交互、多设备 / Wi-Fi / 开发板及持续性能矩阵仍缺真实组合证据。完整目标继续保持未完成；本轮未提交、推送或发布，不以开发桌面验收替代最终 beta 安装包验收。

## 场景步骤编辑与手机在线截图复测（2026-10-01）

按真实当前工作树补齐结构化场景编辑器及参数预览接口。模板可转为自定义步骤；支持现有 20 类运行时步骤的新增、参数修改、上下排序和删除，最多 64 步，保留模板中的关系及窗口约束。切换默认应用不改写已有步骤目标；应用扫描失败保留自定义步骤。编辑或改变结束截图策略使预览失效，运行中锁定编辑；准备控制或预览期间取消不发送场景，危险应用维护在取得控制前显示实际设备与目标。结果显示每步动作、状态与耗时并导出真实 JSON。

参数预览复用运行时校验而不构建设备管理器、不取得控制、不读取设备；成功明确返回 `deviceVerified: false`，不声称安装包内容、设备能力、权限或动作效果已验证。新增浏览器检查最初因精确标签匹配包含选择框/文本域子内容、以及把 details 的 group 当成步骤数量而失败；改用真实控件角色与步骤名称定位后通过，并保留业务校验。六项定向回归全部通过：有效/无效参数、桌面身份及 JSON 边界、步骤编辑和排序、应用目标不变、取消与危险步骤确认、应用读取失败后的只读预览与 360 px 布局。

本轮主目录（本地主工作树）的桌面复测先遇到页面编译超时，延长等待后只读点击/平移通过，但截图返回通用 500；不能将该版本记为完整通过。随后在本任务的独立工作树测试当前完整实现：真实 HDC 连续、并发及取消后采集共六次，正常截图为 1216×2688、2,617,626 字节；每次远端和本地临时文件均确认不存在，取消后下一次采集成功。此后真实 Piora Electron 开发桌面端使用实际 IPC 与同一 USB Mate 60，无接口模拟：第一次按钮截图返回 200，但马上按快捷键的检查超时，未记为通过；脚本改为等待按钮结束处理并恢复画面焦点后，整轮退出 0。

最终真实桌面报告显示：画面点击和 150% 放大拖动产生的 action/manual 请求为 0，本地滚动偏移为 65×85；截图按钮与默认快捷键各返回 200，分别保存 2,608,424 字节且路径不同。自定义检查点编辑及实际参数预览接口返回 200、一个步骤、`deviceVerified: false`，无设备输入或租约请求；页面运行错误为 0。手机画面来自兼容自动刷新，不能据此声称实时视频服务或录屏通过。报告与截图位于忽略的 `.verification/harmony-desktop-view-only-current-report.json` 和同前缀 PNG；隔离桌面配置已在 finally 清理，端口 30146 已结束监听，未新建应用或手机测试数据。

首次未限制并发的完整套件中，工作线程测试在首个成功应答前超过其 300 ms 测试期限，338 通过、1 失败、1 跳过；未改变产品或测试超时策略。加入桌面菜单检查并限制为四个测试进程后重跑，最终 343 项、342 通过、0 失败、1 项既有跳过，原始输出为 `.verification/harmony-scenario-editor-suite-final-20261001.log`。根 TypeScript、相关 ESLint、性能预算、38 个共享动作/6 个模板/15 个文档入口检查通过；23 张设计图补齐场景编辑控件并重新渲染核对。

该阶段完整目标仍未完成：当时逐步截图动作、当前步骤实时进度及场景报告尚需补齐，现状见上方最新联合验收；正向应用数据库、调试签名安装与维护、视频录屏、最新文件恢复交互、多设备/Wi-Fi/开发板及持续性能矩阵仍待真实组合验收。当时未提交、推送或发布，开发桌面端证据不能替代最终 beta 安装包验收。

任务总览现汇总安装、数据库采集、传输、导出、测试与媒体。安装成功回执与应用版本回读分别核对；进程中断或成功回执缺失时标为待核对，不自动重试。采集详情展示时间、大小及一致性核验方式，记录不提供失效快照的查询入口。

本页以 [HarmonyAtlas 的公开功能介绍](https://bbs.itying.com/topic/67b748ec36bb8501316f5031)为对照。该介绍来自第三方论坛，未发现可核实的官方源码或完整协议；下表按用户可观察的能力验收，而不假定其内部实现。

| 能力 | Piora 当前实现 | 尚需实机验证或边界 |
| --- | --- | --- |
| 设备发现、信息、只读屏幕镜像与 AI 输入 | 投屏画布只读，点击不会发送设备动作；可缩放、平移查看、截图和录屏。AI 与工具页继续使用后台设备动作和租约管理；截图可在人工租约持有时单独采集并显示预览 | 不同手机、平板、开发板的 HDC/视频兼容性与旋转、断连恢复；本机已通过新观察引用的 tap_ref 操作，完整 AI 场景与连续动作矩阵仍需合并验收 |
| 手动 Wi-Fi 调试连接 | 输入局域网 IPv4:端口，HDC `tconn` 连接或断开并核对设备列表；断开有活跃控制权的设备会被拒绝。设置页显示 HDC 报告的 USB/TCP 标记，旧版 HDC 无标记时仅按 IP:端口序列号推断 | 需先在设备设置中启用无线调试；USB/Wi-Fi 切换及不同 HDC 版本须真机验证；当前不支持公网主机名或 IPv6 |
| 应用搜索、详情、安装、停止、清数据、卸载 | 当前活跃用户的应用列表与版本/申请权限；工作区 HAP 冻结校验后安装；直接动作与 AI 共用控制链。真实 Piora 桌面与 API 26 手机已核对自有调试应用的安装、版本、入口、启动、停止、卸载及最终不存在回读；2026-10-04 应用维护第四轮另以独立 UUID marker 回读验证清数据效果、重启导出与版本保持 | 第四轮后的严格回执加固仅有 40/40 软件回归，尚无加固后同版应用维护整轮实机结论；系统应用限制及不同 bundle 输出格式仍需对应证据，自有应用成功不扩展为任意应用可操作 |
| 应用清缓存、使能/禁用 | 当前活跃用户可用 `bm clean -c -n` 请求清缓存；2026-10-04 第四轮独立回读确认 cache marker 消失、普通文件保留。root 构建上调用 `bm enable/disable -n`，失败不宣称生效 | 清缓存 PASS 只对应第四轮源码，后续回执加固尚无同版整轮实机结论；root 使能/禁用未实测，普通 user 构建不支持 |
| 指定非活跃用户安装/卸载 | **不提供**会静默作用于错误用户的 `-u` 控件 | 官方 `bm` 文档说明非活跃 user ID 可能仍作用于当前活跃用户；跨用户能力需要设备厂商或系统 API 与真机证据 |
| `singleton`、`allowAppUsePrivilegeExtension` 等特权 | 应用页对工作区内的 `install_list_capability.json` 提供签名指纹核对、字段差异预览、原文件哈希保护、备份写入、哈希验收与备份恢复；**不把本地文件改动伪装为设备已生效** | 镜像部署、重启、root/开发板环境和应用真实生效仍须开发板验证 |
| 文件浏览、文本、媒体、上传/下载、新建、删除、重命名、复制/移动、权限、收藏、查找 | 限定共享可写路径与调试沙箱；目录按 500 项翻页；图片可显示原始尺寸并缩放，16 MiB 内常见音视频可只读播放，抓取后核对文件大小、修改时间和文件头，视频范围请求可定位；普通文件及有界文件夹可设备内复制/跨目录移动，发布目标前后核对 SHA-256，且不覆盖已有目标；文件夹限制 10000 项、1 GiB，拒绝符号链接及特殊文件；单项传输及最多 20 项的持久后台任务；2 MiB UTF-8/UTF-16 LE/BE/GB18030 哈希编辑与有界差异预览，保留 BOM 与单一换行格式；单项 `chmod`；本机收藏和限量递归搜索；当前页排序及隐藏文件切换 | 沙箱要求调试签名且应用已启动；音视频解码取决于桌面端编码支持，范围请求会重新从设备抓取有界文件；不同设备的 `stat`、`tar`、`sha256sum`、文件传输及权限行为需要验证；后台进度仅包含已确认完成的项/字节，不提供虚假的当前文件百分比；混合换行需明确选择统一格式；分页无全目录快照，文件变动可能移动页边界 |
| SQLite 数据库 | 数据库页自动列出应用、按应用限量扫描沙箱并核对 SQLite 文件头；不可访问与真正空库分开。打开或刷新时采集两份设备副本，比较 SHA-256 并拒绝非空或大小不明 WAL 及 rollback journal；成功时显示采集时间、字节数及双份校验结果，再提供表、视图、索引、只读 SQL、结构和 CSV/JSON。导出可选全部/当前页、CSV 编码及获准工作区中的新目标路径，后台任务可取消、下载并在重启后追溯；原有应用导出一致副本与本地只读查看仍保留。真实桌面与 API 26 手机已通过自有调试应用的 4 个数据库自动归属，含系统加密库的明确拒绝，以及普通备份的只读快照、结构、精确整数/BLOB 查询、刷新和 JSON 导出 | 普通第三方应用的不可访问状态不能算无数据库，也不能用自有调试样本推断可读取；其他加密格式、活跃写入及不同设备上的拒绝行为仍需对应实机验证 |
| 设备终端、本机终端、快捷命令 | 设备页有绑定手动 lease 的交互式 HDC PTY、终端输出搜索/复制/粘贴、与本机终端分屏、单次命令及多标签记录；统一搜索可查单次命令、当前设备 PTY 与本机工作区已有终端的输出，点击命中切换对应标签并定位；快捷项支持设备/本机目标、分组、收藏、参数、编辑和 JSON 导入导出。2026-10-04 终端第四轮已实测沙箱单次命令、两个 PTY 的目录/环境隔离、隐藏标签搜索、粘贴预览、多行明确执行、Ctrl+C、清屏及退出后重连 | 第四轮是 Next 16.3.7 的开发桌面子项证据，不是当前 Next 16.3.8 或最终 CI 安装包整轮结论。单次命令不保留目录/环境；快捷项需手动执行，本机搜索是可刷新的快照，控制序列或清屏后的命中可能已不在可视缓冲；其他 HDC 版本仍需相应设备验证 |

官方依据：[HDC 版本和沙箱命令说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md)、[bm 工具及用户范围说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/bm-tool.md)、[应用特权配置](https://github.com/openharmony/docs/blob/master/en/device-dev/subsystems/subsys-app-privilege-config-guide.md)、[SQLite WAL](https://www.sqlite.org/wal.html)。

## 原计划的实现与验收缺口

原计划书要求的范围比上方公开功能对照更广。下表按最新对应轮次区分已到达的真实桌面子项与尚未闭合的验证；历史 PASS 保留其源码、组件和设备范围，不据软件回归或旧轮次推断当前整轮、签名或最终 CI 安装包通过。第二设备、平板/折叠、开发板特权与可选投屏适配属于兼容或可选覆盖，不能从当前一台普通权限手机推断可用，也不能把它们与本机常用功能的实现缺口混同：

| 计划项目 | 当前缺口 |
| --- | --- |
| 手动 Wi-Fi 连接/断开与连接方式诊断 | 局域网 IPv4 的连接/断开入口已实现并用模拟 HDC 测试；连接方式详情、跨 USB/Wi-Fi 的真实切换验收尚未完成 |
| 可选 HOScrcpy 投屏适配 | 可配置用户自行提供的 dsh-hos-scrcpy 本地包；Piora 启动独立 Java sidecar，服务端将 H.264 回调转换为现有已认证视频接口的数据包；缺失或启动失败时回退内置 HDC 投屏，运行中失败触发短时冷却。SDK jar 不随 Piora 分发 | 尚未使用真实设备和该 SDK 完成视频、旋转、崩溃恢复性能验收；所用开源 sidecar 监听本机回环，其 SDK 的许可归属仍待上游补全 |
| 应用管理及开发板特权 | 清缓存及清数据已由 2026-10-04 第四轮的独立 marker 回读验证，后续严格回执加固只有软件回归，尚无加固后同版整轮实机证据。工作区镜像配置预览、备份、写入及恢复已接入；不提供非活跃用户控件，root 使能/禁用、镜像部署、重启及特权实际生效仍需对应开发设备 |
| 文件工作台 | 20 项后台队列、项级进度、取消和持久结果已接入；单文件软件边界已放宽到 1 GiB，超过 256 MiB 的 HDC 调用限时 30 分钟；显式 UTF-16/GB18030 文本编辑和有界差异预览已接入，取消后也尽力清理随机设备暂存文件。1 GiB 真机上传与下载往返已核对 SHA-256；真实桌面端对手机万项目录的前两页及末尾空文件路径直达已通过。真实桌面在实际部分上传和下载后取消，暂存清理、源文件保留及取消后重新上传已通过；断线中断清理仍须另行设备验收。HDC 未提供可信逐字节回执，排序/隐藏仅处理当前页 500 项 |
| 数据库 | 自动发现、文件头核验、不透明 ID 与只读快照已接入；CSV/JSON 导出支持编码、范围和持久任务。已有同应用五条目归属、加密拒绝、非空 WAL 拒绝、关闭后空 WAL 校验、SQL/结构/刷新/JSON 导出及文件路径关联的实机子项；另一个应用未运行、成功空库与停止后不可访问的三次独立扫描均不自动启动。2026-10-04 第六轮另验证两自有应用各两份同名数据库、四个独立 ID 与归属标记、更晚快照时间、文件路径关联及结果可见性；该轮基于 Next 16.3.7，不能写成当前 Next 16.3.8 或最终 CI 安装包整轮通过。写入期间系统备份的另一整轮、其他加密格式及设备仍未完成 |
| 设备终端与快捷命令 | 设备与本机终端分屏，设备 PTY 内搜索/复制/粘贴；统一搜索覆盖单次命令记录、当前设备 PTY 和本机工作区终端快照，支持切换到命中终端及缓冲区内查找。已有本机终端执行与统一搜索实机子项；2026-10-04 第四轮另通过沙箱单次命令、双 PTY 目录/环境隔离、隐藏标签搜索、粘贴预览与明确多行执行、Ctrl+C、清屏、退出后重连和关闭。该轮基于 Next 16.3.7，当前 Next 16.3.8 与最终 CI 安装包不由旧 PASS 替代；本机快照需刷新，粘贴草稿不会自动执行 |
| 任务与 AI | AI 已可通过 `database` 操作打开、有限查看、查询与导出本机数据库副本；设备“任务”页汇总传输、数据库导出、测试执行与媒体历史，提供状态筛选及分类定位，进入时自动读取执行记录。HDC 没有可信的运行中逐字节进度事件；索引只覆盖各来源保存的有限历史，不能当成无限期完整任务账本 |
| 交付验收 | 首台 API 26 手机与真实 Piora 开发桌面已通过 1 GiB 文件往返 SHA-256、万项目录分页与末尾路径直达、正式 1.1.8 源码对应 debug HAP 的 55 分 33 秒原生观看、500 次精确动作回读、100 次亮屏/未锁定检查，以及 20 秒可播放录像；私有 debug 1.1.26 另已通过同一采集 epoch 的竖屏、横屏、竖屏切换、原生截图与可解码录屏。传输中取消及实际临时文件清理也已通过；Wi-Fi 切换、第二手机、平板/折叠、开发板、双设备、公开发行签名、随包 HAP 替换、正式组件旋转复验与最终 beta 安装仍未完成 |

这些缺口按原计划继续实施；无法从当前普通权限手机或自动化测试推断开发板特权的可用性。

## 真机验收步骤

1. 分别连接普通 user 构建与可用的 root/开发设备；记录型号、系统 API、HDC 客户端/设备版本和连接方式。至少覆盖 Windows 主机，若发布 Linux 包则复测 Linux。
2. 在每台设备上完成发现、信息、首帧、只读画布点击/缩放/平移、旋转、截图、录屏、断线重连及双设备切换；画布不得发送触摸或取得控制。后台 AI/工具动作另行核对实际效果；被取消或效果不明的命令不得显示为已验证成功。
3. 安装一个专用测试 HAP，核对应用列表、版本/权限字段、启动、停止、清数据和卸载。root 设备再验证使能/禁用；普通 user 设备必须明确失败，不应改变别的应用或账号。
4. 启动调试签名的测试应用，分别在共享路径和其 `data/storage` 中测试中文、空格、空目录、普通文件、符号链接、256 MiB 边界、上传/下载、重命名、权限、2 MiB 文本及冲突保存；核对 BOM/CRLF 保留与混合换行的显式选择，搜索超过上限时必须给出截断提示。
5. 从测试应用导出一致的 SQLite 数据库，下载后分页查看含中文、大整数与 BLOB 的表、执行只读查询并分别导出 CSV/JSON；提供非空或大小不明 WAL 旁文件时应拒绝；已知空 WAL 必须在采集前与两份复制后重复确认，并通过主文件校验。活跃数据库主文件不能作为一致快照验收。
6. 运行成功、非零退出、超时、大输出和取消的设备命令；切换标签、设备及本机终端，核对 lease 归属与结果文案。调试沙箱命令在不同 HDC 版本分别测试。

专用测试工程可用 `node scripts/prepare-harmony-fixture.mjs debug <全新目录>` 从 `tests/harmony-fixture/base` 生成，再用 DevEco Studio 构建并配置与测试 bundle 匹配的调试签名。[华为真机调试文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V14/ide-debug-device-V14)要求真机安装前为 HAP 签名；编译成功的 `*-unsigned.hap` 不算安装验收。

调试页面的 **Export SQLite acceptance sample** 按钮调用系统 `RdbStore.backup()`，把合成数据的一致副本复制到应用 `filesDir`，并显示路径。该副本包含中文、64 位整数及 BLOB；签名 HAP 安装并启动后，才可在文件面板下载并验证。备份 API 和路径可由 [ArkData 官方接口](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/arkts-apis-data-relationalstore)及设备回执核对。

## 已完成的首台真机验证（2026-09-29）

Windows 主机通过 USB 连接 `BRA-AL00`（系统 `7.0.0.107`、API 26、普通 `uid=2000(shell)`），选用 DevEco Studio 的 HDC `3.2.0e`。以下检查在该设备上实际执行；序列号和屏幕、应用内容不写入验收记录。

| 项目 | 真机结果 |
| --- | --- |
| 发现与截图 | 设备发现、doctor 的连接与几何检查通过；只读截图返回 1216 × 2688 PNG。新版截图分别在无租约和持有人工租约时再次成功，大小约 2.1 MiB；网页截图缩略图由浏览器夹具核对。未据此宣称镜像流、录屏、触控校准或旋转已经验收。 |
| 应用发现与数据库 | 当前用户应用列表完整返回 309 条。数据库自动扫描将 309 个应用全部单独标记为沙箱不可访问，发现数据库 0 个；没有把它们报成“无数据库”，也没有自动启动应用或提升权限。设备端 SQLite 文件头命令对普通非数据库文件返回否；调试签名应用的正向扫描与快照尚未验收。未对现有应用执行安装、停止、清数据或卸载。 |
| 共享文件 | 在独立 `/data/local/tmp/piora-atlas-<随机 ID>` 目录验证了新建、中文及空格文件名上传、列表、UTF-8 回读、带哈希保存、搜索、`chmod 600`、重命名、下载内容校验、文件与空目录删除。测试文件已清理。普通目录 266 项的列表在批量 `stat` 修复后耗时约 0.6 秒。 |
| 设备命令 | 通过设备管理器执行 `printf`，得到退出码 0 和预期输出；`exit 7` 如实返回非零退出码。新交互式会话在同一 PTY 中先 `cd /data/local/tmp` 再执行 `pwd`，真实返回 `/data/local/tmp`；结束时关闭 PTY。浏览器组件在模拟接口下验证了渲染、输入、尺寸和离开面板后的关闭；真机与网页合并链路仍待验收。 |

这是一台普通权限手机上的局部验收。专用测试 HAP、调试沙箱、SQLite 一致快照、root 能力、交互式终端的真机网页端到端操作、镜像与输入、断连和多设备等项目仍按上方步骤待验收；不能把自动测试或单台设备结果扩展为跨设备通过。

## 工作台改版的同机复测（2026-09-30）

同一台普通权限手机更新到 `7.0.0.109` 后，开发版网页通过真实 HDC 接口完成以下检查，未以模拟设备代替。验证时设备处于锁屏；测试过程及产物没有保存锁屏密码。

| 项目 | 结果 |
| --- | --- |
| 截图与预览 | 网页点击“截图”后媒体接口和受认证缩略图接口均返回 200，预览实际加载为 1216 像素宽。截图在人工租约持有时也由管理器成功采集。 |
| 文件工作台 | 网页文件树加载成功，输入新建的临时文件夹路径并回车，面包屑跳到该目录；真实设备的 PNG 文件上传、精确定位、列表、下载内容核对与只读图片预览接口均通过，临时目录已清理。 |
| 数据库发现 | 网页数据库树显示全部 309 个应用，扫描完成后明确标注“无法完整扫描”，没有把不可访问的沙箱当成“无数据库”。设备未安装已启动的调试签名测试应用，因此数据库正向发现、快照、表格及导出尚未实机验收。 |
| 画面手势（历史行为，已移除） | 当时浏览器画布指针滑动会发起设备动作请求；该行为后续已移除，当前画布只读。此记录仅保留旧轮次证据，不能作为现行操作指南或当前通过项。 |
| 视频流 | 内置视频组件在这台设备上尚未初始化，视频接口明确返回 `CAPABILITY_UNAVAILABLE`，网页退回截图轮询，并显示可点击的“启用实时视频”入口。持续视频、触控流畅性与初始化恢复尚未通过实机验收。 |
| 数据库测试样本准备 | 专用 debug 测试工程已用本机 DevEco Studio 工具链完成 ArkTS 编译与 `assembleApp`，产生 `entry-default-unsigned.hap`；构建日志明确提示没有签名配置。此结果只证明样本源码可编译，不能算安装、启动、数据库扫描或快照的真机通过。 |

仍需设备解锁并保持亮屏，随后在桌面端显式初始化视频组件，验证视频帧、只读画布、截图和 AI 动作后的重新观察。数据库正向验收还需安装并启动有效调试签名的专用测试 HAP；在取得该设备条件前，不得将本次改版标为真机完整通过或触发 beta 发布。

后续静态与浏览器回归补齐了数据库结果表格的单元格/整行复制、投屏截图快捷键，以及文件与数据库页来回切换时保留路径、预览和 SQL 草稿。文件地址栏的最近路径只记录成功定位。相关浏览器测试与 TypeScript 检查通过；这些结果不替代上述尚未完成的解锁后真机验收。

文件页又补上按设备恢复上次成功定位的路径。浏览器双设备回归从设备 A 切到设备 B 再切回 A，确认文件路径仍能恢复；测试同时发现并修复了自动恢复与用户立刻输入路径之间的竞态。恢复期间地址栏显示加载状态，新跳转会取消旧请求。该回归仍是模拟接口，尚需双真机切换验收。

并发运行更大范围回归时，又发现恢复文件路径会先加载父目录，并把父目录短暂持久化；恰好在这段时间切换设备，保存的文件目标可能退回父目录。已让文件直达过程的父目录列表加载不覆盖地址栏或持久位置，跨设备浏览器回归通过。单台真机的桌面文件切换已通过；双真机切换仍未验收。

数据库页在同一双设备浏览器回归中保留已打开的数据库/表标签与 SQL 草稿，并在返回原设备时重新打开数据库取得新快照；跨设备遗留的数据库文件快捷入口会清除。浏览器测试曾在无关的停止按钮点击稳定性上偶发超时，重跑通过；真机双设备状态仍未验证。

数据库扫描状态现区分排队与实际扫描，模拟设备测试核对仅两个并发工作项显示“扫描中”，其他应用仍为“等待扫描”。浏览器回归还核对重新扫描后 SQL 草稿和表标签重绑；这些状态需要在真实可访问的调试应用上复测。

文件管理新增普通文件及有界文件夹的设备内复制和移动：真实手机在独立 `/data/local/tmp/piora-copy-test-*` 目录中完成源文件复制、已有目标拒绝覆盖、目标校验后移动及内容回读；文件夹覆盖嵌套文件、空目录、拒绝复制到自身及拒绝符号链接，随后核对没有残留测试目录。移动源内容变化、较大文件夹与操作中断等边界尚未完成实机覆盖。文件列表新增桌面本地文件拖入：只把 1–20 个真实本地路径填入批量上传草稿，需再核对目标目录并点击上传；浏览器回归核对拖入本身不会产生传输请求。首次真实桌面端拖入并上传后，发现任务显示完成时前端还持有已经交接的旧人工令牌，随后的文件移动失败。修复后用当前代码重跑真实 Electron 与 Mate 60：拖入本地 SQLite 样本后手机目标文件仍不存在，点击“上传这一批”后后台任务完成且手机文件有内容，随后继续移动另一设备文件成功；页面异常为 0，临时目录已清理。

### Piora 桌面端与同机联合验收（2026-09-30）

使用仓库 `desktop/` 的真实 Electron 主进程与认证桥接运行开发版 Piora，连接上述 Mate 60；测试进程使用隔离的临时桌面配置，并在结束后清理。未运行本地 release 打包。截图与文件操作均从桌面工作台界面点击触发，再核对真实 HDC 返回；不是仅调用服务端接口或浏览器夹具。

| 项目 | 桌面端实测结果 |
| --- | --- |
| 启动、发现、截图 | 桌面窗口载入会话和鸿蒙工作台，发现手机并保存截图；媒体请求返回 200，任务页缩略图加载为 1216 像素宽，与设备截图 1216 × 2688 对应。渲染进程无页面异常。 |
| 文件与截图并行 | 桌面文件页输入 `/data/local/tmp/piora-desktop-live-<随机 ID>/sample.txt` 并回车，自动展示设备文本；点击“复制文件”后目标文件为 19 字节。再输入目录路径，树形面板定位到该目录；通过界面移动复制件后设备核对旧路径消失、新路径保留 19 字节。复测还核对列表自动移除旧文件名并显示新文件名，无需手动刷新。保持人工设备租约、打开文件工具抽屉时再次点击底部“截图”，媒体请求返回 200。测试发现窄窗口抽屉曾覆盖截图按钮，已缩短抽屉并用元素位置断言核对按钮可达；临时目录已清理。 |
| 数据库与状态保留 | 从文件页切到数据库页，309 个应用均单独显示“无法完整扫描”；返回文件页后，地址栏仍是此前成功打开的设备路径。未将不可访问应用误报为“无数据库”。 |
| 工作台宽度 | 工具标题的“展开”入口在真实 Electron 桌面端切到全宽布局，文件工具区域实测 760 像素宽；“还原”后返回双栏并继续完成文件操作。窄侧栏中的截图按钮仍可点击。 |
| 工具切换与滚动 | 真实桌面端在文件详情将工具内容滚至 1473 像素处，切到数据库页后滚动归零，应用搜索与重新扫描按钮从顶部可见；切回文件页恢复原滚动位置。浏览器截图复核了带查询结果的数据库首屏，避免沿用文件页滚动导致常用入口被隐藏。 |
| 文件操作菜单 | 对真机临时文件在桌面端右键，出现文件操作菜单并成功复制设备路径。浏览器回归覆盖 Shift+F10 打开、Esc 关闭及菜单关闭后文件抽屉保持打开。菜单中的下载和管理入口只定位到现有表单，不直接执行写入。 |
| 实时视频 | 桌面界面显式点击“启用实时视频”时，初次返回 `SCREEN_LOCKED` 且原因错误地是状态未知。设备 `hidumper` 使用空白分隔的 `screenLocked true/false`，解析器已修复并由实际输出格式的测试覆盖；同机再次请求准确返回 `SCREEN_LOCKED / locked`，截图轮询仍可用。中文界面展示了“手机已锁屏。请手动解锁并保持亮屏”的提示，桌面复核通过。手机随后重新锁屏；修复后视频帧及 AI 动作后的重新观察仍需设备保持解锁再验收。 |

正向数据库验收仍需可安装、已启动且调试签名的测试 HAP。现有 309 个应用的沙箱不可读，无法据此声称 SQL、表结构和导出已通过真机测试。桌面端上述通过项也不代替持续视频、实际触控效果、录屏和断连恢复验收。

数据库快照成功响应现携带已校验文件的字节数和双份 SHA-256 一致标记；浏览器回归核对标题下的显示。界面在打开新库时先清除旧标记。由于这台普通权限手机目前没有可读取的应用数据库，该展示只通过模拟快照验证，尚未通过真实桌面端正向快照验收。

文件管理的展开状态现将目录树、文件列表和选中项详情并排展示；浏览器布局回归核对三栏的实际位置、可用宽度及路径按钮没有溢出。窄面板保留纵向布局。真实 Piora Electron 桌面端再次连接 Mate 60，完成截图、路径直达、复制、移动、右键复制路径及 309 个应用状态检查后，展开文件页实测工具宽 760 像素，三栏宽约 165/309/213 像素且渲染进程无页面异常。首次重跑发现选中项详情自身滚动会误关右键菜单，修复并复测通过；一次验收脚本曾因使用未编译 CSS 类名而失败，改用桌面版实际类名后通过。此次桌面通过仍不覆盖锁屏下无法验证的视频、触控与数据库正向快照。

数据库导出新流程在真实 Piora Electron 桌面端用**本地隔离 SQLite 样本**完成了 API 与任务页联合验收：打开只读快照、提交 UTF-8 BOM CSV 后台任务、等待完成，任务卡显示 1 行与 53 字节，已获准工作区内的新目标文件内容和 BOM 均核对一致。测试样本目录及隔离桌面配置在结束时清理。浏览器回归另外覆盖导出范围、编码、目标字段、任务下载与取消；单元测试覆盖已有目标拒绝覆盖、重启后完成任务可追溯、未完成任务标中断并清理临时文件。此为**本地数据库导出链路**证据，不能代替尚缺的调试签名手机应用数据库正向扫描、设备快照和导出实机验收。

随后收紧快照来源：设备采集的快照绑定设备序列标识，设备读取、关闭及导出任务创建时核对归属；本地工作区快照只允许走本地 SQLite 接口。真实桌面端与同一手机重跑后，截图两次均返回 200（其中一次持有人工设备租约），文件直达、复制、移动、右键菜单及展开三栏仍通过，309 个应用均显示沙箱不可访问，渲染页面无异常。本地 SQLite 样本通过本地只读导出；尝试将其作为手机数据库创建任务得到 400，符合隔离预期。此前本地样本的任务卡联测属于收紧归属前的结果，**不视为设备数据库导出正向验收**。

复核真实桌面截图后，将 760 像素工作区的详情由 213 像素窄列调整到文件列表下方，与列表同为约 532 像素宽；目录树仍在左侧。第二次完整 Electron 与 Mate 60 联合回归通过截图（含人工租约）、文件路径直达、复制与移动、右键操作、数据库应用状态和跨来源快照拒绝，页面错误为 0。浏览器布局回归也核对了响应式排列。手机仍处锁屏，视频帧和真实点击效果没有正向通过。

文件查看新增限量的十六进制预览。真实桌面端在手机 `/data/local/tmp` 临时目录创建含 `01 02`、ASCII 与 `00` 的 8 字节二进制文件，通过路径栏选中后点击“查看十六进制”，界面实际显示 `00000000  01 02 50 69 6f 72 61 00`、8/8 字节和完整 SHA-256；随后的截图、文件复制/移动、数据库状态与快照归属回归仍通过，渲染页面错误为 0。临时文件与目录已清理。该能力只预览 64 KiB 以内的普通文件、最多显示前 512 字节，更大的文件保留下载入口。

1 GiB 文件在真实 Piora Electron 桌面端完成上传与下载往返：在已获准的临时目录生成带首尾标记的 1,073,741,824 字节文件，经文件页拖入并确认上传到 Mate 60 的独立 `/data/local/tmp/piora-desktop-live-*` 目录；任务确认上传 1,073,741,824 字节，设备 `stat` 大小一致。随后在文件页选中该文件并排队下载到另一临时目录，任务同样确认 1,073,741,824 字节；下载文件与原文件 SHA-256 均为 `907a5144722180541fe4d872d14159c38cae89186b719df439366a2293250b4c`。同轮小文件移动、截图、媒体历史、文件预览和数据库应用状态回归通过，桌面渲染错误为 0；手机与本机临时文件已清理。该结果验证完整字节往返，不声称 HDC 提供逐字节实时进度或覆盖传输中断恢复。

万项目录在真实 Piora Electron 桌面端与 Mate 60 上复测：在独立设备临时目录创建 10,000 个空文件，确认设备端数量后，文件页显示第 1–500 项与第 501–1000 项，两页各有 500 条文件行；输入末尾 `file-9999.txt` 的完整路径后成功直达并选中该文件。首次试验暴露设备 `stat` 将空文件报告为 `regular empty file`，而文件解析仅认识 `regular file`，现已修复并增加回归测试。通过轮同时完成截图两次（含人工租约）、拖入上传待核对与实际上传、移动文件、媒体历史、二进制预览及 309 个应用的不可访问状态展示，桌面页面错误为 0；设备临时目录已清理。此轮未验证目录变化期间的跨页一致性或中断恢复。

数据库正向样本已从仓库的独立 debug fixture 源码在隔离目录通过 DevEco CLI 编译，但构建提示缺少签名配置，产物不能安装；本机 CLI `auth status` 显示未登录，`signature generate` 要求先登录。设备仍报告 `screenLocked true`。因此不能把该编译结果当作手机应用数据库扫描、快照或导出通过；需要可安装的调试签名 HAP 与保持亮屏的手机后继续。

设备命令页在真实 Piora Electron 桌面端连接 Mate 60 再验收：单次 `echo` 命令显示实际输出及 `exit 0`；新建第二标签以 `Ctrl+Enter` 执行 `pwd`，统一搜索第一标签中的唯一标记并点击结果后返回第一标签；“设备与本机分屏”显示本机终端面板。交互式设备 Shell 返回“已连接”，在 xterm 画面键入命令后，标记同时出现在输入回显和设备输出中；关闭后出现重新打开入口。本轮页面错误为 0。该轮未检查本机终端执行输出、沙箱 Shell 或跨断线恢复。

追加的桌面端与真机重测在本机分屏内实际执行带唯一标记的 Windows Shell 命令，终端画面显示输入和输出；设备页统一搜索该标记后出现“本机终端”命中并可跳转。手机单次命令、两个标签、设备交互式 Shell 与关闭操作同轮重跑通过，页面错误为 0。此结果不覆盖调试应用沙箱 Shell 或断线恢复。

文件文本编辑另用真实桌面端和 Mate 60 完成冲突与成功路径：先打开设备文件并在界面形成未保存草稿，随后在设备端改写原文件；桌面保存得到 409，草稿仍保留，设备原改动未被覆盖。重新预览新版本后从桌面保存原文本，设备读取结果一致。随后的截图（含人工租约）、文件复制/移动、数据库应用状态及本地快照隔离回归通过，页面错误为 0，隔离临时目录已清理。该测试不代替 2 MiB、不同编码或断线时的真机编辑验收。

根据真实桌面截图修正共享根目录的面包屑重复斜杠；再次用 Piora Electron 和 Mate 60 输入完整文件路径后，界面面包屑与设备父目录逐字符相符，同轮截图、拖入上传、复制/移动、十六进制预览及数据库应用状态回归通过，页面错误为 0。数据库结果表格另用浏览器交互样本核对“空表”与“筛选无匹配”的不同提示，以及筛选后隐藏行的复制选择被清除；该项不作为手机数据库正向样本验收。

同一应用的两个不同目录若存在相同库文件名，扫描结果现在各有跨扫描稳定的 24 位十六进制不透明位置指纹；操作 ID 仍为每次扫描重新生成的随机值，列表和标签不暴露原始沙箱路径。同名库的界面名称附短标识，标签和 SQL 草稿按完整指纹恢复；旧版仅记录名字且无法唯一匹配的标签被舍弃，不会错误打开另一库。模拟设备扫描和浏览器交互测试已验证双库归属、刷新后身份稳定、重开页面和草稿恢复；真机正向扫描仍需可安装的调试签名样本。

真实 Piora Electron 数据库页截图发现默认窄面板把应用列表排成横向 130 像素小卡，名称和扫描原因难以阅读。已改为树区纵向全宽滚动、结果区在下方；浏览器容器宽度断言及再次连接 Mate 60 的桌面截图均确认两行应用上下排列。该轮手机 309 个应用逐项为“无法完整扫描”，截图接口返回 200，页面错误为 0；这仍是受限状态验收，不是数据库快照正向验收。

设备文件预览补上图片原始尺寸、适合窗口及 25%–400% 缩放，还有有界音视频只读播放。用真正的 Piora Electron 桌面端连接 Mate 60，在独立 `/data/local/tmp/piora-desktop-live-*` 目录放入生成的 1 秒 WAV、仓库现有的 5,298,445 字节 MP4 与桌面截图 PNG：WAV 和 MP4 均实际播放并推进时间，MP4 还解码出非零视频尺寸及持续时间；图片从适合窗口放大到 125% 后实际显示宽度增加，再恢复适合窗口。对手机 MP4 的 `bytes=0-31` 请求返回 206、`Content-Range: bytes 0-31/5298445` 和准确的 32 字节。首轮通过元数据与图片检查；第二轮因开发热更新时懒加载脚本失败、未进入媒体测试，固定源码后从新进程重跑并确认视频实际播放，页面错误为 0。手机与本机测试文件已清理。不同编码的兼容性仍以桌面端实际解码结果为准。

按最新交互要求，投屏画布改为只读并去掉底部文字输入；缩放后的拖动仅用于查看。浏览器交互回归在无租约和 AI 持有租约两种状态下点击画布，都没有触发设备动作或人工接管。真实 Piora Electron 桌面端连接 Mate 60 后再次点击画布、切换到 150% 并拖动，捕获到的 `/api/harmony/action` 与 `/api/harmony/manual` 写请求均为 0；同轮截图接口返回 200，页面错误为 0，实际界面截图保存在忽略的 `.verification/harmony-desktop-view-only.png`。测试脚本先后因抽屉覆盖画布、使用未编译的 CSS 类名，以及非本项所需的任务历史等待而退出；隔离只读测试路径后从新进程通过。设备 `screenLocked true`，画面虽然可见但实时视频初始化仍不可据此判定通过；DevEco CLI 当前仍未登录，调试签名应用数据库正向验收待完成。

任务页不再只依赖内存中的最近一次媒体提示。服务端按当前设备和已配置媒体目录枚举 Piora 生成的截图/录屏文件，限制数量并核对常规文件与 PNG 头；界面显示历史缩略图、时间、尺寸、大小及打开/复制入口。浏览器回归覆盖截图/录屏筛选和复制路径；单元测试从磁盘重新发现结果、隔离另一设备并排除删除或无效文件。真实 Piora Electron 桌面端连接 Mate 60 截图后，任务页历史卡片和受认证缩略图均可见，原有截图、文件、数据库回归仍通过，页面错误为 0。该结果证明已保存媒体的历史查看，不代表锁屏下录屏成功或视频流已验收。

媒体文件名对 Wi-Fi 地址等需规范化的设备标识附加哈希，模拟的 `phone:1` 与 `phone-1` 两台设备历史互不混淆。旧版此类设备未带哈希的媒体文件无法无歧义归属，仍保存在原目录，但不进入按设备筛选的历史列表；普通字母数字序列号的既有文件名保持兼容。

任务页现在由同一只读总览接口汇集传输、数据库导出、场景执行与媒体历史，显示按设备已索引记录的状态计数和最近记录；点“查看分类记录”定位到下方对应分类。进入任务页时自动读取测试执行记录，传输和测试状态随界面语言显示。状态筛选在服务端先匹配再截取最多 100 项，故大量较新的成功任务不会遮蔽较旧的失败或待核对任务。界面按当前语言生成行数、步骤与媒体类型说明。浏览器回归和汇总单元测试覆盖四类记录、状态筛选与分类定位。真实 Piora Electron 桌面端连接 Mate 60 再次截图，任务总览显示中文“截图”详情及已完成筛选；两次截图接口均返回 200，其中一次持有人工租约。文件路径直达、十六进制预览、复制移动、三栏布局、309 个应用的不可访问状态及本地隔离数据库导出也重跑通过，渲染页面无异常。手机仍锁屏，不能把这轮通过写成实时视频、实际点击效果或手机应用数据库快照的正向验收。

本轮完整 Harmony 回归为 285 项、284 通过、0 失败、1 项既有跳过；根与桌面 TypeScript、ESLint（0 错误、2 条原有脚本警告）、鸿蒙文档检查、许可证清单、性能预算、发布卫生检查和差异空白检查通过。当前代码再次完成真实 Piora Electron 桌面端与 Mate 60 的任务总览、截图、媒体历史及文件操作联测；锁屏视频、有效触控和调试签名应用数据库仍未具备正向验收条件，因此尚未提交、推送或触发 beta。

加入十六进制预览后的完整 Harmony 回归为 282 项、281 通过、0 失败、1 项既有跳过；TypeScript、ESLint（仅 2 条原有脚本警告）、鸿蒙文档检查、发布卫生检查和差异空白检查通过。本地未构建 release，也未提交或推送。

本次更改后的完整 Harmony 回归为 281 项、280 通过、0 失败、1 项既有跳过；TypeScript、鸿蒙文档检查、发布卫生检查与差异空白检查通过。ESLint 无错误，原有两个脚本警告仍在；新增的组件 Hook 依赖警告已单独修复并重新检查该组件。尚未运行本地 `next build` 或 release 打包，也未提交或推送。

同轮回归运行 `node --test lib/harmony*.test.mjs components/HarmonyPanel.test.mjs components/HarmonyPanel.browser.test.mjs`：275 项通过、0 失败、1 项既有跳过；`tsc --noEmit`、项目 ESLint（2 条原有脚本警告）、鸿蒙文档校验和发布卫生检查通过。真实桌面文件流程在恢复路径竞态修复后再次通过。未执行 `next build` 或本地 release 打包。

## 数据库自动重扫与异常重试复测（2026-09-30）

服务端数据库目录五分钟过期或另一个窗口发起扫描时，操作 ID 会重新生成。本轮让工作台检测扫描代际变化，立即关闭旧快照并清除结果、时间与校验标记，再按应用和不透明稳定标识恢复标签、表标签及各库 SQL 草稿，重新采集快照。目录轮询只保留一个在途请求，显式重新扫描取消旧轮询；旧响应无法覆盖新目录。扫描失败时可立即再次点击重新扫描，SQL 草稿仍保留。

浏览器行为回归模拟两个同名库、外部扫描、扫描中的旧结果清除、新操作 ID 与快照绑定、独立 SQL 草稿和表标签恢复、慢请求跨过一个轮询周期、迟到响应及失败后的显式重试。根 TypeScript 与相关 ESLint 通过；完整 Harmony 回归为 287 项、286 通过、0 失败、1 项既有跳过，失败重试补充后定向回归再次运行。

真实 Piora Electron 桌面端使用隔离配置连接 Mate 60，数据库页读取 309 个应用，均明确显示无法完整扫描；通过真实桌面认证通道发起另一次目录扫描，页面自己的轮询收到新扫描代际和完成状态；随后点击界面的重新扫描，再收到不同的新代际。两轮应用数量及不可访问归属一致，没有出现确认无数据库；同轮界面截图返回 200、页面错误为 0。实测图保存于忽略的 `.verification/harmony-desktop-database-rescan.png`，测试进程及临时桌面配置已结束并清理。

该真机结果只验证应用发现、重新扫描及不可访问状态。手机仍锁屏，DevEco CLI 仍未登录，没有可安装、已启动的调试签名数据库样本；正向数据库快照、SQL、结构、导出及视频初始化不能视为通过。最新投屏只读要求已同步到原设计功能说明，旧人工点击优先示意不再属于验收范围。未提交、推送或触发 beta。

## 数据库工作区布局及文件联测（2026-09-30）

数据库与文件抽屉在窄面板占满可用宽度，高度保留底部截图和录屏入口。数据库内容按实际抽屉高度分配；尚未打开快照时应用树占用主要空间，打开表或索引优先显示数据或结构，SQL 控制台按标签展开并保留草稿。行为回归验证应用树、编辑器和首行数据位于抽屉可视区，外层不产生多余纵向滚动。完整 Harmony 回归为 287 项、286 通过、0 失败、1 项既有跳过；TypeScript、相关 ESLint、文档和性能预算检查通过。

真实 Piora Electron 连接 Mate 60 后，窄工作区宽度 668 像素，数据库抽屉同宽，内容区域高 528 像素，应用树高约 327 像素，均位于可视范围；309 个应用均明确显示无法完整扫描，外部扫描和界面重新扫描均更新，截图接口返回 200，页面错误为 0。随后真实桌面文件联测通过路径跳转、文件复制移动、拖入上传、十六进制查看、展开布局和独立滚动；截图及持有租约时的截图均返回 200。临时文件、隔离桌面配置和测试进程均按脚本清理。数据库导出仅为本机隔离样本，不代表手机应用数据库验收。

实测截图保存于忽略的 `.verification/harmony-desktop-database-layout-full.png`。手机锁屏和调试签名样本缺失仍限制正向数据库及视频验收；未提交、推送或触发 beta。

投屏只读复测：主工作区的一次隔离桌面启动在进入认证页面前超时，未计为通过；随后在本开发工作区重新启动真实 Piora Electron 并连接 Mate 60，点击画布和放大后拖动均未发送设备动作或接管请求（0 次），截图接口返回 200，页面错误为 0，测试进程与临时配置已清理。本次结果仅确认只读投屏交互和截图，不代表全部功能及锁屏下视频初始化已验收。

## 设备回执与失败后的截图（2026-09-30）

本轮开始时 Mate 60 曾报告已解锁，实际安装内置投屏 HAP 返回退出码 0，但设备输出 `fail to verify pkcs7 file`、错误码 9568257；服务包实际未安装。原初始化接口仍返回成功，不能计为视频通过。现在安装、卸载和启动均必须收到明确成功回执；安装失败停止后续启动，并在应用页显示签名原因和设备错误码。判据对照 [官方 HDC 回执](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md) 与 [官方 aa 回执](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/aa-tool.md)。随后手机再次锁屏，DevEco CLI 仍未登录；实时视频、录屏和调试应用数据库正向验收仍缺少设备可接受的签名包。

真实桌面复测发现录屏启动失败后误留“停止录屏”状态，以及错误浮层阻挡截图点击。前者已通过延后发布录屏状态及保留热重载错误的清理证据修复；后者改为独立布局行。补充行为测试验证失败后不存在录屏成功状态，并能直接点击截图，无需关闭错误提示。完整 Harmony 回归为 292 项、291 通过、0 失败、1 项既有跳过；最新定向回归 50 项与工作台浏览器交互回归均通过，TypeScript 和相关 ESLint 通过。此处自动测试结果不代表全部功能真机验收完成。

最新真实桌面重跑的首次截图按钮保持禁用，未能执行后续流程；随后直接读取 HDC 发现目标手机为 USB Offline，因此本轮不能计为通过。主工作区的投屏只读浏览器与组件回归 4 项全部通过；先前真机点击和缩放拖动 0 次设备写入的证据保留，但不能代替离线后的再次验证。未提交、推送或触发 beta。

## 安装、数据库采集任务及设计同步（2026-09-30）

任务总览补齐直接/场景安装、显式投屏服务初始化与数据库采集。任务开始及结果落入私有本机记录，详情显示目标、时间、大小和校验方式；签名拒绝是失败，安装发送后中断或缺少成功回执归为待核对。未发送的取消与只读采集取消单独标为取消；重启后未完成记录归为待核对，不恢复输入、不自动安装。数据库一致性失败不会产生成功记录，历史采集元数据也不作为可查询的当前快照。

回归覆盖进行中记录、重启恢复、失败签名码、取消后的效果未知、设备隔离、不保存租约、直接安装与场景安装归属、采集成功及两份副本不一致的失败。工作台浏览器回归实际点击任务状态筛选和展开详情，检查本地安装目标、签名错误码、采集时间及重新采集提示。完整 Harmony 回归 296 项、295 通过、0 失败、1 项既有跳过；TypeScript、相关 ESLint、文档 15 个入口及性能预算检查通过。最后记录校验收紧后定向回归 4 项与类型、lint、文档检查再次通过。

交互设计源文件的投屏、媒体、恢复和任务页面同步修订：删除鼠标手机操控及人工点击优先流程，改为 AI 运行时只读观看；任务图补齐安装与数据库采集、失败及待核对。18 张界面/状态图已从 HTML 重新生成，原生成脚本同时检查只读文案、任务类型、路径跳转、数据库搜索与刷新示意；投屏、任务、AI 观看及恢复图片人工检查无遗留人工点击流程。这些图均为设计示例，不是真机验收证据。

本轮开始和结束时 HDC 均确认 Mate 60 为 USB Offline，DevEco CLI 登录状态为未登录。未重启反复执行同一离线真机流程；真实手机的实时视频、录屏、已签名应用安装和应用数据库快照/SQL/导出连续流程仍未完成。未提交、推送或触发 beta，完整目标保持未完成。

## SQL 错误定位及独立解析资源验证（2026-09-30）

查询错误现在在 SQL 编辑器旁显示，保留上一次成功结果；能够核验的位置提供行列和定位按钮。独立 SQLite worker 只在准备语句错误时按需解析私有只读副本，不执行诊断 SQL，不修改源数据库。原生和 WASM 的错误文本必须一致；没有错误 token 的不完整语句明确显示无可核验位置。UTF-8 字节位置转换到编辑器偏移，中文、Emoji、选中语句在全文中的位置均被覆盖；编辑后旧定位立即禁用。

定向 12 项测试通过；其中打包测试使用临时最小 ASAR 及真实侧目录运行 worker，实际加载 ESM/WASM，无开发目录依赖，并核对源数据库前后逐字节不变。这是资源隔离单元测试，没有构建发布安装包。完整 Harmony 回归 299 项，298 通过、0 失败、1 项既有跳过；TypeScript、相关 ESLint、文档 15 个入口、许可证清单和性能预算检查通过。第一次定位测试错误地把 Emoji 计为两列，期望值已按 Unicode 字符校正；浏览器测试随后实际检查定位光标、草稿变更提示及无位置失败后结果仍在。界面回归截图保存在 `.verification/harmony-design-audit/database-query-error.png`，是隔离组件状态，不是真机数据库结果。

外部设计稿补充 SQL 错误定位状态及配套功能说明，当前 19 张设计图全部重新生成，并验证设计示例的定位按钮和草稿更改后的禁用行为；设计图不作为产品实机证据。主工作区只读投屏新增点击、长按、本地拖动不发送设备动作的回归，4 项通过，类型及 lint 通过；开发工作区继续保留只读投屏。

最新 HDC 仍为 Mate 60 USB Offline，DevEco CLI `auth status` 仍为未登录。此轮不重复启动已知离线的真实手机流程，不能把软件回归或设计图当作手机应用数据库、视频及录屏验收完成。需要手机重新在线及设备可接受的调试签名包后继续真实 Piora 连续流程。未提交、推送、发布，目标仍未完成。

## 新任务入口与连接信息实机复测（2026-09-30）

本轮 HDC 确认 Mate 60 已恢复 USB Connected；DevEco CLI 仍未登录。复用已有只读参数采样，顶栏显示连接方式、单独的序列号尾号与响应耗时，并注明时间及主机 HDC 开销。离线、未授权、未知状态分别显示恢复说明；样本过期或切换设备后不沿用旧耗时。

真实 Piora Electron 开发桌面端从“新对话”选择项目并打开右侧工作区，先发现延迟加载期间没有提示；增加加载提示后延长等待，进一步确认项目恢复会把刚打开的工具区关闭。现已修复为文件恢复不关闭用户打开的非文件工具区，再从新进程复测通过，没有强制点击或覆盖界面样式。

完整新任务流程复测通过：USB 信息与采样时间可见，兼容投屏获得实际画面，截图接口返回 200；目录树加载成功，输入 `/data/local/tmp/debugserver` 后回车直达并定位面包屑。手机不允许列出 `/data/local`，首次脚本错误地将其当作应成功的路径；随后将它纳入拒绝路径验收，确认中文访问原因可见，原 `/data/local/tmp` 目录及用户输入保持不变，再跳转可访问子目录成功。实时视频组件缺失另携带结构化原因，页面按语言说明兼容投屏和显式初始化入口；未因此自动安装组件。

数据库页自动展示 309 个应用，全部逐项显示沙箱无法完整扫描及原因；点击“重新扫描”更新扫描标识并再次完成，数量与受限状态相符。无数据库文件路径输入框，也未把不可访问应用显示为无库。从点击只读画布到路径导航、数据库扫描，设备动作与接管接口请求合计 0 次；渲染页面错误为 0。实机截图保存在忽略的 `.verification/harmony-desktop-new-task.png`、`harmony-desktop-new-task-files.png` 与 `harmony-desktop-new-task-databases.png`，隔离配置与测试进程已清理。

本轮完整 Harmony 与项目切换回归共 305 项，304 通过、0 失败、1 项既有跳过；之后文件访问文案、未知连接状态与错误原因序列化的定向回归 45 项，44 通过、0 失败、1 项既有跳过。最新根 TypeScript、相关 ESLint、文档 15 个入口、许可证清单、性能预算及差异空白检查均通过。

这些结果只证明上述连续流程。手机应用数据库的有效快照、SQL、结构和导出仍缺已安装且已启动的调试签名样本；实时视频、录屏及多设备验收也未完成。尚未提交、推送或触发 beta，完整目标保持未完成。

## 数据库结构准确性与文件地址栏复测（2026-09-30）

真实 SQLite 回归先复现生成列被错误过滤的问题：`SELECT *` 有六列，结构页只返回四列。现已保留 VIRTUAL/STORED 生成列，并用实际 SQLite 文件核对结构字段与数据列一致。表达式索引通过 `index_xinfo` 区分键与辅助存储列，保留 ASC/DESC 与 COLLATE；部分索引显示实际创建语句。普通表的自动 UNIQUE/主键约束索引进入对象树，省略目标字段的外键显示父表主键，不显示 `null` 字段。结构读取后原始文件字节完全一致。结构页补充表创建语句与分项索引卡片，键盘可选择索引并高亮详情；360 px 窄面板没有整体横向溢出，创建语句可独立滚动。

文件地址栏将路径输入与“前往”独立成行，最近路径、复制和收藏位于下方。真实桌面端原先约 130 px 的输入空间现为 354.69 px，占 405.69 px 地址行的主要部分。Ctrl+L 全选设备地址，Enter 跳转目录或文件；不可读取的 `/data/local` 显示原因且保留此前确认的目录。菜单回归还发现已选中文件会被重复预览、覆盖未保存草稿，且预览期间禁用行影响 Escape 返回焦点；现在重复打开该文件菜单保留预览和编辑状态。

真实 Piora Electron 开发桌面端与 USB Mate 60 的连续流程再次通过：新任务选择项目、连接信息、兼容只读画面、截图、目录树、路径快捷键、可访问目录与拒绝路径、独立合成文本的预览及本机草稿、右键复制路径、Shift+F10 打开菜单及 Escape 返回文件焦点。通过 HDC 在指定临时路径准备独立文本仅用于测试夹具；所有浏览和菜单交互均使用实际桌面面板。编辑未保存到手机，HDC 回读确认源文本未变，夹具随后删除。画布、查看文件及扫描期间未请求设备动作或接管，页面运行错误为 0。数据库仍自动列出 309 个应用并分别说明无法访问；重新扫描更新时间且保持真实受限状态，没有数据库路径输入框。

本次实机脚本最初把正常列表内文件误认为必须带“路径直达”标记，之后又以聚焦时会被 AppTooltip 临时移除的 `title` 属性定位，导致脚本等待失败；已改为使用稳定的可访问文件名，重新执行上述完整流程通过，没有强制点击或改写页面样式。最新文件地址栏实机截图为 `.verification/harmony-desktop-new-task-files.png`，键盘菜单与草稿流程截图为 `.verification/harmony-desktop-file-context-draft.png`。`.verification/database-structure/database-structure.png` 与 `database-structure-narrow.png` 是隔离组件截图，不是手机数据库结果。

数据库、快照、查询错误、导出与打包资源定向回归共 17 项全部通过；最新工作台组件连续流程回归通过（包含实际请求计数、地址栏宽度与 Ctrl+L、未保存草稿及键盘菜单）。根 TypeScript、相关 ESLint、文档入口、性能预算与差异空白检查通过。19 张设计图及配套功能说明已同步结构和地址栏行为并重新渲染检查。

CLI 最新探测仍未登录，手机没有可读取的已启动调试签名数据库样本。正向手机数据库快照、SQL、结构及导出，以及实时视频/录屏与多设备矩阵仍未完成；不以本机 SQLite 或隔离 UI 回归替代这些验收。尚未提交、推送或触发 beta，完整目标保持进行中。

## 截图暂存清理与文件菜单焦点（2026-09-30）

兼容投屏和用户截图在每次采集的 finally 中清理本机 PNG 与本轮生成的远端图片，清理仍位于每设备采集队列内。远端删除使用独立 3 秒命令，不沿用已取消信号；不删除其他进程生成的图片。新增回归先在旧实现复现采集后残留与取消后未清理，再确认修复后成功、取消及并发采集的完整字节与调用顺序。HDC/工作台定向回归共 25 项全部通过，根 TypeScript 与相关 ESLint 通过。

直接使用真正 HDC 执行器连接 USB Mate 60，顺序两次、并发两次、完成设备截屏后取消一次及恢复一次，共 6 次采集。成功帧为 1216×2688，样本各 2,369,835 字节；每轮在后端 dispose 前以独立设备检查确认本轮远端文件不存在，本机 PNG 同样不存在。并发顺序为采集、传输、清理后才允许下一轮采集，取消后下一轮成功；退出后私有本机目录不存在。这个检查仅证明在线设备上的自有暂存清理，不把断线后的尽力清理当作已删除证据。

文件菜单触发器改用稳定文件名按钮，不依赖 AppTooltip 临时移除的 title 属性。组件回归启用实际 AppTooltip 并等待标题移除，确认右键菜单 Escape 返回文件焦点。真实 Piora Electron 开发桌面端与 Mate 60 的新任务连续流程再次通过同一条件、未保存草稿、Shift+F10/Escape、源文本未变、目录树和路径直达、截图及数据库应用扫描/刷新；设备动作/接管请求为 0，页面错误为 0。独立手机文本夹具与本机配置已清理。309 个应用仍各自显示不可访问，不代表正向数据库采集已完成。

## 日志工作台功能与交互回归（2026-09-30）

日志补齐独立 TAG、设备时钟范围、保留原文/筛选结果 UTF-8 导出、复制、清空与完整行详情。最近一万行采用可见行虚拟渲染，暂停冻结展示副本而继续接收，断线保留已采集内容，切换设备不混用。分别显示服务端未接收与本机保留上限淘汰数；导出仅包含当前展示副本，不补造丢失的历史。HiLog 未提供年份/时区，时间按实际月日和时钟比较，可选跨午夜的范围。

4 项日志定向回归通过：真实子进程 UTF-8 分块和取消，普通/正则筛选，整秒/小数秒和跨午夜时间边界，浏览器一万行、阅读锚点、暂停后继续接收、精确导出、详情复制、无效时间、断线保留、清空及窄面板。首次时间实现的浮点精度误包含下一秒，已改为整数毫秒；首次隔离浏览器夹具脚本编码失败，已统一为 UTF-8 与普通脚本打包后重跑。根 TypeScript、相关 lint、文档与性能预算检查通过，19 张设计图与配套说明已同步并重新渲染。

新增真实桌面日志验收第一轮收到实际 HiLog，并在暂停后继续观察到新日志，TAG/时间过滤得到结果，但导出回调误用 Electron evaluate 环境不可用的 require，实际主进程日志确认异常，不能计为通过。该轮已经终止，本机私有配置已清理；脚本改为从调用方传入已确认的私有保存路径，并捕获下载回调错误。再次运行停在设备参数响应验收：HDC 显示 USB Connected，但参数及其他命令返回“通信通道正在建立”，没有获得有效响应，未进入日志导出验收。

连接失效后无法确认第一轮独立合成文本夹具已经删除，已记录其单个生成路径到忽略的 `.verification/harmony-pending-device-cleanup.json`。脚本仅对严格匹配的自有夹具路径删除，并要求肯定删除回执；下次真实参数查询成功后先清理待核对夹具再验收，不把 HDC 退出 0 当作清理成功。没有删除其他进程或用户文件。没有因自动测试通过而将手机日志验收提前标为成功；签名样本、正向数据库、视频/录屏、多设备及发布仍未完成。

## 日志真实桌面端验收通过（2026-09-30）

随后实际设备参数恢复为有效 API 26，既有真实 Piora Electron 开发桌面端脚本从新任务入口重新完成设备、兼容只读画面、截图、文件树和路径直达、草稿与菜单焦点、数据库应用目录及日志连续流程，退出 0。此轮使用真正手机 HiLog SSE，暂停显示时仍观测到新日志；TAG 与设备时钟范围得到筛选结果，实际 Electron 下载写入私有本机目录，筛选文件 1,643 字节、保留原文文件 1,154,271 字节，清空和恢复采集成功。页面错误和设备动作/接管请求均为 0。它证明这些日志功能的真机桌面组合流程，不证明视频、录屏或正向应用数据库。

此前自有文本夹具经肯定删除回执完成清理，本轮测试夹具、下载文件和隔离本机配置在 finally 清理。当前待核对夹具记录不存在。旧的失败记录仍保留作为修复依据，不能据早期失败或后续成功推断全部设备功能通过。

## 应用工作台与安装预览（2026-09-30）

应用页改为激活后自动读取完整设备列表、本地搜索和每页 100 项，新增系统、第三方及分类未确认。元数据只接收匹配包身份的明确布尔值，兼容真机 `isSystemApp/userDataClearable` 与官方字段，缺失、冲突、字符串布尔和其他应用身份都不猜测。缺少分类时最多三路详情读取、两分钟限时，能取消或继续；不会启动任何应用。详情展示版本、已发现 Ability、安装来源、使能和带时间的进程观察，受保护维护入口禁用并显示原因。

沙箱按钮先检查该应用的只读目录，再切到文件页并填入应用及根路径。隔离完整工作台回归实际经过三个组件的回调和文件范围恢复，确认跨页定位正确且没有动作/接管请求。首次新回归因字段的辅助说明混入可访问名称而等待失败，现已为应用字段设置明确名称，后续完整流程通过。准备控制期间取消后，即使租约承诺稍后返回也不再发送启动命令；维护后通过详情或列表回读，而非乐观删除。

HAP 预览接口要求桌面认证和允许工作区，仅读取根配置，实际展开元数据不超过 512 KiB，包文件最多 256 MiB；不执行内容或声称签名已验证。Stage 与旧 config.json 版本事实、坏包、异常身份、重定向 ZIP 路径、展开超限、取消、认证/工作区/JSON 边界均有回归。预览后改文件的测试确认 `STALE_SNAPSHOT` 及未派发设备指令；匹配文件冻结后，即使原文件再变化，后端仍收到原字节。安装界面显示包名、版本、现有版本、设备、替换选择、大小和 SHA-256，确认取消不安装，路径修改会使预览失效；命令返回后回读目标版本，无法核对一致时显示待核对。

使用本机已经编译的 60,817 字节 unsigned 测试 HAP，实际预览读取到自有测试包、1.0.0 / 1000000、entry 和 EntryAbility，签名仍为未验证；没有据此执行已知会被设备拒绝的安装。首次 ZIP 实现误用库不支持的异步迭代接口，改为官方有界 StreamHelper 后包解析回归通过；随后补齐该公开接口缺失的 TypeScript 类型。

最新完整 Harmony 回归共 317 项，316 通过、0 失败、1 项既有跳过；原始输出在忽略的 `.verification/harmony-app-suite-20260930.log`。根 TypeScript、相关 ESLint、动作目录/文档入口、性能预算和差异空白检查通过。一次测试文件筛选错误误触发全仓自动发现，已终止，未把该轮当作 Harmony 回归；新命令先确认至少 70 个匹配文件，再仅运行 77 个 Harmony 测试文件。20 张设计/状态图和配套说明已更新并渲染检查，应用与安装预览图已人工检查；设计示例不是实机证据。

本轮早期 HDC 报告手机 USB Offline；随后连接恢复，实际参数查询成功后运行完整真实桌面流程，退出 0。真实 Piora Electron 开发桌面端通过 USB 连接手机，设备截图返回 200，自动列出 309 个应用，详情读取到 3 个明确的保护字段；本机 HAP 只读预览通过。点击投屏没有产生设备输入或接管请求，文字输入与接管入口不存在，页面错误为 0。

文件路径跳转、草稿和菜单焦点、设备源文本未改变、无权限跳转保留原位置均通过。数据库扫描及刷新归属 309 个应用，本次全部不可访问并显示原因，不能计为“无数据库”或正向查询通过。实际 HiLog 暂停仍采集、TAG/时间过滤、原生下载、清空与恢复通过，筛选导出 114 字节、保留原文导出 580,833 字节。测试自有手机文本夹具、下载和隔离配置已清理，待核对清理记录不存在。

主工作区另运行投屏专项浏览器回归，4 项全部通过：点击、拖动、长按不发送设备输入或取得控制，放大拖动只移动本地查看区域，输入文字与系统按键入口已移除，截图保留。此项浏览器测试与上述真实桌面手机流程分别记录，不混称为实机视频/录屏验收。

签名测试应用的安装/维护及数据库正向快照、SQL、结构与导出，实时视频/录屏、多设备和持续性能矩阵仍未完成。未提交、推送或触发 beta，完整目标保持进行中。

## 文件草稿保护与真实设备冲突验收（2026-09-30）

文件草稿按设备、共享/应用范围、原路径保存，浏览其他文件、刷新目录、切应用或设备、关闭工具、页面重载后重新打开可恢复。独立 IndexedDB 事务完成后才显示本机已保留；存储失败保留内存，提供复制并在尚未提交或失败时提示离开页面。明确放弃才删除，删除失败恢复内存；没有自动按年龄或数量清理。恢复始终核对当前设备哈希，无法读取或变化时保持原文与草稿但禁用保存；范围切换取消旧读取，等待租约期间取消不会继续写设备。

新增真实浏览器组件回归验证上述行为，并覆盖存储/删除失败、过期读取、取消保存、原始哈希提交及保存后删除草稿。初始测试 HTML 未声明 UTF-8 导致夹具脚本语法错误，补齐字符集后修复；应用 datalist 输入实际角色为 combobox，测试已按真实可访问角色选择。新回归还暴露切设备恢复期间过早开放地址的问题，恢复完成前现在禁用地址。最终完整 Harmony 回归共 318 项、317 通过、0 失败、1 项既有跳过；原始输出在忽略的 `.verification/harmony-file-draft-suite-20260930.log`。根 TypeScript、相关 ESLint、文档目录、性能预算及差异空白检查通过；20 张设计图和配套说明同步更新并重新渲染，文件编辑图已检查。

第一轮真实桌面端在截图处收到 502（HDC 拒绝命令），退出 1，未进入文件草稿验收，不计为通过。随后设备参数仍有效，独立实际截图返回 1216×2688、960,432 字节；在已确认旧流程终止和截图恢复后重新运行。第二轮真实 Piora Electron 开发桌面端连接 USB 手机完成整个流程，退出 0：截图 200、路径与文件树、目录跳转后草稿恢复、刷新目录后草稿恢复均通过。仅改变本轮自建 UUID 文本文件来制造设备外部修改，重新预览后草稿不变且保存禁用，明确放弃后读取到新设备内容。没有在用户文件上写入或制造冲突，也没有将软件模拟的成功保存当作真实手机保存通过。

同轮自动应用列表 309 项、保护字段 3 项及 HAP 本机只读预览通过。数据库扫描与刷新仍为 309 个不可访问应用，不证明正向库采集/查询。实际 HiLog 暂停继续采集、TAG/时间过滤、原生下载、清空及恢复通过：筛选导出 2,769 字节、保留原文 858,388 字节。设备输入/接管请求与页面错误均为 0。自建设备夹具及私有下载、Electron 配置在 finally 清理，待核对清理记录不存在。签名样本、正向数据库、视频/录屏、多设备及持续性能验收尚未完成，完整目标未标为完成，尚未推送发布。

## 本机草稿恢复与只读投屏再次实机验收（2026-09-30）

文件页新增独立本机草稿入口，按当前设备列出范围、路径与保存时间，每页最多 50 份。IndexedDB 升级保留旧草稿，旧记录缺少保存时间时明确显示未知；列表只读取元数据。打开恢复副本不访问手机，原设备文件删除或无法读取时仍可查看、复制。只有点击“核对设备文件”才读取当前设备状态；捕获原文与旧哈希不当作当前设备内容。明确放弃使用所查看草稿版本，期间出现新编辑则拒绝删除并要求重新选择；成功删除同步关闭同一文件的旧编辑副本。存储不可用时说明仅列出当前窗口副本，不把读取失败当作没有草稿。

真实浏览器组件定向回归通过旧数据库升级、缺失文件恢复、零设备读取、复制、核对失败保留、取消与明确删除、新编辑阻止旧副本删除、存储失败回退及删除后编辑器同步。113 份草稿的分页分别为 50、50、13，列表没有读取草稿正文；360 px 面板无整体横向溢出。最新完整 Harmony 回归共 318 项，317 通过、0 失败、1 项既有跳过，原始输出为忽略的 `.verification/harmony-draft-recovery-suite-20260930.log`。TypeScript、相关 ESLint、文档入口与性能预算检查通过。设计新增草稿恢复状态及配套说明，21 张设计图全部重新渲染检查；设计示例不作为手机验收证据。

真实 Piora Electron 开发桌面端与 USB Mate 60 的完整连续流程退出 0：截图返回 200，目录树、路径跳转、草稿跨文件恢复、目录刷新及外部修改保护通过。随后仅删除本轮自建 UUID 文本文件，在桌面本机草稿入口打开、复制其恢复副本，期间设备文件 API 请求为 0；明确核对得到文件不存在，草稿仍在，明确放弃成功。自建手机文件获得肯定删除回执，私有桌面配置与下载在 finally 清理，待核对设备清理记录不存在。恢复截图为忽略的 `.verification/harmony-desktop-local-draft-recovery.png`。

同轮应用列表 309 项、明确保护字段 3 项和本机 HAP 只读预览通过。数据库 309 个应用均显示无法访问及原因，重新扫描通过，不计为无数据库或正向查询。真实 HiLog 暂停继续采集、TAG/时间过滤、原生下载、清空与恢复通过：筛选导出 1,638 字节，保留原文 601,593 字节。投屏点击及本地拖动没有发送设备输入或接管，整个流程设备动作/接管请求为 0，页面错误为 0。该结果属于实际开发桌面端与真实手机，不是已发布 beta 安装包验收。

签名应用安装与维护、正向应用数据库快照/SQL/结构/导出、实时视频/录屏、多设备及持续性能矩阵仍待完成。尚未提交、推送或发布，完整目标保持进行中。

## 文件对照与展开布局修订（2026-09-30）

根据实际桌面截图，文件预览补齐采集时原文和修改草稿。原文只读且可收起；宽预览并排、窄面板堆叠。核对保存、差异、复制和明确放弃位于文本之前，滚动编辑区时保持可见；SHA-256 折叠显示并注明是采集副本。直接打开和文件路径跳转定位到预览区，右键选中不抢走菜单位置。展开工作台现在解除文件与数据库工具区原有宽度上限；文件文本预览适度缩窄列表，排序、数量和隐藏文件控件换行保持可见。本机草稿目录与恢复副本在宽区域并排。

浏览器行为回归确认原文不可编辑、编辑后原文不变、对照开关无新设备请求、修改撤销旧差异、预览滚动时保存按钮可见、旧哈希提交及较新草稿保护。首次宽对照测试发现标签换行导致两个正文错位 21 px，修复后按实际标签高度对齐。旧回归把“复制草稿”按钮存在等同未清理草稿，现改为检查已验证保存后 IndexedDB 不存在该草稿、保存按钮禁用，复制仍可用于刚采集的文本。展开三区及变窄列表控件的真实边界检查通过，360 px 草稿和文本区域无整体溢出。外部 21 张设计图与配套说明同步更新并重新渲染检查。

首次完整回归 318 项、316 通过、1 失败、1 既有跳过：布局测量发生在文件已选中但文本响应尚未完成的中间状态。回归现在等待实际只读原文出现，再测量文本预览布局；没有降低三区宽度要求。调整后两项浏览器连续流程按并发 2 重跑均通过。最终完整回归 318 项、317 通过、0 失败、1 既有跳过，原始输出为忽略的 `.verification/harmony-file-preview-suite-final-20260930.log`，早期失败输出保留在同目录另一文件。TypeScript、相关 ESLint、性能预算、文档入口与差异空白检查通过。

本轮真实桌面端尝试在预检阶段退出 1，HDC 目标显示 USB Connected，但实际设备参数查询持续返回“通信通道正在建立”。验收脚本在页面尚未创建时的诊断输出又用 undefined 写文件，遮蔽了原始预检错误；已修复为先记录原始错误并保存 null 布局。依据本机 HDC help 对主机服务执行一次 kill -r，之后独立参数查询仍失败，没有重复重启或把连接列表当作成功通信。此轮未创建手机测试文件，待核对清理记录不存在；新增文本对照和展开布局的实机验证尚未通过。CLI 实际 auth status 仍为 Not logged in。已请求用户重新连接 USB 并确认调试授权，保留原有签名登录问题。

完整回归后补充数据库展开/还原布局检查，独立工作台浏览器连续流程再次通过：展开的数据库工具区占实际可用宽度至少 95%，没有越界，展开和返回双栏均保留原 SQL 草稿。此检查使用隔离软件夹具，不是手机正向数据库结果。

已 git fetch origin，工作区 HEAD 与 origin/main 无相互新增提交；没有提交、推送或触发 beta。本轮浏览器与设计证据不能代替真实桌面手机组合流程，完整目标仍未完成。

## 目录树分页、键盘及浏览状态恢复（2026-09-30）

目录树补齐独立下一页、扫描数量、失败保留与分支重试。只缓存目录，每分支先显示 200 个，用户每次从缓存增加 200 个；不把 500 项设备页一次全部挂载。树内独立滚动，刷新/导航取消旧分页；下一页不改变文件列表或地址。方向键、Home/End、名称首字符、Enter 与空格可导航；焦点用引用管理，不读取设备或重绘整个文件区。树底重试按钮最初因焦点处理滚回父节点、鼠标抬起位置改变而无法点击，已修复并用实际指针重试验证。隐藏文件页不截获当前工具的 Ctrl+L，Alt+← 保持上级导航。

按设备和应用范围保存展开选择、渐进显示数量、额外根目录与滚动位置，最多记住 256 个分支，不保存旧设备目录或权限结果。重新打开先完成当前路径读取，再最多三个并发只读请求重新读取已展开目录第一页，不自动读取后续页。失败显示原因与重试；手动导航、滚轮或刷新中止恢复，旧设备/旧范围/迟到结果不更新新树。恢复不夺焦点，存储写入合并到动画帧；禁用或异常的 sessionStorage 不影响当前浏览。

隔离浏览器回归使用 1205 个示例条目、三页共 964 个目录，确认每个目录只显示一次、文件不成为目录节点、缓存显示更多不读取设备、失败重试不改变列表、迟到分页不能追加。360 px 面板无横向溢出，树高度独立限制。新增恢复回归确认重载后读取新目录名称，显示数量与滚动恢复，另一设备不继承展开/滚动，切回原设备恢复；读取失败保留分支并成功重试，方向键打断后拒绝晚回复，关闭工具后保留独立分支及主动收起选择。元数据回归覆盖设备/应用身份隔离、非法路径与超限、存储不可用，以及不保存旧目录数据。五项定向回归全部通过。

分页阶段完整回归 319 项、318 通过、0 失败、1 项既有跳过，原始输出为忽略的 `.verification/harmony-folder-tree-suite-20260930.log`。补齐浏览状态后最终完整回归 321 项、320 通过、0 失败、1 项既有跳过，原始输出为 `.verification/harmony-folder-view-suite-final-20260930.log`。根 TypeScript、相关 ESLint、性能预算、38 个共享动作/6 个模板/15 个文档入口及差异空白检查通过。22 张设计图全部重新渲染并检查，新增目录分页、重试、键盘与浏览恢复说明；新图的 360 px 单列布局和无横向溢出也通过。设计示例与软件夹具不作为实机证据。

本轮独立 HDC 参数查询仍持续返回“通信通道正在建立”，不能以 USB Connected 证明可操作。没有重复启动已知失败的桌面流程或重启 HDC，没有新建手机夹具，待核对设备清理记录不存在。真实桌面脚本已加入目录键盘零文件读取及关闭工具后恢复展开的检查，语法检查通过，尚未执行通过。新增目录状态与上一轮文本对照/展开布局的真实桌面手机组合验收仍待连接恢复；签名应用安装与维护、正向应用数据库/SQL/导出、实时视频/录屏、Wi-Fi/多设备与持续性能矩阵仍未完成。尚未提交、推送或发布，完整目标保持进行中。

## 调试通信未就绪的真实桌面端验收（2026-09-30）

以当前真机返回的 Connected 列表及明确通道错误建立回归，先在旧代码复现设备被误报 online，再修复为仅在参数查询出现明确 HDC 通道错误、且整轮设备信息无有效响应时返回 unknown 与 `hdc-channel-not-ready`。目标命令的明确通道错误清除该设备的信息和能力缓存，恢复后不沿用失败缓存。协议判断只匹配 HDC 标记行，不把普通日志文字、参数缺失或权限不足当作通道失效；有有效模型等响应时仍保持在线。错误提示不声称上一次动作已经撤销。

30 项后端、连接与错误提示定向回归通过，涵盖零退出码通道失败、立即恢复重探测、运行中通道失败后的缓存失效、部分有效响应、权限/未知参数边界，以及中英文提示。完整 Harmony 回归 327 项、326 通过、0 失败、1 项既有跳过，输出为忽略的 `.verification/harmony-channel-ready-suite-20260930.log`。随后根据真实截图将底部“请连接设备”改为“等待调试通信”，四项面板回归再次通过。

真实 Piora Electron 开发桌面端直接连接同一 USB 手机，使用实际 IPC 身份与后端接口，没有模拟或拦截设备响应。连续两轮故障状态验收均退出 0，每轮初次发现和两次刷新得到三份 unknown/hdc-channel-not-ready/USB 结果，没有参数响应样本。界面显示通信未就绪与重新插拔/解锁/调试授权指引，截图和新录屏禁用，不显示旧实时画面。每轮在空白投屏区域点击五次并刷新设备，action/manual/media 写请求为 0，页面错误为 0；底部正确显示等待通信。没有安装、启动或解锁应用，没有新建手机文件。私有桌面配置已清理，30145 服务监听已结束，待核对手机清理记录不存在。

最新只含设备面板的真实截图为 `.verification/harmony-desktop-channel-not-ready-panel.png`，完整桌面截图为 `.verification/harmony-desktop-channel-not-ready.png`，有限状态报告为 `.verification/harmony-desktop-channel-not-ready-report.json`。此结果证明真实故障提示与禁用行为，不证明手机正常操作流程已经通过，也不代表已发布 beta 安装包验收。

根 TypeScript 初次发现客户端设备类型缺少新增字段，补齐后通过；后续与真实桌面 dev 启动并行的类型检查因 Next 正在重写临时类型文件而报缺失文件，服务终止后根检查重新通过。相关 ESLint、性能预算、38 个共享动作/6 个模板/15 个文档入口与差异空白检查通过。设计补充通信未就绪状态、刷新保持未确认及操作禁用，共 23 张全部重新渲染检查；说明中原有“仅定义接口、不修改代码”的过期阶段标题已同步。

该轮快捷键复核结论有误，后续直接读取组件确认已经存在固定 Alt+Shift+S 的设备截图监听；缺失的是设计要求的自定义设置与更完整的范围保护。`capture.screenshot` 仍是另一项桌面截图 IPC，不能代替设备截图。此处保留修正，以下新验收记录以实际代码与执行结果为准。真实手机通信与 CLI 登录仍未恢复，目录恢复/文本对照的新交互正向实机、调试签名应用、设备数据库、实时视频/录屏、多设备及持续性能矩阵仍待完成。已 fetch 确认 HEAD 与 origin/main 无相互新增提交，尚未提交、推送或发布，完整目标保持进行中。


## 可配置设备截图快捷键与真实桌面离线验收（2026-09-30）

保留已有固定 Alt+Shift+S 的默认行为，新增独立 `harmony.screenshot` 注册项，接入应用设置的录制、冲突检查、清除、恢复默认及可搜索入口；按钮提示随实际配置更新。Electron 完整映射校验同步接受该项，但不注册设备截图的全局快捷键或菜单动作，AppShell 将处理权留给设备面板。面板必须 active、可见且可截图；截图中、输入框、终端、显式保留区、可见模态弹窗、已处理/重复/输入法组合事件不抢键。contenteditable 的 true、空值与 plaintext-only 均保留编辑按键。

浏览器运行实际 ShortcutSettings 和 HarmonyPanel 组件，核对旧键停止、新键即时生效、冲突不保存、清除与恢复默认、自定义配置重载后仍生效、隐藏面板与通信失败不派发截图。截图在工具模板准备期间及 AI 持有设备时均仍可用，不获取人工租约、不改变 AI 持有者。首次新增隐藏状态检查发生在 React 更新提交前，调整夹具为同步提交真实 React 更新后通过。最终定向 21 项全部通过；完整 Harmony 加快捷键、菜单与设置搜索回归共 341 项、340 通过、0 失败、1 项既有跳过，输出为忽略的 `.verification/harmony-capture-shortcuts-suite-final-20260930.log`。根与桌面 TypeScript、相关 ESLint、性能预算、15 个文档入口检查通过；23 张设计图同步键位与范围说明并重新渲染核对。

第一轮实际 Piora Electron 开发桌面端连接同一真实 USB 目标，通道仍未就绪，设备快捷键修改、清除、恢复默认通过，注册错误/设备动作请求/页面错误均为 0。增加重载后验收的下一轮退出 1：新任务的临时项目与右侧面板选择在重载后清空，脚本没有重新打开，不能算重载验收通过；已保留失败截图并修正流程为重新选项目和打开设备面板。随后一轮原通道状态验收又退出 1，现场 HDC 已变为 USB Offline，参数查询返回设备未连接；不能继续声称当前处于通道尚未建立。

按新现场状态另运行独立离线验收，真实 Piora Electron 桌面流程退出 0：自定义键位后重载、重新打开同一设备面板，按钮提示恢复自定义配置；清除与恢复默认即时生效。五次真实设备列表均为 offline、USB、无响应样本；截图与录屏禁用，没有旧画面。默认/自定义/清除后的按键均无设备派发，注册错误 0、设备 action/manual/media POST 请求 0、页面错误 0。原始报告为忽略的 `.verification/harmony-desktop-shortcuts-offline-report.json`，对应截图为同名前缀 PNG。隔离桌面配置在 finally 清理，端口 30145 不再监听，待核对设备清理记录不存在。

上述证明软件交互及真实桌面的异常/离线配置流程，不能代替手机在线截图或已发布安装包验收。手机当前离线，目录恢复/文本对照的新交互正向实机、调试签名应用安装与维护、设备数据库快照/SQL/结构/导出、实时视频/录屏、多设备及持续性能仍待完成。尚未提交、推送或发布，完整目标保持进行中。

## 普通权限原生视频与亮屏维护（2026-10-01）

此前新增的正向设备数据库流程也已完成，报告为忽略的 `.verification/harmony-desktop-device-database-report.json`：真实桌面预览、安装调试签名样本、回读版本及启动返回 200；按应用自动发现 3 个数据库，打开 `atlas_sample` 的两行合成记录，查看 `atlas_labels` 视图、`atlas_label_index` 索引，精确整数和 BLOB 查询、刷新快照、双份 SHA-256 只读校验、本机 JSON 导出及文件路径跳转到数据库通过。样本停止与卸载返回 200，回读不存在，页面错误 0。只证明可访问的自有调试样本，不把不可访问第三方应用推断为可读取或无数据库。

USB 手机通信已恢复。本节记录真实 Piora Electron 开发桌面端、实际桌面 IPC 和真实 HDC 设备流程；未模拟接口。使用普通前台投屏源码 1.1.0 的设备调试签名 HAP，SHA-256 为 `fb8875d6a9365dfb493490e2e849f1d74bb656211a16949f8b457040305a9064`。主界面初始化按钮完成安装、版本及 EntryAbility 回读并启动；正常系统授权先拒绝，等待 16 秒未自动弹窗，再明确请求并允许，原生 H.264 1080×2386 正常显示。稳定观看期间兼容帧接口请求为 0，视频中截图返回 200。

20 秒流程的实际开始至停止间隔为 20.057 秒，保存 MP4 为 20.631 秒、475043 字节；45 秒流程分别为 45.066 秒、45.215 秒、876411 字节。两份文件均在 Electron 实际解码、播放和跳转。另一轮从桌面安装并启动自有第二应用，原生视频持续呈现新页面；录制 20.059 秒，MP4 为 20.254 秒、334315 字节。45 秒及第二应用流程均确认停止录像后原生观看仍持续，截图返回 200。三轮均退出 0、页面错误 0，自建应用停止、卸载并回读确认不存在。报告分别为忽略的 `.verification/harmony-desktop-ordinary-mirror-20s-report.json`、`-45s-report.json`、`-background-report.json`，不作为已发布安装包验收。

横屏验收另外失败：真实手机截图为 2688×1216，固定编码流仍为 1080×2386；1.1.0 图像方向不匹配，启用画布跟随旋转的 1.1.1 实验又未更新旋转后的画面。两种失败均不能算横屏通过，失败日志保留；实验策略已撤回，源码保留已验证的 1.1.0。其 DisplayManager 原始诊断同时包含真实屏、录屏虚拟屏和重复客户端属性，已修复解析为唯一明确真实屏，13 项几何测试通过。识别物理几何并不证明原生视频旋转成功，比例不一致的坐标操作仍应拒绝。

连续验收期间使用有截止时间的独立维护任务，每 45 秒重新确认手机亮屏、未锁定、自有前台页面，再点击其无操作标题并刷新临时屏幕超时。独占验收前请求停止维护，等待停止、卸载自建应用及恢复超时的肯定回执后才启动下一流程。记录不包含锁屏密码；单独的屏幕超时成功或 HDC Connected 均不是未锁定证据。

随包投屏 HAP 尚未替换为新源码产物。公开发行签名、GitHub Actions 打包及实际 beta 安装包验收仍待完成；横屏、多设备及持续性能矩阵也不能用这三轮成功代替。尚未提交、推送或发布。

后续停止共享恢复流程退出 0：手机自有按钮停止采集后，桌面由原生视频切换为明确标注的兼容投屏，新设备截图替换旧图；等待期间没有自动授权弹窗。重新观察自有开始按钮和点名该应用的授权按钮，明确允许后刷新桌面，原生视频恢复并持续稳定。再次录制的实际间隔为 20.053 秒，MP4 为 20.237 秒、485379 字节，Electron 解码和跳转成功；停止录像后观看和截图仍可用。设备应用清理及不存在回读通过，页面错误 0。报告为忽略的 `.verification/harmony-desktop-ordinary-mirror-interruption-report.json`。首次脚本因把停止提示固定为一个字串而失败，现场连接断开会更新为另一条明确停止提示；失败日志保留，修正为核对已知停止/等待明确共享状态后从新进程完整重跑。
