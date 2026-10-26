# Pi GUI 默认能力

Piora 的普通任务是 Pi 的图形界面。已加载的 Pi 原生能力默认可用，不再添加一层默认禁用策略。

- 默认连接全局 `mcp.json`、Pi 已允许的项目 `.pi/mcp.json` 和已加载扩展注册的 MCP 服务器。
- 服务器 `enabled:false`、工具 `hidden`、用户自定义工具清单及手动关闭原生连接继续生效。
- Pi 根据 MCP 暴露方式启用 codemode 或 tool_search，遵循 `autoEnableCodemode`、`defaultTools` 和 `codemode` 模式设置。没有 MCP 配置时，辅助工具仍按 Pi 原生规则保持未激活；这不等于能力被 Piora 禁用。
- codemode 保留原生 models 目录、分类和图片接口，并保留嵌套工具的普通调用流程。
- 默认工作区工具包括 Pi 的 PowerShell。工具定义 token 统计保留，Piora 不再以固定 10,000 token 门槛静默删除工具。
- 项目自定义限制、笔记模式、独立设备运行模式与用户选择的工具审批策略继续约束对应任务。

设置页的连接开关用于用户主动停用；默认会话不再需要逐项开启 MCP 工具和资源。旧的自定义工具选择不会被覆盖。
