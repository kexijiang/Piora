# 聊天与设置界面调整验证（2026-11-14）

## 修改范围

- 项目内新建聊天使用 SquarePen；最近聊天和消息搜索结果使用 MessagesSquare，并移除聊天图标底色。
- 图片查看器先处理 Esc，关闭预览后恢复焦点，避免触发全局停止会话；未打开预览时保留原有停止快捷键。
- 项目工具页隐藏房间协作条目，隐藏项不进入关闭工具提示和可见分组统计；保留既有工具策略数据。设备、桌面、工具发现和表情包等开关显示本地化名称及作用说明。
- 设置导航、搜索和页面挂载移除远程控制入口，同步开发接口文档。
- 全局原生单选下拉框使用应用主题、圆角菜单、悬停和选中标记；多选列表保留原交互。桌面表情包面板也加入相同的菜单样式。菜单内的 Esc 优先关闭下拉列表，再次按下才交给外层对话框。
- 运行文案提供中英文各 50 条默认值，每轮按新的任务标识随机选取并保持整轮稳定。允许手动增删改，默认模型可一次生成并替换 50 条；生成结果不完整、重复或超长时保留原库。兼容原单条文案设置。
- 系统提示词选择器移入输入框底部工具栏，提供搜索、简短摘要和可展开的完整内容预览；按 Esc 关闭时不触发全局停止。

## 已执行且通过

- 根项目 `tsc --noEmit` 与桌面项目 `tsc -p desktop/tsconfig.json --noEmit`。
- 本次修改涉及的 TS/TSX 文件定向 ESLint 检查。
- `git diff --check` 与更新说明片段检查。
- `components/MessageImage.browser.test.mjs`：实际图片组件与全局快捷键同时挂载；工具栏和图片区域内的 Esc 关闭图片，停止计数不变；关闭图片后的 Esc 仍能停止，缩放、拖动、复制、失败重试和焦点恢复继续通过。
- `components/ProjectToolsConfig.browser.test.mjs`：隐藏房间条目和内部工具名，检查中文名称、开关描述、手动开启、服务端回执及刷新恢复，覆盖 390px 窗口。
- `components/ChatUiSettings.browser.test.mjs`：实际设置组件、实际 ChatInput 与提示词选择器，验证手动文案持久化、失败及不完整生成保留原库、生成中禁止覆盖编辑、完整 50 条替换、手动追加第 51 条和旧单条文案兼容。
- 同一浏览器用例还验证提示词搜索、完整内容预览、选择和 Esc；原生菜单的鼠标选择、键盘选择、禁用选项、浅色/深色/窄窗口、外层对话框 Esc 优先级；实际归档页面下拉框；由桌面代码生成的表情包面板三个下拉框。
- `components/TaskDuration.browser.test.mjs`：修改文案库不改变当前轮，下一轮使用新库；原有计时、刷新、阶段变化、结束状态及布局回归通过。
- `lib/running-status-labels.test.mjs`：两套默认文案数量及唯一性、手动编辑约束、严格 50 条生成校验、同一任务稳定选取及不同任务的分布。
- `lib/running-status-generation.test.mjs`：真实生成路由配合夹具模型，验证默认模型调用、结果校验、跨源拒绝、请求类型和大小限制、不可用模型与取消；不创建聊天记录。
- 相关既有测试：MessageView、SessionSidebar、AliIcon、ConversationSearchDialog、SessionToolsControl、SystemPromptEditor、ConversationSettings、composer-send、composer-picker、dsh-meme、settings-search 和 i18n registry/format。

## 失败与复测

- 图片 Esc 回归用例在修复前复现失败：预览未关闭，已注册的全局停止处理器抢占 Escape。增加预览自身的处理后复测通过。
- 补充桌面表情包面板覆盖时，测试首次因直接按 ESM 导入桌面 CommonJS 包内的 TypeScript 文件失败；改为仓库已有的 Jiti 加载方式后，包含实际输入框和表情包面板的完整用例复测通过。

## 产物与边界

截图位于 `.verification/chat-ui-20261114/`：`status-and-prompt.png`、`archived-select.png`、`select-light.png`、`select-dark.png`、`select-narrow.png`、`meme-select.png`。截图中的文案和模型为测试夹具数据。

浏览器验证使用本机 Edge，API 和生成模型使用夹具；已验证交互及协议，不代表真实模型提供商、完整扩展服务或发布包验收。未调用真实模型生成，未运行全量 CI、`test:desktop:e2e`、`next build`、本地发布打包或真实设备测试。未提交、推送或发布。
