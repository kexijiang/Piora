# HarmonyAtlas 类设备工作台验收矩阵

本页以 [HarmonyAtlas 的公开功能介绍](https://bbs.itying.com/topic/67b748ec36bb8501316f5031)为对照。该介绍来自第三方论坛，未发现可核实的官方源码或完整协议；下表按用户可观察的能力验收，而不假定其内部实现。

| 能力 | Piora 当前实现 | 尚需实机验证或边界 |
| --- | --- | --- |
| 设备发现、信息、屏幕镜像与输入 | 现有 Harmony 工作台展示设备、只读画面、截图/录屏和经过 lease 的点击、滑动、按键 | 不同手机、平板、开发板的 HDC/视频兼容性与旋转、断连恢复 |
| 应用搜索、详情、安装、停止、清数据、卸载 | 当前活跃用户的应用列表与版本/申请权限；工作区 HAP 冻结校验后安装；直接动作与 AI 共用控制链 | 真机安装/卸载回执、系统应用限制、不同 bundle 输出格式 |
| 应用使能/禁用 | root 构建上调用 `bm enable/disable -n`，只针对当前活跃用户；失败不宣称生效 | root 真机回执；普通 user 构建不支持 |
| 指定非活跃用户安装/卸载 | **不提供**会静默作用于错误用户的 `-u` 控件 | 官方 `bm` 文档说明非活跃 user ID 可能仍作用于当前活跃用户；跨用户能力需要设备厂商或系统 API 与真机证据 |
| `singleton`、`allowAppUsePrivilegeExtension` 等特权 | **不把系统镜像配置伪装为运行时开关** | 官方文档要求签名/配置 `install_list_capability.json`，部分流程还需 root、系统分区挂载和重启；应在专门的系统镜像工作流中处理 |
| 文件浏览、文本、上传/下载、新建、删除、重命名、权限、收藏、查找 | 限定共享可写路径与调试沙箱；只读浏览；文件传输；1 MiB UTF-8 哈希编辑；单项 `chmod`；本机收藏和限量递归搜索 | 沙箱要求调试签名且应用已启动；不同设备的 `stat`、`sha256sum`、文件传输及权限行为需要验证；不支持递归删除与系统路径改写 |
| SQLite 数据库 | 下载后在本机只读查看普通表，限制 64 MiB、行列与时间，不允许任意 SQL | 运行中数据库的主文件可能遗漏 WAL；需应用导出一致快照，不宣称在线数据库一致性 |
| 设备终端、本机终端、快捷命令 | 设备页有绑定手动 lease 的交互式 HDC PTY、单次命令、多标签单次命令记录与自定义快捷项；可转到 Piora 已有的本机多标签 PTY | 交互式设备 Shell 的 `cd`/环境变量可保留；单次命令不保留。快捷项只填充，需手动执行。交互式调试沙箱仍需在专用调试 HAP 上验证 |

官方依据：[HDC 版本和沙箱命令说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md)、[bm 工具及用户范围说明](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/tools/bm-tool.md)、[应用特权配置](https://github.com/openharmony/docs/blob/master/en/device-dev/subsystems/subsys-app-privilege-config-guide.md)、[SQLite WAL](https://www.sqlite.org/wal.html)。

## 真机验收步骤

1. 分别连接普通 user 构建与可用的 root/开发设备；记录型号、系统 API、HDC 客户端/设备版本和连接方式。至少覆盖 Windows 主机，若发布 Linux 包则复测 Linux。
2. 在每台设备上完成发现、信息、首帧、点击校准、旋转、截图、录屏、断线重连及双设备切换；确认被取消或效果不明的命令不会显示为已验证成功。
3. 安装一个专用测试 HAP，核对应用列表、版本/权限字段、启动、停止、清数据和卸载。root 设备再验证使能/禁用；普通 user 设备必须明确失败，不应改变别的应用或账号。
4. 启动调试签名的测试应用，分别在共享路径和其 `data/storage` 中测试中文、空格、空目录、普通文件、符号链接、256 MiB 边界、上传/下载、重命名、权限和 1 MiB 文本冲突保存；搜索超过上限时必须给出截断提示。
5. 从测试应用导出一致的 SQLite 数据库，下载后分页查看含中文、大整数与 BLOB 的表；提供 WAL 旁文件时应拒绝。活跃数据库主文件不能作为一致快照验收。
6. 运行成功、非零退出、超时、大输出和取消的设备命令；切换标签、设备及本机终端，核对 lease 归属与结果文案。调试沙箱命令在不同 HDC 版本分别测试。

专用测试工程可用 `node scripts/prepare-harmony-fixture.mjs debug <全新目录>` 从 `tests/harmony-fixture/base` 生成，再用 DevEco Studio 构建并配置与测试 bundle 匹配的调试签名。[华为真机调试文档](https://developer.huawei.com/consumer/cn/doc/harmonyos-guides-V14/ide-debug-device-V14)要求真机安装前为 HAP 签名；编译成功的 `*-unsigned.hap` 不算安装验收。

调试页面的 **Export SQLite acceptance sample** 按钮调用系统 `RdbStore.backup()`，把合成数据的一致副本复制到应用 `filesDir`，并显示路径。该副本包含中文、64 位整数及 BLOB；签名 HAP 安装并启动后，才可在文件面板下载并验证。备份 API 和路径可由 [ArkData 官方接口](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/api/arkts-apis-data-relationalstore)及设备回执核对。

## 已完成的首台真机验证（2026-09-29）

Windows 主机通过 USB 连接 `BRA-AL00`（系统 `7.0.0.107`、API 26、普通 `uid=2000(shell)`），选用 DevEco Studio 的 HDC `3.2.0e`。以下检查在该设备上实际执行；序列号和屏幕、应用内容不写入验收记录。

| 项目 | 真机结果 |
| --- | --- |
| 发现与截图 | 设备发现、doctor 的连接与几何检查通过；只读截图返回 1216 × 2688 PNG。未据此宣称镜像流、录屏、触控校准或旋转已经验收。 |
| 应用发现 | 当前用户应用列表返回 200 条；按 `piora` 搜索正常返回空列表。未对现有应用执行安装、停止、清数据或卸载。 |
| 共享文件 | 在独立 `/data/local/tmp/piora-atlas-<随机 ID>` 目录验证了新建、中文及空格文件名上传、列表、UTF-8 回读、带哈希保存、搜索、`chmod 600`、重命名、下载内容校验、文件与空目录删除。测试文件已清理。普通目录 266 项的列表在批量 `stat` 修复后耗时约 0.6 秒。 |
| 设备命令 | 通过设备管理器执行 `printf`，得到退出码 0 和预期输出；`exit 7` 如实返回非零退出码。新交互式会话在同一 PTY 中先 `cd /data/local/tmp` 再执行 `pwd`，真实返回 `/data/local/tmp`；结束时关闭 PTY。浏览器组件在模拟接口下验证了渲染、输入、尺寸和离开面板后的关闭；真机与网页合并链路仍待验收。 |

这是一台普通权限手机上的局部验收。专用测试 HAP、调试沙箱、SQLite 一致快照、root 能力、交互式终端的真机网页端到端操作、镜像与输入、断连和多设备等项目仍按上方步骤待验收；不能把自动测试或单台设备结果扩展为跨设备通过。
