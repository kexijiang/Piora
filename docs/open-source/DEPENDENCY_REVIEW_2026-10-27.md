# PR #227 dependency compatibility review

This review covers the grouped npm update on `46a863e9d5383d0206e43c9b2092c9d3e207729c`. It does not replace release packaging, browser acceptance, Windows CI, or physical Harmony device acceptance.

## electron-builder 26.18.0

- The official npm `app-builder-lib` tarball matches the existing lock's SHA-512 integrity. Its stock `templates/nsis/portable.nsi` retains the reviewed SHA-256 `80fa75cf8cb68f4999eb92afc9f37f8e5b605cb1c3a077821bbc350a9b907a48`; the existing portable override guard remains unchanged.
- The actual `out/util/appFileCopier.js` now exports `collectionMatchesAppDependencies` and `resolveFirstMatchingCollection`. It rejects a completely unrelated tree and continues after collector errors, but accepts **any one** matching direct external dependency. A root tree sharing `koffi` can still omit `electron-updater`; the upstream overlap check is not a full-closure guarantee. Unmatched nonempty trees also remain last-resort fallback candidates.
- Keep the narrow traversal-first correction rather than removing it as obsolete. The patch now accepts only 26.18.0 and exact reviewed original/patched SHA-256 fingerprints. Disk-based fixtures execute the installed npm and traversal collectors, exercise root overlap and fallback, and compare the complete fixture closure including transitive/optional dependencies while excluding web/dev-only packages. These tests do not perform local release packaging.
- The desktop lockfile requirement is exact `26.18.0`, matching `desktop/package.json`, rather than a caret range. Official-registry artifact URL normalization changes no package versions, dependency graph, or integrity values.

## DevEco CLI 1.3.9

- Integrity-verified official `@deveco/deveco-cli-common` tarballs were compared with 1.3.6. The wrapper/common platform split remains; common now directly requests Axios 1.20.0 rather than 1.19.0. Keep the project-wide Axios 1.20.0 override and the node-forge 1.4.0 RSA DigestAlgorithm patch and fingerprint; a dependency update does not supersede that local security fix.
- The upstream README changes describe safer non-forced skill installation, broader agent recognition, and device API restrictions. Piora's used `serve mcp`, `check lint`, and `signature generate` interfaces remain present. CLI help/version and isolated copied production-closure tests cover local launch/resolution, not real SDK signing or device behavior.
- Packaged verification continues resolving dependencies from the actual common implementation in a fresh child with empty `NODE_PATH`, checking both exact manifests, Axios, node-forge, RSA bytes, and actual CLI `--version`. It also rejects an unpatched nested forge copy that could shadow the secure root package.

## gRPC-js 1.14.6

- The [official release](https://github.com/grpc/grpc-node/releases/tag/%40grpc%2Fgrpc-js%401.14.6) completes additional [GHSA-f596-whhp-79r4](https://github.com/grpc/grpc-node/security/advisories/GHSA-f596-whhp-79r4) error-detail redaction paths. Review of the official, lock-integrity-verified tarball confirms request deserialization and response serialization return generic errors by default instead of internal exception text.
- Regression tests use Hypium's actual resolved transport for unary metadata, cancellation, and both codec failure paths. Video-session tests exercise the existing Hypium-generated gRPC service; no physical device result is implied.

## electron-updater 6.8.11

- Compared integrity-verified official 6.8.9 and 6.8.11 tarballs. The public `downloadUpdate()` API still returns file-path arrays, while internal download results are now objects. The update removes stale blockmaps, validates cache filenames, and improves multipart range parsing. Piora does not call the changed internal result API.
- New tests execute the installed cache helper against real files (valid cache, changed bytes, malformed/path-traversal metadata) and the installed `AppUpdater` concurrent-download state machine with controlled transfer IO. They check public return shape and stale blockmap cleanup. Existing installed-provider tests retain branded channel and missing-channel behavior; actual Electron installer execution remains CI-only.

## Verification record

### Electron 45 combined graph on main fa7480d

The current prepared tree merges main `fa7480d1486e3ff2e6d2c520789bee5563a74a22` into published #227 head `d6640107c23c520e4f9ad4f056a49c8cfafe9e83`. Before adopting that published head, its complete tree was verified identical to the locally tested tree; a fresh fetch confirmed the remote head. Main adds Electron 45.0.0 and its compatibility review/tests. Semantic conflict resolution preserves the prior #227 graph except for main's exact Electron requirement and Electron package record. Builder 26.18.0, all grouped upgrades, official URLs and security guards remain intact. The main implementation/tests/docs and prior #227 source fixes were checked byte-for-byte, and an independent review confirmed graph, changelog and source preservation. Licenses were regenerated for the final lockfile (1,379 unique packages).

Because Electron changed, this checkpoint uses a new locked install and a fresh applicable aggregate rather than inheriting the prior graph's results:

- Linux x64, Node.js 22.19.0; isolated writable HOME/cache, inherited agent-directory and XDG state/config/data overrides unset. `npm ci --registry=https://registry.npmjs.org/` passed (1,319 packages, 27 seconds), including the guarded dependency/native patches and Pi 1.4.0 source verification. Worker/desktop fixtures were rebuilt.
- **573 complete applicable files: 3,046 tests, 3,031 passed, zero failed, 15 skipped**, serially in 348.3 seconds. No resource-skip flag was set. The 15 skips remain 13 Windows/native-platform cases and two unavailable DevEco Studio compilation fixtures; they are not passes.
- Focused integration checks passed **69 tests across 14 files, zero skipped**, covering real builder collectors/fallback, updater cache/state behavior, gRPC redaction, actual isolated DevEco CLI closure, Harmony video/ownership, Pi alignment, and Electron 45 preload/permission compatibility. The nested RightPanel regression is included. The feasible mixed-file cookie case separately passed **1/1**.
- Native diagnostics executed the actual **Electron 45.0.0 binary** (embedded Node 24.22.0). All three patched Node/Electron loose-file/Electron ASAR image probes passed. The two unpatched Electron baselines reproduced the expected GLib issue. The preload/permission VM regressions and native Node-mode probes do not replace real renderer or Windows acceptance.
- Full typecheck/lint, Harmony docs, hygiene, licenses, performance budgets, backgrounds and runtime audit passed again. Lint has zero errors and the same two existing clipboard-script warnings; runtime audit reports zero vulnerabilities and verifies the Pi/forge boundaries.

The 78 browser-dependent files below remain deferred under the explicit local-browser exception. No local Next.js production build or release package was run, and unchanged website checks were not repeated. Earlier CI or local results are historical evidence only; the next exact commit still requires its own successful mandatory CI before merging.

### UI-only main synchronization to 5d51b7f

The preceding prepared checkpoint incorporated main `5d51b7f5ac651271607a155389bdcb1a653644d4`, adding the merged Mermaid preview/UI work. Its 18 changed paths contain no dependency manifests, lockfile or dependency patches. Before reconstructing the pending merge, the complete prior staged tree and dependency delta were backed up. All 18 non-changelog #227 blobs, including the exact manifests, lockfile and license inventory, and all 17 non-changelog advanced-main blobs were verified byte-for-byte; both sets of changelog notes remained. Only this review record was subsequently extended.

On this synchronized tree, **192 tests across 31 affected files passed, zero failures/skips**. The selection covers Mermaid geometry helpers/static rendering, Markdown and message rendering, chat history/scroll/process views, desktop styles, themes/locales, actual builder collection/fallback, updater/gRPC security behavior, isolated DevEco CLI closure, and Pi dependency alignment. Worker/desktop fixtures, full typecheck/lint, Harmony docs, hygiene, licenses, performance budgets, backgrounds and runtime audit all passed again; lint has the same two existing warnings and the audit reports zero vulnerabilities.

No new install or full aggregate was needed for that UI-only synchronization: its unchanged dependency graph retained the fresh 7354bb7 aggregate and native-diagnostic evidence below, while affected behavior was rerun explicitly. This is **not** a claim of another full-suite run at that checkpoint. Its CI file selection had 572 nonbrowser files and 78 browser-dependent files; the new nonbrowser Mermaid helper was covered by the scoped rerun. The new `components/MermaidBlock.browser.test.mjs` requires a real browser throughout and joined the local deferral list below. Final-head CI remained mandatory under the same explicit exception.

### Combined dependency graph on main 7354bb7

The dependency-graph checkpoint incorporated main `7354bb78b60473ed41925251bde40683e0a4a219`, including the merged Pi 1.4.0 upgrade. The prior complete staged tree and independent fixes were backed up before reconstructing the pending merge. Manifest/lock conflicts were resolved by a semantic three-way merge: the resulting graph is exactly the prior reviewed #227 graph plus main's five direct Pi requirements, seven Pi package entries, and `marked-cjk-friendly` entry. Official URLs, existing integrity values, the exact builder pin, all prior dependency fixes, and main's source certificate/tests were preserved. The license inventory was regenerated for the final lockfile and contains 1,379 unique packages. An independent read-only review confirmed these preservation checks.

Because this synchronization changes shared runtime dependencies, the earlier results below were **not** reused as proof for the combined graph. Fresh Linux x64 / Node.js 22.19.0 validation used an isolated writable HOME, with inherited `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `PI_CODING_AGENT_DIR`, and `PIORA_DESKTOP_DATA_DIR` unset:

- A new `npm ci --registry=https://registry.npmjs.org/` passed, installing 1,319 packages and applying the guarded builder, forge, native-image and Pi source-profile patches. Pi 1.4.0's 1,013 source files and effective Undici 8.12.3 were verified.
- Worker/desktop test fixtures were rebuilt with `npm run pretest`. Focused integration checks passed **89 tests across 17 files, zero failures/skips**, including Pi compaction, isolated source closure/launchers and version alignment, real builder collectors, actual DevEco CLI closure, updater/gRPC behavior, Harmony shared video/ownership, and the nested RightPanel regression.
- A fresh serial applicable aggregate (`node --test --test-concurrency=1`) ran all **571 complete nonbrowser files** from the current CI selection: **3,041 tests, 3,026 passed, zero failed, 15 skipped**, in 340.2 seconds. No resource-skip flag was set. The companion route cases passed within this same aggregate. The 15 skips are platform-specific native/Windows checks and two unavailable DevEco Studio compilation fixtures; none is counted as passed.
- The feasible cookie recovery case in the otherwise browser-dependent file was rerun separately with the exact name pattern recorded below: **1 passed, zero skipped**. The 77 audited browser-dependent files remain deferred to final-head CI under the explicit exception; this is not a claim that the complete browser/Windows suite passed locally.
- Full typecheck and lint passed (zero lint errors, the same two pre-existing clipboard-script warnings). Harmony docs, hygiene, the regenerated license check, performance budgets, backgrounds, and runtime audit passed; the audit reported zero vulnerabilities and verified the Pi/forge security boundaries.
- Native image diagnostics again passed all three patched Node/Electron/directory-or-ASAR probes. The two unpatched Electron baseline probes reproduced the known GLib issue as expected.

The independent `website` subproject and its lockfile were unchanged, so its install/build was not rerun locally. No local Next.js production build or release package was created. Browser, Windows packaging, real SDK signing and physical-device acceptance remain distinct gates; required final-head CI must pass before merging.

### Earlier validation checkpoints

Local validation used Linux x64, Node.js 22.19.0, an isolated writable `HOME`, and the locked `npm ci` install. The initial aggregate source tree included main `d1324cfde43362373821c9fab4ec576de726e1c5` (#228, #229 and its preview workflow change); the later main synchronization and its scoped revalidation are recorded below. No local `next build` or release package build was run.

- `npm ci --registry=https://registry.npmjs.org/`: passed, including the reviewed builder/forge/native-image postinstall patches.
- `npm run pretest`: passed (Harmony worker and desktop test fixtures only).
- `npm run lint`: passed, zero errors; two existing warnings in clipboard scripts. `npm run typecheck`: passed.
- `npm run harmony:docs:check`, `npm run verify:hygiene`, `npm run licenses:check`, `npm run perf:check`, `npm run verify:backgrounds`: passed.
- `npm run audit:runtime`: zero vulnerabilities after verifying the Pi source profile and exact installed forge patch bytes.
- `node scripts/diagnose-sharp-electron.mjs`: all three patched Node/Electron/ASAR probes passed. The two unpatched Electron baseline probes reproduced the expected GLib issue; baseline failures are not patched-probe failures.
- Focused collector, dependency-patch, updater, gRPC, DevEco HTTP and installed-provider tests: 27 passed, zero skipped. Their final versions were also included in the aggregate selection below.
- The serial 570-file applicable selection (`node --test --test-concurrency=1`, with no `PIORA_SKIP_RESOURCE_TESTS` setting) completed 3,031 tests: **3,014 passed, 2 failed, 15 skipped**. Both failures were in unchanged companion-pet route fixtures: an inherited explicit `PI_CODING_AGENT_DIR` overrode their per-test `PIORA_HOME` and deliberate missing-home conditions. Re-running `node --test lib/companion-pet-route.test.mjs` with that override unset and the isolated `HOME` retained passed all three tests without editing code or assertions. This is an initial aggregate plus a successful environment-corrected rerun, **not a single all-green aggregate**.
- The actual isolated DevEco 1.3.9 closure test passed in that aggregate, including `--version`, `check lint --help`, `serve mcp --help`, `signature generate --help`, and rejection of vulnerable nested Axios/unpatched forge copies.
- The only feasible nonbrowser case in the excluded cookie file passed separately: `node --test --test-name-pattern='^browser recovery snapshots only session cookies and serializes concurrent writes$' lib/browser-cookie-persistence.test.mjs` (1 passed, zero skipped).
- The 15 aggregate skips cover Windows-only/native-platform acceptance and two missing-DevEco-Studio fixture compilations; they are not counted as passed. The 77 browser-dependent files below are deferred to final-commit GitHub CI under the user's explicit cloud-browser exception. CI and Windows packaging gates remain unchanged, and merging still requires their successful final results.

### Main synchronization to 7481f3b

The previous prepared checkpoint incorporated main `7481f3b5d166a886b4eae2c0f67cd00f3e1e2317`. Before reconstructing the pending merge, the complete staged tree and an independent patch of the dependency fixes were backed up. All 16 non-changelog fix blobs and all 19 non-changelog advanced-main blobs were then verified byte-for-byte; the changelog preserves both sets of entries. That main synchronization changed no dependency manifests, lockfile, collector patch, native-image patch, or updater implementation.

After synchronization, the worker/desktop fixtures were rebuilt and **370 tests across 45 affected files passed with zero failures or skips**. The selection covers chat direct-process/history and command rows, AppShell/RightPanel, settings/search/locales, Harmony shared DevEco video/ownership/cleanup/recording/media, the actual Hypium gRPC transport, dependency collector/updater security cases, and the isolated DevEco CLI closure. The unchanged companion route fixtures also pass with the isolated HOME and inherited agent-directory override unset. No resource-skip flag was used.

Full `npm run typecheck` and `npm run lint` passed again (zero lint errors, the same two existing warnings). Harmony docs, licenses, performance budgets, backgrounds, runtime audit (zero vulnerabilities), and hygiene also passed again on this synchronized tree. The prior aggregate is retained as an initial aggregate plus environment-corrected rerun, not relabeled as a new full-suite pass. The changed `CompactProcess.browser` and `HarmonyPanel.browser` tests remain within the explicit browser deferral below; final-head CI still owns browser and Windows/package acceptance.

### Browser-dependent files deferred locally

Except for the explicitly tested cookie unit case above, no case in these files is counted as locally passed. The list was audited to retain feasible mocked/static tests and prerecorded-media tests in the applicable selection rather than excluding every file that mentions Playwright. The current fa7480d aggregate selected all 573 applicable complete files from the 651-file CI selection, including the added Pi compaction, Mermaid helper and Electron 45 regressions. The current 78-file browser deferral list includes the merged Mermaid browser regression.


- `components/AppShellSessionSelection.browser.test.mjs`
- `components/AutomationPanel.browser.test.mjs`
- `components/ChatCommands.browser.test.mjs`
- `components/ChatInput-layout.browser.test.mjs`
- `components/CompactProcess.browser.test.mjs`
- `components/CompactionProgress.browser.test.mjs`
- `components/FileChangeNavigation.browser.test.mjs`
- `components/FileSplitPreview.browser.test.mjs`
- `components/HarmonyMirror.browser.test.mjs`
- `components/HarmonyPanel.browser.test.mjs`
- `components/MermaidBlock.browser.test.mjs`
- `components/NativeMcpConfig.browser.test.mjs`
- `components/NestedToolCalls.browser.test.mjs`
- `components/QuickAccess.browser.test.mjs`
- `components/RoomMembers.browser.test.mjs`
- `components/RoomWorkspaceResize.browser.test.mjs`
- `components/SkillsConfig.browser.test.mjs`
- `lib/app-shell-navigation-browser.test.mjs`
- `lib/appearance-settings-browser.test.mjs`
- `lib/background-browser.test.mjs`
- `lib/browser-cookie-persistence.test.mjs`
- `lib/browser-mode-browser.test.mjs`
- `lib/browser-network-proxy.test.mjs`
- `lib/chat-bottom-browser.test.mjs`
- `lib/chat-command-flow.browser.test.mjs`
- `lib/chat-layout-browser.test.mjs`
- `lib/chat-send-scroll-browser.test.mjs`
- `lib/clipboard-click-browser.test.mjs`
- `lib/clipboard-drafts-browser.test.mjs`
- `lib/clipboard-image-browser.test.mjs`
- `lib/clipboard-layout-browser.test.mjs`
- `lib/clipboard-v2-browser.test.mjs`
- `lib/companion-bubble-browser.test.mjs`
- `lib/companion-tools-browser.test.mjs`
- `lib/composer-files-browser.test.mjs`
- `lib/composer-picker-browser.test.mjs`
- `lib/composer-send-browser.test.mjs`
- `lib/dictation-browser.test.mjs`
- `lib/dompurify-browser.test.mjs`
- `lib/file-tree-resize-browser.test.mjs`
- `lib/harmony-application-picker-browser.test.mjs`
- `lib/harmony-command-shortcuts-browser.test.mjs`
- `lib/harmony-database-export-jobs-browser.test.mjs`
- `lib/harmony-device-console-browser.test.mjs`
- `lib/harmony-device-database-jump-browser.test.mjs`
- `lib/harmony-device-file-drafts-browser.test.mjs`
- `lib/harmony-device-folder-tree-browser.test.mjs`
- `lib/harmony-device-terminal-browser.test.mjs`
- `lib/harmony-device-terminal-lifecycle-browser.test.mjs`
- `lib/harmony-log-viewer-browser.test.mjs`
- `lib/harmony-mirror-panel-browser.test.mjs`
- `lib/harmony-scenario-editor-browser.test.mjs`
- `lib/harmony-sqlite-viewer-browser.test.mjs`
- `lib/harmony-transfer-jobs-browser.test.mjs`
- `lib/harmony-workbench-tree-resize-browser.test.mjs`
- `lib/json-editor-browser.test.mjs`
- `lib/message-delete-browser.test.mjs`
- `lib/model-limits-browser.test.mjs`
- `lib/model-provider-save-browser.test.mjs`
- `lib/model-sampling-browser.test.mjs`
- `lib/models-config-browser.test.mjs`
- `lib/native-terminal-browser.test.mjs`
- `lib/prompt-recovery-browser.test.mjs`
- `lib/reply-suggestions-browser.test.mjs`
- `lib/room-message-layout-browser.test.mjs`
- `lib/runtime-error-retry-browser.test.mjs`
- `lib/runtime-error-screen-browser.test.mjs`
- `lib/session-history-browser.test.mjs`
- `lib/settings-loading-browser.test.mjs`
- `lib/shell-surface-browser.test.mjs`
- `lib/shell-ui.test.mjs`
- `lib/ssh-tabs-browser.test.mjs`
- `lib/task-status-browser.test.mjs`
- `lib/terminal-history-browser.test.mjs`
- `lib/terminal-surface-browser.test.mjs`
- `lib/transfer-station-browser.test.mjs`
- `lib/ui-performance-browser.test.mjs`
- `lib/user-input-browser.test.mjs`
