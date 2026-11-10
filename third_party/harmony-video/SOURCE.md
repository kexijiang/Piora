# HOScrcpy native video libraries

These unmodified ARM64 ELF libraries are extracted from the public HOScrcpy
1.0.18-beta distribution. Only the two selected Unix-socket capture libraries
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
