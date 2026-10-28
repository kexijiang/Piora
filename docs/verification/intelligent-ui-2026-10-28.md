# Intelligent UI 第一阶段验证记录

日期：2026-10-28。对应 [需求 #235](https://github.com/kexijiang/Piora/issues/235)，使用与边界见 [功能文档](../intelligent-ui.md)。

## 环境与范围

- Windows，独立工作树 `intelligent-ui/Piora`，分支 `codex/intelligent-ui`，基线 `37959a18`。
- 使用锁文件执行 `npm ci --no-audit --no-fund`，没有增加依赖或修改锁文件。安装时 Node.js 为 24.5.0；下述最终验证统一使用与 CI 一致的 Node.js 22.19.0。
- 按 `.github/workflows/ci.yml` 与 `test-suite.yml` 扩大到完整测试枚举：本次涉及扩展加载、聊天发送、分支、复制、导出及回收站共享路径。
- 只执行 `build:harmony-worker` 和 `build:desktop` 测试夹具编译，没有执行 `next build`、应用打包或发布。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过，含桌面包 |
| `npm run lint` | 0 errors；2 个未修改脚本中的已有 warning：`clipboard-native-drag-probe.mjs:107`、`verify-packaged-clipboard.mjs:68` |
| `npm run harmony:docs:check` | 通过：39 actions、6 templates、17 entrypoints |
| `npm run verify:hygiene` | 通过 |
| `npm run licenses:check` | 通过：1379 packages |
| `npm run verify:backgrounds` | 通过：37 backgrounds |
| `npm run audit:runtime` | 通过：0 vulnerabilities |
| `npm run perf:check` | 通过；最终 10000 条聊天记录处理 5.90 ms，预算 100 ms |
| `node scripts/diagnose-sharp-electron.mjs` | 通过，Node / Electron raw / ASAR 全部 6 项 |
| `git diff --check` | 通过 |

完整枚举命令 `node scripts/run-tests.mjs` 已结束，耗时约 39.7 分钟：**3178 tests，3144 pass，10 fail，24 skip**。没有设置 `PIORA_SKIP_RESOURCE_TESTS=1`。运行期间完成修复，之后对受影响路径和失败项重新验证；这不是一次无失败的完整运行，也不等同于远端双平台 CI 全绿。

首次 10 个失败均有成功复测：

| 首次失败 | 处理与复测 |
| --- | --- |
| 普通会话扩展清单 1 项、品牌身份 2 项 | 更新默认关闭实验扩展的预期，扩展名称使用品牌常量；`agent-runtime-isolation`、`brand-prompts`、Beta 和回收站相关组 25/25 通过 |
| Windows 原生气泡 1 项、Electron 粘贴 1 项 | 安装缺失的 Electron 45.0.0 测试运行时，按 npm 包内校验和核对官方压缩包；`companion-bubble-position` 与 `composer-files-browser` 4/4 通过 |
| Harmony 生成代码编译 2 项 | 仅在测试进程指定已安装 DevEco JBR 的 `JAVA_HOME` 与 PATH；`design-to-harmony-phase5` 11/11 通过，无跳过 |
| 用户字体比例 1 项 | 将新控件固定字号改为主题字号变量；浏览器与 `font-preferences` 组 8/8 通过 |
| Shell 资源测试 2 项 | 测试进程使用空 `PSModulePath` 与 `PSExecutionPolicyPreference=Bypass`，没有修改系统设置；`npm run test:shell-resource` 6/6 通过，无跳过，覆盖 Windows PowerShell、PowerShell 7、Git Bash |

最终相关回归 **189/189 通过，无跳过**（包括最后的焦点、命令入口、取消与祖先状态修复）：

```powershell
node --test --test-concurrency=1 hooks/useAgentSession.test.mjs components/MessageView.test.mjs components/intelligent-ui*.test.mjs lib/compact-chat-history.test.mjs lib/extension-config.test.mjs lib/beta-features*.test.mjs lib/answer-output*.test.mjs lib/intelligent-ui.test.mjs lib/session-export.test.mjs lib/session-trash.test.mjs lib/settings-search.test.mjs lib/agent-runtime-isolation.test.mjs lib/brand-prompts.test.mjs lib/font-preferences.test.mjs lib/i18n/*.test.mjs
```

另行执行 RPC、启动和自动化回归，**22/22 通过，无跳过**：

```powershell
node --test --test-reporter=spec lib/rpc-manager.test.mjs lib/rpc-task-activity.test.mjs lib/rpc-startup-sdk.test.mjs lib/rpc-startup-cleanup.test.mjs lib/automation-runtime.test.mjs
```

测试结果不可简单相加，多个分组有重叠。

## 功能证据

- 真实 SDK 注册测试覆盖默认关闭、开启后下一轮获得工具、运行中关闭保持当前轮能力、下一轮移除、再次开启，并覆盖普通输入、流式输入和命令路径的 16 种空闲入口开关切换。使用本地模型响应夹具，没有调用真实供应商。
- 协议与 API 测试覆盖受限表达式、恶意引用、版本冲突、只读快照、活动分支归属、祖先修改与兄弟分支隔离、复制/分叉、HTML 导出、回收站清理。
- 浏览器测试覆盖输入与本地计算、保存/失败/恢复、工具完成后即可交互、正常流结束不重挂载控件、分支切换、窄屏、深浅主题、中英文与 22px 字体设置。最终夹具使用 planner → MessageView → AnswerOutput → renderer，直接断言 `entryId` 补齐前后输入框是同一个 DOM 节点、焦点未变。
- 本地固定数据夹具一次测得首次控件约 1505 ms、输入到指标更新约 5 ms。首次加载包含测试包及完整消息组件；没有进行生产构建或真实模型延迟测量，数值不可直接用作产品性能承诺。
- 额外覆盖祖先规格收窄后修改参数的场景：已有子分支保留原始保存值，随后创建的新分支继承祖先新值，避免将祖先默认值误写入已有分支。
- 运行中追问与引导输入也等待参数保存；保存失败返回未提交并保留输入。等待期间停止、撤回、切换聊天或启动新一轮，会取消尚未提交的旧输入。

## 未覆盖范围与跳过项

完整枚举中 24 个跳过项已经核对：

- 5 项符号链接测试：当前 Windows 账户没有创建符号链接权限，涉及 Bash 输出、宠物素材、文件索引/编辑及静态资源打包；本次未修改这些实现。
- 1 项 Harmony 目录分页脚本测试：用例显式跳过 Windows，依赖 POSIX shell 路径行为；本次未修改该路径。
- 1 项真实固定版本 7za 长路径测试：未设置 `PIORA_TEST_7ZA`，属于便携包验证；本次未修改打包或解压器。
- 17 项原生 H.264 C++ 测试：未配置测试所需编译器；本次未修改编码、队列或视频传输实现。

上述跳过不计为通过。Linux 全套、实际模型端到端生成、发行包验收、Harmony 实机及发布工作流未在本地验证。网站没有变更，未执行 website 安装/审计/构建。此记录不声称已经提交、推送、合并或发布。
