# Dependency compatibility review — 2026-09-30

Reviewed against main `0e6fc8e33dbfc08e1c43b345a931ade1f3ec17f3` in an independent clean checkout. The original local checkout was clean and was left untouched. Versions below are installed lockfile versions, rather than only manifest ranges. The website is present, independently installed, and included in this review.

## Applied updates

| Component | Before | After | Compatibility decision |
| --- | --- | --- | --- |
| Electron (desktop workspace/root lock) | 43.4.0 | 43.7.7 | Stable fixes within the existing major; avoids the 44.x migration. Windows packaging and isolated application verification remain CI checks. |
| Next.js / eslint-config-next (root and website) | 16.3.3 | 16.3.7 | Matching patch versions; no application/router migration. |
| PostCSS (root) | 8.5.26 | 8.5.28 | Patch update within the existing 8.x toolchain. |
| Undici (runtime and Pi bundled replacement) | 8.9.0 | 8.11.2 | Security and HTTP/WebSocket fixes; satisfies the existing Node 22.19+ requirement. |
| Undici (@electron/get) | 7.29.0 | 7.30.0 | Update within the dependency's supported 7.x range. |
| Undici (node-gyp) | 6.28.0 | 6.29.0 | Update within the dependency's supported 6.x range. |
| brace-expansion (runtime/Pi replacement) | 5.0.9 | 5.0.12 | Fix recursion/expansion denial of service; preserve the existing minimatch override. |
| brace-expansion (older build-tool branches) | 1.1.18 / 2.1.4 | 1.1.21 / 2.1.7 | Fixed releases within each existing major. |
| @humanfs/node / @humanfs/core | 0.16.7 / 0.19.1 | 0.16.8 / 0.19.2 | Filesystem patch fixes, including recursive-copy symlink handling. |
| fast-uri (root / website) | 3.1.7 / 3.1.6 | 3.1.8 / 3.1.8 | Patch fixes; no 4.x migration. |
| ip-address | 10.7.0 | 10.7.2 | Address parsing/diagnostic fixes within the current major. |
| Moment | 2.30.1 | 2.31.0 | Locale input/path validation fix; existing API retained. |
| fastq (transitive) | 1.20.1 | 1.20.3 | Refreshed within the existing filesystem-tool dependency range. |
| Axios (DevEco CLI) | 1.19.0 | 1.20.0 | Scoped override fixes HTTP/2, prototype-pollution and parsing issues while preserving the existing CLI entrypoint/layout. |
| Website @cloudflare/vite-plugin | 1.54.2 | 1.62.3 | Supported stable plugin update with Wrangler/worker types kept together. |
| Website Wrangler | 4.127.1 | 4.145.0 | Stable 4.x fixes for the active website's Cloudflare toolchain. |
| Website @cloudflare/workers-types | 5.20260830.1 | 5.20260930.2 | Required compatible peer of the updated toolchain. |

The website lock retains its peer dependency records. `npm ci --legacy-peer-deps=false` explicitly overrides the root `.npmrc`, so this independent project validates peer compatibility rather than silently dropping peers. Its existing Vinext beta, Vite 8.2.2, React 19.2.8 and react-server-dom-webpack 19.2.8 remain together.

## Bundled dependency safety and auditing

Pi 0.84.3 ships a shrinkwrap and embedded dependencies. Root overrides do not replace these files. The existing postinstall patcher still checks the package name, exact reviewed source/target versions, safe paths, and idempotence. It replaces the complete package directory; old Undici files cannot survive the replacement. The license bundle records both the upstream locked version and the final installed version.

The refreshed lock reflects the published Pi tarball's embedded brace-expansion 5.0.9 and Undici 8.9.0 (the older lock recorded 5.0.7 and 8.5.0). Postinstall replaces them with 5.0.12 and 8.11.2. A plain `npm audit` reads those pre-postinstall records and therefore reports obsolete embedded versions. `npm run audit:runtime` first verifies exact reviewed identities, the official registry source and lock integrity metadata, and byte-for-byte equality of every source/target file. It then audits a temporary derived lock describing the actual installed replacements. The canonical lock is unchanged and **no advisory is suppressed**. Unexpected versions, unpatched packages, extra/modified files, symlinks and special filesystem entries fail the check. New advisories affecting the final versions remain visible.

Regression tests cover unreviewed versions, separate packaging source roots, idempotence, removed old files, license provenance, unpatched runtime packages and same-version file tampering. Existing Electron-builder collector and node-pty patches retain their original strict version guards.

Windows CI successfully built the upgraded Electron application, then exposed stale version assertions in the packaged Pi verifier. Those assertions now require brace-expansion 5.0.12 and Undici 8.11.2. Regression fixtures exercise the actual verifier, accepting reviewed packages and rejecting previous versions, incorrect identities and missing manifests; the packaging gate remains strict.

## Updates deliberately retained for separate work

| Component | Current / available | Reason |
| --- | --- | --- |
| Pi agent/AI/coding-agent | 0.84.3 / 0.99.1 (older PR #60 targets 0.87.1) | Even 0.87.1 changes `shouldStopAfterTurn` to `finishTurn`, makes SessionManager authoritative for provider context, and changes context-edit/turn-end/ProviderStreams contracts. Current shell code depends on the old callback to enforce 30 steps and three repeated failures. Session restore, compression, providers and extensions require migration and actual termination/queue/automatic-compaction acceptance requested in #60. CI alone cannot establish that compatibility. |
| React / server-dom-webpack | 19.2.8 / 19.3.0 | Coordinate rendering/runtime migration with the separate Vinext beta website rather than mixing it into security patch maintenance. |
| KaTeX / iconv-lite / Three | 0.16.47 / 0.18.9; 0.6.3 / 0.7.3; 0.185.1 / 0.186.1 | Minor changes before 1.0 can change API/behavior; math output, Harmony encoding and rendering require dedicated coverage. |
| koffi / DevEco CLI | 3.2.1 / 3.3.2; 1.3.3 / 1.3.4 | Native clipboard/ABI needs Windows acceptance. CLI 1.3.4 replaces `dist/cli.js` with a root wrapper and optional implementation packages, breaking the application's direct entrypoint and package verifier. Retain 1.3.3 and scope its Axios security update separately. |
| TypeScript / ESLint / @electron/asar | 5.9.3 / 7.0.2; 9.x / 10.x; 3.4.1 / 4.3.1 | Major compiler/lint/packaging migrations, not automatic lock refreshes. |
| GitHub checkout / setup-node actions | v4.2.2 / v7.0.1; v4.4.0 / v7.0.0 | SHA-pinned actions still work on hosted runners, which report forced Node 24 execution. Major action/runner/cache changes require a separate review including the optional self-hosted Harmony runner. The deprecation warning is retained and disclosed. |
| node-pty / electron-builder | 1.1.0 / 26.15.3 | Required local ConPTY shutdown and dependency-collector patches are version guarded. Preserve reviewed compatibility until a replacement is evaluated. |
| Mediabunny | 1.60.0 / 1.61.0 | Used by Harmony recording; real media/device validation and source-license provenance need a separate update. |
| sherpa-onnx | 1.13.6 / 1.13.8 | Active SenseVoice speech runtime; binary checksums, ONNX runtime and real voice-path acceptance are coupled. |
| whisper.cpp | 1.9.2 / 1.9.4 | Preparation script is unreferenced by active build/package scripts; retained legacy tooling, not the active SenseVoice path. |

Other non-security updates were identified but retained to keep this change focused: CodeMirror commands/state/view, Lezer common, Tabler icons, MCP SDK, JSZip, Mammoth, OpenCC, Playwright and ws. Their availability is not a statement that all direct dependencies are current. @xmldom/xmldom 0.8.15 is already installed; the old open PR is not a reason to repeat or downgrade it. PowerShell 7.6.6 is already current.

## Embedded and forked upstream projects

- `agegr/pi-web` was fetched and recent changes reviewed. Commit `f5e768e` bounds Stop/timeouts when a detached descendant retains output handles; `9ede521` restores forced cleanup when upstream idle shutdown is disabled. Piora has its own abort generation/queued-message cleanup and idle timer implementation; no unreviewed merge is applied. Upstream's newer Pi lifecycle and expanded symlink-folder access also require deliberate adaptation to Piora's session and filesystem boundaries.
- `react-screenshots` reviewed snapshot `db3f8dd69b1aa9e1d3ea7ee5fa950ced1a436803` and OpenPetsKit `d57f8b4b7312fb15cc123e76a3b9ac1bdedf4ad3` match their upstream heads.
- OpenPets application snapshot `6855f9daa95dcdb19fe6caf6b0a28e2e578bb5e0` matches upstream main. The separate catalog/assets commit `6c8187c4b67d4e27c6e4e573530bd74b5e998c75` cannot currently be resolved by the upstream compare API (404); retained licensed assets are not replaced on that basis.
- Codex's adapted pet files were compared individually against snapshot `775fb21d2af9b9936618fe22dd62e6f0cb3ba4a3`. `model.rs` and `asset_pack.rs` have identical Git blob SHAs; `catalog.rs` differs only in Rust test fixture generation/caching, not production catalog content. No Rust runtime or upstream binary is integrated, and no adaptation update is needed for those changes.

## Verification and remaining acceptance

Local baseline: root installation, lint, typecheck, 17 security tests and 334 Harmony/RPC/session/shell tests passed; one symlink-permission test skipped. Website lint/typecheck and three tests passed. Lint has two existing script warnings, retained unchanged.

Upgrade checks: clean root/website installation; root lint/typecheck; 40 security/license/audit regression tests (one symlink-permission skip); license inventory, repository hygiene, Harmony schema/docs, background hashes and performance budgets; website lint/typecheck and three tests all passed. Production runtime audit and website audit returned zero vulnerabilities. Full suite and CI results are recorded in the pull request so results correspond to its exact head SHA.

Additional final checks: 330 upgraded Harmony/RPC/session/Shell integration tests passed with one permission skip, including the real Agent loop's 30-step guard. The first CI head passed all six OS/shards and Windows Shell resource checks, but Linux quality audit caught the DevEco/Axios vulnerability; the scoped Axios fix addresses it. CLI `--version`/`--help`, actual CLI-resolved Axios HTTP/cancellation, Harmony checking and release-hardening checks passed (14 passed, one permission skip). Final runtime and effective all-dependency audits both returned zero vulnerabilities. A local full-suite attempt did not finish after an Electron test; it is not recorded as a passing full run. Final CI is the full-suite/packaging authority.

No local production build or release packaging was run, following AGENTS.md. CI performs the website static build and Windows unpacked packaging/isolated verification. No release is published. Harmony real voice path, signed test HAP, multiple devices/Wi-Fi and Pi's requested manual migration acceptance have not been verified here and are not claimed as passed.

## Official evidence

- [Electron 43.7.7](https://github.com/electron/electron/releases/tag/v43.7.7), [Next.js 16.3.7](https://github.com/vercel/next.js/releases/tag/v16.3.7).
- [Axios 1.20.0 security and compatibility notes](https://github.com/axios/axios/releases/tag/v1.20.0); DevEco CLI 1.3.4's official npm tarball was inspected without executing it.
- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) were identified and retained for separate runner migration.
- [Undici 8.11.2](https://github.com/nodejs/undici/releases/tag/v8.11.2), [7.30.0](https://github.com/nodejs/undici/releases/tag/v7.30.0), [6.29.0](https://github.com/nodejs/undici/releases/tag/v6.29.0), [brace-expansion security advisory](https://github.com/juliangruber/brace-expansion/security/advisories/GHSA-q2hr-2g5m-vwhr).
- [humanfs node 0.16.8](https://github.com/humanwhocodes/humanfs/releases/tag/node-v0.16.8), [fast-uri 3.1.8](https://github.com/fastify/fast-uri/releases/tag/v3.1.8), [Moment 2.31.0](https://github.com/moment/moment/releases/tag/2.31.0), [ip-address releases](https://github.com/beaugunderson/ip-address/releases).
- [Cloudflare Wrangler 4.145.0](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.145.0), [Vite plugin 1.62.3](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare%2Fvite-plugin%401.62.3).
- [Pi 0.87.1 coding-agent changes](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/CHANGELOG.md), [agent changes](https://github.com/earendil-works/pi/blob/v0.87.1/packages/agent/CHANGELOG.md), [current releases](https://github.com/earendil-works/pi/releases).
- Related existing PRs: [#137](https://github.com/kexijiang/Piora/pull/137), [#136](https://github.com/kexijiang/Piora/pull/136), [#131](https://github.com/kexijiang/Piora/pull/131), [#60 and requested acceptance](https://github.com/kexijiang/Piora/pull/60#pullrequestreview-5073134158). Their overlapping updates were independently reviewed; no existing PR was closed.
