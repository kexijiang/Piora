# PR #367 dependency review (2026-11-09)

Reviewed initial head `e5402cda632bc8c3c9a8584093640f4988ae897d` against main
`a710777f487f69eb2a7e055b4390950f8cebf2e2`. No release or deployment is part of this PR.

## Source and compatibility

- All 59 lock entries whose version or resolved URL changed were compared with the
  exact version metadata from registry.npmjs.org. Name, version, SHA-512 integrity
  and declared license matched. Their tarball URLs are normalized to that official
  registry without changing integrity values. Signature presence was observed,
  not cryptographically verified. Fixed Dependabot's workspace declaration of
  Electron (`^45.2.3`) to match the manifest's exact `45.2.3` pin.
- [node-forge 1.4.2 to 1.4.3](https://github.com/digitalbazaar/forge/compare/v1.4.2...v1.4.3):
  `lib/rsa.js` is unchanged in upstream and in the installed artifact (SHA-256
  `6632e195295ce76f6bb9131ee770dcd6cc1ee4ffac7906302208b00faf95a87f`).
  Retained canonical DER verification and exact byte checking. New upstream fixes
  enforce X.509 name constraints, reject small-order Ed25519 keys, and fix TLS and
  HTTP denial-of-service cases. Existing valid/malformed RSA tests remain; added
  generated Ed25519 signature acceptance and identity-key forgery rejection.
- [Undici 8.12.3 to 8.12.4](https://github.com/nodejs/undici/compare/v8.12.3...v8.12.4):
  reviewed redirect/cache control, SRI ASCII whitespace parsing, HTTP/2 stream
  cleanup/replay and SQLite cache lock handling. Added real fetch/MockAgent SRI
  tests for five ASCII whitespace characters, valid SHA-256 and stronger invalid
  SHA-512; rejection must be specifically caused by integrity mismatch. Updated
  staged, bundled, audit and Pi effective-resolution checks together. Pi's original
  source commitment and historical upstream Undici version remain unchanged.
- Next.js and eslint-config-next 16.4.5 are synchronized security patches covering
  cache isolation, response forwarding, image optimization and Edge headers.
  [Release](https://github.com/vercel/next.js/releases/tag/v16.4.5).
- Mermaid 12.3.0 includes diagram fixes and DOMPurify 3.4.17. Existing strict
  security mode and disabled HTML labels are unchanged. Actual ELK lock is 0.12.1,
  not 0.12.0 mentioned in the upstream release notes. The additional GPL secondary
  option does not require selecting GPL: the existing EPL-2.0 option remains.
  Packaged NOTICE now provides exact corresponding source links; original license
  text remains in the generated package license bundle.
- Mediabunny 1.65.2 fixes fragmented MP4 keyframe metadata, packet lookup,
  conversion timestamp handling and AudioEncoder state. Owned-recording lifecycle
  and recovery regressions are included. Updated the previously stale MPL source
  notice to the exact 1.65.2 distribution; packaging still includes original src/.
- Playwright-core 1.65.0 includes route-handler waiting, clock real-timer and browser
  updates. Piora continues to use node:test, not the new Bun/test-runner features.
- Electron 45.2.3 contains Chromium/Node updates, upstream security backports,
  Wayland hidden-parent crash and CSS-removal fixes. Windows native and packaging
  verification must be supplied by CI, not inferred from Linux checks.
- Koffi 3.3.7 [changelog](https://koffi.dev/changelog) was checked against the
  installed package: call overhead, deferred allocator release, shutdown/reset and
  macOS ARM64 compiler changes; no public API migration. Native libc `abs(-123)`
  followed by unload passed on Linux.
- @lobehub/icons 6.15.0 mainly updates generated icons and Vue publication; Piora's
  React integration is unchanged. Turndown 7.2.5 improves string concatenation while
  retaining ES5 output. Typebox 1.4.4 strengthens IRI validation without changing
  the root API; no direct Piora IRI/Value.Mutate dependency was found.

## Verification

Linux x64, Node 24.22.1 (CI uses Node 22.19.0). Initial default-cache installation
failed because the cloud HOME cache was not writable. Reinstalled with an isolated
writable npm cache; rebuilt native dependencies with an isolated HOME and the
repository-specified, SHA-256-verified patchelf 0.19.2. Complete postinstall passed.

- Security, dependency patch/audit/license, direct-lock, release-hardening,
  Mermaid cache, owned-recording lifecycle and recovery tests: 82/82 passed.
- Pi source-profile and packaged verification unit tests: 11/11 passed, including
  actual isolated SDK/worker imports and effective Undici resolution. These are
  test fixtures, not a built release artifact.
- Changelog tests: 7/7 passed; fragment validation passed.
- Final dependency patch rerun after adding the previous 8.12.3 replacement case:
  14/14 passed (overlaps the earlier suite; not an independent additional total).
- Full ESLint passed with 0 errors and 11 existing warnings.
- Web and desktop typecheck, Harmony docs, hygiene, license inventory freshness,
  backgrounds and performance budgets passed.
- Runtime audit passed the high-severity gate: six moderate findings remain;
  no advisories were suppressed and no forced dependency downgrade was applied.
- Browser tests initially failed before execution because sandbox Chromium could
  not create its singleton socket. A permitted retry outside the execution sandbox
  hit the same host-level socket restriction. These browser checks remain blocked
  locally and must pass in CI; no launch or browser behavior is claimed as passed.

Full CI, Windows native paths and packaging remain required on the final pushed
head. No next build, local release package, deployment or physical-device action
was performed. CI results and any later checks are recorded in the PR follow-up.
