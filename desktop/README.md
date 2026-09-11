# Piora desktop shell

This directory owns the Electron process only. The existing Piora web application
continues to run as an independent Next.js standalone process on loopback.

## Development

For the normal desktop feedback loop, run this once from the repository root:

```powershell
npm run dev:desktop
```

This command binds an authenticated Next.js development server to
`127.0.0.1:30141`, watches `desktop/src`, and opens Electron after both the web
server and desktop TypeScript compile are healthy. React and CSS use Next.js
hot reload; a successful main-process or preload compile restarts Electron.
Ctrl+C or quitting Electron terminates the complete development process tree.
The command does not run `next build` or create standalone output.

If port 30141 is already occupied, stop the existing process first; the command
reports the conflict without attaching to an unauthenticated server.
For an intentional parallel instance, choose another loopback port before
starting, for example `$env:PIORA_DESKTOP_DEV_PORT = "30142"`.

For a one-off Electron-only compile:

Install this directory's pinned toolchain, then compile it:

```powershell
cd <repository>\desktop
npm install
npm run typecheck
npm run build
```

The production shell expects a Next standalone `server.js`. During isolated
standalone shell work, point
at an existing standalone artifact explicitly:

```powershell
$repositoryRoot = git rev-parse --show-toplevel
$env:PI_DESKTOP_SERVER_ENTRY = Join-Path $repositoryRoot ".next\standalone\server.js"
npm start
```

Do not run `next build` as part of the normal Piora development loop. Produce
the standalone output in an isolated release checkout or CI job.

## Release input

The repository's release configuration must enable Next's `output:
"standalone"`. Before packaging, the staged standalone tree must exist:

- `../.next/standalone/server.js`

Run `npm run build:web` from the repository root to create it and stage
`public/` plus `.next/static/`. `electron-builder.yml` copies the complete tree
to `resources/web/`. The after-pack step archives the runtime into `runtime.asar`
behind a small launcher. Native dependencies requiring real paths, including the
complete node-pty module and its ConPTY worker/DLLs, stay in
`runtime.asar.unpacked`. Runtime-aware resolution keeps Pi extensions and native
terminal support available without relying on the developer checkout.

After `npm run pack:win` or `npm run pack:linux`, run `npm run verify:package`
from the repository root (pass the Linux unpacked `resources/web` path when
verifying that target).
The verifier copies `resources/web/` outside the checkout, confirms the traced
Next/Pi dependencies are present, starts the service in isolation, and checks
both desktop-token rejection and authenticated health/root responses.

Electron Builder runs `scripts/electron-after-pack-licenses.cjs` after the final
`resources/web` tree is copied and before the Windows packages are assembled. It writes an
exact package-copy manifest, CycloneDX SBOM, and content-addressed license texts under
`resources/licenses/third-party/`. The package verifier recomputes and compares this bundle;
do not hand-edit it or replace it with the broader source lockfile inventory.

Stable tags publish an assisted Windows x64 NSIS installer, update metadata,
ZIP/portable EXE artifacts, and a Linux x64 AppImage. The installer allows a
custom destination and is the recommended edition: installed builds check the
appropriate GitHub Release channel after startup, expose progress and restart/install
actions in Help, and never install an update while a task is running. Portable
builds link to the installer instead of modifying themselves. The Linux package
intentionally omits the Windows-only pinned local Whisper runtime, so local
speech transcription reports unavailable there.

Beta tags (`vX.Y.Z-beta.N`) use `harmony-preview.yml` and publish Windows installer,
portable EXE, blockmap, `beta.yml`, and checksums as a prerelease; they do not run
the stable Linux/ZIP pipeline. Installed beta builds use the beta update channel.
Settings > General also provides an opt-in scheduled silent update: installation
waits for tasks to finish, edits to be saved, and the computer to be idle. This is
unavailable in portable/development builds. See [release procedure](../docs/release.md)
for exact metadata, checks, and tag commands.

## Security boundary

- The renderer uses Chromium sandboxing and context isolation with Node.js
  integration disabled.
- Pi and Next execute in a child process with no shell invocation.
- The service binds only to `127.0.0.1` on an available port. The selected port
  is reused when possible so origin-scoped web preferences survive restarts.
- A fresh high-entropy token is passed to the server, enforced by Piora, and
  injected into requests by Electron's network layer. The renderer cannot read
  the token.
- Cross-origin navigation, new Electron windows, webviews, and permission
  requests are denied in the privileged application renderer. The right-side
  Browser tool uses a separate sandboxed `WebContentsView` and persistent
  partition; untrusted pages never receive the application preload bridge.
- Child stdout/stderr and lifecycle events are written to
  `<userData>/logs/piora.log` with one rotated backup.

## Startup diagnostics

On Windows, press Win+R and enter `%APPDATA%\Piora\logs` to find `piora.log`
and its previous 5 MiB rotation, `piora.log.1`. Installed and portable builds use
the same location. If that directory cannot be written, new builds fall back to
`%TEMP%\Piora\logs\piora-startup-<pid>.log`; the failure dialog shows the actual path.

Logs record the version, operating system, executable path, process ID, startup
stages and elapsed time, local server stdout/stderr, and renderer failures.
While startup remains pending, the last stage is recorded every 15 seconds.
The startup failure dialog can copy the error details or open the log folder.
These are local files; they are not automatically uploaded.

For a failed launch, collect both log files immediately after reproducing it,
along with the version, installed/portable choice, Windows version, and whether
there was no window, a crash, a stalled startup screen, or an error dialog.
Failures before Electron loads the JavaScript entry point (for example an OS
loader failure) may leave no application log and need Windows Event Viewer data.

## Integrated title bar

The desktop window uses Electron's native Window Controls Overlay rather than
`frame: false`. On Windows, the permanent operating-system title/menu rows are
hidden while native minimize, maximize, close, edge resizing, Alt menu access,
and application-menu accelerators remain available.

The web shell owns a 40 px top drag strip. It should use `app-region: drag`
(plus the prefixed form supported by Chromium), size its safe area with
`env(titlebar-area-x)`, `env(titlebar-area-width)`, and
`env(titlebar-area-height)`, and mark every interactive child as
`app-region: no-drag`. These environment variables fall back normally in the
browser build, so the same shell can serve both web and desktop.

## Bundled PowerShell

Windows 安装版和便携版内置完整 PowerShell 7，终端默认直接启动随包的
`resources/powershell/pwsh.exe`，无需预装 PowerShell 或 .NET。开发/浏览器模式
继续发现本机 Shell；用户明确配置的自定义 Shell 仍可使用。内置版本由
`third_party/powershell/manifest.json` 锁定，GitHub Actions 打包时校验 SHA-256，
保留全部上游许可文件，并在隔离目录验证内置终端。不要在本机构建发布包。
