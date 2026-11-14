# 默认只投屏、启动等待与回复文件链接验证

日期：2026-11-12。基线：`f3831410d7bd49801e61ff77d07c875d251d3d1c`（`v0.5.11-beta.3`）。本记录描述本轮源码修复与本地验证，不代表已发布版本验收。

## 复现与修复

- 投屏窗口打开、切换设备及恢复连接原先均启用手机控制。现在初始状态、重新打开同一设备、连接代次变化及重连后均默认只观看。关闭状态下指针经过、点击、滚轮和按键不会准备控制通道、取得输入租约或派发输入；点击“操控手机”后沿用现有交互。
- 观看订阅的 6 包硬上限会把同一轮成批到达的新视频帧误判为积压，丢弃完整依赖链并等待下一关键帧。回归用例先在旧代码失败，调整为 24 包硬上限后通过；8 MiB 缓冲、80 ms 积压年龄及录屏独立订阅保持有效。该结果证明修复了可复现的误丢帧，不能据此声称真机实际帧率。
- 原生采集 socket 启动等待原先最多执行 20 次 HDC 查询，每次均有独立超时，实际等待会叠加调用耗时。现在该阶段共享 8 秒实际时间预算，查询使用剩余预算；首次未就绪时读取本次加载诊断，确定 ABI 失败后及时进入已校验的兼容库流程，明确权限拒绝及时返回。此预算不包括上传、读取诊断和退出清理，不是整个投屏初始化耗时承诺。
- 正文路径 `C:\My Project\reports\result.md` 原先识别成 `Project\reports\result.md`，`src/example.browser.test.mjs` 原先拆成两个引用。识别器现在保留完整 Windows 绝对路径、多点文件名以及行列信息。相对引用按会话目录解析，绝对引用保留原盘符。

## 已执行检查

- 61 项快速测试通过：`lib/file-references.test.mjs`、`lib/file-links.test.mjs`、`lib/harmony-mirror-core.test.mjs`、`lib/harmony-bundled-video.test.mjs`、`lib/harmony-mirror-worker.test.mjs`。
- 8 项相关结构检查通过：`components/HarmonyPanel.test.mjs`、`lib/harmony-desktop-profile.test.mjs`。
- `components/HarmonyMirror.browser.test.mjs` 通过：默认观看不发控制请求，显式开启后正常交互，重新打开和恢复连接返回观看状态；保留主题、窄窗口、媒体、输入错误和恢复流程断言。设备列表、视频画面和设备接口为夹具。
- `components/HarmonyMirror.resize.browser.test.mjs` 通过：真实开发 Electron 窗口、IPC 路由及尺寸变化，视频采集、解码和设备输入为夹具。
- `lib/file-reference-browser.test.mjs` 通过：浏览器点击正文的相对路径与带空格、多点文件名的绝对路径，经真实文件 GET 处理器读取两份临时磁盘文件并在右侧显示对应正文；行列定位、草稿保留及文件确实缺失的错误反馈同时通过。临时目录加入测试 allow-list，其他定位样例使用内容夹具。
- 根项目 TypeScript `--noEmit` 通过；修改的 TypeScript/JavaScript 文件定向 ESLint 通过，0 警告。
- 更新说明片段校验、`git diff --check` 及 Harmony 文档入口检查通过。

初始新增回归用例分别复现了路径截断、健康视频突发丢帧及 ABI 失败后多余等待，随后通过。原有慢观看订阅测试增加实际停读，继续断言过期 GOP 丢弃、关键帧恢复及录屏完整性；未删除恢复断言。首次定向 ESLint 发现原有测试的无用表达式警告，改用 `Array.from` 消费解析迭代器后复查通过。

## 未覆盖与交付状态

- 本机 HDC 设备发现返回 `[Empty]`，没有可用物理手机；未测量真机首帧时间、实际显示帧率、端到端延迟或长时间稳定性。
- 未运行全量 CI、未构建或安装新的发布包；本轮修复尚未提交、推送或发布。
- 已发布的 `v0.5.11-beta.3` 不包含本轮修复。
