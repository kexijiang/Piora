# HOScrcpy native video libraries

These unmodified ARM64 ELF libraries are extracted from the public HOScrcpy
1.0.18-beta distribution. Only the three selected Unix-socket capture libraries
are included; Piora does not run or distribute the Java bridge.

- Upstream: https://gitcode.com/OpenHarmonyToolkitsPlaza/HOScrcpy
- Fixed public distribution mirror: `ns-zzj/dsh-hos-scrcpy` commit
  `0b327aeac7a3280d043825addbffb1d594807000`,
  `resources/hosScrcpy-1.0.18-beta.jar`.
- The exact archive and extracted file hashes are recorded in `manifest.json`.
- License: MIT, copied verbatim from upstream commit
  `cf6603b38586d457801ee93203e1a09a846b943e`. The upstream copyright line contains
  unfilled template placeholders; those are preserved rather than replaced with
  an invented attribution. The mirror also records this in its third-party notice.

The 6.5 and 6.6 libraries extend the older libraries in hypium-driver. Filename
selection is a candidate choice, not proof of device ABI compatibility. Piora
reports a matching startup loader error if the selected library cannot load.

Both 6.6 builds are kept because they depend on different protobuf ABI symbols.
The 20260418 build is also byte-identical to the library in the locally installed
DevEco Studio `hosScrcpy-1.0.17-beta.jar`. Its distributable source remains the
same pinned public 1.0.18-beta archive above. The older build is attempted only
after a confirmed loader ABI failure, after checking that no owned video
process or foreign socket is still active. Device diagnostics are separate from
installed Piora acceptance results.
