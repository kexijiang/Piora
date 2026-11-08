# #331 超时提示与重试验证

基线：upstream/main `1abe810c`（0.5.10-beta.8）。Windows 10.0.26300、Node 24.5.0、Next 16.4.4、Edge 无头浏览器。独立工作树 `issues-331-344`。

## 行为

- 首包超时与流中断错误在展示层提供中英文说明，保留可展开的原始错误。服务端错误原文保持不变，继续供自动重试和模型回退识别。
- 同一会话、本次请求内的相同终止错误只生成一条通知；失败回复到达或按提交标识从磁盘恢复后，删除对应通知（包括待显示队列）。另一请求或不同错误仍可显示。
- 失败回复旁的“重试”复用原消息重发流程，保留完整文本、图片和文件附件。忙碌时和重试提交中禁用按钮；无法关联原问题的回复不显示此按钮。
- 重试是重新发送，不是模型输出断点续传。现有等待计时、请求超时配置和自动重试机制保留。

![375 像素宽度的中文流中断提示与重试](assets/331-timeout-retry.png)

## 已执行

```powershell
node --test hooks/useAgentSession.test.mjs lib/model-stall-guard.test.mjs lib/retry-settings.test.mjs lib/chat-history-projection.test.mjs lib/message-retry.test.mjs lib/prompt-error-notices.test.mjs lib/model-output-error-browser.test.mjs lib/new-task-selection-browser.test.mjs components/NewSessionProjectPicker.test.mjs
node_modules/.bin/tsc.cmd --noEmit
node_modules/.bin/eslint.cmd components/ChatHistory.tsx components/ChatWindow.tsx components/MessageView.tsx hooks/useAgentSession.ts lib/chat-history-projection.ts lib/model-timeout-display.ts lib/prompt-error-notices.ts
git diff HEAD --check
npm run changelog:check
```

113/113 测试、类型检查、定向 ESLint、差异检查和更新说明片段检查通过。

浏览器测试在 375 像素宽度分别检查中英文的输出预算、首包超时和流中断提示，点击原始详情及重试按钮，核对提交中的原消息 ID、原 entry ID 和图片字节，确认忙碌状态禁用。消息组件、语言包及样式为生产实现；模型响应和重试回调为夹具，未联系真实服务商。

## #344 复查

新任务选择测试增加 390 像素窄窗口，并保留 1200 像素桌面窗口。通过 UI 选择模型、等待工作目录、选择项目和发送，核对启动请求中的模型、cwd 和 projectRoot；两种宽度均通过。未复现剩余“选不中”现象，不将此结果写成真实用户环境已修复，也不自动关闭 #344。“Pi 默认”属于系统提示词选择器。

## 失败记录与边界

- 首次类型检查发现重试按钮使用了不存在的图标名，已改为现有 `reload` 后复测通过。
- 同步 beta.7 后浏览器预算错误测试失败，原因是主线丢失了翻译键。upstream 随后在 beta.8 恢复；本分支同步后仅保留新增超时文案，复测通过。
- 未运行完整本地 lint/CI、真实模型请求、服务商续传或发布包验收；未执行 `next build` 或本地发布构建。远端结果以 PR 当前提交的 GitHub Actions 为准。
