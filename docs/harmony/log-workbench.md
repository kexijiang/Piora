# 鸿蒙设备日志工作台

## 入口

桌面应用右侧「鸿蒙设备 → 日志工作台」。内部有「实时日志」与「会话日志」两个页签。会话日志需要打开一个已有聊天，可在设备离线时使用。

实时页切换到会话页时保持采集，暂停按钮只暂停显示。离开日志工作台时释放本页的设备日志订阅，保留已挂载页面的缓冲。切换设备清空旧设备缓冲；日志文件按保存时的聊天归属，不会因稍后切换聊天而改写归属。

## 功能

- 实时日志：应用/包名、进程、PID/TID、级别、TAG、DOMAIN、时间和正文筛选，查找高亮与历史、暂停、跟随、可调整高度的完整行详情。保留最近最多 100000 行 / 128 MiB 文本预算，先达到的限制生效；保存的是点击时仍保留的筛选结果。
- 会话日志：选择或拖入多份文本、ZIP/GZ/RAR，自动识别 UTF-8、UTF-16、GB18030/GBK，也可手动选择；有导入进度、取消、失败重试。压缩包保留原包并平铺解析文件。单个明文上限 1 GiB，压缩包 2 GiB，累计展开 8 GiB。
- 阅读：按块索引与分页，只渲染可见行；支持结构化字段筛选、原始行号、详情、下载原文件与导出筛选结果。
- 跨文件查找：搜索当前会话所有已解析文件，包括压缩包中的日志；支持普通、扩展和正则模式、文件名通配与排除、多轮结果、原文定位、复制结果。每页、复制与后台任务分别有预算，超限明确显示。
- 加入对话：单文件、多选文件或具体日志行生成可编辑草稿，使用本机实际可读路径与清单；已有草稿保留，用户检查后发送。
- 管理：改名、删除本机导入副本、查看与清理多个聊天的日志；不会删除用户导入前的原始文件。

原厂编码 HiLog 需要本机官方 `hilogtool` 与匹配字典。缺失时保留原包并提示补充，可以在管理中配置工具路径后重试解析；明文导入不需要这些工具。

## 项目分析与适配

来源是 [Alentaoker/dsh-harmoneydev-tools](https://github.com/Alentaoker/dsh-harmoneydev-tools)，固定提交 `8b178a755d33cee9899160a7be283af2b23eb85d`。其日志功能分为两部分：MIT 的 Harmony 实时界面，以及 Apache-2.0 的 `plugin/dsh-e2e` 日志分析库（现包名 `dsh-log-analysis`）。离线日志库基本独立，直接依赖 DSH 的部分主要是插件注册、会话标题、HTTP 路由和对话草稿，因此复用核心并适配宿主，比加载整个插件更符合 Piora 的架构。完整来源与许可在 [SOURCE.md](../../third_party/harmony-log-workbench/SOURCE.md)。

| 边界 | Piora 接入 |
| --- | --- |
| 页面入口 | `HarmonyPanel.tsx` 新增设备/日志页面切换，不恢复已收起的旧工具导航 |
| 两种日志视图 | `harmony/HarmonyLogWorkbench.tsx`，切换内部页签保留实时组件 |
| 存储、索引、解压、跨文件查找 | `lib/harmony/log-library/vendor/`，保留上游后台 worker 与预算 |
| 宿主运行时 | `lib/harmony/log-library/runtime.ts`，按数据目录缓存并跨热更新复用 |
| HTTP | `/api/harmony/log-library/[...operation]`，使用 Piora 桌面认证、同源检查、真实会话校验和有界请求体 |
| 对话 | `RightPanel` 传递当前聊天身份和已有的草稿入口；不调用模型或发送聊天 |
| 打包 | Next 显式追踪运行时模块、ZIP 依赖和 Windows x64 RAR 解码文件；ASAR 将日志模块及其依赖整体放入真实 sidecar |

存储位于当前 Pi 数据目录的 `piora/harmony-log-workbench/log-library`。所有普通文件操作先绑定 `sessionId`；跨会话管理只返回元数据，正文接口继续校验文件归属。原始字节与按需生成的脱敏分析副本分别保存。分析副本的自动脱敏不能识别所有业务敏感内容。

## 验证

快速检查：`node --test lib/harmony-log-library-route.test.mjs lib/harmony/log-library/tests/*.test.mjs`。

桌面场景：`npm run test:desktop:e2e -- --scenario harmony-logs`。按项目规则在独立 worktree 运行，使用真实 Electron、认证 HTTP 接口和后台索引/搜索线程；导入的日志及设备流是独立生成的夹具，不读取用户聊天或连接真实手机。运行结果在该 worktree 的 `.verification/desktop-e2e-*`。

此场景不证明真实设备 HiLog、官方解析器、GiB 级容量、持续采集或发布安装包已验收。实际执行结果及启动失败/中断需要分别记录。

打包校验额外由 `verify-packaged-harmony-logs.mjs` 检查 25 个关键资源，包括 `.mjs` worker、ZIP 依赖及 Windows RAR EXE/DLL/许可。必须同时验证归档内容和 `runtime.asar.unpacked`，只验证解出的归档不足以证明安装版可以启动后台线程。

2026-11-10 源码与资源准备结果：32 项日志相关测试、TypeScript、许可清单检查及新增打包脚本的零警告 ESLint 通过；移植日志模块的定向 ESLint 为零错误、25 条警告。开发版桌面启动因隔离依赖解析及启动重启未完成场景，不计为界面通过。按本轮要求停止开发版验证，最终真机验收等待 GitHub Actions 产出的 Beta 安装版。
