# 文档索引

- [完整中文用户手册](user-manual.zh-CN.md)：从首次安装、模型配置到日常操作、备份迁移和故障排查；包含当前源码及未发布功能的适用范围说明
- [项目介绍与使用](../README.md)
- [桌面开发与启动](../desktop/README.md)
- [桌面自动化测试](desktop-automated-testing.md)：隔离的真实 Electron 场景、结果报告、失败诊断与新增场景方式（#247 首批能力）
- [发布与构建](release.md)
- [Harmony 设备指南](HARMONYOS_DEVICE_AUTOMATION.md)：连接、控制、语音、诊断、场景及验证
- [SSH 工作台](SSH_WORKBENCH.md)
- [Intelligent UI 实验功能](intelligent-ui.md)：开关、交互计算、参数保存、分支隔离与实现边界（未发布）
- [Intelligent UI 阶段成果报告](intelligent-ui-phases.md)：三个交付阶段、当前成果、验证证据与后续验收门槛
- [Intelligent UI 第二阶段设计与 Review](intelligent-ui-phase2-design.md)：触发决策、计划编译、受限修复、状态提交和泛化验收
- [Intelligent UI 第二阶段实施进展](intelligent-ui-phase2-progress.md)：各版本实现、实际验证与失败记录；最新开发完成结论见状态索引
- [Intelligent UI 第二阶段开发完成报告 v2.17](verification/intelligent-ui-phase2-completion-2026-10-30.md)：2A 至 2D 功能核对、动作事实说明、58 项相关检查及真实 V4.1 桌面取消和权限流程；人工验收与 CI 留到三个阶段开发后
- [Intelligent UI 2B 读取兼容增量](verification/intelligent-ui-phase2-read-path-2026-10-29.md)：候选状态、分支快照、导出与回收站的实现和验证
- [Intelligent UI 2B 写入协调增量](verification/intelligent-ui-phase2-write-coordination-2026-10-29.md)：运行时所有权、收尾等待、参数互斥和双进程验证
- [Intelligent UI 2B 生成发布与恢复](verification/intelligent-ui-phase2-publication-2026-10-29.md)：真实运行链路、磁盘回执、分支复制、旧草稿恢复与 Review
- [Intelligent UI 旧稿迁移与布局原型](verification/intelligent-ui-phase2-migration-2026-10-29.md)：显式字段核对、分支检查，以及分组、卡片和筛选表格的独立原型
- [Intelligent UI 布局接入与真实模型试跑](verification/intelligent-ui-phase2-rich-2026-10-29.md)：Plan2 编译、主聊天保存与追问链路、真实模型样本及当前限制
- [Intelligent UI 结构变更确认方案](intelligent-ui-migration-design.md)：待实现的候选确认、取消和历史发布锚点
- [Intelligent UI 增量预览方案](intelligent-ui-preview-design.md)：严格片段校验、瞬态预览、取消、重连和焦点边界；内部 Plan2 已接入，完整验收仍在进行
- [Intelligent UI 增量预览成果](verification/intelligent-ui-phase2-preview-2026-10-29.md)：SDK 事件链、只读浏览器验证、真实模型提前显示样例及未完成项
- [Intelligent UI 结构变更确认成果](verification/intelligent-ui-phase2-structure-confirmation-2026-10-29.md)：字段含义核对、正常结束后确认、取消与中断恢复，以及确认前后的历史边界
- [Intelligent UI 登记动作设计](intelligent-ui-actions-design.md)：工作区参数读取、结果另存、权限、操作记录及明确采用
- [Intelligent UI 登记动作成果 v2.7](verification/intelligent-ui-phase2-actions-2026-10-29.md)：动作按钮、取消与结果核对、相关本地验证及剩余验收
- [Intelligent UI 连续工作流成果 v2.8](verification/intelligent-ui-phase2-workflow-2026-10-29.md)：真实模型到浏览器、保存和追问验证；字面量简写与转换前校验，保留小样本和语义验收边界
- [Intelligent UI 默认路径与基线 v2.9](verification/intelligent-ui-phase2-default-2026-10-29.md)：Beta 默认 Plan2、40 项相关回归及两模型 240 次开发集基线；CI 按用户安排后置
- [Intelligent UI 名称空间与候选比较 v2.10](verification/intelligent-ui-phase2-namespaces-2026-10-29.md)：减少无歧义 ID 重试，窄窗口与可访问名称；240 次候选比较及隔离预算差异、澄清误触发等未完成项
- [Intelligent UI 接纳与决策边界 v2.11](verification/intelligent-ui-phase2-decision-admitted-2026-10-29.md)：评估复用真实 SDK 接纳，区分未知规则与可调参数，记录两个模型的边界任务对比和剩余语义错误
- [Intelligent UI 计算表达与开发集复测 v2.12](verification/intelligent-ui-phase2-inline-2026-10-30.md)：Plan2 受限嵌套计算、103 项本地验证及 240 次真实接纳路径复测；保留格式、语义和能力边界失败，CI 在三个阶段开发后统一处理
- [Intelligent UI 封存集与桌面动作 v2.13](verification/intelligent-ui-phase2-heldout-2026-10-30.md)：312 次两协议、两模型对比；修复自动命名使动作失效，记录真实桌面读取、保存、取消与追问及未完成的产品验收
- [Intelligent UI 当前状态](intelligent-ui-phase2-status.md)：2A 至 2D 的实现、证据范围、模型能力矩阵和剩余验收，避免历史快照与当前进度混淆
- [Intelligent UI 随参数更新的说明 v2.16](verification/intelligent-ui-phase2-dynamic-text-2026-10-30.md)：绑定文字、预览和导出一致性，103 项相关测试及 V4.1 真实回归；保留权限文案缺口
- [Intelligent UI 单位迁移与 V4.1 实测 v2.15](verification/intelligent-ui-phase2-title-migration-2026-10-30.md)：修复自动标题生成冲突，78 项本地测试及真实单位迁移、Markdown 保存、Beta 切换；记录静态旧值文案问题
- [Intelligent UI 失败反馈与恢复 v2.14](verification/intelligent-ui-phase2-feedback-2026-10-30.md)：中英文错误原因、旧记录兼容、5xx 后保留原请求及 44 项相关本地检查
- [Intelligent UI 第一阶段手测](intelligent-ui-testing.md)：专用工作树启动、固定采购示例、参数恢复、追问与引导排队验收
- [Intelligent UI 第二阶段体验测试](intelligent-ui-phase2-testing.md)：7 组自然语言用例、预期数值、单位核对、保存权限、取消与结果记录（DeepSeek V4.1 Flash）
- [Intelligent UI 第二阶段提交前同步](verification/intelligent-ui-phase2-sync-2026-10-30.md)：同步 beta.69、依赖补丁兼容、64 项定向检查及保留的内容一致性问题
- [开发约束与架构边界](../AGENTS.md)
- [聊天命令处理与 UI 重设计](design/chat-command-flow.md)：输入语义、执行状态、接口及验收证据（未发布）
- [版本更新说明](../CHANGELOG.md)

历史方案保留原始上下文，不代表当前实现或未完成工作：

- [性能审查归档](archive/performance-2026-09-07/README.md)
- [旧 Harmony 指南](archive/harmony-2026-09-27/previous-device-guide.md)
- [本次仓库清理决定](audits/repository-cleanup-manifest.json)
- [Harmony H00–H22 实施与验收记录](audits/harmony-2026-09-27/progress.md)
