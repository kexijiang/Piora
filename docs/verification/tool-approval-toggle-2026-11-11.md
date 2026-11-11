# 工具执行审批恢复与开关验证

- 工作分支：`codex/restore-permission-toggle`，独立 worktree。
- 恢复人工/模型审批、会话模式及默认偏好；新增默认开启的全局显示与执行开关。关闭不覆盖原模式，重新开启恢复。保留静默浏览器登录、工作流与统一过程折叠。
- TypeScript：`node_modules/.bin/tsc --noEmit --incremental false` 通过。
- 修改及新增的 TS/TSX 文件定向 ESLint 通过。
- 185 项定向 Node 测试通过，涵盖权限策略、独立审核、真实 SDK 嵌套调用、开关释放等待及恢复、普通业务提问、取消/重连、输入框与新任务提交、设置搜索。
- 浏览器组件夹具：`ConversationSettings.browser.test.mjs` 与 `ChatInput-layout.browser.test.mjs` 均通过。通过 UI 切换开关，验证隐藏、刷新持久化与恢复；网络使用夹具，不代表真实模型或安装包验收。
- 初轮验证因生成品牌文件缺失、菜单 effect 返回值错误、恢复后的旧测试夹具与断言不匹配而失败；分别准备品牌文件、修复 effect、更新夹具后复测通过。设置浏览器测试的同步 checkbox 断言改为点击后等待实际 UI 状态，仍核对保存值及刷新结果。
- 未运行完整 CI、真实桌面 E2E、真实模型审核、安装包或跨平台验收；未构建发布包或运行 next build。远端 CI 结果以 PR 检查为准。
