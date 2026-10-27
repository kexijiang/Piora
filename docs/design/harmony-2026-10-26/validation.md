# 鸿蒙工作台实现验收记录

> 本文保留合并前的开发阶段结果。后续 beta.40 的 Node 22 发布验证见 [发布验证记录](../../beta40-validation.md)。

日期：2026-10-26。环境：Windows x64，Node.js v24.5.0，现有锁定依赖。CI 使用 Node.js 22.19.0，本次未把 Node 24 结果视为 Node 22 或其他系统已验证。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 根应用与桌面通过 |
| 本次修改相关 TS/TSX/MJS 的 ESLint | 通过 |
| 工作台、投屏浏览器交互与设备管理、系统录屏、字体、布局复测 | 93 项通过，0 跳过；日志 `.piora-data/harmony-recheck.log` |
| 桌面启动可选服务与布局回归 | 17 项通过；日志 `.piora-data/harmony-layout-regressions.log` |
| 媒体、画面订阅、窗口权限末轮检查 | 64 项通过，0 跳过；日志 `.piora-data/harmony-final-media.log` |
| 最终设备与 UI 交互复测 | 61 项通过，0 跳过；日志 `.piora-data/harmony-delivery-tests.log` |
| 通用确认、主题、剪贴板、原有启动窗口及宠物气泡 | 30 项通过，0 跳过；日志 `.piora-data/harmony-shared-regressions.log` |
| 重复关闭、取消、保存失败、跨窗口消息去重及可信发送方 | 窗口控制器专项通过；日志 `.piora-data/harmony-window-final.log` |
| `npm run build:desktop` | 桌面 TypeScript 测试夹具编译通过；没有制作发布安装包 |
| `npm run harmony:docs:check` | 通过，39 个动作、6 个场景模板、16 个文档入口 |
| `npm run verify:hygiene` | 通过，2454 个文件及可达 Git 文本历史 |
| Windows 原生 Electron DPI | 100%、125%、150%、175%、200%；每档四种投屏比例、每种连续移动 80 次，尺寸误差不超过 1 DIP，通过 |
| 长录屏写入器 | 使用真实编码帧、121 秒和 1799／1800 秒媒体时间戳验证超过旧限制、到限收尾、MP4 可解析；不是实际等待 30 分钟的真机测试 |
| `npm run licenses:check` | 通过，1382 个包 |
| `npm run verify:backgrounds` | 通过，37 个资源 |
| 原生 Sharp 诊断及性能预算 | 通过；日志 `.piora-data/harmony-sharp-check.log`、`.piora-data/harmony-perf-check.log` |
| 全局 `npm run lint` | 未通过：website ESLint 插件出现 `contextOrFilename.getFilename` 错误，涉及 `website/app/features.json/route.ts`；本任务未改 website |
| 全量 `npm test` | 首轮完整结束：2990 项，2973 通过、10 失败、7 跳过，耗时约 49 分钟；未设置 `PIORA_SKIP_RESOURCE_TESTS`。不能称最终代码全量通过 |

各组有重叠用例，不将这些数字相加冒充唯一测试总数。全量测试的 9 个相关失败（4 个桌面启动夹具、1 个字号、2 个旧布局、1 个准备状态、1 个磁盘检查 mock）均已修正并专项复测通过，不删除对应行为覆盖。另一个 Agent 后台浏览器登录态断言首轮失败，独立复跑通过（`.piora-data/harmony-browser-regression.log`）；原因尚未定位，这不改变首轮全量命令的失败结果。

7 个跳过项未计为通过：5 个需要 Windows 文件符号链接权限的用例；设备文件大目录分页用例明确排除 Windows；7za Unicode／长路径用例因未配置 `PIORA_TEST_7ZA` 跳过，本次未涉及便携包压缩实现。Windows 原生窗口、Shell 资源用例本轮实际执行；没有设置资源测试跳过开关。

最终交互复测命令（PowerShell；截图使用模拟设备数据）：

```powershell
$env:PIORA_HARMONY_SCREENSHOT_DIR = Join-Path $PWD 'docs/design/harmony-2026-10-26/implemented'
node --test --test-concurrency=1 components/HarmonyPanel.browser.test.mjs components/HarmonyMirror.browser.test.mjs lib/harmony-passive-media.test.mjs lib/harmony-device-manager.test.mjs lib/harmony-media-history.test.mjs
node --test --test-name-pattern=desktop lib/harmony-window.test.mjs
node --test --test-concurrency=1 components/ConfirmDialog.test.mjs lib/harmony-media-clipboard.test.mjs lib/theme.test.mjs lib/desktop-startup-loading.test.mjs lib/companion-bubble-position.test.mjs
npm run typecheck
npm run harmony:docs:check
npm run verify:hygiene
```

字体同步最后补充后再次执行 `node --test components/HarmonyMirror.browser.test.mjs`、对应文件 ESLint 和完整 typecheck，均通过。原生 DPI 用例另外完整执行，没有以纯数学尺寸测试代替 Win32 实际 bounds 检查。

## 实机和截图范围

- `third_party/harmony-tools/windows-x64/hdc.exe list targets` 返回 `[Empty]`。
- 未完成 USB 真机 10 分钟播放、平均至少 24 FPS、端到端 P95 不超过 250 ms 的实测。
- 未完成真机实际 30 分钟录屏的播放、定位、内存趋势与原生／系统回退验收。
- `implemented/` 是真实组件 + 模拟数据的浏览器截图；不冒充真实手机或完整原生外窗截图。
- Windows 原生窗口尺寸测试实际运行 Electron，可证明该测试环境的尺寸行为；不覆盖真实多显示器热插拔、用户可见窗口所有交互和手机视频质量。

## 交付限制

工作区存在其他任务的修改，未撤销或混入提交。本次没有提交、推送、打标签、运行 `next build` 或制作发布包。CI 的 Linux 原生、发布打包、依赖审计和设备 runner 结果不由本机测试替代；生产依赖审计按仓库 CI 在 Linux 执行。本次没有改依赖或 website，因此未执行 website 安装和站点构建。
