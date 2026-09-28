# 当前设备运行边界

HTTP、轻量 Agent 网关与场景以 `lib/harmony/contracts/actions.ts` 为动作契约。`action-dispatcher.ts` 执行直接动作；`scenario-executor.ts` 执行有界步骤。Manager 保持 façade，集中设备 lane、lease、epoch、互斥与取消；读屏质量和几何分别位于 observation。

HDC 负责发现、文件/流和只读设备信息；Hybrid 选路，Hypium 只在独立子进程加载。父进程 PATH 不变，子进程收到固定 HDC 环境。`.harmony-worker` 通过独立 TypeScript 任务编译并被 standalone 打包验证。worker IPC 绑定协议版本、专属进程 epoch、设备、单调请求 ID 和截止时间；过期或外来请求在执行前被拒绝，取消终止其专属进程。worker 超时/崩溃后不重放效果不明的动作。

设备锁位于用户目录统一 physical serial 哈希命名空间，跨进程及品牌互斥；活 PID 不会因时间老而被抢占。退休死 owner 与建立新 owner 使用互斥 gate，无法确认的状态拒绝接单。

HDC 在线状态作为已完成设备授权的边界，不添加应用范围 grant 或单次审批。lease 只负责并发归属与取消；安装前自动导入校验过的 HAP 副本。场景 journal 保存步骤与检查点，私有输入不进入公开列表。恢复在设备 lane 内重观测，未知副作用不能自动重放。

应用管理的直接动作与场景使用同一动作目录和设备 lane。桌面及 AI 安装入口均只接受已允许工作区内的 HAP，并由控制后端冻结产物。设备文件浏览是只读能力：共享路径通过 HDC shell 查询，可调试应用沙箱通过 `shell -b` 查询；路径不允许父级跳转、控制字节或沙箱外绝对路径。目录条目采用 NUL 分隔并限制为 500 项，缺失目录或缺少 `stat -c` 时返回能力错误。单文件下载通过 `file recv` 先写到本机临时目录，核对大小后只创建已获准工作区内尚不存在的目标文件。上传使用与安装相同的写入 fence：先冻结工作区文件，限制设备目标路径，默认拒绝覆盖与符号链接，`file send` 后核对目标大小。HDC 3.1.0e 起支持非交互式 `shell -b` 和沙箱文件传输，但真机兼容性仍须逐设备验证。

应用使能/禁用仅调用 `bm enable/disable -n`，不传 user ID，按设备当前活跃用户执行。OpenHarmony 官方文档说明它仅在 root 构建可用；user 构建和设备返回未确认成功时必须报错。文档同时说明 `-u` 指定非活跃用户可能实际作用于当前活跃用户，因此面板不提供跨用户切换。

设备文件变更仅允许可写共享路径或调试沙箱的 `data/storage` 内。新建目录不自动创建父目录；删除仅针对普通文件和空目录，重命名保持在同一目录且使用 `mv -n`，每次变更后重新查询设备路径类型。符号链接不作为可变更目标；无法可靠确认结果时报错，不宣称成功。

权限编辑仅接受三位八进制模式，不支持递归、setuid/setgid/sticky、所有者或系统目录操作；设备执行 `chmod` 后用 `stat -c '%a'` 回读。目录和文件必须是普通目标，符号链接不通过类型检查。

文件名搜索在设备 lane 内按广度优先遍历，最多 5 层、80 个目录、4000 个条目、200 个匹配项或 30 秒；不进入符号链接，子目录不可读会计入跳过数。面板收藏路径按设备与沙箱保存在本机浏览器存储中。

设备文本预览在传输前限制为 1 MiB 普通文件，完整下载后核对长度，以严格 UTF-8 解码并拒绝 NUL 字节。AI 结果最多携带 12,000 个字符，标注设备内容不可信；面板显示完整文本。保存时要求打开时的 SHA-256 与设备当前内容匹配，新内容先经 `file send` 写入同目录独立暂存文件，再在设备 shell 中检查原文件哈希并替换，最后回读新哈希。缺少 `sha256sum` 时禁用保存；取消或无法确认时不把未知效果报为成功。

SQLite 查看器只接受工作区内已下载的普通本地文件，限制为 64 MiB，拒绝伴有 `-wal` 的文件。服务端先复制到私有临时目录，再由独立 worker 用 `DatabaseSync({ readOnly: true, allowExtension: false })` 打开。只列普通表，并从清单选表、分页读取；不接受任意 SQL，最多返回 50 行、100 列，文本和 BLOB 单元格截断显示，worker 超过 3 秒即终止。它不提供正在写入的设备数据库的一致性保证：主文件可能遗漏 WAL 中的事务，用户应先通过应用导出一致快照。依据 [SQLite 备份说明](https://www.sqlite.org/backup.html)和[WAL 说明](https://www.sqlite.org/wal.html)。

命令抽屉只供用户手动运行，不加入 AI 动作目录。命令仍需设备 lease，经过与其他写操作相同的 dispatch fence 和设备 lane；每条命令使用单独的 HDC `shell` 调用，最多 15 秒、128 KiB 输出。退出码通过每次随机生成的结束标记解析；缺失标记时结果不确认。多标签只保留当前网页中的输出记录，不是交互式 PTY，工作目录和环境变量不跨命令保持。

用户定义的快捷命令仅按设备保存在浏览器存储，最多 20 条；点击后填入命令输入框，不自动发往设备。面板提供本机终端入口，切换到 Piora 已有的多标签 PTY，而不把本机命令伪装为设备 Shell。

命令兼容性依据：[OpenHarmony HDC 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md)与[Bundle Manager 文档](https://github.com/openharmony/docs/blob/master/en/application-dev/tools/bm-tool.md)。

现有 `check-runtime/check-config/check-types` 继续提供 DevEco CLI 检查。开发验证链引用 report ID、工程源指纹、用户选中 HAP hash、场景执行 ID 与按进程过滤日志；不声称读取 IDE Problems 或证明用户选中的 HAP 一定来自该源码构建。
