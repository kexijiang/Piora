# 0.5.5-beta.43 发布验证

日期：2026-10-27。Windows x64，Node.js 22.19.0，Electron 44.9.1。

## 变更与实物证据

- beta.42 云端构建与六个测试分片通过，但实际便携版冷启动失败，因此未发布；原标签和原始候选字节保留。详细结果见 [beta.42 记录](beta42-validation.md)。
- 从同一下载包提取原始 payload（仅检查云端产物，未在本地制作发布包）：普通 Node 观察到 2040 个文件，路径和大小完全一致；打包 Electron 的 `fs.lstat` 将两个 ASAR 报为大小为 0 的目录，复现了运行环境差异。
- 校验器改用 Electron `original-fs`，继续逐项验证完整归档字节、文件集合和哈希；不忽略 ASAR、不关闭校验。修复后的脚本使用同一原始 Electron 对同一 payload 完整验证通过，2040 个文件一致。
- 新增真实 Electron 回归：旧实现失败，修复后通过；篡改 ASAR 后依然失败。新增 Windows 主 CI、beta 与稳定发布包的实际 Electron 清单门禁。
- 主分支 beta.42 CI 的聊天键盘测试两次在 Enter 后立即计数处失败；beta 标签 CI 和本地复测通过。改为等待实际命令卡片展开，再验证原有三个卡片和 `aria-expanded` 状态，不降低行为断言。

## 验证范围

涉及离线校验器、发布脚本和 CI 门禁，扩大到完整本地测试与质量检查；资源密集用例另行串行补跑。版本、锁文件、中文说明、README、用户手册和许可证清单同步至 beta.43。

- 手动完成 `npm run build:harmony-worker`、`npm run build:desktop` 测试夹具编译后，以 `node scripts/run-tests.mjs --test-shard=1/2` 与 `--test-shard=2/2` 完整执行全部测试文件，每个分片内部保持串行；设置 `PIORA_SKIP_RESOURCE_TESTS=1` 和空 `PSModulePath`。
- 两个分片合计 3099 项：首次 3081 通过、17 跳过、1 取消。取消项为大型 DevEco 隔离依赖复制达到原有 120 秒上限；整轮检查结束后，使用原时限单独执行 `node --test --test-name-pattern='isolated DevEco 1.3.6' lib/harmony-packaging.test.mjs`，99.94 秒通过。未把这次初始运行记作全绿。
- 使用已下载候选中的真实 7-Zip 26.04 工具与完整许可证／源码材料，经仓库固定摘要验证后设置 `PIORA_TEST_7ZA`；真实 Unicode／空格／超长路径和篡改拒绝用例已通过，未再将其算作环境跳过。
- `npm run test:shell-resource` 补跑 6 项通过；另外串行执行 `harmony-command-shortcuts-browser`、`harmony-device-terminal-browser`、`harmony-device-terminal-lifecycle-browser`、`harmony-workbench-tree-resize-browser`、`harmony-transfer-jobs-browser` 五个文件，14 项（含子用例）通过。
- 初次跳过的 11 个资源用例已补齐，剩余 6 项为 5 个当前 Windows 账户无权创建的符号链接用例及 1 个 Unix 文件分页用例，均未计作通过；对应 Ubuntu 云端测试仍会执行。
- `npm run lint`、`npm run typecheck`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run verify:backgrounds`、`npm run perf:check`、`npm run audit:runtime` 全部通过。Lint 保留两条已有诊断脚本警告；运行时审计为零漏洞。
- `node scripts/diagnose-sharp-electron.mjs` 原生图片诊断通过，覆盖 Node、实际 Electron、普通目录和 ASAR 两种加载路径。

本地不运行 Next 生产构建或制作安装包。新标签仍需重新完成云端构建、全部分片与包校验；发布前必须下载同次成功运行的候选，完成实际程序和手机验收。现有投屏功能证据见 [真机记录](design/harmony-live-video-2026-10-26/README.md)，不代替 beta.43 原始包验收。
