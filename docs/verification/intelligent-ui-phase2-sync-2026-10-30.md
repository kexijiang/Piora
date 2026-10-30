# Intelligent UI 第二阶段提交前同步记录

2026-10-30。用户要求提交并推送当前代码，本次在专用工作树、`codex/intelligent-ui` 分支整理第一至第二阶段成果。

## 基线与保留范围

- 提交前 fetch upstream 与 origin，先将功能分支 rebase 到 `838e2714648507dd6a9c0d3f9abb4be4b995d578`（beta.68）并执行下面的检查；再次 fetch 发现更新后，继续同步到 upstream/main `5b68fcd3`（beta.69）。后一次仅含角色主题字号 CSS 与版本、说明文件变化，没有改动本次检查涉及的 TypeScript 或依赖补丁。
- 保留第一阶段功能和第二阶段 2A 至 2D 实现，以及全部阶段报告、评估夹具、19 份 PDF、第二阶段手测指南和最新边距修复。
- rebase 前保留分支与 stash 备份。187 个新增文件恢复后逐一比较 Git 对象哈希，均与备份一致；两个在预览中打开的 PDF 未从磁盘移除，其内容也通过核对。
- 更新说明保留 upstream 的已发布版本记录，Intelligent UI 工作仍归入 Unreleased。语言包同时保留新角色主题与实验功能字段。
- 依赖入口同时保留 Windows Bash 取消补丁和 Intelligent UI 参数接纳补丁；前者严格验证后还原为原始字节参与目录校验，后者要求匹配已审查的补丁状态，不跳过文件或放宽未知内容校验。

## 同步后实际检查

环境：Windows / Node.js 22.19.0。以下检查在 beta.68 同步后执行；beta.69 的独立字号与版本更新未重复运行这些测试。

| 检查 | 结果 |
| --- | --- |
| `node scripts/patch-bundled-dependencies.mjs` | 通过；Intelligent UI 接纳补丁已存在，Windows 取消补丁应用后通过源目录完整性验证 |
| 6 个定向测试文件 | 64/64 通过，0 失败、0 取消、0 跳过 |
| `npm run typecheck` | Web 和 Desktop 均通过 |
| 冲突相关源码的 ESLint | 通过 |

定向测试文件为 `lib/pi-source-profile.test.mjs`、`lib/intelligent-ui-admission-profile.test.mjs`、`lib/answer-output-admission-runtime.test.mjs`、`lib/windows-bash-cancel.test.mjs`、`lib/rpc-manager-behavior.test.mjs`、`lib/agent-profile-routes.test.mjs`。覆盖依赖完整性、调用接纳、Windows 实际子进程停止、会话运行与配置路由；不代表全仓测试通过。

原始输出保留在本机 `.verification/intelligent-ui-push-*.log`。边距修复此前的 8 项浏览器测试见[对应记录](intelligent-ui-phase2-spacing-2026-10-30.md)，不是本次 rebase 后重跑的完整浏览器结果；历史模型评估也没有重跑。

## 已知问题与后续安排

用户截图中，2 人时表格 A 为 180 元、B 为 150 元，文字却说 A 更划算；该内容一致性问题仍未修复，已纳入开发回归记录。不能因布局修复或本次技术检查通过而把它记为解决。

第二阶段功能开发完成，第三阶段尚未完成。独立人工语义验收、完整 CI 和综合发布验证按用户安排后置；本次不运行模型请求、不构建 Next 生产包或发布安装包。推送触发的远端检查应另行报告真实状态，不把触发或排队计为通过。
