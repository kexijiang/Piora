# Pi 1.0 migration assessment (2026-10-02)

The four direct Pi runtime packages migrate together from 0.84.3 to exact 1.0.2 (updated 2026-10-04). The release and npm tarballs are published, and both versions require Node >=22.19.0. The migration is technically viable with the changes below. Merge remains conditional on all required validation, including the existing security audit.

## Compatibility changes

- The shell agent uses `finishTurn` with `{ action: "end" }` instead of the removed `shouldStopAfterTurn`. The 30-step limit, three consecutive failures and cancellation protection remain enabled. Error/aborted responses retain the SDK's normal terminal handling.
- Shell pruning replays prefix system messages, retaining named sections and tool add/remove updates at the retained turn. First-request and pruned-continuation tests assert the actual provider-boundary prompt and tool definitions, rather than relying on scripted tool calls alone.
- Prompt preflight uses the SDK's `started | queued | handled` dispositions. Only started input is eligible for model fallback continuation. Cancellation fences asynchronous admission and clears late queued input.
- Independent `steer` and `follow_up` input hooks are tracked as writers. Stop remains pending until those hooks settle; a cancelled late admission is cleared before any new prompt can start. Handled input reports its disposition and does not enter the queue.
- SessionManager owns persisted history and the provider projection. Piora preserves original chat rows and entry IDs while accepting `context_edit` and usage metadata. Structured system/loadout messages are omitted from chat rows. SDK restore and `refreshContext()` govern provider-visible edits.
- Pi 1.0's system prompt state is read-only. Tool-free Piora sessions use the public `transformContext` hook to project an empty system/tool loadout, without rewriting canonical history. Provider streams receive a transcript with system entries, rather than separate `systemPrompt` and `tools` properties.
- Context estimates count effective system/tool state once. The cached session catalog matches Pi's global activity/mtime/filename ordering while retaining bounded reads and stable refreshes.
- Headless theme construction supplies the new muted fallback and keeps the new `style()` method plain text. Tool validation checks the SDK's JSON-only argument boundary before schema validation.
- Piora retains its explicit extension loader and `noExtensions: true`. It does not enable Pi's new built-in MCP, codemode or llama extensions alongside Piora's own integrations. Packaging still stages the complete coding-agent dependency closure because dynamically imported workers and QuickJS WASM are runtime assets. The isolation verifier requires these assets.

## Bundled dependency security and licenses

Pi 1.0.1 removes the published `npm-shrinkwrap.json` and nested bundled dependency tree. The 1.0.2 tarball also omits them. Its direct `brace-expansion` is 5.0.12, but `minimatch@10.2.6` can retain an older 5.0.9 from the previous lock. A scoped root override now pins that edge to 5.0.12; regeneration removes the stale nested entry. The four direct Pi packages and their shared runtime dependencies resolve to 1.0.2. The existing Undici root override remains exact 8.11.2 even though upstream coding-agent still declares 8.10.2.

Installed and isolated dependency-closure verification confirms top-level brace-expansion 5.0.12 and Undici 8.11.2. The coding-agent closure contains 121 package directories, including hoisted codemode, MCP, QuickJS WASM and Bedrock dependencies. One complete Pi AI package (842 files) matches source bytes, and 148 provider/auth modules load without credentials or model requests. Packaging now requires the hoisted paths, verifies every source-present legacy AI copy, rejects source-absent packaged copies, and resolves the provider module surface from the effective installed layout.

The directory patcher retains its accepted-version sets, including the reviewed 8.10.2 to 8.11.2 replacement. A missing nested copy now still validates the exact root source manifest. The audit retains legacy byte-for-byte replacement checks and additionally validates hoisted manifests, rejecting untracked nested copies. License inventory is regenerated from the actual lock, not hand-edited to disguise the new layout.

**Embedded bundle blocker:** the official build script bundles dependencies with esbuild and does not externalize Undici. The v1.0.2 upstream lock pins Undici 8.10.2. The published `dist/bundle/chunks/chunk-ZSBPJAJ2.js` contains 110 Undici module wrappers. Those compiled bytes remain in the staged closure and cannot be changed by npm root overrides or the existing directory patcher. The ordinary unbundled SDK resolves the reviewed root Undici; this does not certify every shipped compiled byte. Runtime audit and packaged dependency verification now fail closed on unverified embedded Undici. No embedded version is relabeled, no unreviewed source backport is attempted, and no security gate is removed. Adoption is prepared in the existing draft PR; merge/release remains deferred until the embedded code has verified safe provenance or a separately reviewed remedy.

Independent blockers remain [node-forge GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) (official npm latest 1.4.0; no patched release) and [braces GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (official npm latest 3.0.3; no patched release). Full dependency audit also reports the unchanged development-only http-cache-semantics 4.2.0 advisory; unrelated desktop tooling upgrades are deferred. No node-forge experimental patch or alternate test route is attempted in this update. DevEco remains 1.3.3; other open dependency work (#144, #65 and superseded #60) is not merged into this PR.

## Patch assessment (2026-10-04)

- Adopt 1.0.1's bounded codemode output, Bedrock transcript fixes and overridable npm dependency layout.
- Adopt 1.0.2's optional sampling-by-thinking-level support together with the synchronized Pi packages. It does not require changing Piora's own model settings UI.
- Preserve canonical system/tool transcript state, Stop cancellation fencing for asynchronous steer/follow-up writers, and external post-settlement assertions in migration acceptance.
- Merge main `a3f2ade390af778846ac978b336891b3867f94c9` into the existing PR142 lineage at `54e9bdf7e95081b627c452adb3c8b8c2909f575c`, retaining PR143's Next.js 16.3.8 root and website changes. Resolve changelog by retaining both histories and regenerate the license conflict.
- Use an independent worktree and a normal fast-forward push to PR142's existing branch. Do not create a duplicate PR, force-push, change protection/security settings, release or deploy.

## Current validation (2026-10-04)

- Pass: clean `npm ci`; exact installed Pi versions and dependency resolution; 145 initial targeted regressions; 41 final packaging/security/license regressions; 108 final combined installed-SDK/Shell/RPC/security regressions; typecheck; lint with two existing warnings; Harmony worker and desktop code compilation; license freshness, hygiene, Harmony docs, performance and background checks.
- Pass within scope: isolated dependency-closure copy, complete Pi AI byte comparison and credential-free provider module loading. [Recorded package evidence](PI_1_0_2_DEPENDENCY_EVIDENCE_2026-10-04.json) includes lock integrity, source package identities and embedded chunk hash.
- Fail: `audit:runtime` reports node-forge plus unverified embedded Undici. Full `npm audit` reports eight high-severity package findings (node-forge/DevEco, braces and its tooling dependants, and http-cache-semantics). Neither audit is waived.
- Complete local suite is being evaluated separately and is not claimed as passed; its results and exact-head CI are recorded in PR142. The environment's Playwright browser download returns HTTP 403; system Chromium 151.0.7922.173 is available for independent browser checks. Environment permissions and missing browser resources have already caused failures in the initial run.
- Not run: live-model acceptance (prior credential failure remains unresolved); local production/release packaging prohibited by AGENTS.md; hardware acceptance outside this migration. Remote Windows build/isolated application acceptance must be assessed at the exact pushed commit, never copied from the older successful artifact checks.

## Validation boundaries

Installed SDK acceptance tests exercise persistence/restore, canonical context edits, independent sessions, registered custom providers, structured provider transcripts, tool execution, streaming events, steering/follow-up queues, actionable turn-end entries, automatic threshold compaction and asynchronous input cancellation. These tests use a controlled model response stream; the lifecycle, extensions and SessionManager are the real installed SDK.

Historical 1.0.0 evidence: targeted RPC/title/license regression, history/JSON regression, typecheck and lint passed locally. Review fixes pass 63 combined lifecycle/Shell/RPC/context checks, including actual 30-step and repeated-failure protection. The initial local full run reported 2,294 passed, two failed and six skipped: the SDK discovery-order difference was reproduced on Windows/Linux CI and fixed; the Room syntax-highlighting wait timeout passed its independent recheck without changing assertions. A final-head full run and CI are still required. Live-provider acceptance is unavailable; no authentication/account diagnostics are published here. A controlled provider test is not a claim of live model acceptance.

Local production/release builds are prohibited by AGENTS.md. Windows isolated packaged verification belongs to remote CI. This task does not publish a release or deploy Piora. The existing machine defects in mirror table parsing, initial PTY cd output and Chinese audio-device names are outside this migration.

## Sources and overlapping work

- [Pi 1.0.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0) and its installed npm type declarations/runtime code.
- [Coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md) and [agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md).
- [Required lifecycle acceptance in older PR #60](https://github.com/kexijiang/Piora/pull/60#pullrequestreview-5073134158). That older PR targets 0.87.1 and is not merged by this work.
- [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
- Existing #144 dependency group and #65 humanfs update remain separate; #60 is the older Pi direction. This update continues PR142 and preserves the original checkout.
- [Pi 1.0.1 release](https://github.com/earendil-works/pi/releases/tag/v1.0.1), [Pi 1.0.2 release](https://github.com/earendil-works/pi/releases/tag/v1.0.2), [official bundle builder](https://github.com/earendil-works/pi/blob/v1.0.2/scripts/build-coding-agent-bundle.mjs), [upstream package lock](https://github.com/earendil-works/pi/blob/v1.0.2/package-lock.json), and the integrity-locked npm tarballs.
