# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.
**Never build release packages locally** — push the release commit and tag, and let GitHub Actions build, verify, and publish all beta/stable artifacts.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

Additional server-side subsystems share the same Next.js process but have separate state boundaries:

- **Rooms** coordinate multiple agent sessions through `room-store`, `room-coordinator`, and room SSE routes.
- **Harmony** controls OpenHarmony devices through an explicit runtime profile, approval queue, device manager, HDC backend, screenshots, UI trees, and vision helpers.
- **Companion pets** keep imported sprite metadata in the companion store and serve runtime spritesheets through dedicated routes; desktop companion windows are separate renderer entry points.
- **Optional workflow extensions** provide goal tracking and structured plans through ordinary extension tools and slash commands. They are disabled by default, have no special composer mode, and do not alter the core prompt protocol or session runtime.

---

## File Map

```
app/api/
  agent/                  session creation, commands, per-session SSE, running snapshots
  sessions/               list/read/mutate, context branches, export, duplicate/restore, flags
  rooms/                  room CRUD, coordinator input, and room event streams
  harmony/                device/config/state/action/approval/frame/tree/vision APIs
  companion-pets/         pet catalog/import plus spritesheet serving
  git/                    status/diff/branches and stage/commit/push/revert mutations
  browser/                private headless browser state and screenshots
  files/, file-index/     allow-listed file reads and indexed workspace search
  cwd/, default-cwd/      cwd selection/validation and managed default workspaces
  models/, models-config/ model scope, provider catalogs, discovery, config, and tests
  auth/                   provider listing, API keys, OAuth/device-code login, logout
  extensions/             unified extension inventory and per-extension enable/disable
  plugins/, skills/       package/resource management, search, install, update checks
  prompts/, speech/       prompt optimization and local transcription
  worktrees/              git worktree list/create/remove
  health/, home/, project-info/, search/ supporting workspace endpoints

lib/
  rpc-manager.ts             AgentSessionWrapper, lifecycle registry, and session startup
  extension-config.ts        extension inventory, stable ids, load plan, and preferences
  first-party-extensions.ts  bundled extension descriptors and profile membership
  prompt-run-registry.ts     active prompt identity and terminal cleanup
  goal-run-registry.ts       state helper owned by the optional Goals extension
  plan-artifact-registry.ts  state helper owned by the optional Plans extension
  task-status.ts             normalized running/task snapshots
  session-reader.ts          read-only session loading, context building, and caches
  session-{path,flags,trash}.ts session lookup, metadata flags, and recoverable deletion
  room-{store,coordinator,chat-routing,chat,types}.ts multi-agent room subsystem
  harmony/                   runtime, device manager, HDC, approvals/errors, UI tree, vision
  companion-pets.ts          pet validation/import and sprite processing
  companion-store.ts         companion persistence boundary
  companion.ts               active companion preferences/state helpers
  model-*.ts, provider-*.ts  model scope/policy/runtime/discovery and credential listing
  file-*.ts, path-security.ts allow-list, paths, editing, upload, indexing helpers
  git-*.ts, worktree.ts      git status/write helpers and project/worktree resolution
  api-types.ts, types.ts     API/shared UI types; pi-types.ts isolates SDK structural types
  i18n/                      typed registry, formatter, and en/zh-CN message catalogs
  rpc-*.ts                   task activity and headless extension UI adapters

components/
  AppShell.tsx              top-level layout, URL/project/tab state, workspace composition
  ChatWindow.tsx            chat rendering, session hook, and task-control registration
  ChatInput.tsx             composer, model/thinking controls, one-shot goal/plan selection
  MessageView.tsx           user/assistant/tool message rendering
  SessionSidebar.tsx        sidebar composition; details live under components/sidebar/
  Room*.tsx                 room navigation, settings, and multi-agent workspace
  Companion*.tsx            companion settings, pet renderer, and desktop companion window
  FileExplorer/FileViewer   allow-listed file navigation, editing, and previews
  Models/Extensions/Plugins/SkillsConfig model, extension, package, and skill settings
  workspace/                browser, command, change/review, search, and Harmony panels
  MarkdownBody/MermaidBlock markdown and diagram rendering

hooks/
  useAgentSession.ts       messages, streaming/SSE, forks, tree navigation, reconciliation
  useTaskStatus.ts         global running-task SSE/polling state
  useHarmonyLiveFrame.ts   Harmony frame/event polling and stability handling
  useCompanion*.ts         companion catalog and preference state
  useCommands.ts           slash-command discovery and execution state
  useI18n.tsx              locale context and typed message lookup
  useLocalDictation.ts     recording/transcription orchestration
  useBackground/useTheme/useFontPreferences appearance state
  useKeyboardShortcuts/useFocusTrap/useResizablePanel interaction/layout helpers
```

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Optional Goals and Plans extensions
- `extensions/piora-goal.ts` and `extensions/piora-plan.ts` are ordinary configurable first-party extensions. Both are disabled by default and appear in Settings > Extensions.
- Core prompt requests do not accept goal/plan flags, `AgentSessionWrapper` does not track workflow mode state, and the composer exposes no Goal or Plan mode controls.
- Enabling an extension registers its tools and slash commands through Pi's normal extension loader. Its tools then participate in the ordinary per-session capability selection instead of being force-enabled by the wrapper.
- The Goals extension persists `piora-goal-run` custom entries and exposes `piora_goal` plus `/goal`. It may carry saved context into a later user prompt, but it never starts automatic model continuations.
- The Plans extension persists `piora-plan-artifact` custom entries and exposes `piora_plan`, `piora_plan_execution`, and `/plan`. Approval and execution are extension commands; no core read-only lease or prompt mode exists. Restored incomplete executions become `interrupted`, never falsely `running`.

### Extension inventory and toggles
- `lib/extension-config.ts` resolves Pi's first-party, user, project, and package extension paths before session construction. Disabled extensions are removed from the load plan, so their modules are not executed.
- Per-extension preferences live in `~/.pi/agent/piora/extensions.json`; ids are stable across first-party builds and package version updates. A user file cannot acquire a first-party id merely by copying its filename.
- `/api/extensions` and `components/ExtensionsConfig.tsx` expose the same resolved load plan used by session startup. Package-level filters remain managed by `/api/plugins`.
- Changing an extension invalidates the shared services cache. An idle current session uses `restart_extensions` to destroy its wrapper and rebuild from the new load plan; a busy session keeps running and applies the setting on its next restart.

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### Agent tools and permissions
Piora does not expose tool permission tiers or Project Trust. New and existing sessions enable Pi's complete built-in coding tool set, while extension tools remain active. The bundled `extensions/piora-browser.ts` registers a private headless browser tool backed by Playwright and an installed Edge/Chrome executable.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions.

### Automatic model fallback
- Settings > Models exposes a global switch, disabled by default, persisted in `<agentDir>/piora/model-fallback.json` through `/api/models/fallback`.
- `lib/model-fallback.ts` handles provider availability failures (including 401/402/403/429/5xx) after SDK retries settle. It tries at most three distinct enabled, authenticated candidates per prompt, preserving image support and known context requirements. Context overflow remains the SDK compaction path; tool failures, invalid requests, refusals, and cancellation do not trigger model fallback.
- Recovery stays inside the same wrapper/PromptRun. An admitted prompt continues through `sendCustomMessage(..., { triggerTurn: true })`, retaining tool results instead of replaying the original user prompt. Every switch is recorded in the transcript, and `model_fallback` updates the UI selection. Only terminal failure emits `prompt_error`; the session router preserves its reason for scheduled-task history.
- Missing explicitly requested startup models may fall back only when the switch is enabled. Pinned Team profiles prohibit fallback both at provisioning and during execution. Failed model candidates are tracked only within the current prompt, never globally across sessions.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### User submissions must survive cancellation and reload
- `useAgentSession` commits full original text and attachments to IndexedDB through `prompt-recovery` before network work. `ChatInput` awaits acceptance and clears only the unchanged originating draft; cancellation, ambiguous responses and storage failures must return `false`.
- A prompt's optional `onDurable` callback acknowledges that IndexedDB commit before network setup. The composer can clear immediately on this local receipt; failed sends restore an empty originating composer without overwriting newer input or another session. The pending recovery record remains until a disk-backed receipt confirms delivery.
- Every send carries a unique `clientPromptId`/idempotency key. History hydration merges unconfirmed recovery records. Never confirm by matching text, since identical messages can be distinct sends.
- The SDK can buffer messages before its first assistant response. UI tracked prompts persist their session file before admission; only IDs read from a disk-backed SessionManager confirm deletion of a local recovery copy, never SSE or an in-memory history response.
- UI command journals remain a durable send archive without automatic age/count deletion. `/api/sessions/[id]/submissions` exposes older sends that never reached model history, but the composer has no send-history button or archive popup. Automatic prompt recovery remains active. Recovery rows have no real entry ID and require distinct virtual row keys.
- Successful attachment-free UI slash commands may produce no SDK user message. Their disk-backed command journal entries confirm the exact idempotency key only after `completed`; session response cache signatures include journal changes. Other pending, failed, and cancelled sends keep their recovery copies.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events, opens it before each prompt, and closes it only after `prompt_done` plus server-idle settlement. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion notifications
- Completion notifications are opt-in and stored in `localStorage` as `pi-completion-notifications-enabled`.
- The packaged Electron app sends a native Windows notification through a same-origin, main-frame-only IPC bridge. Browser mode falls back to the Web Notification API.
- Notification payloads contain only app-owned completion copy and an optional sanitized task title; chat text, tool output, and file contents are never forwarded.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
