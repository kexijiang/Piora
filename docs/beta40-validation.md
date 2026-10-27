# 0.5.5-beta.40 发布验证记录

日期：2026-10-26。平台：Windows x64。Node.js：22.19.0；Electron：44.9.1。使用独立 Git 工作区，以远端 beta.39 / `55a17a16` 为基础，合入本地未提交实现及设计资料。

## 范围

- 完整鸿蒙工作台、独立只读投屏、DIP 缩放、通用提示、原始截图、长录屏与恢复。
- 保留远端新增的录屏独立通道确认、视频取消和设备代次校验；完整工作台默认启用，显式受限部署仍可设置 `PIORA_HARMONY_WORKBENCH=0`。
- 宠物任务气泡拖动、文件树分栏、Markdown 滚动同步、扩展重载、开发启动和热更新。
- 主对话执行过程竖线与正文对齐；源代码异步着色后的定位高亮。
- 根包、桌面包、锁文件、README、用户手册和许可证清单统一到 beta.40。两套命令交互设计原型作为资料保留，模拟结果不代表已执行真实命令。

## 本地检查

日志保存在发布工作区 `.piora-data/release-validation/`，不提交运行日志或本机路径。

| 命令 / 检查 | 结果 |
| --- | --- |
| `npm ci` | 按锁文件安装完成 |
| `npm run lint` | 0 错误，2 条既有脚本警告；增补文件 ESLint 复查通过 |
| `npm run typecheck` | 根和桌面类型检查通过；最终代码修改后再次通过 |
| `npm run harmony:docs:check` | 通过 |
| `npm run verify:hygiene` | 文件树及可达 Git 文本历史通过；最终文件树再次复查 |
| `npm run licenses:check` | 通过，1380 个包 |
| `npm run verify:backgrounds` | 通过 |
| `npm run perf:check` | 通过 |
| `npm run audit:runtime` | 0 个漏洞 |
| `npm run build:harmony-worker`、`npm run build:desktop` | 仅编译测试夹具，通过；没有制作本地发布包 |
| `node scripts/diagnose-sharp-electron.mjs` | Node / Electron 原生图片及 ASAR 加载通过 |
| 合并专项：画面、录屏生命周期、工作台边界 | 43 项通过 |
| 主对话过程浏览器回归 | 宽屏和 390 px 窄屏竖线与正文误差不超过 1 CSS 像素；原有交互通过 |
| `node --test lib/portable-payload.test.mjs`，配置固定 7-Zip 26.04 | 5 项通过，0 跳过，覆盖 Unicode、空格、长路径 |
| 源代码延迟语法加载、改动定位与分栏滚动 | 浏览器回归通过；文件导航、行号和编辑规则 19 项通过 |
| `node --test hooks/useAgentSession.test.mjs` | 调整冷加载夹具后 54 项通过；保留 15 秒行为超时及全部断言 |

完整测试集完整运行 40 分钟：3064 项，3055 通过、1 失败、1 超时取消、7 跳过。没有将这一条命令记为零失败。

- 文件改动导航在切换源代码时等待定位高亮超时：改为由 React 状态保留高亮并等待源代码行就绪；增加延迟 JSON 语法加载的实际浏览器验证。最终浏览器导航、Markdown 分栏滚动及 19 项文件编辑回归通过。
- 真实路由取消用例首次冷加载 TypeScript/SDK 超过 15 秒：将依赖加载移到各用例计时前，保留原有 15 秒操作期限、真实路由和全部竞态断言。最终会话 Hook 54 项全部通过。
- 这两项完成修复后已按受影响范围复测；其余完整批次通过项覆盖未再修改的运行代码。没有把分组复测数量相加冒充唯一用例总数，也没有宣称另跑了一次完整零失败批次。
- 7 项跳过分别为 5 项 Windows 符号链接权限限制、1 项明确排除 Windows 的设备目录分页、1 项未设置 `PIORA_TEST_7ZA` 的便携压缩测试。最后一项已用仓库固定、校验哈希的 7-Zip 26.04 单独补跑，5 项便携用例全通过。剩余 6 项环境限制未计为通过，跨平台 CI 继续覆盖。

测试入口使用 `node scripts/run-tests.mjs`，此前已执行 npm pretest 对应的两个夹具编译命令。不设置 `PIORA_SKIP_RESOURCE_TESTS`，Shell 资源用例随完整测试执行。固定 7-Zip 用例另外执行，不把缺少环境导致的跳过当作通过。

## 未覆盖边界

- 本地没有运行 `next build`、安装包或便携发布包构建；由 GitHub Actions 构建和验证。
- 当前发布差异未修改 website 源码、依赖或配置，未重复其安装和构建；远端完整 CI 保留网站检查。
- Linux、发布打包及真实手机性能不由本机结果代替。USB 真机 10 分钟动态播放、24 FPS、端到端 P95 250 ms、真实 30 分钟录屏及多显示器交互尚未验证。
- `docs/design/harmony-2026-10-26/validation.md` 是合并前 Node 24 开发阶段记录，其失败、跳过和未提交状态是历史结果，不代替本记录。
