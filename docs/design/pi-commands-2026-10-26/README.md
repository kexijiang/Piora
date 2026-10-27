# Piora 命令交互设计稿

打开 `overview.html` 查看全部状态，打开 `index.html` 操作原型。截图位于 `screenshots/`，总览图为 `overview.png`。

这是独立设计原型，不连接 Pi，不执行真实命令，不修改运行时组件。技能、扩展、执行时间和加载数量均为示例。

## 交互规则

- 输入 `/` 打开统一菜单；会话命令、技能和扩展说明各自的执行方式。选择命令仅补全，随后可以继续填写。
- `/reload` 等会话操作明确显示“直接执行”；有必需参数时先完成校验。
- Skill 与 query、附件一起提交为同一条请求。技能选中后保留正文编辑区，主按钮仍为“发送”。
- “完成后再提问”是会话操作的可选后续步骤：命令成功后才发送问题，失败时保留草稿。这与 Skill 的 query 是两种不同语义。
- 当前任务忙碌时显示排队回执，允许取消排队或停止当前任务后再执行。
- 命令结果显示在对话内，包括执行中、成功摘要、可展开详情、失败原因及恢复操作。实际实现必须等待真实执行结果。
- 扩展要求用户输入时，直接展示选择控件和继续/取消操作。

共 11 个主要状态、2 个深色主题截图、1 个窄窗口截图。原型状态选择器可直接切换每个状态。

## 参考

- [Claude Code 交互模式](https://code.claude.com/docs/en/interactive-mode)：输入框中的命令发现和键盘操作。
- [Cursor Skills](https://cursor.com/help/customization/skills)：技能选择与任务描述在同一输入流程中组合。
- [VS Code Chat](https://code.visualstudio.com/docs/chat/chat-overview)：聊天输入中的上下文与工具入口。

视觉沿用仓库 `docs/PIORA_UI_STYLE_SPEC.md` 的中性灰阶、深浅主题和克制的浮层。

## 重新生成和验证

在仓库根执行：

```powershell
node docs/design/pi-commands-2026-10-26/render.mjs
```

使用仓库安装的 `playwright-core` 和 Microsoft Edge，无需 Next.js 构建。脚本验证 Skill 提交、参数校验、失败草稿保留、排队取消、扩展回复、横向溢出、输入框裁切和重复工具栏，并重新生成截图及总览页面。

原型中未展开的附件、模型、文件跳转等入口只显示模拟提示；`/compact` 仅展示菜单入口。它们不代表生产功能已实现。
