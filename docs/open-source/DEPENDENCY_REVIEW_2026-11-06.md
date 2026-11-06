# Dependency review — 2026-11-06

Scope: PR #339, initial head `1749c5008df53a6675ed4dcee0b59910c34a6f9d`, based on main `486f677ffb17a5abcdc02ca0d499268a3bb32a95`.

## Security patch migration

node-forge 1.4.2 includes the 1.4.1 canonical DER DigestInfo repair. Its RSA verifier re-encodes the parsed digest and compares the original bytes against the canonical encodings with or without the optional NULL parameter. This supersedes the local 1.4.0 extra-nested-element patch and additionally rejects noncanonical encodings. Version 1.4.2 restores PEM Buffer-input compatibility.

Postinstall now verifies the exact upstream version and `lib/rsa.js` SHA256 `6632e195295ce76f6bb9131ee770dcd6cc1ee4ffac7906302208b00faf95a87f`, without rewriting upstream code. Runtime audit verifies the official source and installed bytes, retains the real 1.4.2 version and no longer synthesizes 1.4.1-piora.1. Unknown versions, altered bytes and unreviewed sources still fail closed.

Regression coverage includes ordinary signatures, omitted/present NULL, additional nested elements, nonempty NULL, nonminimal DER length, trailing bytes, PEM Buffer input, idempotency and identity/source tampering.

Source: https://github.com/digitalbazaar/forge/blob/v1.4.2/lib/rsa.js

## Provenance and licensing

All 95 mirror URLs introduced by the dependency resolution were checked against the exact official npm package/version metadata. Name, version and SHA512 integrity matched; declared licenses were unchanged. Their URLs are normalized to the metadata's official tarball URLs without changing versions or integrity values. The existing npm configuration is unchanged. The license inventory is regenerated for 1269 unique packages. Registry signatures present in metadata were recorded during review, but no claim of separate cryptographic signature verification is made.

## Compatibility review

- Electron 45.2.1 stays within major 45 and updates Chromium; Windows packaging, native modules and isolated service checks remain required in CI. https://github.com/electron/electron/releases/tag/v45.2.1
- Koffi 3.3.6 fixes callbacks/array memory behavior. Clipboard code uses load/func/proto/register/pointer and does not rely on array-object identity. Windows-specific FFI still needs Windows execution. https://koffi.dev/changelog
- Three r187 affects rendering/animation and removes old APIs. No identified use of the removed high-risk APIs was found; typechecking and companion tests do not independently prove visual correctness. https://github.com/mrdoob/three.js/releases/tag/r187
- Mediabunny 1.65 includes synchronization changes. Piora's recording path uses EncodedVideoPacketSource, StreamTarget and fastStart:false, rather than Conversion or audio encoding; recording/finalization/cancellation regressions remain relevant. https://github.com/Vanilagy/mediabunny/releases/tag/v1.65.0
- Typebox 1.4 shares composed subschema references. No explicit application mutation of these shared schema objects was identified. Pi's separate 1.3.27 installation follows its exact dependency pin. https://github.com/sinclairzx81/typebox/blob/main/changelog/1.4.0.md
- magic-string 1.4.5 is required by @tailwindcss/node 4.3.4's ^1.1.0 range, not an unexplained major-version substitution. https://github.com/tailwindlabs/tailwindcss/blob/v4.3.4/packages/@tailwindcss-node/package.json
- Next 16.4.4 explicitly does not include the subsequently scheduled November security release. Do not describe this PR as covering that later release; runtime audit is a separate gate. https://github.com/vercel/next.js/releases/tag/v16.4.4

Main subsequently advanced to `4ab5dcdd440dab6eb1c521e898179a09b0af3f28` (beta.4 metadata), and Dependabot refreshed the PR to `5ad1277c5d79070c1516c4150bdeb13b2b3316cf`. Repairs were reapplied without dropping those changes; affected metadata/license/build-fixture checks were repeated.

## Validation boundary

The original CI failed during dependency installation on the old node-forge guard: https://github.com/kexijiang/Piora/actions/runs/42141977343. Test/quality results for repaired code are recorded in the repair commit and PR. Initial cloud installation attempts failed because npm/node-gyp default caches were outside the writable workspace; these failures are not passing tests. Local checks use Linux and Node 24.22.1, while CI uses Node 22.19.0. No release package, real-device acceptance, real-model acceptance or deployment is performed. Merge requires complete required CI for the final exact head.

Local results (Linux, Node 24.22.1): locked `npm ci` with writable npm/node-gyp caches and pinned patchelf 0.19.2 passed; worker and desktop test-fixture compilation passed. The 18-file focused batch passed 128/128 with zero skips, covering the patch/audit, Pi SDK/Typebox/MCP, recording, clipboard and companion paths. `npm run lint` passed with nine pre-existing warnings; `npm run typecheck`, `npm run audit:runtime`, `npm run perf:check`, `npm run verify:hygiene`, `npm run licenses:check`, Harmony documentation checks and background verification passed. The runtime audit retained moderate findings and did not waive them.

`node scripts/diagnose-sharp-electron.mjs` passed all three patched Node/Electron/ASAR probes; the intentionally restored upstream Electron baseline produced GLib warnings and correctly failed its baseline probes. A separate Electron-as-Node Koffi libc getpid/unload probe passed; this is Linux FFI evidence, not Windows clipboard acceptance. Initial smoke-command mistakes (binary not yet downloaded and a nonexported package.json lookup) were corrected before the successful run.

After the beta.4-only synchronization, rebuilt both fixtures and reran patch/audit/license/builder-metadata/Harmony-packaging regressions: 41/41 passed with zero skips. Audit, license freshness and hygiene were repeated for the synchronized tree. The earlier 128-test batch and this 41-test batch overlap and must not be summed. Full Windows CI and packaging checks are intentionally left to the existing required GitHub workflow under the current AGENTS.md development-validation rules; no test assertion or CI gate was weakened.
