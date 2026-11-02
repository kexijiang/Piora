# 第三阶段：共享生成预算与状态继承

2026-10-31 | 3B / 3C 接入基础成果 | 第三阶段仍在开发

## 1. 本批成果与当前边界

按照 v3.3，补齐小程序进入聊天前需要的共同生成预算、分叉/复制和静态导出基础。

相关测试合并运行结果为 **90 / 90 通过**。应用 TypeScript 与本批 10 个源码模块的 lint 通过。

本批没有注册聊天小程序工具或启用渲染入口。测试使用固定数据及确定性的 SDK 供应商夹具，没有调用真实模型，没有启动 Next 开发桌面，也没有运行完整 CI 或构建发布包。设计、开发完成与产品验收仍分开记录。

### 生成预算与诊断

- piora_render_mini_app 与现有两个组件工具共用同一个 PromptRun 预算。切换工具不能重置 3 次尝试、1 次纠错和 60 秒窗口；重复投递复用结果，取消后的上下文不可执行。
- 小程序原始参数在 SDK 类型转换前通过真实编译器校验。字符串数字等错误不会被 SDK 转换后绕过接纳；失败在权限检查与执行之前返回。
- 计算或编译诊断通过通用 answerOutputDiagnostic 参与纠错计数；已有组件诊断保持兼容。错误带有有界的原因和字段路径，不回显任意异常堆栈。
- 参数摘要按 UTF-8 实际字节计数，支持小程序 256 KiB 计划上限；数组遍历不调用输入提供的 getter 或迭代器。

### 分叉、复制与导出

| 场景 | 当前实现及证据 |
| --- | --- |
| 复制已确认状态 | 生产 duplicate 路由创建副本并保留当前参数；副本与原会话之后独立保存，写入请求回执不跨会话继承 |
| 选择旧分支 | 只拷贝目标分支祖先上的状态，排除兄弟分支；校验来源、程序、状态摘要与分支锚点 |
| SDK 标签转换 | 精确校验移除/重建标签及 compaction 的 firstKeptEntryId 变化；保留原始 assistant 摘要与标签证据，重复分叉仍能核对 |
| 在工具回合中截断 | 已确认的来源可在保留自身结果后继承；未保留的后续状态不复制。尚未发布的候选在副本中保持不可写 |
| 来源缺失或被改动 | 缺失日志、篡改历史、坏检查点和发布前变化拒绝继承，不发布小程序状态文件 |
| 静态导出与快照 | 通用持久化适配器读取当前分支的确认参数和结果；HTML 转义文本，不向附录注入生成程序或交互 iframe |

<!-- pagebreak -->

## 2. 实际验证

| 检查 | 结果与覆盖范围 |
| --- | --- |
| 相关 Node 测试合并 | 90 / 90；包含共享接纳、真实 SDK 执行与嵌套调用、真实 SDK 分叉、生产 duplicate 路由、状态与发布日志、旧组件继承及回收站回归。计数包含 Node 报告的子测试 |
| 小程序继承专项 | 14 项，已包含在上述 90 项内；覆盖标签、压缩锚点、旧分支、独立写入、未确认候选、坏来源、导出及复制接口 |
| TypeScript | node_modules/.bin/tsc.cmd --noEmit --pretty false，通过 |
| 修改模块 lint | 10 个 TypeScript 源码文件，通过；不是全仓库 lint |

合并测试命令：

```text
node --test lib/intelligent-ui-admission.test.mjs
  lib/mini-app-admission.test.mjs lib/mini-app-inheritance.test.mjs
  lib/mini-app-journal.test.mjs lib/mini-app-state.test.mjs
  lib/mini-app-generation.test.mjs
  lib/answer-output-admission-runtime.test.mjs
  lib/answer-output-route.test.mjs
  lib/session-fork-publication.test.mjs
  lib/intelligent-ui-generation-copy.test.mjs
  lib/session-trash.test.mjs
```

以上按一条命令执行，换行仅为阅读。完整命令、返回码、日志摘要及源码 SHA-256 记录于本报告同名 JSON。

### 首次失败与复测

第一次继承测试有 1 项失败：夹具使用了不存在的 appendLabel 方法。核对 SDK 后改用 appendLabelChange。清理逻辑提前注册，确保夹具初始化失败也会恢复环境。

随后生产 duplicate 接口测试返回 404。原因是夹具把会话直接放进 sessions 根目录，未采用应用会话扫描所需的项目子目录。修正夹具目录后，保留原有成功、独立写入与状态断言，接口测试通过。之后增加标签合并、压缩锚点和坏状态覆盖，最终合并验证为 90 / 90。

上述失败没有通过删除断言或降低强度处理；首次失败日志与成功复测日志均保留。

### 证据边界

生产路由函数在测试进程中使用真实 SDK 和磁盘文件执行，未经过实际 Next HTTP 服务或 Electron 窗口。生成接纳测试的“模型”是确定性的测试供应商，不代表 DeepSeek 生成质量。状态保存会调用真实隔离 QuickJS 试运行；没有据此推断三维视觉、原生 GPU 或桌面安装包通过。

<!-- pagebreak -->

## 3. 接下来要完成的工作

| 第三阶段步骤 | 当前结论与下一步 |
| --- | --- |
| 3A 基础运行 | 沿用此前原型；本批没有新增渲染、动态列表或三维能力 |
| 3B 完整使用流程 | 共用接纳和基本继承已接通；继续工具扩展、生成协调器、catalog、预览及 Surface 登记，验证真实开发应用中的生成、操作、保存、刷新和追问 |
| 3C 恢复与动作 | 基本分叉、复制、导出已有生产接口证据；完整恢复矩阵、草稿分页、迁移确认、动作权限及关闭 Beta 的完整取消流程仍待补齐 |
| 3D 复杂能力 | 动态列表、三维拾取和相机、持续模拟/小游戏、主题、字号、无障碍、性能和泛化评估仍待完成 |
| 3E 综合验收 | 三阶段综合回归、完整 CI 与人工语义验收仍留到开发完成后；尚未执行 |

真实模型测试继续使用用户指定的 **DeepSeek V4.1**，先确认实际模型标识，不使用 V4 Pro 或静默替换。当前 90 项自动检查不替代这部分模型质量与人工验收。

### 源码落点

- answer-output-admission.ts、intelligent-ui/admission.ts：共同接纳、修复计数、原始参数检查及有界摘要。
- mini-app/diagnostic.ts、plan-admission.ts、generation-runtime.ts：稳定且有界的小程序诊断。
- answer-output-inheritance.ts：SDK 分叉历史映射与原始调用证据。
- mini-app/journal.ts、state-store.ts：确认状态继承、候选隔离、独立写入身份与快照读取。
- mini-app/answer-output-adapter.ts、answer-output-server.ts：通用复制、快照和静态导出接口。

工作树：C:/Users/shengjiajun/.codex/worktrees/intelligent-ui/Piora。

分支 codex/intelligent-ui，HEAD b41fa2ff；本批代码尚未提交或推送，精确源码身份以同名 JSON 为准。此前 62 项客户端报告与 50 项状态报告保留各自快照，不改写为本批结果。

相关日志位于 .verification/phase3-integration-current.log、phase3-integration-typecheck.log、phase3-integration-lint.log；首次失败与复测日志使用 phase3-inheritance 前缀。

实施依据为 [第三阶段方案 v3.3](../intelligent-ui-phase3-design-v3.3.md)，持续状态见 [第三阶段进展](../intelligent-ui-phase3-progress.md)。本报告是接入基础成果，不是第三阶段完成声明。
