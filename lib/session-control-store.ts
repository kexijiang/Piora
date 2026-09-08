import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionCommandEvent, SessionCommandRecord, SessionCommandStatus } from "./session-message-types";

type CommandJournalEntry =
  | { kind: "command"; command: SessionCommandRecord }
  | { kind: "status"; commandId: string; status: SessionCommandStatus; patch?: Partial<SessionCommandRecord>; timestamp: number };
type EventJournalEntry = { event: SessionCommandEvent };

declare global {
  var __pioraSessionControlWriteLocks: Map<string, Promise<void>> | undefined;
  var __pioraSessionControlCursors: Map<string, number> | undefined;
}

function writeLocks(): Map<string, Promise<void>> {
  return globalThis.__pioraSessionControlWriteLocks ??= new Map();
}

function cursors(): Map<string, number> {
  return globalThis.__pioraSessionControlCursors ??= new Map();
}

function safeSessionFileName(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function parseLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as T]; } catch { return []; }
  });
}

async function serializeWrite<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = writeLocks().get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const chain = previous.then(() => current);
  writeLocks().set(path, chain);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (writeLocks().get(path) === chain) writeLocks().delete(path);
  }
}

async function appendLocked(path: string, line: string): Promise<void> {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await serializeWrite(path, async () => {
    const directory = resolve(path, "..");
    const release = await lockfile.lock(directory, {
      lockfilePath: `${path}.lock`,
      realpath: false,
      retries: { retries: 50, factor: 1.15, minTimeout: 4, maxTimeout: 50 },
    });
    try {
      appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600, flush: true });
      chmodSync(path, 0o600);
    } finally {
      await release();
    }
  });
}

export interface SessionControlStoreOptions {
  root?: string;
  retentionDays?: number;
  retentionCount?: number;
}

export class SessionControlStore {
  readonly root: string;
  readonly retentionDays: number;
  readonly retentionCount: number;

  constructor(options: SessionControlStoreOptions = {}) {
    this.root = resolve(options.root ?? process.env.PIORA_SESSION_CONTROL_ROOT ?? join(getAgentDir(), "piora", "session-control"));
    this.retentionDays = Math.max(1, Math.min(365, Math.floor(options.retentionDays ?? 30)));
    this.retentionCount = Math.max(100, Math.min(100_000, Math.floor(options.retentionCount ?? 10_000)));
  }

  commandsPath(sessionId: string): string {
    return join(this.root, "commands", `${safeSessionFileName(sessionId)}.jsonl`);
  }

  eventsPath(sessionId: string): string {
    return join(this.root, "events", `${safeSessionFileName(sessionId)}.jsonl`);
  }

  snapshotsPath(sessionId: string): string {
    return join(this.root, "snapshots", `${safeSessionFileName(sessionId)}.json`);
  }

  loadCommands(sessionId: string): SessionCommandRecord[] {
    const commands = new Map<string, SessionCommandRecord>();
    for (const entry of parseLines<CommandJournalEntry>(this.commandsPath(sessionId))) {
      if (entry.kind === "command" && entry.command?.commandId) {
        commands.set(entry.command.commandId, { ...entry.command });
      } else if (entry.kind === "status" && entry.commandId && commands.has(entry.commandId)) {
        const current = commands.get(entry.commandId)!;
        commands.set(entry.commandId, { ...current, ...entry.patch, status: entry.status });
      }
    }
    return [...commands.values()].sort((left, right) => left.acceptedAt - right.acceptedAt);
  }

  findByIdempotencyKey(idempotencyKey: string, sessionId?: string): SessionCommandRecord | undefined {
    const commandDir = join(this.root, "commands");
    if (!existsSync(commandDir)) return undefined;
    if (sessionId) {
      return this.loadCommands(sessionId).find((command) => command.idempotencyKey === idempotencyKey);
    }
    for (const entry of readdirSync(commandDir) as string[]) {
      if (!entry.endsWith(".jsonl")) continue;
      const commands = this.loadCommandsFromPath(join(commandDir, entry));
      const match = commands.find((command) => command.idempotencyKey === idempotencyKey);
      if (match) return match;
    }
    return undefined;
  }

  findByCommandId(commandId: string): SessionCommandRecord | undefined {
    const commandDir = join(this.root, "commands");
    if (!existsSync(commandDir)) return undefined;
    for (const entry of readdirSync(commandDir) as string[]) {
      if (!entry.endsWith(".jsonl")) continue;
      const match = this.loadCommandsFromPath(join(commandDir, entry)).find((command) => command.commandId === commandId);
      if (match) return match;
    }
    return undefined;
  }

  private loadCommandsFromPath(path: string): SessionCommandRecord[] {
    const commands = new Map<string, SessionCommandRecord>();
    for (const entry of parseLines<CommandJournalEntry>(path)) {
      if (entry.kind === "command" && entry.command?.commandId) commands.set(entry.command.commandId, { ...entry.command });
      else if (entry.kind === "status" && entry.commandId && commands.has(entry.commandId)) {
        const current = commands.get(entry.commandId)!;
        commands.set(entry.commandId, { ...current, ...entry.patch, status: entry.status });
      }
    }
    return [...commands.values()];
  }

  async appendCommand(command: SessionCommandRecord): Promise<void> {
    await appendLocked(this.commandsPath(command.targetSessionId), JSON.stringify({ kind: "command", command } satisfies CommandJournalEntry));
  }

  async appendStatus(command: SessionCommandRecord, status: SessionCommandStatus, patch: Partial<SessionCommandRecord> = {}): Promise<void> {
    await appendLocked(this.commandsPath(command.targetSessionId), JSON.stringify({ kind: "status", commandId: command.commandId, status, patch, timestamp: Date.now() } satisfies CommandJournalEntry));
  }

  async appendEvent(event: Omit<SessionCommandEvent, "cursor">): Promise<SessionCommandEvent> {
    const path = this.eventsPath(event.sessionId);
    return serializeWrite(path, async () => {
      const directory = resolve(path, "..");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(directory, {
        lockfilePath: `${path}.lock`,
        realpath: false,
        retries: { retries: 50, factor: 1.15, minTimeout: 4, maxTimeout: 50 },
      });
      try {
        const existing = parseLines<EventJournalEntry>(path);
        const last = existing.at(-1)?.event.cursor ?? cursors().get(event.sessionId) ?? 0;
        const full: SessionCommandEvent = { ...event, cursor: last + 1 };
        appendFileSync(path, `${JSON.stringify({ event: full } satisfies EventJournalEntry)}\n`, { encoding: "utf8", mode: 0o600 });
        chmodSync(path, 0o600);
        cursors().set(event.sessionId, full.cursor);
        return full;
      } finally {
        await release();
      }
    });
  }

  listEvents(sessionId: string, afterCursor = 0): SessionCommandEvent[] {
    return parseLines<EventJournalEntry>(this.eventsPath(sessionId))
      .map((entry) => entry.event)
      .filter((event): event is SessionCommandEvent => Boolean(event && typeof event.cursor === "number" && event.cursor > afterCursor));
  }

  /** Compact only old terminal commands; active commands remain recoverable. */
  async compact(sessionId: string, now = Date.now()): Promise<void> {
    const path = this.commandsPath(sessionId);
    await serializeWrite(path, async () => {
      const directory = resolve(path, "..");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = await lockfile.lock(directory, {
        lockfilePath: `${path}.lock`,
        realpath: false,
        retries: { retries: 50, factor: 1.15, minTimeout: 4, maxTimeout: 50 },
      });
      try {
        const commands = this.loadCommands(sessionId);
        const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
        const terminal = new Set<SessionCommandStatus>(["completed", "failed", "cancelled", "expired", "interrupted"]);
        // UI submissions are the durable recovery archive, including commands
        // stopped before the SDK wrote a user message. Never age them out.
        const retained = new Set(commands.filter((command) => command.source !== "ui" && (!terminal.has(command.status) || command.acceptedAt >= cutoff)).slice(-this.retentionCount));
        const keep = commands.filter((command) => command.source === "ui" || retained.has(command));
        if (keep.length === commands.length) return;
        const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
        writeFileSync(temporary, keep.map((command) => JSON.stringify({ kind: "command", command } satisfies CommandJournalEntry)).join("\n") + (keep.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        await release();
      }
    });
  }
}

export function resetSessionControlStoreForTests(): void {
  globalThis.__pioraSessionControlCursors?.clear();
  globalThis.__pioraSessionControlWriteLocks?.clear();
}
