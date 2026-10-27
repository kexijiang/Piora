# 0.5.5-beta.42 发布验证

日期：2026-10-27。Windows x64，Node.js 22.19.0。

## 来源与范围

PR [#226](https://github.com/kexijiang/Piora/pull/226) 的提交 `3bf7150a` 已通过 [CI 40396465441](https://github.com/kexijiang/Piora/actions/runs/40396465441)：Ubuntu／Windows 全部六个测试分片、Windows Shell 资源测试、两个平台质量门禁、网站检查、Windows 打包及隔离验证全部通过。可选硬件任务未触发，不计为 CI 真机通过。已合并至主分支 `0b0fb66a`。

本次发布准备仅更新根包、桌面包、锁文件的版本字段，以及 CHANGELOG、README、用户手册和许可证清单。运行时代码与通过 CI 的合并内容相同。版本说明包含停止引导恢复、Pi 原生默认能力和全部鸿蒙视频／媒体／界面修复；对应真机与界面证据见 [投屏验收记录](design/harmony-live-video-2026-10-26/README.md)。

## 本地门禁

- `node scripts/verify-release-metadata.mjs v0.5.5-beta.42 --prerelease` 通过；`node scripts/create-release-notes.mjs v0.5.5-beta.42 ...` 从该版本 CHANGELOG 生成中文说明。
- `node --test --test-concurrency=1 lib/release-notes.test.mjs lib/release-hardening.test.mjs lib/windows-update-artifacts.test.mjs lib/license-compliance.test.mjs lib/brand-release-workflows.test.mjs lib/brand-release-assembly.test.mjs lib/pi-version-alignment.test.mjs lib/node-version.test.mjs`：56 项通过、1 项 Windows 符号链接权限跳过。初次 Pi 冷启动子进程超过原有 15 秒上限，低负载完整复测通过，未修改上限或运行时代码。
- 最终 lint、根包及桌面 typecheck、Harmony 文档、仓库卫生、许可证、背景资源和运行时审计全部通过。lint 两条既有脚本警告，运行时审计零已知漏洞；许可证按最终锁文件重新生成。
- 仅版本元数据和说明变化，不重复未受影响的完整运行时测试、性能预算和原生图片诊断；源代码的对应完整 CI 已通过，新的 beta 标签工作流仍重新运行全部测试分片与包验证。website 没有改动，跳过其独立本地检查。Windows 权限限制和其他操作系统不宣称本地通过。
- 本地不执行 Next 生产构建或发布打包。云端候选构建、下载后原始包验收及独立发布均在标签推送后执行；本记录本身不是已发布证明。

## 实际候选结果

标签构建 [40412915279](https://github.com/kexijiang/Piora/actions/runs/40412915279) 的全部测试与静态包检查通过。下载的候选 ZIP 摘要为 `e8491076b52e03a8183698e81c6224aeabc2b891b59089bd50c53c522f5fdc67`，与 GitHub 摘要一致；各文件 SHA-256 与更新说明均吻合。

实际便携版冷启动未通过：校验器运行在 Electron Node 模式，普通 `fs` 将 `resources/app.asar` 和 `resources/web/runtime.asar` 看作虚拟目录，而构建清单将其记录为完整归档文件。已在原始下载包中复现。beta.42 未发布，标签保留；后续 beta.43 修复校验器并补上真实 Electron 清单门禁。
