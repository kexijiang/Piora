# 原生投屏库与设备 ABI

Piora 的 HDC 原生投屏通过 UiTest 加载 ARM64 动态库，再读取 Unix socket 视频流。UiTest 返回的版本号只是库选择依据；实际加载是否成功取决于设备系统提供的动态符号。UI 树、截图和输入正常不代表视频库一定兼容。

## 内置库与选择

- 保留 Hypium 随附的 6.3.1、6.4 Unix 库，供较旧设备使用。
- `third_party/harmony-video/manifest.json` 固定 HOScrcpy 1.0.18-beta 分发中的 6.5（2026-03-13）和 6.6（2026-06-29）库，记录源归档及每个库的 SHA-256。UiTest 7.x 不再选择旧 6.4 库。
- 同时比较内置库和已安装 DevEco 的 `plugins/screen-mirroring/lib/hosScrcpy-*.jar`；按不高于设备版本的库版本及构建日期选择较新候选。旧 IDE 不会遮住内置的新库。
- 内置新增库在上传前校验文件类型、大小、ARM64 ELF 标识和 SHA-256。版本选择不代表已完成该系统的实机 ABI 验收。

无需为了正常安装的 Piora 额外安装 IDE。若希望使用比内置版本更新的 IDE 库，应先核对 JAR 中实际含有的 `libscrcpy/libscrcpy_server_unix_<版本>-<日期>.z.so`，并确认库版本不高于设备 UiTest 版本。仅更新 SDK 路径或普通 HDC 可执行文件不会更新投屏库。当前不宣称某个 DevEco 产品版本保证适配所有 UiTest 7.x 系统。

## 启动失败诊断

加载失败时先读取本次唯一 `piora_video_<id>.so` 对应的启动日志和按此名称过滤的 hilog，再清理本次文件。结构化错误保留设备版本、选中库名称、SHA-256、来源及有界的加载证据；不返回整份设备日志。

例如 `Error relocating ... ClearTableImplEb: symbol not found` 会报告 `debug-video-abi-incompatible` 和真实缺失符号。此类错误停止无效的自动重连，保留最后画面与操作栏，由用户查看详情、更新兼容库后手动重连。不会停止其他开发工具拥有的 UiTest 进程。

运行中缺少关键帧时会请求 IDR；视频通道静默超过 2 秒会请求刷新帧。前端先在同一连接请求关键帧并给予恢复时间，仍无进展才更换连接。传输无帧与解码器积压分别报告，不再把 `0 submitted` 笼统称为解码故障。断线期间保留的最后画面不接受设备坐标操作。

## 可重复获取与验收边界

运行 `node scripts/sync-harmony-video.mjs [已下载的归档路径]` 可从固定源恢复清单里的两个库；源归档或库 hash 不一致会失败。许可证和来源记录保存在同目录，随安装包一同发布。安装包校验还会检查 ASAR sidecar 中的真实库文件和 hash。

回归覆盖选择、归档、错误日志隔离、关键帧恢复、手动重连、独立录屏和画面保留；设备 ABI 与持续投屏稳定性仍须在目标 VNE/真机复测。本次开发时 `hdc list targets` 为空，不能将协议夹具写成实机通过。
