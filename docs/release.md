# Piora release procedure

Piora publishes desktop packages from [`kexijiang/Piora`](https://github.com/kexijiang/Piora). It does not publish the former `@agegr/pi-web` npm package. The release source is the commit referenced by the version tag, and that commit must be contained in `origin/main`.

## Channels and artifacts

| Channel | Tag | Workflow | Packages |
| --- | --- | --- | --- |
| Beta | `vX.Y.Z-beta.N` | `.github/workflows/harmony-preview.yml`, then `.github/workflows/publish-preview.yml` | Windows x64 NSIS installer, installer blockmap, `beta.yml`, `SHA256SUMS.txt` |
| Stable | `vX.Y.Z` | `.github/workflows/release.yml` | Windows x64 NSIS installer, installer blockmap, `latest.yml`, `SHA256SUMS.txt` |

Beta tag CI builds and uploads a candidate without creating a GitHub Release. Once all build and verification jobs succeed, the publication workflow automatically publishes those same bytes as a GitHub prerelease. Stable publication is marked latest. The stable workflow ignores prerelease tags even though its tag trigger matches `v*`. A push to `main` runs CI; it does not itself publish a package.

Windows installers support application updates; beta installers consume beta update metadata. Future beta and stable releases build only the Windows x64 installer; portable EXE, ZIP, Linux AppImage and other platform packages are no longer generated. The optional scheduled silent-update setting is disabled by default and defers installation while tasks or unsaved edits remain. Desktop installers and executables are not Authenticode signed; the bundled Harmony HAP has its own mandatory OpenHarmony signing and verification gate.

## Prepare the source

Use Node.js 22.19.0 (see `.nvmrc`) and the committed npm lockfile. Review the entire release diff, including previously uncommitted work. Keep credentials, sessions, user imports, logs and generated build output out of Git.

Update all version locations together:

- `package.json` and `desktop/package.json`;
- `package-lock.json`: top-level version, `packages[""].version`, and `packages.desktop.version`;
- the matching dated heading in `CHANGELOG.md`;
- the README source-version statement when preparing a documented release.

Regenerate the license inventory after version or lockfile changes. Its freshness check includes the lockfile hash; an unchanged dependency list does not make an old inventory current.

```powershell
npm ci
npm run licenses:generate
npm run licenses:check
npm run verify:hygiene
npm run lint
npm run typecheck
npm test
npm run perf:check
npm run verify:backgrounds
```

For a beta candidate, validate metadata and generate reviewable notes before tagging:

```powershell
node scripts/verify-release-metadata.mjs v0.4.41-beta.8 --prerelease
node scripts/create-release-notes.mjs v0.4.41-beta.8 .verification/release-notes.md
```

Replace the example version with the actual candidate. Generated notes come from the matching CHANGELOG section; do not claim unperformed device or installation checks passed.

## 每次提交与发布的更新说明

开发提交维护本 PR 独立的 `changelog.d/<唯一标识>.<类型>.md`，不再共同编辑 `CHANGELOG.md` 的 `Unreleased`。使用明确的中文描述问题和改进后的行为，纯工程变更也说明用途；无需发布说明时以 `.skip.md` 记录具体理由并由评审确认。格式、检查命令和已有 PR 的迁移步骤见 [片段指南](../changelog.d/README.md)。提交正文同时记录相关验证结果，不将尚未执行的安装验证写成通过。

发布准备在同步后的独立分支上，从已提交的说明输入生成预览，审核后写入：

```powershell
npm run changelog:release -- 1.2.3-beta.1 2026-11-08
npm run changelog:release -- 1.2.3-beta.1 2026-11-08 --write
```

替换为实际版本及日期。脚本固定读取 HEAD，保留历史版本，将遗留 `Unreleased` 及本次片段汇总到新版本，并仅删除已消费片段。将这些变更与版本、锁文件、README、许可证清单一起提交为发布 PR；脚本不修改这些版本元数据，也不构建发布包。开发 PR 的 CI 只校验片段，不回写汇总文件。发布校验拒绝仍有待处理片段的源码；发布 PR 同步新变更后须核对新片段并重新整理，确保打标签的提交中所有变化均有对应说明。

GitHub Release 与应用更新窗口共用该版本的说明。`electron-before-build.cjs` 调用 `prepareBuildReleaseNotes()` 生成 `desktop/build/release-notes.md`，electron-builder 的 `releaseInfo.releaseNotesFile` 将内容写入更新 YAML；生成文件不提交到 Git。Beta 更新器使用 generic feed，不能只依赖 GitHub Release 正文。

`verify-windows-update-artifacts.mjs` 必须验证更新 YAML 的 `releaseNotes` 非空并与目标 CHANGELOG 版本完全一致。不得为了完成发布而跳过更新说明检查。此规范适用于之后所有提交和 beta/stable 发布。

## GitHub Actions packaging

Never build release packages locally, including in a separate worktree. Push the reviewed commit and tag; GitHub Actions alone builds, verifies and publishes artifacts. The commands below describe CI steps, not local release instructions.

```powershell
npm ci
npm run dist:win:preview  # beta
# npm run dist:win       # stable Windows
npm run verify:package
node scripts/verify-portable-runtime.mjs desktop/release/win-unpacked v0.4.41-beta.8
npm run licenses:package:check
node scripts/verify-windows-update-artifacts.mjs desktop/release v0.4.41-beta.8
node scripts/smoke-test-portable.mjs desktop/release/win-unpacked/Piora.exe --expected-version v0.4.41-beta.8 --packaged-runtime
```

The staging script validates standalone output and matching static assets. Packaging archives the web runtime into `resources/web/runtime.asar`; native dependencies needing real paths, including the complete node-pty module and ConPTY helpers, live in the adjacent unpacked tree. Do not manually rearrange native binaries or reuse stale `.next` output.

`verify:package` copies the packaged service to an isolated location and checks desktop authentication, authenticated root/health responses, Pi sessions, external package/extension/Skill discovery, packaged terminal support and license material. It uses packaged Electron as the Node runtime when required. The after-pack step generates an exact package-copy manifest, CycloneDX SBOM and content-addressed license texts under `resources/licenses/third-party/`; these are separate from the broader source lockfile inventory.

The smoke script verifies the embedded application version, renderer and preload bridge in an isolated profile. Windows CI exercises both the unpacked Electron payload and the installed NSIS application. Actual upgrade and data retention should also be checked on a release machine.

The shared payload manifest gate also runs its verifier with the packaged Electron binary in Node mode. The verifier uses Electron's `original-fs` to hash physical ASAR archives as complete files; ordinary Electron filesystem APIs mount them as virtual directories. This gate preserves rejection of missing, extra, changed or linked payload entries in the installer runtime. Its existing script names retain the portable prefix for compatibility.

## Commit, push and trigger

After the source gates pass, commit the complete release input and push `main`. Use an unused version tag; do not move a published tag to another commit.

```powershell
git push origin main
git tag -a v0.4.41-beta.8 -m "Piora v0.4.41-beta.8"
node scripts/verify-release-metadata.mjs v0.4.41-beta.8 --prerelease --require-origin-main
git push origin v0.4.41-beta.8
gh run list --repo kexijiang/Piora --workflow harmony-preview.yml --limit 5
```

For stable releases, wait for main-branch CI before creating `vX.Y.Z`, omit `--prerelease` from metadata verification, and follow `release.yml`. Always pass `--repo kexijiang/Piora` to `gh`: a fork checkout with an `upstream` remote may otherwise select the upstream project.

Beta CI runs the reusable six-shard Windows test suite alongside the Windows package job. The package job checks source hygiene, licenses, lint, types, backgrounds and performance budgets, builds Windows packages using the repository-provided Harmony capture HAP, and checks updater metadata, package isolation, licenses, the Electron runtime and installed application before uploading the candidate. Publication requires an overall successful original run. Phone hardware acceptance is optional and its result must be reported accurately.

When `harmony-preview.yml` completes successfully, `publish-preview.yml` automatically publishes its verified artifacts through `workflow_run`. No environment approval or manual acceptance is required. Keep this publication workflow on the default branch so GitHub can trigger it. Failed or cancelled builds do not publish. The former `preview-publish` environment no longer has required reviewers and is not referenced by the publication job.

Manual dispatch remains available to publish an existing successful build that has not yet been released (for example, a build completed before automatic publication was enabled):

```powershell
gh workflow run publish-preview.yml --repo kexijiang/Piora -f tag=v0.4.41-beta.8 -f build_run_id=<successful-preview-run-id>
```

The publication workflow binds the requested run to the tag commit, rechecks release metadata, verifies the grouped package checksums and CHANGELOG-derived notes, and publishes the already verified bytes. It does not rebuild the desktop package. Optional installed-app or phone testing must report the exact tag, run ID, package hash and result accurately; unperformed hardware tests must not be reported as passed.

Stable CI first runs the Ubuntu source gate, builds the Windows installer, verifies the runtime, installed application, updater files and checksums, and publishes only after tests and Windows verification succeed. Do not bypass a failed gate by manually uploading unverified binaries.

## Verify and report

- Confirm both the build run and, for beta, the later publication run belong to the intended repository, tag and exact commit.
- Report queued, building, candidate ready, acceptance failed, publication queued and published distinctly. A pushed tag or successful candidate build is not proof of a published release.
- If a gate fails, inspect that step's log, fix the source and use a new candidate version when the tagged source must change.
- After success, check the Release contains the expected package set and verify downloaded SHA-256 checksums.
- On clean machines, verify startup, model setup, image history reload, project selection, editing/conflicts, terminal, browser login, external extension loading, and the Harmony workbench's read-only projection, media, files, databases and agent actions when hardware is available.
- For installed updates, test download, busy/unsaved deferral, installation, restart and data retention.
- Record the exact commit, run and Release URLs. Historical acceptance/design documents describe their own tested versions, not automatic proof for the new release.

See [README](../README.md), [desktop development](../desktop/README.md), [release checklist](open-source/LAUNCH_CHECKLIST.md) and [black-screen troubleshooting](open-source/BLACK_SCREEN_TROUBLESHOOTING.md).
