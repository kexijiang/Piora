# 快捷回复（Quick replies）

## 启用与使用

进入 **设置 → 对话 → 快捷回复**，选择独立的提取模型、调整提取提示词，打开“自动提取快捷回复”，点击“保存设置”。默认关闭。聊天模型、提示词优化器模型和本功能模型分别保存，互不覆盖。

每个完成的助手回复最多显示 8 个气泡。提取协议保留最多 3 组的关系信息，界面统一平铺展示。点击选项把完整短句加入输入框，仍由用户按发送键提交。互斥方案在同一单选组内替换；多选组和不同问题可以组合。不显示推荐标签，不默认选中。没有明确选择时不显示任何占位区。

“测试提取”使用当前尚未保存的模型和提示词，接受一段示例助手回复，返回可操作的 chips 和测试输入框，不发送到真实会话。测试也会调用模型；自动提取关闭时仍可测试。

## 交互与界面

- 位于普通会话输入框上方、附件区域之前，与原有 `composer-column` 对齐；不增加底部常驻图标。Rooms 不传入提取来源。
- 输入框上方仅展示圆润的文字气泡，不显示标题、分组说明、选中数量、推荐标记或操作栏；模型和提示词统一从设置页管理。
- 所有选项按原文顺序排在同一个 flex 容器内，空间不足时自然换行；没有展开、收起或更多选择按钮。互斥关系保留在点击逻辑中。
- 使用现有主题 token：正文 `--text`，说明 `--text-muted`，中性背景 `--surface-muted` / `--bg-panel`，选中背景 `--accent-subtle`，描边 `--accent`，气泡圆角 `999px`。chips 间距 8px，桌面高度至少 32px，触屏至少 44px。窄屏自然换行。
- 悬浮提示只展示完整填入短句。所有文本以 React 文本节点渲染，不解释模型 HTML。
- 气泡使用普通按钮、`aria-pressed` 和焦点边框。每个气泡均可用 Tab 到达，方向键/Home/End 只移动焦点，Space/Enter 操作当前按钮，不触发发送。鼠标点击后把桌面输入光标移到插入位置；键盘操作保留选项焦点，触摸不主动唤起键盘。
- 关闭功能或切换来源均保留已经写入的草稿。来源改变后显示新的未选选项；旧片段不会被当成新来源的同名选项。
- 选项区域改变高度时，位于对话底部的用户继续跟随底部；阅读上方历史时不强制跳转。

## 草稿所有权

`lib/reply-draft.ts` 管理 `{ value, spans }`。每个片段保存来源、组/选项标识、UTF-16 起止位置、原始文字、是否编辑过、是否拥有前置换行。

1. 首次选择在草稿末尾追加短句，必要时加入一个换行。
2. 单选切换在原片段位置替换，不改变其他选项的顺序。
3. 重复点击只移除该片段和其拥有的换行，绝不全局替换同文字符串。
4. 手动输入以共同前缀/后缀定位变更范围，移动后续片段的位置，标记受影响片段。完整删除片段会解除其选择。
5. 改过的片段需要在就地提示中明确选择“替换/移除这段文字”。“保留修改”不动草稿。常驻区域不提供清空选择按钮；用户可以再次点击气泡取消选择。
6. 历史整段回填与采用优化结果解除旧片段关联；撤销/重做同时恢复文字与关联，最多保留 100 个内存快照，跨会话加载和成功清空重置撤销栈。
7. chips 文字沿用现有普通发送、`clientPromptId`、`onDurable` 和 `prompt-recovery` 流程。发送只传普通文本和原有附件；来源标识、原文依据和选择元数据不进入模型消息。失败恢复遵守“原会话且当前输入为空”的保护条件。

普通输入框仍按现有 `draftKey` 保存会话草稿；分支切换改变提取来源，不会删除同一会话的未发送输入。

## 配置与本机存储

`localStorage["piora-reply-suggestions-settings-v1"]`：

```ts
interface ReplySettings {
  version: 1;
  enabled: boolean; // 默认 false
  model: { provider: string; modelId: string } | null;
  systemPrompt: string; // 非空，最多 8,000 个 Unicode 字符
}
```

一次保存写入完整对象；同窗口通过 `piora:reply-suggestions-settings`、其他窗口通过 `storage` 事件同步。模型只展示当前工作目录下启用且已认证的目录项，保留已保存但不可用的模型名称，不静默回退。提示词超限不截断，阻止保存。恢复默认只改变提示词草稿。

IndexedDB `piora-composer` v1：

| Store | Key | 内容与生命周期 |
| --- | --- | --- |
| `drafts` | 原有会话 `draftKey` | 一个事务保存文字、完整图片/文件材料、重试标识和 `replySpans`；不因提取缓存淘汰而删除 |
| `replies` | SHA-256 来源/配置键 | `{ key, result, used }`，包括空结果，最多保留 200 条最近使用记录 |

草稿异步加载使用修订与当前输入保护，不能覆盖刚输入的文字或其他会话。草稿存储失败在输入框上方显示说明；提取缓存不可用时仍可直接请求提取。应用备份导出包括尚未打开会话的持久草稿；恢复替换草稿 store，回滚沿用原有备份流程。原来的发送恢复数据库保持独立。

## 调用时机与来源隔离

`useAgentSession.replyHistorySettling` 在逻辑 prompt 结束后，等待磁盘会话重新加载期间保持为 true。`ChatWindow` 仅在会话不忙、不加载、不压缩、无扩展交互且历史已落定时提供 `ReplySource`。不把第一次 `agent_end` 当成提取时机。

`latestReplySource()` 只接受尾部 `stopReason === "stop"` 的助手文本和真实 entry ID。后面已有用户/工具消息、错误/中止/长度截断、仅思考或含工具调用均不提取。打开历史会话时只考虑当前分支尾部，不遍历全部历史。

客户端请求键包含 session ID、leaf ID、source entry ID、正文、提取模型、系统提示词、语言、协议版本。切换来源、设置或运行状态会终止旧请求；迟到的缓存读取和网络结果也有独立存活检查。409 表示来源过时，静默隐藏；其他失败也不在输入框上方增加错误操作栏；设置页的测试提取仍展示具体错误。不影响聊天发送，不自动重试。

## 服务端接口

两条 POST 路由均要求现有同源/认证保护和 JSON Content-Type，正文上限 256 KiB。

### `/api/sessions/[id]/reply-suggestions`

```json
{
  "sourceEntryId": "entry-id",
  "leafId": "branch-leaf-id",
  "model": { "provider": "provider-id", "modelId": "model-id" },
  "systemPrompt": "提取规则",
  "locale": "zh-CN"
}
```

`leafId` 可为 null，此时使用会话磁盘上的当前叶节点。服务端自行通过 `SessionManager` 读取来源，不接受客户端伪造正文作为会话依据；提取前后检查来源和会话忙碌状态，不创建 `AgentSession`。显式历史叶节点必须存在，来源必须是该上下文最后的合格助手回复。

### `/api/reply-suggestions/preview`

同样接收 `model`、`systemPrompt`、`locale`，另接收 `source`（最多 24,000 字符）和可选 `cwd`。示例不写入会话。

### 输出

```ts
interface ReplyResult {
  groups: Array<{
    id: string; // 应用赋值，忽略模型自行生成的标识
    title: string;
    selectionMode: "single" | "multiple";
    options: Array<{
      id: string;
      label: string;
      insertText: string;
      evidence: string;
      recommended: boolean;
    }>;
  }>;
}
```

模型输出必须是裸 JSON；固定输出协议始终追加在用户提取规则之后。校验最多 3 组/8 项、标题 64 字符、标签 48 字符、填入短句 160 字符、依据 500 字符，单选至少两项，去除重复含义/标签的响应，不任意截断单选组。依据必须是分析正文的连续原文。只有依据包含明确推荐标记才保留推荐元数据；简化的气泡界面不显示推荐标记。

分析正文去除 fenced code、引用行和缩进示例；超过 24,000 字符只保留尾部完整段落，无完整段落则不提取。不传图片、思考、工具输出或完整会话历史。语义判断由提取模型完成；结构和证据引用由服务端强制校验。

通过 `createTrustedModelServices` 和与 `/api/models` 相同的 `resolveVisibleModels` 使用项目自定义提供商、认证和模型范围。固定使用显式模型：15 秒超时、`maxRetries: 0`、`maxTokens: 3072`、`cacheRetention: none`，无工具、无主对话回退。

服务端 `globalThis` 中最多 16 个并发提取键，合并相同请求。每个消费者单独取消；全部离开才终止提供商请求。成功和空结果缓存最多 200 条、30 分钟有效。来源变化使响应作废。返回应用定义的错误类别，避免把提供商错误 URL 或凭据透传给浏览器。

| HTTP | code | 客户端处理 |
| --- | --- | --- |
| 400 / 413 / 415 | `invalid_settings` / `invalid_source` / `invalid_request` | 修正配置或示例 |
| 403 | `access_denied` | 现有来源/目录权限保护 |
| 409 | `stale_source` | 静默丢弃 |
| 422 | `model_unavailable` | 选择可用模型或登录 |
| 429 | `busy` | 用户手动重试 |
| 499 | `cancelled` | 取消结果不展示 |
| 502 | `provider_error` / `invalid_output` | 普通会话静默隐藏，设置预览显示错误 |
| 504 | `timeout` | 用户手动重试 |

## 验证

规则/片段测试：`lib/reply-suggestions.test.mjs`。服务端实际处理函数配受控会话/模型依赖：`lib/reply-suggestions-server.test.mjs`。Edge 中打包真实 `ChatInput` 和设置组件：`lib/reply-suggestions-browser.test.mjs`，不改动 `.next`。

另回归现有 composer 回执、失败重试、prompt-recovery 和会话完成结算测试。浏览器验收输出在 `.piora-data/verification/reply-suggestions/`，包括深色桌面、窄屏输入框和浅色设置截图。自动化模型响应使用测试夹具；具体提供商的提取质量可在设置中的“测试提取”验证。
