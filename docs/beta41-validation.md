# 0.5.5-beta.41 发布补充验证

日期：2026-10-26。Windows x64，Node.js 22.19.0。

## 原因与范围

beta.40 提交 `879d898b` 的云端 Windows / Linux 六个测试分片及 Windows Shell 资源测试均通过。主 CI 和 beta 发布包验证发现 `verifyPackagedCoreTools` 仍把默认产品当作禁用鸿蒙工具的旧镜像模式，拒绝了完整工作台的 `harmony_control`。beta.40 未发布安装包，标签保留不移动。

本次仅修正发布验证契约及其测试，默认必须加载并启用唯一的 Harmony 网关；显式受限模式仍禁止注册任何 Harmony 工具，旧操作工具和默认禁用的可选扩展仍拒绝。增加真实扩展注册集成用例，防止验证器的测试数据与运行时再次脱节。产品运行时代码与 beta.40 相同，版本、锁文件、README、手册和许可证清单更新至 beta.41；更新说明包含 beta.40 全部用户变化。

## 本地门禁

- `node --test lib/packaged-tool-registration.test.mjs lib/packaged-app-verification.test.mjs lib/harmony-mirror-mode.test.mjs`：17 项通过，无跳过。
- `node --test lib/brand-release-workflows.test.mjs lib/brand-release-assembly.test.mjs lib/license-compliance.test.mjs lib/release-hardening.test.mjs lib/release-notes.test.mjs`：43 项通过，1 项 Windows 符号链接权限限制跳过；未计为通过，Linux CI 覆盖。
- `npm run lint`、`npm run typecheck`、`npm run harmony:docs:check`、`npm run licenses:check`、`npm run verify:hygiene`：全部通过；lint 为 0 错误、2 条既有脚本警告，最终改动脚本单独 ESLint 无警告。
- 未更改产品运行代码、外部依赖、资源和性能预算，不重复已通过的背景、原生图片诊断、审计、性能及完整本地测试；完整基础记录见 [beta.40 验证记录](beta40-validation.md)。云端仍重新执行完整测试和安装包校验。
- 本地没有执行 Next.js 生产构建或发布打包；实际包验证必须由新的 GitHub Actions 运行确认，不能以本地脚本用例代替。
- 鸿蒙真机帧率、延迟和完整 30 分钟录屏仍未验收。
