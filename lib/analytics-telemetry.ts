import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { diffLines, applyPatch } from "diff";
import {
  AnalyticsStore,
  analyticsDirectory,
  readAnalyticsConfig,
  stableAnalyticsId,
} from "../desktop/src/analytics-store.mts";
import type { SessionCommandRecord } from "./session-message-types";
type Context = {
  sessionId?: string;
  query_id: string | null;
  run_id: string | null;
  source: string;
  insideProvider?: boolean;
};
type Stream = {
  result(): Promise<{
    usage?: Record<string, unknown>;
    stopReason?: string;
    durationMs?: number;
  }>;
};
type Prepare = (
  ...args: unknown[]
) => Promise<{
  provider: object;
  model: { provider: string; id: string };
  [key: string]: unknown;
}>;
declare global {
  var __pioraAnalytics:
    | {
        store?: AnalyticsStore;
        session: Map<string, Context>;
        context: AsyncLocalStorage<Context>;
        locks: Map<string, Promise<void>>;
        lastScan: number;
        timer?: ReturnType<typeof setInterval>;
      }
    | undefined;
}
function state(): NonNullable<typeof globalThis.__pioraAnalytics> {
  return (globalThis.__pioraAnalytics ??= {
    session: new Map(),
    context: new AsyncLocalStorage<Context>(),
    locks: new Map(),
    lastScan: 0,
  });
}
export function analyticsStore(): AnalyticsStore | undefined {
  if (!readAnalyticsConfig()) return undefined;
  const directory = analyticsDirectory();
  if (!directory) return undefined;
  try {
    if (!state().store) {
      const store = new AnalyticsStore(directory);
      state().store = store;
      recoverAnalyticsPending(store);
    }
    return state().store;
  } catch {
    return undefined;
  }
}
/** A server restart cannot know the outcome or final token usage of an interrupted call. */
export function recoverAnalyticsPending(store: AnalyticsStore): void {
  for (const row of store.db.prepare("SELECT * FROM pending").all() as {
    id: string;
    kind: string;
    payload: string;
  }[]) {
    try {
      const p = JSON.parse(row.payload);
      if (row.kind === "run")
        store.record(
          "run.finished",
          "run:" + row.id + ":finished",
          {
            run_id: row.id,
            outcome: "interrupted",
            duration_ms: null,
            waiting_ms: null,
            finished_at: null,
          },
          timestamp(store),
        );
      if (row.kind === "model")
        store.record(
          "model.finished",
          "model:" + row.id + ":finished",
          {
            id: row.id,
            ...p,
            status: "interrupted",
            finished_at: null,
            duration_ms: null,
            ...normalizeAnalyticsUsage(undefined),
          },
          timestamp(store),
        );
      store.db.prepare("DELETE FROM pending WHERE id=?").run(row.id);
    } catch {
      /* Keep the pending record for a later recovery attempt. */
    }
  }
}
export function startAnalyticsJournalReconciliation(root: string): void {
  if (!analyticsStore() || state().timer) return;
  const reconcile = () => {
    try {
      reconcileAnalyticsJournals(root);
    } catch {
      /* fail open */
    }
  };
  reconcile();
  state().timer = setInterval(reconcile, 60000);
  state().timer?.unref();
}
function timestamp(store: AnalyticsStore, time = Date.now()) {
  return new Date(
    time + (store.get<number>("clock_offset_ms") ?? 0),
  ).toISOString();
}
export function emitAnalytics(
  type: string,
  key: string,
  payload: Record<string, unknown>,
  at?: string,
): void {
  const store = analyticsStore();
  if (!store) return;
  try {
    store.record(type, key, payload, at ?? timestamp(store));
  } catch {
    try {
      store.set("health_codes", ["COLLECTOR_WRITE_FAILED"]);
    } catch {
      /* analytics never blocks the user */
    }
  }
}
function sourceOf(source: string): string {
  return source === "ui" ? "chat" : source === "extension" ? "system" : source;
}
export function recordAnalyticsCommand(
  command: SessionCommandRecord,
  at = Date.now(),
  replay = false,
): void {
  const store = analyticsStore();
  if (
    !store ||
    command.acceptedAt < (store.get<number>("enabled_at") ?? Infinity)
  )
    return;
  const id = stableAnalyticsId(
    store.installationId,
    "query:" + command.commandId,
  );
  const source = sourceOf(command.source),
    human = command.source === "ui";
  emitAnalytics(
    "query.submitted",
    "query:" + command.commandId + ":submitted",
    {
      query_id: id,
      command_id: command.commandId,
      source,
      trigger: human ? "human" : "system",
      accepted_at: timestamp(store, command.acceptedAt),
    },
    timestamp(store, command.acceptedAt),
  );
  const status =
    (
      {
        dispatching: "running",
        delivered: "running",
        expired: "cancelled",
      } as Record<string, string>
    )[command.status] ?? command.status;
  const run = command.runId ?? command.attachedRunId ?? null;
  if (status !== "accepted")
    emitAnalytics(
      "query.updated",
      "query:" + command.commandId + ":revision:" + (command.revision ?? 1),
      {
        query_id: id,
        revision: Math.max(1, command.revision ?? 1),
        status,
        run_id: run,
      },
      timestamp(store, at),
    );
  if (
    !replay &&
    ["dispatching", "running", "delivered"].includes(command.status)
  ) {
    // Until the SDK exposes consumed steer IDs, ambiguous steer attribution is explicitly unknown.
    const root = command.roomContext
      ? store.get<string>(
          "room_query:" +
            command.roomContext.roomId +
            ":" +
            command.roomContext.messageId,
        )
      : undefined;
    state().session.set(command.targetSessionId, {
      sessionId: command.targetSessionId,
      query_id: command.delivery === "steer" ? null : (root ?? id),
      run_id: run,
      source,
    });
    if (command.delivery === "steer")
      store.set("health_codes", ["STEER_ATTRIBUTION_UNKNOWN"]);
  }
}
export function recordAnalyticsRoomMessage(
  roomId: string,
  message: { id: string; createdAt: number; author: { kind: string } },
): void {
  const store = analyticsStore();
  if (
    !store ||
    message.author.kind !== "user" ||
    message.createdAt < (store.get<number>("enabled_at") ?? Infinity)
  )
    return;
  const key = "room_query:" + roomId + ":" + message.id,
    id = stableAnalyticsId(store.installationId, key);
  store.set(key, id);
  emitAnalytics(
    "query.submitted",
    key,
    {
      query_id: id,
      command_id: stableAnalyticsId(store.installationId, "command:" + key),
      source: "room",
      trigger: "human",
      accepted_at: timestamp(store, message.createdAt),
    },
    timestamp(store, message.createdAt),
  );
}
export function withAnalyticsSession<T>(sessionId: string, fn: () => T): T {
  return state().context.run(
    { sessionId, query_id: null, run_id: null, source: "system" },
    fn,
  );
}
function context(): Context {
  const ctx = state().context.getStore();
  return {
    ...((ctx?.sessionId ? state().session.get(ctx.sessionId) : ctx) ?? {
      query_id: null,
      run_id: null,
      source: "system",
    }),
    ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
  };
}
export function beginAnalyticsRun(
  sessionId: string,
  runId: string,
  source = "system",
): void {
  const store = analyticsStore();
  if (!store) return;
  const previous = state().session.get(sessionId);
  const ctx = {
    sessionId,
    query_id: previous?.query_id ?? null,
    run_id: runId,
    source: sourceOf(source),
  };
  state().session.set(sessionId, ctx);
  const startedAt = timestamp(store);
  store.db
    .prepare("INSERT OR IGNORE INTO pending VALUES(?,?,?,?)")
    .run(
      runId,
      "run",
      JSON.stringify({ startedAt, mono: performance.now(), ...ctx }),
      Date.now(),
    );
  emitAnalytics(
    "run.started",
    "run:" + runId + ":started",
    {
      run_id: runId,
      query_id: ctx.query_id,
      parent_run_id: null,
      source: ctx.source,
      started_at: startedAt,
    },
    startedAt,
  );
}
export function finishAnalyticsRun(runId: string, reason: string): void {
  const store = analyticsStore();
  if (!store) return;
  try {
    const r = store.db
      .prepare("SELECT payload FROM pending WHERE id=? AND kind='run'")
      .get(runId) as { payload: string } | undefined;
    if (!r) return;
    const p = JSON.parse(r.payload) as { sessionId: string; mono: number };
    const outcome =
      reason === "idle"
        ? "completed"
        : reason === "abort"
          ? "cancelled"
          : reason === "error"
            ? "failed"
            : "interrupted";
    emitAnalytics("run.finished", "run:" + runId + ":finished", {
      run_id: runId,
      outcome,
      duration_ms:
        outcome === "interrupted"
          ? null
          : String(Math.max(0, Math.round(performance.now() - p.mono))),
      waiting_ms: null,
      finished_at: outcome === "interrupted" ? null : timestamp(store),
    });
    store.db.prepare("DELETE FROM pending WHERE id=?").run(runId);
    state().session.delete(p.sessionId);
  } catch {
    /* fail open */
  }
}
export function normalizeAnalyticsUsage(
  usage: Record<string, unknown> | undefined,
) {
  const keys = ["input", "output", "cacheRead", "cacheWrite"],
    values = keys.map((k) => usage?.[k]);
  const known = values.every(
    (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0,
  );
  // Pi normalizes providers into nonoverlapping buckets. All-zero is indistinguishable from its defaults.
  if (!known || values.every((v) => v === 0))
    return {
      usage_status: "unavailable",
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_write_tokens: null,
      total_tokens: null,
    };
  const nums = values as number[],
    total = nums.reduce((s, n) => s + BigInt(n), BigInt(0));
  return {
    usage_status: "reported",
    input_tokens: String(nums[0]),
    output_tokens: String(nums[1]),
    cache_read_tokens: String(nums[2]),
    cache_write_tokens: String(nums[3]),
    total_tokens: String(total),
  };
}
const installed = Symbol.for("piora.analytics.model-observer");
export function installAnalyticsModelObserver(
  runtime: unknown,
  defaultSource = "system",
): void {
  if (!runtime || typeof runtime !== "object") return;
  const object = runtime as {
    prepareRequest?: Prepare;
    [installed]?: { source: string };
  };
  if (object[installed]) {
    if (defaultSource !== "system") object[installed].source = defaultSource;
    return;
  }
  if (typeof object.prepareRequest !== "function") return;
  object[installed] = { source: defaultSource };
  const prepare = object.prepareRequest.bind(runtime);
  object.prepareRequest = async (...args) => {
    const prepared = await prepare(...args);
    if (!analyticsStore()) return prepared;
    return {
      ...prepared,
      provider: new Proxy(prepared.provider, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (
            !["stream", "streamSimple"].includes(String(key)) ||
            typeof value !== "function"
          )
            return value;
          return (...callArgs: unknown[]) => {
            const store = analyticsStore();
            if (
              !store ||
              store.get<{ enabled: boolean }>("policy")?.enabled === false ||
              state().context.getStore()?.insideProvider
            )
              return Reflect.apply(value, target, callArgs);
            const id = randomUUID(),
              ctx = context(),
              started = timestamp(store),
              mono = performance.now();
            if (
              object[installed]!.source !== "system" ||
              !state().context.getStore()
            )
              ctx.source = object[installed]!.source;
            const metadata = {
              query_id: ctx.query_id,
              run_id: ctx.run_id,
              provider: prepared.model.provider.slice(0, 128),
              model: prepared.model.id.slice(0, 256),
              source: ctx.source,
              started_at: started,
            };
            const finish = (
              message?: Awaited<ReturnType<Stream["result"]>>,
              failed = false,
            ) => {
              const usage = normalizeAnalyticsUsage(message?.usage),
                status =
                  message?.stopReason === "aborted"
                    ? "cancelled"
                    : failed || message?.stopReason === "error"
                      ? "failed"
                      : "completed";
              emitAnalytics("model.finished", "model:" + id + ":finished", {
                id,
                ...metadata,
                status,
                finished_at: timestamp(store),
                duration_ms: String(
                  Math.max(0, Math.round(performance.now() - mono)),
                ),
                ...usage,
              });
              try {
                store.db.prepare("DELETE FROM pending WHERE id=?").run(id);
              } catch {
                /* recovery reports unknown */
              }
            };
            try {
              store.db
                .prepare("INSERT OR IGNORE INTO pending VALUES(?,?,?,?)")
                .run(id, "model", JSON.stringify(metadata), Date.now());
              emitAnalytics(
                "model.started",
                "model:" + id + ":started",
                { call_id: id, ...metadata },
                started,
              );
            } catch {
              /* the provider call must still proceed */
            }
            try {
              const stream = state().context.run(
                { ...ctx, insideProvider: true },
                () => Reflect.apply(value, target, callArgs),
              ) as Stream;
              void stream.result().then(
                (message) => finish(message),
                () => finish(undefined, true),
              );
              return stream;
            } catch (error) {
              finish(undefined, true);
              throw error;
            }
          };
        },
      }),
    };
  };
}
interface ToolInfo {
  name: string;
  sourceInfo?: { source: string; path: string };
}
interface ToolDefinition {
  execute: (...args: unknown[]) => Promise<unknown>;
  [key: symbol]: unknown;
}
const wrapped = Symbol.for("piora.analytics.file-observer");
const languages: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".java": "Java",
  ".kt": "Kotlin",
  ".c": "C",
  ".cpp": "C++",
  ".h": "C",
  ".cs": "C#",
  ".go": "Go",
  ".rs": "Rust",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
  ".vue": "Vue",
  ".sql": "SQL",
  ".json": "JSON",
  ".yaml": "YAML",
  ".yml": "YAML",
  ".toml": "TOML",
  ".md": "Markdown",
  ".txt": "Text",
};
export function measureAnalyticsLines(
  before: string,
  after: string,
): { added_lines: string; deleted_lines: string } {
  let added = 0,
    deleted = 0;
  for (const part of diffLines(
    before.replace(/\r\n/g, "\n"),
    after.replace(/\r\n/g, "\n"),
  )) {
    if (part.added) added += part.count ?? 0;
    if (part.removed) deleted += part.count ?? 0;
  }
  return { added_lines: String(added), deleted_lines: String(deleted) };
}
async function snapshot(
  file: string,
): Promise<{ text: string; exists: boolean }> {
  try {
    const s = await stat(file);
    if (s.size > 2097152) throw new Error("too_large");
    const bytes = await readFile(file);
    if (bytes.includes(0)) throw new Error("binary");
    const text = bytes.toString("utf8");
    if (text.split("\n").length > 100000) throw new Error("too_large");
    return { text, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { text: "", exists: false };
    throw error;
  }
}
export function installAnalyticsFileObserver(
  session: unknown,
  cwd: string,
  sessionId: string,
): void {
  const inner = session as {
    getAllTools(): ToolInfo[];
    getToolDefinition(name: string): ToolDefinition | undefined;
  };
  for (const info of inner.getAllTools()) {
    if (!["write", "edit"].includes(info.name)) continue;
    if (
      info.sourceInfo?.source !== "builtin" ||
      info.sourceInfo.path !== "builtin:" + info.name
    )
      continue;
    const tool = inner.getToolDefinition(info.name);
    if (!tool || tool[wrapped]) continue;
    tool[wrapped] = true;
    const execute = tool.execute.bind(tool);
    tool.execute = async (...args) => {
      const store = analyticsStore(),
        input = args[1] as { path?: unknown };
      if (
        !store ||
        store.get<{ enabled: boolean }>("policy")?.enabled === false ||
        typeof input?.path !== "string"
      )
        return execute(...args);
      const path = isAbsolute(input.path)
        ? input.path
        : resolve(cwd, input.path);
      let normalized: string;
      try {
        normalized = (await realpath(path)).replaceAll("\\", "/").toLowerCase();
      } catch {
        normalized = resolve(path).replaceAll("\\", "/").toLowerCase();
      }
      const previous = state().locks.get(normalized) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((r) => {
        release = r;
      });
      const chain = previous.then(() => next);
      state().locks.set(normalized, chain);
      await previous;
      const id = randomUUID(),
        ctx = state().session.get(sessionId) ?? {
          query_id: null,
          run_id: null,
          source: "system",
        };
      const ext = extname(path).toLowerCase(),
        language = languages[ext] ?? "Other",
        category = [".json", ".yaml", ".yml", ".toml"].includes(ext)
          ? "config"
          : [".md", ".txt"].includes(ext)
            ? "document"
            : languages[ext]
              ? "code"
              : "other";
      let before: { text: string; exists: boolean } | undefined,
        status = "measured",
        result: unknown;
      try {
        try {
          before = await snapshot(path);
        } catch (error) {
          status =
            error instanceof Error &&
            ["too_large", "binary"].includes(error.message)
              ? error.message
              : "unreadable";
        }
        try {
          result = await execute(...args);
          if ((result as { isError?: boolean })?.isError) status = "failed";
        } catch (error) {
          status = "failed";
          throw error;
        }
        return result;
      } finally {
        try {
          let after: { text: string; exists: boolean } | undefined;
          try {
            after = await snapshot(path);
          } catch {
            status = status === "measured" ? "unreadable" : status;
          }
          if (!before || !after || !after.exists)
            status = status === "measured" ? "unreadable" : status;
          // Check actual result against write intent, or edit's structured patch when available.
          if (
            status === "measured" &&
            info.name === "write" &&
            typeof (input as { content?: unknown }).content === "string" &&
            after?.text !== (input as { content: string }).content
          )
            status = "concurrent_change";
          if (
            status === "measured" &&
            info.name === "edit" &&
            before &&
            after
          ) {
            const patch = (result as { details?: { patch?: unknown } })?.details
              ?.patch;
            if (
              typeof patch !== "string" ||
              applyPatch(
                before.text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"),
                patch,
              ) !== after.text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")
            )
              status = "concurrent_change";
          }
          const lines =
            status === "measured" && before && after
              ? measureAnalyticsLines(before.text, after.text)
              : { added_lines: null, deleted_lines: null };
          emitAnalytics("file.changed", "file:" + id, {
            operation_id: id,
            run_id: ctx.run_id,
            query_id: ctx.query_id,
            tool_call_id: String(args[0]).slice(0, 256),
            file_key: createHmac("sha256", store.get<string>("file_salt")!)
              .update(normalized)
              .digest("hex"),
            language,
            file_category: category,
            kind:
              status !== "measured"
                ? "unknown"
                : !before?.exists
                  ? "created"
                  : before.text === after?.text
                    ? "unchanged"
                    : "updated",
            ...lines,
            measurement_status: status,
          });
        } catch {
          /* never change the original file tool result */
        } finally {
          release();
          if (state().locks.get(normalized) === chain)
            state().locks.delete(normalized);
        }
      }
    };
  }
}
/** Replay only journals newer than the explicit enrollment time; no old session backfill. */
export function reconcileAnalyticsJournals(root: string): void {
  const store = analyticsStore();
  if (!store || Date.now() - state().lastScan < 60000) return;
  state().lastScan = Date.now();
  const dir = join(root, "commands");
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
    try {
      const full = join(dir, file),
        mtime = statSync(full).mtimeMs,
        key = "journal:" + file;
      if (
        mtime === (store.get<number>(key) ?? 0) ||
        mtime < (store.get<number>("enabled_at") ?? Infinity)
      )
        continue;
      const commands = new Map<string, SessionCommandRecord>();
      for (const line of readFileSync(full, "utf8").split(/\r?\n/)) {
        if (!line) continue;
        let entry: {
          kind: string;
          command?: SessionCommandRecord;
          commandId?: string;
          patch?: Partial<SessionCommandRecord>;
          status?: SessionCommandRecord["status"];
          timestamp?: number;
        };
        try {
          entry = JSON.parse(line) as typeof entry;
        } catch {
          continue;
        }
        if (entry.kind === "command" && entry.command) {
          commands.set(entry.command.commandId, entry.command);
          recordAnalyticsCommand(entry.command, entry.command.acceptedAt, true);
        } else if (entry.kind === "status" && entry.commandId && entry.status) {
          const command = commands.get(entry.commandId);
          if (command) {
            const updated = {
              ...command,
              ...entry.patch,
              status: entry.status,
            };
            commands.set(entry.commandId, updated);
            recordAnalyticsCommand(updated, entry.timestamp, true);
          }
        }
      }
      store.set(key, mtime);
    } catch {
      store.set("health_codes", ["JOURNAL_REPLAY_FAILED"]);
    }
  }
}
