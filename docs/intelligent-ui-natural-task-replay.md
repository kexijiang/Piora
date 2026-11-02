# Intelligent UI 原始生成任务重放

2026-11-02。用于第三阶段开发诊断，完整阶段尚未完成。

`scripts/verify-recorded-mini-app-tasks.mjs` 在独立 Windows 开发桌面中重放模型已经发布的小程序。它复用 `scripts/desktop-e2e/harness.mjs` 的端口、配置、Next 输出目录和进程清理；不修改生成程序，不替换原始记录，不通过 API 执行被测操作。

运行方式：

```powershell
node scripts/verify-recorded-mini-app-tasks.mjs --bindings .verification/phase3-natural-replay-bindings.json
```

不要与同一 checkout 的交互式 desktop launcher 并行。运行时会短暂打开独立测试窗口，结束时由 harness 关闭。绑定文件明确指定每份原始报告及 SHA-256；会话与侧文件复制到隔离目录。真实模型密钥仅保留在内存中继中，测试目录只写入一次性本地中继令牌。

## 绑定文件与独立预期

顶层为 `{version:1,cases:[...]}`。每项包括 `id`、`source`、`sha256`、`readySelector`、`operations` 和 `followup`。绑定只描述生成控件和状态字段如何对应任务概念，不能从生成程序计算预期结果。先独立写出任务轨迹，再确认对应控件与字段；若原程序没有所需行为，应记录缺失，不能改程序以通过重放。

- `click`：通过 iframe 内的真实点击操作 `selector`。
- `host`：通过宿主按钮操作，`name` 为完整按钮名称正则。
- `reload`：刷新当前桌面页面。
- `ui`：操作后可见控件文本的独立预期，等待其完成更新。
- `expected`：`snapshot.state.*` 或 `frame.*` 等路径的精确预期；每次通过真实保存按钮保存，再读取生产 API 核对。
- `sameAs`：要求当前检查点与此前指定操作的完整检查点一致，用于刷新、终态和播放一致性。
- `proseChecks`：文字说明的必要条件；失败记为语义缺陷，继续其他操作，最终状态为 `semantic-failed`，不会把流程完成记成任务通过。

本轮示例的独立预期包括：冒泡排序六次比较的完整数组和五次交换；3/5 升量水各步为 `(0,5) → (3,2) → (0,2) → (2,0) → (2,5) → (3,4)`。实际绑定文件位于本轮 `.verification` 目录；它依赖对应原始生成产物，不是可脱离产物直接运行的固定 CI 测试。

## 模型及结论边界

追问使用配置名为 DeepSeek V4.1 的 `deepseek/deepseek-flash`，实际 HTTP 请求还必须为 `thinking.type=disabled`。任何不同模型或设置都在出网前拒绝；不启用 Pro 或自动 fallback。供应商返回的模型 ID 仅为 `deepseek-flash`，不能据此独立证明内部版本。

追问必须包含刚保存的摘要和 tick，并且不能通过重建 UI 回答。报告保存实际请求设置、来源摘要、操作检查点、回答和失败。文本的必要条件校验不代替两位独立人工语义判断；真实生成、原始结果重放、当前代码复测、其他平台和发布包分别记录，不能互相替代。

开发测试产物位于 `.verification/desktop-e2e-*`，包括 `task-replay.json`、harness 报告、日志及截图。首次失败、夹具修正和之后的复测分别保留。完整 CI 与人工综合验收按约定留到三个阶段开发完成后。

## 组件原始结果重放与推理设置对照

组件使用 `node scripts/verify-recorded-component-tasks.mjs --bindings <绑定文件>`。同样绑定原始报告 SHA-256，每项指定 `inputId`、`operations`（输入值及指标数值容差或文字必要条件）、`followup`。独立预期先按题目计算；节点 ID 仅用于定位原始控件，不从生成公式推导正确答案。组件通过实际数字框修改、等待自动保存、读取生产快照核对、刷新并发出真实追问。报告为 `component-replay.json`；人为添加的上下限等语义发现保留为失败，不以数值步骤完成替代完整任务通过。

组件绑定顶层必须明确 `thinking:"enabled"` 或 `"disabled"`。生成探针和首批任务评估也支持 `--thinking enabled|disabled`，默认仍为 disabled；启用时 SDK 使用 medium 推理级别。实际 HTTP 模型必须是 `deepseek-flash`，追问必须匹配指定 thinking 值。后台标题请求单独记录，不混入任务追问。不同推理配置分别保存目录和分母，恢复评估时禁止改变配置。此选项只影响隔离评估，不改变用户配置，也不切换到 Pro。

自动化 harness 设置 `PIORA_DESKTOP_DEV_COMPILE_ONCE=1`：只编译本次桌面开发夹具，避免 TypeScript 目录监听在操作中重启窗口。Next 开发服务器仍用于页面，日常交互式 launcher 默认保留桌面热重载。运行过程中仍须固定被测代码；这不是发布包构建或发布包验收。
