# Pi 1.0 migration assessment (2026-10-02)

The four direct Pi runtime packages can migrate together from 0.84.3 to exact 1.0.0. The release and npm tarballs are published, and both versions require Node >=22.19.0. The migration is technically viable with the changes below. Merge remains conditional on all required validation, including the existing security audit.

## Compatibility changes

- The shell agent uses `finishTurn` with `{ action: "end" }` instead of the removed `shouldStopAfterTurn`. The 30-step limit, three consecutive failures and cancellation protection remain enabled. Error/aborted responses retain the SDK's normal terminal handling.
- Prompt preflight uses the SDK's `started | queued | handled` dispositions. Only started input is eligible for model fallback continuation. Cancellation fences asynchronous admission and clears late queued input.
- SessionManager owns persisted history and the provider projection. Piora preserves original chat rows and entry IDs while accepting `context_edit` and usage metadata. Structured system/loadout messages are omitted from chat rows. SDK restore and `refreshContext()` govern provider-visible edits.
- Pi 1.0's system prompt state is read-only. Tool-free Piora sessions use the public `transformContext` hook to project an empty system/tool loadout, without rewriting canonical history. Provider streams receive a transcript with system entries, rather than separate `systemPrompt` and `tools` properties.
- Headless theme construction supplies the new muted fallback and keeps the new `style()` method plain text. Tool validation checks the SDK's JSON-only argument boundary before schema validation.
- Piora retains its explicit extension loader and `noExtensions: true`. It does not enable Pi's new built-in MCP, codemode or llama extensions alongside Piora's own integrations. Packaging still stages the complete coding-agent dependency closure because dynamically imported workers and QuickJS WASM are runtime assets. The isolation verifier requires these assets.

## Bundled dependency security and licenses

The published Pi 1.0 shrinkwrap contains brace-expansion 5.0.9 and Undici 8.10.2. Root npm overrides do not replace these bundled files. Postinstall replaces them with reviewed brace-expansion 5.0.12 and Undici 8.11.2. Exact source/target version guards, safe paths and idempotence remain intact; unexpected versions fail installation.

The runtime audit verifies installed replacement manifests and all file bytes against the reviewed root packages before auditing a temporary derived lock. No advisory is suppressed. License inventory and packaged license provenance record the new upstream version and actual patched runtime.

An independent current blocker is GHSA-86w9-cpqp-85rv in DevEco's node-forge dependency. The advisory covers <=1.4.0 and has no patched release; npm's latest node-forge is 1.4.0. Official DevEco CLI 1.3.4 still depends on node-forge ^1.4.0 through its common implementation package, so it does not solve this audit failure. The audit gate must stay enabled. DevEco is retained at 1.3.3 in this migration; its unrelated entrypoint migration is not mixed into Pi.

## Validation boundaries

Installed SDK acceptance tests exercise persistence/restore, canonical context edits, independent sessions, registered custom providers, structured provider transcripts, tool execution, streaming events, steering/follow-up queues, actionable turn-end entries, automatic threshold compaction and asynchronous input cancellation. These tests use a controlled model response stream; the lifecycle, extensions and SessionManager are the real installed SDK.

Targeted RPC/title/license regression, history/JSON regression, typecheck and lint pass locally. Existing shell acceptance covers the actual 30-step limit and repeated-failure protection. The full serial suite, live configured-provider checks and Windows/Linux CI results must be reported separately; a controlled provider test is not a claim of live model acceptance.

Local production/release builds are prohibited by AGENTS.md. Windows isolated packaged verification belongs to remote CI. This task does not publish a release or deploy Piora. The existing machine defects in mirror table parsing, initial PTY cd output and Chinese audio-device names are outside this migration.

## Sources and overlapping work

- [Pi 1.0.0 release](https://github.com/earendil-works/pi/releases/tag/v1.0.0) and its installed npm type declarations/runtime code.
- [Coding-agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/CHANGELOG.md) and [agent changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md).
- [Required lifecycle acceptance in older PR #60](https://github.com/kexijiang/Piora/pull/60#pullrequestreview-5073134158). That older PR targets 0.87.1 and is not merged by this work.
- [node-forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
- Existing #140 dependency group and #65 humanfs update remain separate. The new branch starts from main 9b6ff1198665da4d8497875f7d2205637ae292e9 and preserves the user's previous checkout.
