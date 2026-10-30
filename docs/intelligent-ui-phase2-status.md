# Intelligent UI 第二阶段当前状态

2026-10-30 · 第二阶段功能开发完成，可进入第三阶段；综合验收与发布未完成。当前结论见 [开发完成报告 v2.17](verification/intelligent-ui-phase2-completion-2026-10-30.md) 及对应 PDF。历史报告保留当时结论，不随新增结果改写。

目标仍是自然表达、合适的回答形式、稳定生成，以及修改、保存、继续追问；同时交付布局扩展、增量预览和受控动作。第三阶段的小程序、模拟、教学和小游戏不算在第二阶段实现内。

用户最新安排：“人工验收和 CI 一起留到三个阶段开发完成后”。两位独立语义评判和分歧复核继续保留为最终验收要求，未执行，不阻塞本阶段功能完成。必要的相关本地验证继续进行。

## 要求与已有证据

| 要求 | 实现与证据入口 | 证据范围与状态 |
| --- | --- | --- |
| 2A 上下文触发判断 | `decision-policy.ts`、`decision-context.ts`；[真实接纳评估](verification/intelligent-ui-phase2-decision-admitted-2026-10-29.md) | 同轮判断文字、澄清和 UI，已接入已保存参数；不使用关键词路由。是否问对问题仍需语义评判。 |
| 2A 基线和泛化 | [开发集 v2.12](verification/intelligent-ui-phase2-inline-2026-10-30.md)、[封存集 v2.13](verification/intelligent-ui-phase2-heldout-2026-10-30.md) | 分别完成 240 和 312 次任务，失败保留；两模型技术目标达到。重复样本不是独立任务，未取得两位独立人工评判。 |
| 2B 编译和有界纠错 | `plan.ts`、`rich-plan.ts`、`plan2-expressions.ts`、`admission.ts`；v2.12、[动态说明 v2.16](verification/intelligent-ui-phase2-dynamic-text-2026-10-30.md) | Plan2 默认路径保留原始参数接纳、类型、引用、计算量和重试限制。2.5 新增有界动态文字；v2.16 的 101 项模块测试和 2 项浏览器测试通过，不等于重跑 v2.12 的测试集。 |
| 2B 持久提交与历史 | `generation-journal.ts`、`session.ts`、`store.ts`；[读取](verification/intelligent-ui-phase2-read-path-2026-10-29.md)、[写入](verification/intelligent-ui-phase2-write-coordination-2026-10-29.md)、[发布](verification/intelligent-ui-phase2-publication-2026-10-29.md) | 回执、CAS、分支、复制和旧版读取有相关模块证据；不把局部测试拼成完整桌面验收。 |
| 2B 草稿与结构迁移 | `DraftMigration.tsx`、`StructureMigration.tsx`；[结构确认](verification/intelligent-ui-phase2-structure-confirmation-2026-10-29.md)、[V4.1 实测 v2.15](verification/intelligent-ui-phase2-title-migration-2026-10-30.md) | 修复请求期间自动标题导致的冲突；78 项相关测试通过，一个真实 V4.1 桌面流程走通元转分、刷新核对和确认。 |
| 2C 布局和预览 | `RichSurfaceLayout.tsx`、`IntelligentUiPreview.tsx`；[布局](verification/intelligent-ui-phase2-rich-2026-10-29.md)、[预览](verification/intelligent-ui-phase2-preview-2026-10-29.md) | 分组、方案卡、筛选表格及只读预览已接入。SDK 和浏览器分别覆盖取消、重连与焦点；真实预览时延只来自一个 Flash 样例。 |
| 2D 登记动作 | `action-runtime.ts`、`action-files.ts`、`SurfaceActions.tsx`；[动作流程](verification/intelligent-ui-phase2-action-workflow-2026-10-30.json)、v2.15、v2.16、v2.17 | JSON 流程覆盖读取、刷新采用、拒绝、取消、过期确认、另存及追问；Markdown 已有 review 自动审核、full 直接保存、ask 取消和允许的真实 Windows 记录。仍不是完整权限矩阵。 |
| 2D 体验与失败恢复 | [错误反馈 v2.14](verification/intelligent-ui-phase2-feedback-2026-10-30.md)；动作和布局浏览器测试 | v2.14 的 32 项服务端/文件测试与 12 项浏览器测试通过；键盘、窄屏及中英文宿主提示有针对性覆盖。模型提供的文字不自动翻译。 |
| 2D 动作事实说明 | `action-description.ts`、生成上下文和动作按钮；[v2.17](verification/intelligent-ui-phase2-completion-2026-10-30.md) | 保存时点、只新建和当前权限由宿主提供；58 项相关检查通过。真实模型追问正确解释这些事实；最后补充的 Markdown 格式提示仅经本地检查，尚未供应商复测。 |
| 文档、更新说明、PDF | 本索引、[阶段历史](intelligent-ui-phase2-progress.md)、CHANGELOG、各版本 PDF | 本次提交包含阶段成果、手测指南与边距修复；[beta.69 同步记录](verification/intelligent-ui-phase2-sync-2026-10-30.md) 记录两次同步边界和 64 项定向检查。发布未完成。 |
| 人工验收、CI 与发行 | [执行安排](intelligent-ui-phase2-design.md) | 按用户要求，在三个阶段开发完成后统一处理；不阻塞阶段间功能开发，未执行不记为通过。 |

表内源码名分别位于 `lib/intelligent-ui/` 或 `components/intelligent-ui/`。历史证据描述的是对应版本及范围，不表示当前完整仓库全部验证通过。

## 已实测模型能力矩阵

后续真实模型测试按用户 2026-10-30 的要求统一使用 **DeepSeek V4.1 Flash**（`deepseek/deepseek-flash`），不再调用 `deepseek-v4-pro`。下表 Pro 数据仅是此前已完成的历史记录，不代表后续测试配置。

| 模型 | 当前已观察能力 | 仍未证明 |
| --- | --- | --- |
| DeepSeek V4.1 Flash | Plan2 生成、真实参数流预览；封存集 30 次应交互任务中 29 次最终数值轨迹匹配；Windows JSON 动作、单位核对、动态说明、Markdown 多种权限保存、生成准备时取消、追问和 Beta 切换 | 全输入边界、全部桌面交互、跨平台表现和独立语义验收；最后新增的 Markdown 格式提示尚未真实复测，不能保证所有模型文案准确 |
| DeepSeek V4 Pro | Plan2 生成；封存集 30 次应交互任务中 29 次最终数值轨迹匹配；此前浏览器工作流留有成功与失败 | 实时预览的稳定收益、完整桌面动作矩阵和独立语义验收 |
| 其他供应商/模型 | 使用能力驱动的工具接入；本轮没有调用 | 无真实兼容性或成功率结论 |

封存数字对应 compiler 2.4、intent-4 和冻结适配器。v2.15 新增一个 V4.1 真实桌面流程，v2.16 使用 compiler 2.5 复测同一自然用例，v2.17 补充取消与权限流程，均未重跑封存评估；成功不能折算成新的泛化成功率。后续对已暴露样本调优时，须将其转作开发集并补充未见任务。

## 后置验收与已知限制

1. 三阶段开发完成后，由两位独立人工做语义评判并复核分歧：回答形式、关键澄清、文案与变参计算；实施者自查不能替代此项。
2. 最终验收扩大桌面组合与跨平台覆盖。当前取消实测停在预览准备阶段；已校验片段、焦点、重连另有 SDK／浏览器证据，不能自动标为每个组合的完整链路通过。
3. 模型可能在静态文字中写死变化值、误解业务或描述错动作格式。动态说明和动作事实机制已落地；最后补充的 Markdown 纯文字快照提示尚未供应商复测。除零及条件分支有本地验证，但不宣称所有业务边界正确。
4. 三阶段功能开发后统一做 CI、跨平台发行包和发布验收。发布工作未开始。
5. 2026-10-30 用户试用发现分组内容贴边，已恢复共用内容容器，8 项相关浏览器测试通过；同一截图中“2 人时 A 更划算”的结论与表格相反，已记录为内容一致性失败，尚未修复。见 [样式回退与独立内容问题记录](verification/intelligent-ui-phase2-spacing-2026-10-30.md)。

第二阶段开发范围已逐项核对完成。上述人工、CI 和综合验收继续待完成，不把“开发完成”写成“已验收”或“已发布”；第三阶段按既定隔离运行时与目标案例继续推进。
