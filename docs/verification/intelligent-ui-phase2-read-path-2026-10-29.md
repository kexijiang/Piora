# Intelligent UI 第二阶段持久输出读取进展

日期：2026-10-29。状态：2B 读取兼容已接入，生成发布和完整写入恢复仍在开发。

本次在 v2.0 进展报告之后接入新旧输出的统一读取。第一阶段 v1 输出继续使用原参数状态；v2 输出必须核对会话中的实际工具结果与 generation journal，不能仅凭前端封套认为已保存。

## 已接入行为

- GET 参数接口返回候选、已提交、已取消或已被取代的状态。读取不会创建运行 epoch，也不会把候选提升为已提交。
- 关闭 Beta 功能后，文字快照接口可以读取 v2 已保存参数，不创建 AgentSession 或重新开启工具。
- HTML 导出的参数附录按当前选中分支读取，只选择已提交的最新结构；候选或取消结果不替代上一版已保存值，文本继续做 HTML 转义。
- 新旧协议混合时按分支中的先后顺序选择最新结构。回滚产生的较新 v1 输出能取代旧 v2 输出，旧 v2 参数写入被拒绝。
- 软删除及恢复保留 generation journal；永久清理同时删除旧参数文件和 journal。
- 跨扩展及 Web 模块实例保留状态错误的 HTTP 含义，历史分支缺少输出返回 404，缺少或损坏 v2 记录返回冲突错误。

journal 缺失时，普通导出不添加未经确认的参数附录，原始会话内的文字快照仍保留。读取到损坏记录不会猜测或修补提交状态。

## 验证证据

Windows，Node.js 22.19.0。执行以下 5 个文件的最终回归，59/59 通过，0 跳过：

```powershell
node --test lib/answer-output-route.test.mjs lib/answer-output-server.test.mjs lib/intelligent-ui-generation.test.mjs lib/intelligent-ui.test.mjs lib/session-trash.test.mjs
```

记录保留在本地 `.verification/intelligent-ui-phase2-read-tests.log`。修改文件的 ESLint 通过；Web 与 Desktop 类型检查通过。覆盖真实 SessionManager 磁盘记录、HTTP 接口、功能关闭、历史分支、取消、损坏记录、导出转义和回收站恢复。

## 剩余接入要求

当前仍未向生产模型开放新计划工具。正式发布需继续接通运行时生成及提交、统一 legacy 与 journal 写入边界、跨进程会话写入协调、fork/复制继承、客户端 superseded 草稿恢复和完整端到端验收。只读接口通过不代表这些边界已完成，也不代表阶段二已完成。

下一步优先处理会话写入协调：同进程的最终版本比较与发布使用同步临界区；共享数据目录的 Piora 实例还需要覆盖运行时、参数写入和会话变更的共同所有权约束。SDK 事件本身不等于文件锁，不能以单进程测试代替跨进程证明。

此记录属于实现中的增量证据；阶段 PDF 的既有 v2.0 文件保留为当时的快照，下一次阶段报告将合并本次成果。
