# Piora release procedure

Piora publishes desktop packages from [`kexijiang/Piora`](https://github.com/kexijiang/Piora). It does not publish the former `@agegr/pi-web` npm package. The release source is the commit referenced by the version tag, and that commit must be contained in `origin/main`.

## Channels and artifacts

| Channel | Tag | Workflow | Packages |
| --- | --- | --- | --- |
| Beta | `vX.Y.Z-beta.N` | `.github/workflows/harmony-preview.yml` | Windows x64 NSIS installer, portable EXE, installer blockmap, `beta.yml`, `SHA256SUMS.txt` |
| Stable | `vX.Y.Z` | `.github/workflows/release.yml` | Windows installer, portable EXE, extract-and-run ZIP, installer blockmap, `latest.yml`, Linux x64 AppImage, combined `SHA256SUMS.txt` |

Beta is published as a GitHub prerelease. Stable publication is marked latest. The stable workflow ignores prerelease tags even though its tag trigger matches `v*`. A push to `main` runs CI; it does not itself publish a package.

Windows installers support application updates; beta installers consume beta update metadata. Portable builds are replaced manually. The optional scheduled silent-update setting is disabled by default and defers installation while tasks or unsaved edits remain. Packages are unsigned. Linux does not bundle the Windows local Whisper runtime.

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

每次提交都必须在 `CHANGELOG.md` 记录实际更新点：平时写入 `Unreleased`，发布前整理到带日期的目标版本中。使用明确的中文描述问题和改进后的行为，提交正文同时记录相关验证结果；不要仅写“修复若干问题”或将尚未执行的安装验证写成通过。

GitHub Release 与应用更新窗口共用该版本的说明。`electron-before-build.cjs` 调用 `prepareBuildReleaseNotes()` 生成 `desktop/build/release-notes.md`，electron-builder 的 `releaseInfo.releaseNotesFile` 将内容写入更新 YAML；生成文件不提交到 Git。Beta 更新器使用 generic feed，不能只依赖 GitHub Release 正文。

`verify-windows-update-artifacts.mjs` 必须验证更新 YAML 的 `releaseNotes` 非空并与目标 CHANGELOG 版本完全一致。不得为了完成发布而跳过更新说明检查。此规范适用于之后所有提交和 beta/stable 发布。

## GitHub Actions packaging

Never build release packages locally, including in a separate worktree. Push the reviewed commit and tag; GitHub Actions alone builds, verifies and publishes artifacts. The commands below describe CI steps, not local release instructions.

```powershell
npm ci
npm run dist:win:preview  # beta
# npm run dist:win       # stable Windows
# npm run dist:linux     # stable Linux, on a Linux build machine
npm run verify:package
npm run licenses:package:check
node scripts/verify-windows-update-artifacts.mjs desktop/release v0.4.41-beta.8
node scripts/smoke-test-portable.mjs desktop/release/win-unpacked/Piora.exe --expected-version v0.4.41-beta.8 --packaged-runtime
```

The staging script validates standalone output and matching static assets. Packaging archives the web runtime into `resources/web/runtime.asar`; native dependencies needing real paths, including the complete node-pty module and ConPTY helpers, live in the adjacent unpacked tree. Do not manually rearrange native binaries or reuse stale `.next` output.

`verify:package` copies the packaged service to an isolated location and checks desktop authentication, authenticated root/health responses, Pi sessions, external package/extension/Skill discovery, packaged terminal support and license material. It uses packaged Electron as the Node runtime when required. The after-pack step generates an exact package-copy manifest, CycloneDX SBOM and content-addressed license texts under `resources/licenses/third-party/`; these are separate from the broader source lockfile inventory.

The smoke script verifies the embedded application version, renderer and preload bridge in an isolated profile. Hosted Windows CI exercises the unpacked Electron payload because antivirus scanning can stall the portable wrapper. Final portable-wrapper behavior and actual upgrade/data retention should also be checked on a release machine.

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

Beta CI validates metadata, installs dependencies, runs source hygiene, licenses, lint, types, tests, backgrounds and performance budgets, then builds Windows packages. It checks updater metadata, package isolation, package licenses, the Electron runtime and installed application, creates checksums and notes, uploads artifacts, and only then creates the prerelease.

Stable CI first runs the Ubuntu source gate, builds Windows and Linux, verifies their runtimes and artifacts, combines checksums, and publishes only after both platforms succeed. Do not bypass a failed gate by manually uploading unverified binaries.

## Verify and report

- Confirm the Actions run belongs to the intended repository, tag and exact commit.
- Report queued, building, failed and published distinctly. A pushed tag is not proof of a successful release.
- If a gate fails, inspect that step's log, fix the source and use a new candidate version when the tagged source must change.
- After success, check the Release contains the expected package set and verify downloaded SHA-256 checksums.
- On clean machines, verify startup, model setup, image history reload, project selection, editing/conflicts, terminal, browser login, device control when hardware is available, and external extension loading.
- For installed updates, test download, busy/unsaved deferral, installation, restart and data retention. Verify portable replacement separately.
- Record the exact commit, run and Release URLs. Historical acceptance/design documents describe their own tested versions, not automatic proof for the new release.

See [README](../README.md), [desktop development](../desktop/README.md), [release checklist](open-source/LAUNCH_CHECKLIST.md) and [black-screen troubleshooting](open-source/BLACK_SCREEN_TROUBLESHOOTING.md).
