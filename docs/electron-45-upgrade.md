# Electron 45 compatibility review

The desktop workspace and lockfile pin `45.0.0`. The npm artifact uses the official registry and the existing integrity hash.

Reviewed upstream: [Electron 45](https://www.electronjs.org/blog/electron-45-0) and [breaking changes](https://www.electronjs.org/docs/latest/breaking-changes#breaking-api-changes-450).

- The sandboxed preload imports only `electron` at runtime. It does not depend on removed Node shims, `Buffer`, or immediate timers. The new regression executes the compiled production preload without those capabilities and verifies IPC subscription cleanup and event isolation.
- Renderer sandboxing and context isolation remain enabled; Node integration remains disabled. No subframe worker integration or DevTools extension preload behavior is required.
- Piora has no `getDisplayMedia` or legacy desktop-source capture flow. `display-capture`, camera and unknown permissions remain denied; same-origin main-frame microphone access is still supported. The regression calls both production permission handlers.
- Cookie/proxy encryption still uses the supported synchronous safeStorage API; its announced removal in Electron 46 requires a separate async migration before that upgrade.
- Browser windows and popups are already sandboxed; the changed unsandboxed-opener relationship does not apply. No storage-access-for API is used. ASAR reads stay within Node fs; physical integrity checks use original-fs, and no archive descriptor is passed to native code or child stdio.
- No removed heap-profiling or legacy tracing APIs are used. Linux sharp/libvips symbol isolation is retained; `scripts/diagnose-sharp-electron.mjs` must test the pinned runtime with loose files and ASAR fixtures.

Real Electron renderer/browser checks and Windows package checks remain CI gates. The preload VM test does not replace them. No release package is built locally.
