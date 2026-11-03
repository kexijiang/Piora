# Intelligent UI：结构变更的用户确认方案

状态：**内部 Plan 路径已实现，完整桌面验收未完成**（2026-10-29，v2.6）。
服务端与核对界面已支持正常结束后的明确确认／取消；客户端旧草稿迁移仍是独立流程。
本轮证据见 [结构变更确认成果](verification/intelligent-ui-phase2-structure-confirmation-2026-10-29.md)。默认生成协议尚未切换。

## 当前边界

- `generation-journal.ts` 的 `commitCandidate()` 在精确工具回执、当前运行和源参数 CAS 后，比较同 ID 输入的结构与语义；不兼容时抛出 `MIGRATION_REQUIRED`。
- 比较包括 label、类型、范围、step、options，以及编译后的单位/类型语义；因此部分显示改名也会触发。移除字段需要确认；仅增加字段仍走兼容发布，发生确认时会一并展示新增字段。
- `generation-runtime.ts:onTurnEnd()` 仅将 `MIGRATION_REQUIRED` 分流为 provisional 提案；下一模型请求看到等待确认及旧参数，不能声称新版已保存。准备期间发生其他冲突则终止候选。
- `rpc-manager.ts:bindRunAnswerAdmission()` 透传 cleanup 原因；`finish("idle")` 在撤销旧执行权后封存 ready，其余原因取消 provisional。
- **已经 aborted 的历史候选不能转回 pending/committed。** 用户要继续这类历史变更，必须通过新的生成运行得到新候选。

## 最小用户流程

1. 模型正常调用 plan 工具；候选仍是只读预览，旧版本继续可读、可编辑。
2. SDK `turn_end` 的精确磁盘回执通过验证后，若仅剩字段迁移问题，宿主记录迁移提案。
3. 预览显示“需要核对字段变更”，列出旧含义/值、新含义/范围、建议值，以及新增、移除字段。
4. 原运行正常完成后，用户才能选择“确认并发布新版”或“取消这次变更”。不保持模型运行等待用户。
5. 确认失败时继续保留旧版本和草稿；确认成功后新版成为可编辑输出，旧版按现有规则 superseded。

首版允许用户接受明确展示的新默认值，或为变化字段输入符合新约束的值。
完全兼容字段保留已确认值；单位、类型、选项含义变化不自动换算，也不按相同 ID 猜测等价。
移除字段必须展示其值将不进入新版；新增字段展示初始值。

## journal 数据与生命周期

新增记录状态 `awaiting_confirmation`，与终态 `aborted` 分开。
提案保存在同一 journal，包含：

- 宿主产生的 `proposalId`、不可变 `proposalDigest`、candidate operationId；
- 原 sessionId、PromptRunId/epoch、模型请求捕获的 source stamp；
- 原 assistant entry/hash、candidate receipt、完整 turn receipt；
- 编译后的 Surface/hash、compilerVersion、输入语义、字段差异和建议参数；
- 生命周期 `provisional | ready | committed | cancelled | stale`；
- ready 时原运行的完成 leaf/hash；确认操作的独立身份与回执。

所有生成、比较和状态推进均在已有 ownership → session → legacy → journal 锁域内完成。
工具参数、浏览器提供的 operationId 和提案定位 ID 均不构成授权。

生命周期必须满足：

| 时点 | 结果 |
| --- | --- |
| 精确 turn receipt 成功且原 run/source 仍有效 | candidate → awaiting_confirmation，提案 provisional |
| 原 PromptRun 正常 idle，回执和源版本仍匹配 | 提案 ready；记录完成 leaf；撤销旧运行执行权 |
| 原运行 abort/error/destroy/fork，或 provisional 状态下进程退出 | 候选 aborted、提案 cancelled；不可确认 |
| ready 后用户取消 | 候选 aborted、提案 cancelled；旧请求和迟到结果无效 |
| 新生成、分支或参数变化使源戳/确认视图失效 | 拒绝确认并标 stale；重新生成或明确重新核对，不自动重绑定 |
| ready 后重启 | 可显示待确认提案；不自动发布；只能通过新的明确确认操作 |
| 已 committed 但响应丢失 | 根据确认幂等键返回原结果，不重复追加或加版本 |

需要把 cleanup 改为 `finish(reason)`：先同步撤销旧闭包，再在保留 ownership 的情况下排空队列。
只有 `idle` 可封存 ready；其他原因取消。不得把所有 cleanup 都视作成功，也不得为了封存恢复旧 run 的权限。
启动恢复只保留已完成 ready 转换的提案；缺失回执、未完成 ready 或证据损坏均不能补推为成功。

## 确认端到端协议

已增加受同源检查及 Beta 开关约束的迁移 GET/POST，路径为 `/api/sessions/[id]/intelligent-ui/migration`。
GET 返回当前分支的可核对差异、提案摘要、源版本、当前 leaf，以及允许填写的新参数。
返回数据不包含可借用的模型运行凭据。

POST 仅接收 proposalId、所核对的摘要/版本/leaf、明确选择、新参数及幂等键。
宿主为这次点击建立**新的 UI 确认运行身份和一次性确认授权**，不复用原 PromptRun/epoch。
该操作与普通模型运行互斥；忙时返回冲突，首版无需再调用模型、开放新模型工具或额外审批对话。
授权由服务端确认入口创建并闭包传入，绑定提案摘要、完整新参数摘要和本次运行；模型无法自填授权。

确认使用独立方法 `confirmMigration(input, hostAuthorization)`。
不能给 `commitCandidate()` 加一个客户端可传的 `force: true`。
锁内必须重新核对：

1. 提案 ready，且原候选从未 aborted/cancelled；本次确认身份仍 active、未取消、持有 ownership。
2. session 与当前分支匹配，选择的 leaf 没有在用户核对后变化。
3. 原工具结果、assistant 和完整 turn receipt 仍逐项匹配原始摘要；校验原 turn 的 leaf，不接受任意后代作为其回执。
4. 当前 active structure、surfaceRevision、stateRevision、stateHash 与提案源戳一致。
5. 新参数按候选 Surface 完整验证；变更字段的选择与用户确认摘要一致。

确认不追加伪造的 assistant/toolResult，也不重新编译、替换候选历史内容。
由受保护 SDK manager 追加专用用户确认 custom entry，记录提案摘要、新运行、选择摘要和幂等键。
fsync 后取得该条目的精确 receipt，最后一次原子 journal 写入同时保存 committed、参数、active pointer 和确认记录。
确认操作等待锁时取消必须撤销本次授权；线性化点之前不发布，之后通过回执查询结果。
网络结果未知时先查确认记录，不能把超时当成已成功，也不能重用已撤销的授权。

## 必须单独处理发布锚点

延后确认不能继续把发布锚点设为原 candidate toolResult，否则导航到确认前的祖先会提前看到获批新版。
保留原工具 receipt 作为内容证据，另存 `publicationAnchor`：普通生成默认是原 receipt；确认迁移使用新的用户确认 entry。
active/state 锚定 publicationAnchor；历史读取只有在选中分支包含该锚点时，才把该版本视为已发布。
这要求调整 `readJournal()` 的 pointer 校验、`source()/active()`、`readOutput()`、批量 context/export 和 fork 的保留条件。
确认前分叉不能继承可编辑新版；确认后分叉保留原内容回执及确认回执，不重造证据。
待确认提案不复制为新会话中的确认权限；未发布内容只按现有 excluded history 规则保留只读快照。

## 与本机旧草稿的接口

核对界面展示服务端已保存值；点击确认前等待发起窗口已知 writer。若保存改变源版本，当前提案 CAS 失败，不静默把新值当成生成依据。取消不提交本机草稿。
其他窗口/离线草稿不属于服务端 proposal。发布后仍由客户端 superseded 草稿流程显示、复制和迁移。
服务端确认只处理已保存参数，不删除本地恢复记录，不冒称已经迁移其他窗口的值。
客户端草稿迁移到新版必须在新版 committed 后，通过目标版本现有 PUT CAS 保存。

## 实施入口与回归边界

- `generation-journal.ts`：抽出字段差异；准备/封存/取消提案；确认授权验证；确认 receipt 和 publicationAnchor；保持 aborted 单向终态。
- `generation-runtime.ts:onTurnEnd()`：仅 MIGRATION_REQUIRED 分流为待确认；其他错误仍 abort；下一 context 明确等待用户，不宣称发布成功。
- `answer-output-generation.ts` 与 `rpc-manager.ts:bindRunAnswerAdmission()`：透传结束原因；新增独立确认运行的撤销、互斥和 ownership 生命周期。
- 迁移 API、`read-output.ts` 和客户端 publication UI：显示差异、确认/取消、幂等结果与冲突；不借用普通参数 PUT 绕过语义确认。

最低回归包括：

1. 真实 SDK 回执后产生 provisional；正常结束才 ready；单位/范围/类型/选项变化经确认后保留兼容字段并应用明确选择。
2. cancelled、aborted、错误结束、旧 epoch 和迟到 turn_end 永远不能确认；ready 后明确取消同样终态。
3. 准备、封存、确认 custom entry、receipt、journal 发布各步中断；重启不自动发布，未知结果可幂等查询。
4. 核对后改参、切分支、发布另一版本、ownership 丢失及两窗口同时确认：只允许一个匹配 CAS 的确认。
5. 篡改候选/确认 receipt、参数摘要或 proposal 摘要必须失败；模型输入中的确认字段无权限。
6. 导航至确认前祖先、确认前/后 fork、二次 fork、标签重链、导出及追问，均按 publicationAnchor 判断新版是否存在。
7. 原窗口新编辑、离线旧稿、确认失败后重试：旧稿仍可恢复；服务端确认与本机草稿迁移相互独立。
