# Smart Shell implementation ledger

This tracks the complete accepted smart-shell plan. Unchecked items are required,
not deferred scope. Existing unrelated workspace changes must be preserved.

## Requirements and evidence

- [x] Image-model UI references: main workspace, history/approval interaction
      states, and model/history settings. See `docs/design/smart-shell/README.md`.
- [x] Independent PTY sessions; live cwd; PowerShell/Bash/Zsh command lifecycle;
      honest raw-terminal fallback; native interactive programs and cancellation.
- [x] Durable sessions/runs/commands and idempotent submissions; refresh reconnect;
      process-generation fencing; interrupted/unknown recovery without replay.
- [x] SQLite worker history: Piora human/agent, persisted Pi sessions, PSReadLine,
      Bash/Zsh/Git Bash; incremental imports, rotation, multiline, tombstones.
- [x] Unified input, mode recognition/override, local completions, command blocks,
      multiple terminals, output actions, file/browser links, accessible IME input.
- [x] Natural-language history retrieval grounded in real record IDs.
- [x] Independent Shell Agent/model; bounded execution loop; approval tied to the
      concrete command/environment; takeover; interactive input/background PTYs.
- [x] Settings/model overrides/history source management and legacy migration.
- [x] Explicit file/chat/output references and results handed to main-chat drafts.
- [x] Typecheck, lint, behavioral/PTY/browser tests, 100k-history performance,
      Windows/Linux runtime and isolated packaging validation.

## Architecture decisions

Runtime and history live under `lib/shell/`; public routes under `/api/shell`.
The database worker and shell startup scripts are packaged runtime assets.
Use the existing Pi Agent/ModelRuntime, node-pty and xterm packages.
Only shell prompt/hooks certify completion; silence never means completion.
History timestamps/cwd/exit status absent in sources remain null.
The Shell Agent owns its transcript and serial PTY executor, separately from
the main chat. Normal coding-agent tools/permissions are unaffected.

## Current evidence

The runtime/history suites passed six tests, including discovered PowerShell
PTYs, multiline history/rotation/tombstones,
idempotent request handling and 100,000-record search (P95 74.5 ms in that run).
These checks do not yet establish Linux packaging or complete Agent/UI behavior.
The initial Git Bash claim was too broad: discovery had assumed a C: installation,
but this machine has Git on D:. Discovery now derives Bash candidates from the
actual Git executable; subsequent PTY runs print every exercised profile.

The UI references were generated with built-in imagegen and saved with the full
prompt set. Components now follow their fixed composer/model controls, directory
bar, activity cards, suggestion metadata and grouped settings. Page verification
uses `next dev --webpack`; the concurrent desktop clipboard sources currently
prevent the default Turbopack entry from compiling. Webpack needs the added
`.js` → `.ts` extension resolution for those Node16-style imports.

UI component browser tests pass: history completion never auto-executes, failed
submissions retain drafts, composer fits 360/480/640 px, and failed settings saves
retain edits and can retry. Typecheck and targeted lint passed for this iteration.
The live webpack dev page executed `Write-Output "Smart Shell UI verification"`
successfully and restored its completed command block after a full page reload.
Live screenshots are saved alongside the image-model references; `verification/`
contains explicitly isolated component screenshots with test data.

PowerShell now sources the packaged integration script directly; the process
nonce travels in a child environment variable and is removed after initialization.
This avoids creating executable copies in per-terminal data directories. The PTY
suite passed after this change, but one first-run Windows PowerShell startup hit
the 10-second integration deadline before a repeat passed. Cold-start reliability
still needs further validation. Webpack HMR also temporarily dropped right-panel
styles during editing; a full reload restored them. Check clean navigation and
release CSS loading before final acceptance.

The final source uses `--font-code-family` for terminal code; computed styles in
the reloaded real page confirm Noto Sans Mono/Consolas fallbacks and the expected
flex layout. The component browser test was repeated after the font change and
passed. No model-driven natural-language execution or release packaging acceptance
is claimed by these UI checks.

### Runtime and recovery follow-up

The actual Pi Agent-core loop is now covered by nine controlled-provider tests
(no paid model calls): natural-language execution and duplicate admission,
exact-command approval, immediate takeover during slow model discovery, abort
between durable admission and PTY write, unfinished foreground status, delayed
background failures counted once, the 30-step bound, honest interrupted-tool
context, and late-provider transcript fencing. Each run retains its own durable
transcript; SQLite admits only the latest run to update the continuation context.

The legacy HTTP/SSE routes now use the managed runtime with a persisted cwd-to-tab
mapping. The compatibility test covers flat wire formats, duplicate requests,
Agent ownership and same-origin requests. Error recognition survives module
reloads. Background tabs preserve their originating workspace when started from
a subdirectory, and UI inventory refreshes do not steal the selected tab.

The managed PTY suite now explicitly exercises PowerShell, Windows PowerShell,
and Git Bash installed on D:. It exposed MSYS `/tmp` paths being reported to the
Windows host; the Bash integration now reports native paths through `cygpath`.
The suite passed with directory/variable persistence, certified exit status,
isolated PTYs and receipt recovery after ownership changes or terminal stop.
Nine Agent tests, one legacy test and two PTY/protocol tests passed together.

The component browser suite additionally verifies real IndexedDB recovery and
the transport hook: concurrent submissions share one request; a network retry
keeps that ID; local cleanup failure cannot revoke a durable receipt; a deliberate
repeat after acceptance gets a new ID; background discovery preserves selection;
late events cannot replace another selected terminal. Mock transport/provider
data is used in these behavioral tests; this is not a live-provider acceptance.

History imports now yield between 2 KiB transactions and drain complete records
across chunks. Large individual multiline/JSONL records can grow the read up to
16 MiB, with a visible source error above that limit. Occurrence counters moved
out of expanding JSON checkpoints into SQLite, with migration of old counters.
The first concurrent-import benchmark (8 KiB batches) failed at P95 249.4 ms;
smaller batches and a full worker-turn yield brought the measured P95 to 93.5 ms
with 100,000 existing rows while 30,001 records were imported. The same test
verified multiline boundaries, complete draining, stable repeated syncs and a
checkpoint below 1 KiB. The preceding idle-search test measured P95 60.3 ms.

The new managed-xterm browser test passes real interactive input, refresh
reattachment, a Node full-screen alternate-buffer TUI, Ctrl+C cancellation,
server rejection of stale-generation input, client removal of queued old input,
stale output/sequence rejection and ordered clear/snapshot rendering. The legacy
xterm clipboard/transparent-rendering browser test also passes. Initial failures
were retained during diagnosis: protocol replies needed exclusion from a
keystroke-count assertion, and raw duplicate commands were not always captured.

PowerShell raw capture now wraps the existing `PSConsoleHostReadLine` function,
preserving the user's editor and history filtering. It no longer relies on
`AddToHistoryHandler` being called for every execution: PSReadLine's
[history implementation](https://github.com/PowerShell/PSReadLine/blob/master/PSReadLine/History.cs)
skips immediate duplicates before that callback. The same line-editor boundary is
used by [VS Code's integration](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1).
The PTY suite now explicitly executes the same raw command twice and verifies two
completed records on each discovered profile. PTY/protocol and managed-xterm
tests passed together after this correction; targeted lint and typecheck passed.

### Completion, history and settings follow-up

PowerShell, Windows PowerShell and Git Bash now publish their actual aliases and
functions through the nonce-bound integration channel, including removal and
redefinition at the next prompt. PATH completion excludes ordinary non-executable
files. Quoted and partially quoted paths, shell metacharacters, directory descent,
project scripts and command-position quoting have dedicated completion tests.
The PTY suite passed live alias creation/execution/removal for all three locally
installed integrated profiles. Zsh still requires a Linux runtime check.

Semantic history search forwards current source/cwd/favorite filters, selects
only existing IDs and re-reads them after model selection. Three controlled-model
tests verify local authoritative results, redaction, unknown metadata,
deletion/unfavorite during a delayed response and cancellation/malformed output.
The component browser test verifies literal/semantic response races, IME Enter,
filter forwarding and filling a selected history item without execution.

The Agent suite now has ten passing cases, including actual execution of a
routine package test script without a confirmation detour. Development tooling,
local Git work and project dependency installation can proceed automatically.
Project scripts and pre/post hooks are inspected recursively; recursion,
destructive/publishing scripts and package-manager redirection require review.
Forwarded script arguments are inspected with the script. Additional risk tests
cover force-fetch/refspec flags and package-script interpreter/project overrides.
The policy is an execution review gate, not an OS sandbox.

Cold integration startup now has a 30-second deadline, and xterm attaches its
event stream before awaiting startup so profile prompts/output remain visible.
The PTY/protocol, risk and managed/legacy xterm suites passed six tests together
after this change. The Agent/completion/risk run passed fourteen tests.

The activity timeline uses stable SQLite rowid cursors across commands and runs.
The UI offers older pages and retains loaded history on reconnect, with current
live state winning over archived state. A database test walks 235 mixed records
while records are updated and inserted, checking no gaps, duplicates or leakage
between terminals. Browser checks cover concurrent page requests and switching
terminals. Failed page requests remain retryable.

HTTP submission retries now consult the durable receipt before classifying the
input, so a removed alias cannot change an already accepted command into another
kind of request. The legacy/HTTP regression test passes receipt recovery without
restarting the stopped PTY, plus content/mode mismatch rejection. An initial test
fixture used an incorrect undefined run ID and was corrected to the runtime's
null fingerprint; the corrected test passed.

Settings distinguish inherited thinking configuration from explicit off/high.
Model and thinking choices survive reload, and edits made during a slow settings
save survive its older response. The component browser suite passed these cases
together with existing submission/history/reconnect behavior. Output file links
resolve against the command's execution directory, including parent-relative
paths; direct resolver tests passed. Targeted lint and typecheck passed during
this iteration; release-build verification is in progress in an isolated copy.

Remaining acceptance includes complete live UI/reference/model flows,
Linux/Zsh execution and isolated Windows/Linux release packaging. Those
requirements remain open; passing the above checks is not overall completion.

### Packaged runtime resources

Archive inspection found that the existing unpack rule omitted Shell worker and
integration assets. The archive builder now leaves lib/shell/runtime beside
node-pty and @img in the real ASAR sidecar. The release verifier explicitly
requires all five Shell runtime files there.

Three Electron packaging tests passed together: the real SQLite worker can
write/search local history from the archive, PowerShell sources the packaged
integration script and emits its nonce-bound prompt, native ConPTY reads/writes,
and Sharp still decodes images with its native dependencies. The staging trees
were deleted before the probes, ruling out resolution from those source copies.
The Shell probe substitutes only the unused SDK user-directory lookup and
supplies its own temporary database directory; it is not a full release launch.

An isolated source/dependency copy is being prepared under
X:/release-workspaces/smart-shell-verify-23b77a10 for the full release build. The
development worktree is not used for next build. This host currently has no
installed WSL distribution, so Linux runtime acceptance remains outstanding.

### Live provider probe

The configured application default (qwen-token-plan-cn/qwen3.8-max) returned HTTP
403 AccessDenied.Unpurchased, before any command ran. This is a provider
entitlement failure and is retained as failed acceptance evidence.

A separate temporary terminal with an explicit existing
deepseek/deepseek-v4-flash override completed the same Chinese-language request:
one Get-Location command, exit code zero, verified cwd in output and a nonempty
final explanation. Both probes used real provider calls and the real Agent/PTY
path with isolated temporary Shell storage; neither changed application defaults
or wrote to the main chat. Probe scripts/results are retained under
X:/release-workspaces/smart-shell-live-probe*.

The idle development server was restarted to load the new worker assets.
Its parent PID is 11612, child PID 2240, port 30141; logs are
.next-shell-dev-20260910.log and .next-shell-dev-20260910-error.log.
The first browser/API requests exceeded their wait budgets during cold webpack
compilation; server logs subsequently showed successful requests and browser
inspection showed the loaded page. The timeline endpoint returned its real empty
archive successfully after compilation. Full UI flow verification is ongoing.

The real page subsequently verified command submission/recovery and handoff to
the main-chat draft without sending. After a full fresh navigation, clicking
./README.md opened the real project file (HTTP 200); initial pre-refresh click
attempts did not change views, so they are not counted as passing evidence.
The final loaded 1600x1000 screenshot is
docs/design/smart-shell/10-actual-shell-20260910.png. The isolated browser session
was closed. Server logs retain transient cold-compile JSON parse failures and
timeouts; clean release navigation remains an acceptance item.

The dependency copy initially made verified but slow progress with serial
Robocopy. That exact copy process was stopped and resumed to the same destination
with /MT:8, retaining completed files. The resumed copy is the only authoritative
copy operation; the stopped process's zero wrapper exit is not proof of a
complete dependency tree. Wait for the resumed copy to finish before building.

The composer now retains input mode and explicit references with the terminal's
local draft, restores them after remount/reload and includes them in the submitted
context. The selection-reference button also works through keyboard activation.
The browser suite passed persistence, keyboard activation and actual submission
payload checks; typecheck passed. Newly added references during an in-flight send
are not cleared with that older submission.

### 2026-09-10 continuation: recovery and remaining release gates

The Windows host rebooted at 07:34:14. The previous build/import tool handles
were missing and their process trees were gone. The last build result only
certified editor staging; its log ended during page-data collection. It is not
a successful release build. A new hidden driver is running in the same isolated
snapshot, with separate driver stdout/stderr logs and phase results under
X:/release-workspaces/smart-shell-verify-23b77a10/verification. The development
worktree is still not used for next build.

The resumed dependency copy had completed successfully, including desktop
dependencies, before the interrupted build. The marker in the isolated tree
records the successful copy and matching source/copied package-lock hashes.

Command-card favorites now hydrate from the persisted history record instead
of starting with a false local value. A failed PATCH leaves the visible state
unchanged; a missing record returns 404 instead of fake success. The preceding
favorite browser/semantic run passed four tests, and targeted lint passed.

History settings now offer removal of manually configured sources. Removing
the source stops future imports after saving and preserves imported commands.
A previously validated source whose file disappeared can still be disabled;
enabling it again or changing its path requires validation. New sources must
be actual files, not directories. New HTTP and browser regression checks are
in progress; this entry does not claim their success yet.

The verified Ubuntu 24.04.4 rootfs was imported successfully into the isolated
WSL 2 distribution PioraShellVerify-23b77a10. Its rootfs and import-result.json
are retained in X:/release-workspaces/smart-shell-linux-23b77a10. Linux first launch
and dependency preparation are still pending. Shell, native PTY and Sharp ASAR
probes now support Linux instead of skipping every non-Windows host; they must
actually run there before Linux acceptance can be checked off.

The source-management HTTP regression passed. Its first browser run exposed
the new removal button extending into the adjacent path cell and being covered
by it. The source heading/path now occupy separate grid rows, including narrow
layouts. The corrected browser suite passed add/remove, persistence, prior
save/race/recovery cases and favorite handling. The cross-platform packaging
changes also passed all three real Windows Electron probes again (Shell
worker/integration, native PTY and Sharp); Linux execution remains pending.

Linux first launch returned the actual WSL 2 kernel and filesystem successfully.
It emitted a systemd root-user-session warning, but the shell command itself
exited zero. The bootstrap is installing compiler, Bash/Zsh, Electron libraries,
the same Node 24.5.0 version verified by its published SHA256 checksum, and Linux
npm dependencies in /opt/piora. Until its ready marker and tests finish this is
environment preparation, not a Linux pass.

The final crash-recovery and source-settings run passed both tests. The recovery
fixture writes through the real SQLite worker in a separate Node process, waits
for durable acknowledgements, force-terminates that process, and reopens the
database through ShellStore. Pending commands become unknown, pending runs become
interrupted, terminal ownership/connectivity reset, completed results/drafts and
partial output survive, and retrying the same request returns the original
record without attempting to launch even the deliberately invalid executable.
The audit also found a stale question surviving recovery: recovery now clears
it, and the UI only renders the answer form while the run is awaiting_input.
The final test explicitly checks that the old question and approval are cleared.

Typecheck and targeted lint passed for the source-management iteration; the
later recovery worker/UI/test changes and packaged-verifier changes also passed
targeted lint. Windows webpack compilation and build TypeScript completed; the
isolated release is collecting page data. Its snapshot predates the latest
source-management/recovery fixes and will need a final source sync/rebuild before
it can certify those exact final sources.

The packaged-web verifier now invokes verify-packaged-shell.mjs against its
isolated production server, covering persistent shell variables, independent
terminals, completion/exit status, durable duplicate requests, local history,
favorites and stopped-terminal receipt recovery. Syntax/lint pass, but actual
packaged execution of this new gate is still pending; it does not call a model
or send a message to the main chat.

The isolated baseline Next.js production build now exited successfully (code 0,
1,479,190 ms). All 36 static pages generated; standalone staging is the active
next phase. Its only recorded compiler warning concerns the existing dynamic
session-export dependency. Desktop compilation and full Electron packaging
have not yet been certified by this result.

X:/release-workspaces/sync-smart-shell-final.mjs is prepared to copy/hash the final
Shell implementation, routes, UI, tests and verifier into the isolated snapshot.
It refuses to run until all four baseline driver phases pass. A final rebuild
after this sync is required; do not present the older baseline snapshot as the
final recovery/source-management implementation.

Legacy browser-history review found fixed-count batches could exceed the 512 KiB
API limit for long Unicode commands. Migration now batches by encoded JSON bytes,
snapshots source keys before adding receipt keys, requires explicit durable
receipts, preserves source copies/concurrent writes and reconstructs root paths
stripped by the old key normalizer. Three tests passed: multiple directories
with changing Storage key order, large Unicode batches with retry after a failed
receipt, and a concurrent legacy write. This final change must be included in
both isolated snapshots before their final build/verification.

Linux bootstrap verified the Node 24.5.0 tarball SHA256, ran that Linux binary
successfully and is installing Linux npm dependencies in /opt/piora. Its source
copy preceded the final legacy-migration helper/test, so copy those final files
and the current SmartShellPanel into /opt/piora before running verify.sh.

All four Windows baseline driver phases now passed: editor staging, Next build
(1,479,190 ms), standalone staging (1,080,919 ms) and desktop compilation
(31,788 ms). This is still the older baseline source snapshot, not the final
packaged acceptance.

Linux root npm ci completed successfully (1,418 packages, including the desktop
workspace). The bootstrap then failed because it redundantly invoked npm ci in
desktop, which has no separate lockfile. That redundant command was removed;
do not reinstall the already successful root dependency tree to recover it.
The final legacy helper/test and SmartShellPanel were copied into /opt/piora
successfully after the initial source copy.

Performance counters showed disk 0 (D:/E:/F:) with queue length 10 while disk 1
(C:/G:) was nearly idle. The independent Linux installer had exited before its
owned distro was stopped for relocation to G:. The first move hit a transient
VHD sharing violation; exclusive access was verified before retrying, and only
the empty destination left by that attempt was removed. The second move remains
in progress until WSL returns success and registry BasePath changes to G:.
Windows final verification will use X:/release-workspaces/smart-shell-final-23b77a10.
Its final driver is prepared at X:/release-workspaces/build-smart-shell-final.mjs,
but source/dependency copying, final sync and that driver have not started yet.

WSL relocation completed successfully; the registry now points to
X:/release-workspaces/smart-shell-linux-23b77a10/distro. Linux verification is running
from /opt/piora, with logs/results under the G: artifact directory. It installs
the pinned Playwright Chromium before the actual behavioral/native-package
tests. Root npm ci is not being repeated. The final legacy source typecheck and
targeted lint both passed.

The Windows final source/dependency copy is now running from the successful F:
baseline to X:/release-workspaces/smart-shell-final-23b77a10, excluding .next,
verification data/environments and desktop release outputs. Robocopy completion
must be confirmed before invoking sync-smart-shell-final.mjs and then the final
driver. That driver includes desktop directory packaging and the real packaged
runtime verifier, using the copied Electron distribution rather than another
download. None of those final phases is certified yet.

### Linux native runtime verification, 2026-09-10

The Linux behavioral run completed 32 tests: 29 passed, and three native-package
tests failed because Electron's lazy binary download returned `fetch failed`.
The passing cases include actual Bash/Zsh lifecycle, Agent execution and control,
crash recovery, legacy migration, settings, history search and xterm browser
interaction. A running wrapper script was accidentally edited during that run;
Bash then attempted a trailing `test.mjs` fragment. Consequently the wrapper exit
is not evidence of the Node test count; the retained Node output is authoritative.

The official Electron 43.4.0 Linux x64 archive was downloaded through host curl.
Its SHA-256 matched the pinned Electron package checksums:
`7c5f7918bcae74a05a814543940eb28469c055edaa3cfcf41d0ff1787b314c52`.
It was installed using Electron's own extract-zip library and path marker, and
the actual executable reported Electron 43.4.0. A separate retry passed all three
native-package tests, without skips: sharp decoding, SQLite worker/integration
scripts outside ASAR, and real native PTY read/write. Evidence lives under
`X:/release-workspaces/smart-shell-linux-23b77a10/native-retry.log` and its result JSON.
This establishes those targeted package probes, not full production packaging.

The Linux 100k-history suite is running separately before the full build to avoid
benchmarking alongside a compiler. A prerequisite-checked Linux build driver is
prepared in that artifact directory; it has not started. Windows final-copy
Robocopy PID 22440 remains live; its completion marker is still absent.

The first Linux history suite passed four of five cases: the 100k hot-query P95
was 33.2 ms, but foreground queries during import reached 359.5 ms and failed the
100 ms budget. This failure is retained in `history-benchmark.log`; it must not
be hidden by treating the hot-only result as the entire performance requirement.
A separate instrumented worker probe measured query execution around 31–42 ms
and request roundtrips around 40–69 ms while importing 30k records. Import commit
times sometimes reached 56 ms. That narrower diagnostic does not replace the
original test (which also checks cross-chunk multiline records). The unchanged
full history suite is being retried into separate logs to determine whether the
original latency is reproducible before choosing an implementation change.

The unchanged full Linux history retry passed all five cases, with 49.0 ms P95
during import and 40.0 ms hot-query P95. Both runs remain available; the first
run's environmental variance is not yet explained. No budget was relaxed and
no test fixture was reduced. The Linux full-build driver now uses the successful
retry result as its prerequisite. Its editor staging phase passed and Next's
isolated production build is live (exec session 82635). SHA-256 comparison also
confirmed all 39 selected Smart Shell runtime/API/UI and packaging-script files
in /opt/piora match the current F: workspace. The artifact directory contains
`final-source-manifest.json` and `final-source-verification.json`.

### Completion audit follow-up: IME and production build

Review of the actual composer confirmed that both `isComposing` and legacy
keyCode 229 prevent Enter submission. The component browser suite previously
exercised completion, ordinary Enter and draft recovery, but did not directly
assert those IME branches. It now dispatches both forms through the rendered
React input and asserts prevented default, unchanged draft and no submission.
The expanded Windows browser suite passed (49.5 seconds including startup).
This test-only change does not change the frozen production runtime sources.

Linux Next production build passed in 236.2 seconds, including all 36 static
pages. The full driver has advanced beyond compilation; final standalone assets,
desktop packaging and packaged runtime behavior remain separate gates.

Current audit boundaries:

| Requirement | Direct evidence inspected | Remaining completion evidence |
| --- | --- | --- |
| Natural language and command input | Composer browser assertions; real Agent loop tests | Full packaged end-to-end run |
| Chinese input does not execute while selecting text | Both IME keyboard branches pass in Chromium | Included in expanded component suite |
| Persistent terminal state and execution identity | Managed PTY and abrupt-exit recovery tests | Packaged server persistence probe |
| Multi-source history and fast completion | Parser/import/tombstone tests; Linux full performance retry | First performance run variance remains recorded |
| Model and history settings | Failed-save, concurrent-save, thinking inheritance and source-removal assertions | Production settings/UI review |
| Image-model design fidelity | Three generated references and actual-page captures | Final production visual review |
| Platform distribution | Linux native sidecar tests; Linux Next build | Full Linux/Windows packages and production verifier |

Linux standalone staging (27.4 s), desktop compilation (3.0 s) and directory
packaging (72.1 s) all passed. The resulting Linux web runtime archive is
331,821,854 bytes, and the driver has started the packaged runtime verifier.
This verifies a real Linux distribution; the verifier's final result is pending.
The expanded IME test lint remains live as Windows node PID 12440 / exec 41860;
its read counters show startup dependency reads, so it has not been restarted.

The first Linux packaged-runtime verifier reached and passed persistent Shell
variables, independent sessions, duplicate receipt handling, history retrieval
and favorite persistence. It then failed because the new verification helper
called an unsupported `stop` action. The public API has no such action; this was
a verification-script defect, not evidence of a runtime stop failure. The helper
now sends `exit\r` through the real generation-checked terminal input API and
waits for disconnection before testing receipt recovery without process restart.
No production runtime source changed. The helper was copied into the isolated
Linux source, all 39 selected source hashes reverified, and the full packaged
verifier restarted against the same completed package with a separate retry log
and result file. Its first failure log remains intact.

The Linux full packaged-runtime retry passed with the real packaged Electron
executable. Its report confirms Bash persistent state, independent terminals,
durable retry after process exit, and history/favorite persistence. It also
passed the enclosing application checks (33 dependency checks, authentication,
production pages, isolated Agent creation and packaged extension resources).
Evidence: `packaged-runtime-retry.log` and `packaged-runtime-retry-result.json`
under the Linux artifact directory. The corrected verification helper passed
ESLint from the actual Linux project directory. Windows IME-suite ESLint also
finished without diagnostics (exec 41860).

A separate production UI run against the completed Linux distribution is now
underway. Its initial shortcut attempt timed out before the Shell composer
became visible; the retry uses the actual right-panel button and captures page
text/screenshots if it fails. API/package success is not being substituted for
this visual/interaction check.

Windows final-copy completion is now confirmed (Robocopy code 1 means files
copied successfully). The final sync copied and hashed 56 Smart Shell files,
including the IME assertions and corrected package verifier. The hidden final
driver is live as PID 18324; editor staging passed and Next production build is
running from the G: isolated tree. The development worktree is not being built.

The Linux production UI script now passes actual button navigation, command
submission and settings navigation with no page errors. Visual inspection
found the minimal Ubuntu validation environment had no Chinese glyph fonts;
those diagnostic captures are preserved with `-no-cjk` suffixes. Ubuntu's
fonts-noto-cjk package installed successfully in the owned test distro, and a
fresh production UI capture is running before visual acceptance is claimed.

The fresh Linux production capture passed with no browser page errors. Both
workspace and settings PNGs were visually inspected: Chinese text renders
correctly, the actual Bash output and exit code are visible, the composer stays
at the bottom, and model/terminal/history settings are grouped without overlap.
Reviewed captures are saved under docs/design/smart-shell as
11-linux-production-workspace.png and 12-linux-production-settings.png. This
establishes the 1600x1000 light-theme production view; other UI coverage remains
in the existing component/browser cases and earlier actual-page captures.

### Final audit: raw fallback and Windows exit cleanup

Dark production workspace/settings views now pass real command/navigation checks
and visual review; captures 13 and 14 are linked from the design README.
The new raw-fallback regression uses actual Windows cmd / Linux /bin/sh. It
asserts interactive variable expansion, rejects structured execution without
integration, and never invents command/history completion records.

Linux passed. Windows first passed the functional assertions but its test process
remained alive. A minimal native-PTY diagnostic showed a MessagePort and an input
PipeWrap remained after natural exit; explicitly releasing that exited PTY made
them disappear and allowed the process to exit normally. The diagnosed hung test
was stopped only after capturing this evidence. ManagedShellSession now releases
the owned ConPTY handle in its natural-exit callback, after output has drained.
Unix does not perform this post-exit kill, because its API signals a PID.
The complete Windows runtime suite then exited normally with all three tests
passing, including PS7, Windows PowerShell, Git Bash and cmd fallback (48.3 s).
Targeted lint passed for the runtime and test.

Windows's first full package was produced successfully. Verification initially
lacked the copied clipboard verification helper, then exposed an outdated license
inventory in the baseline-derived isolated tree. The helper was supplied, and
the license inventory regenerated from the matching lockfile; the package refresh
passed. Original failures are retained. The new ConPTY code requires fresh final
artifacts, so both platforms are rebuilding that source rather than certifying
the earlier package. Windows driver PID 14756 uses conpty-final-build logs; Linux
exec 19509 adds a full typecheck before its corresponding build. All 39 selected
Linux production source hashes match the workspace; Windows synced 57 files.
The owned Linux distro also has node/npm/npx links in /usr/local/bin to its
verified /opt/piora-node runtime so child tools resolve that runtime consistently.

The requirement-by-requirement evidence map is now in
`docs/smart-shell-acceptance.md`. It explicitly keeps the latest package gates
open. The ConPTY-fix Linux full typecheck passed in 36.5 seconds; both ongoing
builds have progressed through TypeScript/static page generation, with Windows
already packaging. The pre-existing session-export dynamic-import warning is
retained and has not been confused with a Shell regression.

Windows production UI ran successfully against the ConPTY-fix package: real
PowerShell output, exit 0, fixed composer and settings navigation, with no page
errors. The enclosing package verifier caught another baseline-copy difference:
the isolated electron-builder.yml lacked the workspace's existing koffi ASAR
unpack rules. A no-index diff confirmed those three lines were the only config
difference. The exact workspace config was copied, hashed into the final source
manifest, and a package-only refresh is live as exec 21673. No application source
or dependency version was changed to address this isolation issue.

The Windows visual fixture also now resolves its temporary project path to the
native canonical Windows spelling before submitting it, avoiding a diagnostic
artifact where forward-slash and backslash versions appeared as two project
rows. The previous successful capture is retained until the refreshed package
can be checked again.

The refreshed Windows package passed the full verifier (exit 0, 127.6 seconds),
including real PowerShell state, independent sessions, history/favorites, retry
after exit, all 33 dependency checks and the native clipboard probe without
writing the system clipboard. Its latest production UI also passed without page
errors; captures 15 and 16 are linked from the design README. Canonical fixture
paths did not eliminate the broader sidebar's empty duplicate project row, so
no claim is made that this visual fixture establishes sidebar grouping behavior.
The Shell pane's directory, command, output and settings were directly checked.

Core requirement checkboxes above are now backed by the acceptance map and
behavioral/production evidence. The final verification checkbox remains open
until the current-worktree typecheck (exec 61424) and latest Linux full-package
verification (exec 19509) finish. Earlier Linux successful package results do not
replace that last gate.

Latest Linux full build and packaged verification now passed all seven phases,
including the added full typecheck. The final package verifier used actual Bash
and passed the same persistence/history/receipt checks as Windows. The final
source audit rehashed current-worktree files against both verified source trees:
57 Windows-relevant files and 39 Linux production files matched. No runtime
source changed after those builds. The only outstanding check is the additional
current-worktree TypeScript process (exec 61424, node PID 5864); its live read/CPU
counters were inspected and it has not been restarted.

## Final acceptance

The additional current-worktree TypeScript check completed with exit 0 (exec
61424). All requirements at the top of this ledger are now checked against the
acceptance map, actual behavior, source hashes, production screenshots and both
platforms' final package reports. Latest Windows and Linux packages include the
ConPTY natural-exit cleanup. No development-tree Next build was run, no user
command history was deleted, and no main-chat prompt or external message was
sent as part of verification. Historical failures above remain as diagnostic
records; they are not outstanding Smart Shell delivery gates.

The implemented and verified scope is the agreed Smart Shell refactor. The
broader application's sidebar grouping observation in the isolated UI fixture
is outside this Shell acceptance and is not represented as fixed.
