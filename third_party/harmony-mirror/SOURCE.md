# Piora ordinary-permission screen capture component

Native capture and loopback transport are derived from HongJing commit
`1d470ea8f571f19fcbb6883cc6118fafed6fe14f`, under the MIT license:
https://github.com/guoxiucai/ohos-scrcpy-app/tree/1d470ea8f571f19fcbb6883cc6118fafed6fe14f/scrcpy_server
See `LICENSE-HONGJING-MIT.txt` for the original copyright notice.

Piora changes use an ordinary `EntryAbility`, declare INTERNET and
KEEP_BACKGROUND_RUNNING for a system-notified screen-record task, and require
the normal system capture consent. The component binds only to the phone
loopback address and emits real H.264 encoded frames. It ignores device input
commands. Failed capture does not fall back to JPEG or fabricated frames.
Cancellation, interruption and encoder failure release their owned capture
epoch asynchronously and end the corresponding subscribers. Encoder surfaces
are replaced when display dimensions change; the bridge consumes frames while
the surface is temporarily detached and immediately presents its cached current
image after attachment, so rotation cannot leave a new encoder waiting forever.
The API-26 static-repeat timestamp correction uses the actual device clock;
new source frames return to the absolute source timeline.

The package keeps the existing `com.ohos.scrcpy.server` identity for the desktop
video protocol. Explicit initialization replaces that capture component; passive
viewing never installs or starts it. No upstream signing keys, certificates,
generated profiles, build output, or signed HAP are included in this editable
source directory.

Prepare a separate build workspace using:

```sh
node scripts/prepare-harmony-mirror.mjs <new-output-directory>
```

Configure signing in that separate workspace with DevEco Studio or the logged-in
DevEco CLI. `devecocli signature generate` creates local signing materials;
`devecocli build --build-mode debug --product default` builds a device test HAP.
Debug signing can be limited to registered devices and is not a public release
signature. Do not copy those private configuration files into this source tree.
These commands are for isolated development tests and do not create a release
artifact.

Piora release packages continue to be built in GitHub Actions. A beta tagged run
builds one public release-mode HAP that intentionally remains unsigned and binds
its exact bytes to the source manifest. From that same unsigned input, the
dedicated runner creates a separate private DevEco device-signed acceptance HAP,
verifies its application signature and profile with the API-26 SDK, and uses it
for the registered-phone gate. The private HAP and temporary verification files
are deleted after the gate and never uploaded or packaged. Only the public
unsigned HAP, its manifest, the non-secret receipt and a generated source note
cross into the desktop packaging job. Adding this source does not establish that
a beta tagged run or its final installed-desktop acceptance has passed.

The installed desktop verifies that receipt before doing anything with the public
HAP. Only explicit video-service initialization uses the user's private DevEco
configuration. When no explicit descriptor is configured, Piora copies this
project's metadata-only signing template into its private cache and invokes the
bundled DevEco CLI to generate or update the standard signing configuration for
the connected phone. It then signs a private local copy, verifies the result,
and installs it with ordinary `hdc install`. It never uses `-r`; an
incompatible installed component is removed and its absence checked first.
Missing local signing configuration or a profile that does not contain the phone
produces a configuration error before installation. Passive viewing never signs,
installs, starts, wakes or unlocks the phone.

The accepted device tests for source version 1.1.0 cover portrait native video,
20/45-second recordings, denial followed by explicit consent, and watching a
second owned application. They do not establish rotation support. An API-26
canvas-follow-rotation experiment kept the encoded surface at its original
dimensions and did not update the desktop image after physical rotation; that
experiment was removed. Rotation remains a separate device acceptance item.

Source version 1.1.3 preserves an existing consented capture for at most five
seconds when the last viewer disconnects. A reconnect cancels that cleanup;
an epoch prevents an obsolete timer from stopping a newer connection. The real
desktop/device test passed initial consent without a denial delay, two viewer
refreshes each observed for seven seconds, screenshots and a 20-second playable
recording. This version does not include the unaccepted canvas rotation probes.

The sustained-absence recovery test exposed another failure in 1.1.3: a timer
created for the old viewer could stop a new explicit capture request before its
consent dialog appeared. Source version 1.1.5 shares a presence guard between the
ability and phone page. An explicit request fences that timer and waits at most
30 seconds for its first viewer; once connected, the ordinary five-second
absence cleanup applies. It never requests consent or starts capture itself.
The timer regression checks and debug build pass. The actual Electron/USB device
round then passed two viewer refreshes, sustained panel absence with capture
stopped, a fresh normal consent dialog and native viewing restored, screenshots
and a playable 20-second recording. Cleanup confirmed both stop/uninstall and
the bundle's absence, with no page errors. Public signing, the distributed HAP,
rotation and sustained performance acceptance were still outstanding at that point.

The API-26 background comparison for isolated version 1.1.7 passed 120 actual
product-dispatched counter actions and 805.9 seconds of native viewing, followed
by a playable 20-second recording, screenshots and owned-app cleanup. This
crossed the roughly ten-minute failure point seen in three 1.1.5 runs, supporting
the background-task approach without proving the platform's exact failure cause.
Source version 1.1.8 starts its ordinary recording task only after the native
STARTED event. Explicit stop, viewer absence, native termination and ability
destruction release it; stale async results release their exact older task id.
System cancellation/suspension and task-start failures stop capture without an
automatic consent retry. The lifecycle regressions and isolated debug build
pass. Fresh acceptance with actual Piora Electron 43.7.7 and the USB API-26 phone
completed 3332.957 seconds of native viewing and 500 exact product-dispatched
counter readbacks, with no new compatible-frame polling. It also passed denial
and explicit recovery, two viewer refreshes, sustained absence and fresh consent,
screenshots, a playable 20-second recording and confirmed cleanup of both owned
apps, with no page errors. The accepted debug HAP SHA-256 is
`6d09a8161b5816d60dabb5200e71644064ba17224d88aab3b5171ad780e57fff`.
Public signing, the distributed HAP, rotation and installed-beta acceptance
remain outstanding. This source targets API 26; it does not establish support
on older phones.

The subsequent encoder-error cleanup stops the owning capture asynchronously
and closes its ended video connections. A no-op stop before capture resources
exist keeps viewers waiting for consent connected. After fixing that startup
boundary, private debug 1.1.14 passed real Electron/USB acceptance: first native
viewing and another foreground app worked, a real encoder input error stopped
capture, the desktop revoked the old live state and recovered compatible
observation with the failure reason retained. Both owned apps were removed.
Its SHA-256 is `9460efa65353fec81951e884bcbe0e7d1ed085c302cae0b95ae4e2558ddfac23`.
That artifact includes a private rotation failure probe and is not distributed;
the test does not accept native rotation or recording. Current source without
that probe compiled as private debug 1.1.13, SHA-256
`407712db6d42d9c3019a3d7fc8e8793eb664ca0b4f3587ab5c3a3a471c651246`.
Fresh sustained viewing and recording acceptance for that historical source
remained pending.

Source version 1.1.27 contains the current rotation surface bridge and capture
lifecycle fixes. Its immediate predecessor was built only as an isolated,
device-bound debug 1.1.26 artifact and passed a fresh real Piora Electron 43.7.7
and USB API-26 phone run: portrait to landscape to portrait native video kept one
capture epoch, produced fresh frames after both encoder replacements, used no
screenshot fallback, captured screenshots during native video, recorded a
playable MP4 with decoded frames, and completed explicit stop, uninstall and
absence checks with no native dialogs or renderer errors. That private debug HAP
is not distributed. The 1.1.27 public artifact must be built unsigned and bound
to the same GitHub Actions run as the desktop packages. A separate private
DevEco device-signed copy made from those exact bytes must pass official
verification and the dedicated-phone gate, then be deleted without upload. The
same-run desktop packages must still pass explicit local signing, ordinary
installation and phone acceptance before the beta is published; those checks are
requirements and are not recorded here as completed. Stable publishing remains
fail-closed until an AGC release certificate and profile for the same bundle are
integrated.
