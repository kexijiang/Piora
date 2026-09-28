# 当前设备运行边界

HTTP、轻量 Agent 网关与场景以 `lib/harmony/contracts/actions.ts` 为动作契约。`action-dispatcher.ts` 执行直接动作；`scenario-executor.ts` 执行有界步骤。Manager 保持 façade，集中设备 lane、lease、epoch、互斥与取消；读屏质量和几何分别位于 observation。

HDC 负责发现、文件/流和只读设备信息；Hybrid 选路，Hypium 只在独立子进程加载。父进程 PATH 不变，子进程收到固定 HDC 环境。`.harmony-worker` 通过独立 TypeScript 任务编译并被 standalone 打包验证。worker IPC 绑定协议版本、专属进程 epoch、设备、单调请求 ID 和截止时间；过期或外来请求在执行前被拒绝，取消终止其专属进程。worker 超时/崩溃后不重放效果不明的动作。

设备锁位于用户目录统一 physical serial 哈希命名空间，跨进程及品牌互斥；活 PID 不会因时间老而被抢占。退休死 owner 与建立新 owner 使用互斥 gate，无法确认的状态拒绝接单。

HDC 在线状态作为已完成设备授权的边界，不添加应用范围 grant 或单次审批。lease 只负责并发归属与取消；安装前自动导入校验过的 HAP 副本。场景 journal 保存步骤与检查点，私有输入不进入公开列表。恢复在设备 lane 内重观测，未知副作用不能自动重放。

应用管理的直接动作与场景使用同一动作目录和设备 lane。桌面及 AI 安装入口均只接受已允许工作区内的 HAP，并由控制后端冻结产物。设备文件浏览是只读能力：共享路径通过 HDC shell 查询，可调试应用沙箱通过 `shell -b` 查询；路径不允许父级跳转、控制字节或沙箱外绝对路径。目录条目采用 NUL 分隔并限制为 500 项，缺失目录或缺少 `stat -c` 时返回能力错误。单文件下载通过 `file recv` 先写到本机临时目录，核对大小后只创建已获准工作区内尚不存在的目标文件。上传使用与安装相同的写入 fence：先冻结工作区文件，限制设备目标路径，默认拒绝覆盖与符号链接，`file send` 后核对目标大小。HDC 3.1.0e 起支持非交互式 `shell -b` 和沙箱文件传输，但真机兼容性仍须逐设备验证。

命令兼容性依据：[OpenHarmony HDC 文档](https://github.com/openharmony/docs/blob/master/zh-cn/application-dev/dfx/hdc.md)与[Bundle Manager 文档](https://github.com/openharmony/docs/blob/master/en/application-dev/tools/bm-tool.md)。

现有 `check-runtime/check-config/check-types` 继续提供 DevEco CLI 检查。开发验证链引用 report ID、工程源指纹、用户选中 HAP hash、场景执行 ID 与按进程过滤日志；不声称读取 IDE Problems 或证明用户选中的 HAP 一定来自该源码构建。
