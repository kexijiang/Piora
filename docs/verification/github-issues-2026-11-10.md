# GitHub issue 核对与修复（2026-11-10）

核对仓库：`kexijiang/Piora`。基线：`origin/main` 的 `b316d3d70413788aeb38b455a1f9de652b9753d4`。
本次在独立 worktree `github-issues-20261110`、分支 `codex/github-issues-20261110` 完成修改，未改动主开发目录原有修改。

## 未关闭 issue 的处理结果

| Issue | 核对与处理 | 当前边界 |
| --- | --- | --- |
| [#369](https://github.com/kexijiang/Piora/issues/369) | 确认仍存在并修复。先匹配已注册命令，路径、正则及非命令正文回落普通消息；输入框使用同一分类，HTTP 分发在分类后明确按文本投递。 | 保留 `/missing` 等命令拼写错误、显式命令身份、技能命名空间及扩展命令，不把所有未知单词静默发送。 |
| [#371](https://github.com/kexijiang/Piora/issues/371) | 最新主线的图片输入已在基础区。本次进一步将推理 / 思考移到同一区域，验证不展开高级设置也能操作，保存后能力正确保留。 | 不根据模型名称自动猜测能力；未增加不存在的工具调用能力开关。 |
| [#372](https://github.com/kexijiang/Piora/issues/372) | 主线已修复视频关闭依赖死锁及纯视频清理失败误锁住输入。本次补充慢视频清理后仍可重新开流的回归；修复 worker 丢失错误结构导致英文原文直出的缺口，并在清理待确认时暂停无效重连循环。 | 普通 stopping 自动重试；recovering 保留输入安全栅栏，显示恢复指引后支持手动重试。不能把超时当成输入已释放，不能通过重连强制清除未知物理按住。未在报告中的 VNE 设备实测。 |
| [#373](https://github.com/kexijiang/Piora/issues/373) | 本地夹具复现旧 custom 白名单使现有及新项目会话排除扩展工具的路径。本次增加已关闭工具列表、恢复入口和真实扩展加载错误显示。 | 仅证明配置路径；没有报告人实际会话及扩展进程日志，不能断言独立宿主掉线。保留用户显式关闭，不自动扩大项目工具授权，也没有宣称完成宿主重连。 |
| [#374](https://github.com/kexijiang/Piora/issues/374) | 主线 PR #366 已包含错误去重、超时本地化及保留原文/附件的重试入口；已有运行等待反馈和全局重试/超时设置。本次复测相关逻辑及中文/英文浏览器场景通过。 | 手动重试并非服务端断点续传；没有使用真实模型或等待线上 300 秒。 |
| [#344](https://github.com/kexijiang/Piora/issues/344) | 主线 PR #345 已有修复；新任务项目和模型选择浏览器回归通过。 | 离线接口夹具，不是报告人内网环境的验收。 |
| [#351](https://github.com/kexijiang/Piora/issues/351)、[#357](https://github.com/kexijiang/Piora/issues/357) | 主线 PR #362 已采用较小部署窗口并校验输入输出共享额度；发现、保存/SDK 重载、最终请求覆盖等相关测试通过。 | 仍缺实际 dsv4.1-1017 部署元数据；合成 991041 复现不证明线上根因，保持未完整解决状态。 |
| [#250](https://github.com/kexijiang/Piora/issues/250) | 独立 DSH/Cordis 插件体系属于后续功能项目。 | 本次没有实施通用宿主，也不把扩展诊断视为完成该需求。 |
| [#235](https://github.com/kexijiang/Piora/issues/235) | 已有开发中的 Draft PR #238。 | 本次未修改该功能分支，也没有宣称第三阶段或完整验收完成。 |

## 验证

以下 16 个文件的最终相关测试全部通过，共 118 个不同测试；重复执行不累计：

- 命令：`lib/chat-command-input.test.mjs`、`lib/chat-command-flow.browser.test.mjs`、`components/ChatCommands.browser.test.mjs`。
- 项目工具：`lib/project-tool-settings.test.mjs`、`components/ProjectToolsConfig.browser.test.mjs`。
- 投屏：`lib/harmony-device-manager.test.mjs`、`lib/harmony-mirror-worker.test.mjs`、`lib/harmony-request-error.test.mjs`。
- 模型与旧反馈：`lib/model-sampling-browser.test.mjs`、`lib/new-task-selection-browser.test.mjs`、`lib/model-output-error-browser.test.mjs`、`lib/prompt-error-notices.test.mjs`、`lib/model-stall-guard.test.mjs`、`lib/model-discovery.test.mjs`、`lib/model-limits.test.mjs`、`lib/provider-payload.test.mjs`。

Web TypeScript `tsc --noEmit`、12 个改动生产 TypeScript 文件的定向 ESLint 和 `git diff --check` 通过。没有运行完整本地 CI、`next build`、本地发布打包、原生桌面 E2E、其他平台或真实设备验收。

项目工具新浏览器场景首轮因 controlled 开关需要等待 PATCH 回执，而 `check()` 在回执前检查状态失败。改用 UI 点击，等待保存回执后严格核对开启状态、实际选择及刷新恢复，复测通过；没有删减原有状态断言。

浏览器测试运行真实 React 组件和真实 SDK 本地会话，HTTP / 模型输出 / 视频解码及设备由各测试夹具提供。测试不代表真实供应商、扩展独立进程或手机的端到端验收。相关更新说明保存在本次独立的 `changelog.d/369-374-issue-followups-20261110.fix.md`。

## 提交前验证快照

本报告记录提交前的开发验证结果。后续提交、PR 与远端 CI 状态以关联 PR 当前 head 和 GitHub Actions 为准；本地测试通过不代表远端 CI、实机验收或发布完成。仍需实际部署信息的事项保留其验证边界。

## PR #375 首轮 CI 跟进

[首轮 CI](https://github.com/kexijiang/Piora/actions/runs/42744530494) 的 Windows 第 5 分片出现 13 个失败，全部来自 `ChatInput-retry.test.mjs` 和 `composer-acknowledgement.test.mjs`：两者抽取生产发送回调执行，但没有同步新增的命令目录及解析依赖，报 `commandCatalog is not defined`。补入真实命令解析模块及目录，并新增带附件斜杠正文发送的回归；保留原有恢复、权限、语音、会话切换及迟到回执断言。首轮失败记录保留，后续通过与否以修复提交对应 CI 为准。
