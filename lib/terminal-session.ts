import type { IPty } from "node-pty";
import { loadTerminalPty } from "./terminal-pty";
import { statSync } from "node:fs";
import path from "node:path";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "./file-access";

const MAX_OUTPUT_CHARS = 500_000;
const MAX_COMMAND_CHARS = 64 * 1024;
const IDLE_DISPOSE_MS = 20 * 60 * 1_000;

export type TerminalEvent =
  | { type: "clear"; revision: number }
  | { type: "output"; output: string; revision: number }
  | { type: "status"; connected: boolean; revision: number; shell: string };

export interface TerminalSnapshot {
  connected: boolean;
  cwd: string;
  output: string;
  revision: number;
  shell: string;
}

type TerminalListener = (event: TerminalEvent) => void;

export class TerminalSessionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_terminal_request",
  ) {
    super(message);
    this.name = "TerminalSessionError";
  }
}

export function isTerminalSessionError(value: unknown): value is TerminalSessionError {
  if (!(value instanceof Error) || value.name !== "TerminalSessionError") return false;
  const error = value as TerminalSessionError;
  return Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 && typeof error.code === "string";
}

function shellDefinition(): { executable: string; args: string[]; label: string } {
  const configured = process.env.PI_TERMINAL_SHELL?.trim();
  if (configured) {
    return { executable: configured, args: [], label: path.basename(configured) };
  }
  if (process.platform === "win32") {
    const executable = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
    return { executable, args: ["/D", "/Q", "/K"], label: path.win32.basename(executable) };
  }
  const executable = process.env.SHELL?.trim() || "/bin/sh";
  const label = path.basename(executable);
  return { executable, args: [], label };
}

function terminalKey(cwd: string): string {
  const normalized = isWindowsAbsolutePath(cwd) ? path.win32.resolve(cwd) : path.resolve(cwd);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export async function validateTerminalCwd(value: unknown): Promise<string> {
  const cwd = typeof value === "string" ? value.trim() : "";
  if (!cwd || (!path.isAbsolute(cwd) && !isWindowsAbsolutePath(cwd))) {
    throw new TerminalSessionError("cwd must be an absolute path");
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots) || !isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw new TerminalSessionError("Access denied", 403, "access_denied");
  }
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    throw new TerminalSessionError("Directory not found", 404, "directory_not_found");
  }
  if (!stat.isDirectory()) throw new TerminalSessionError("cwd must be a directory");
  return isWindowsAbsolutePath(cwd) ? path.win32.resolve(cwd) : path.resolve(cwd);
}

export class TerminalSession {
  private child: IPty | null = null;
  private cols = 100;
  private rows = 30;
  private closed: Promise<void> = Promise.resolve();
  private connected = false;
  private generation = 0;
  private listeners = new Set<TerminalListener>();
  private output = "";
  private revision = 0;
  private shell = "";
  private deviceAttributesAnswered = false;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(readonly cwd: string) {}

  snapshot(): TerminalSnapshot {
    return {
      connected: this.connected,
      cwd: this.cwd,
      output: this.output,
      revision: this.revision,
      shell: this.shell,
    };
  }

  start(): TerminalSnapshot {
    this.touch();
    if (this.child && this.connected) return this.snapshot();

    const definition = shellDefinition();
    this.deviceAttributesAnswered = false;
    const generation = ++this.generation;
    this.shell = definition.label;
    const child = loadTerminalPty().spawn(definition.executable, definition.args, {
      cwd: this.cwd,
      env: Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color", TERM_PROGRAM: "Piora" }).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
      useConptyDll: process.platform === "win32",
    });
    this.child = child;
    this.connected = true;
    this.emitStatus();
    child.onData((chunk) => {
      if (generation === this.generation) this.append(chunk);
    });
    this.closed = new Promise<void>((resolve) => child.onExit(({ exitCode, signal }) => {
      resolve();
      if (generation !== this.generation) return;
      this.connected = false;
      this.child = null;
      this.append(`\r\n\u001b[2m[terminal exited: ${signal ? `signal ${signal}` : `code ${exitCode}`}]\u001b[0m\r\n`);
      this.emitStatus();
    }));
    return this.snapshot();
  }

  run(rawCommand: unknown): TerminalSnapshot {
    const command = typeof rawCommand === "string" ? rawCommand.trim() : "";
    if (!command) throw new TerminalSessionError("command is required");
    if (command.length > MAX_COMMAND_CHARS) throw new TerminalSessionError("command is too large", 413, "command_too_large");
    if (command.includes("\0")) throw new TerminalSessionError("command contains an invalid null byte");
    this.start();
    if (!this.child) throw new TerminalSessionError("Shell is not available", 409, "shell_unavailable");
    this.child.write(`${command}\r`);
    this.touch();
    return this.snapshot();
  }

  input(data: unknown, replay = false): void {
    if (typeof data !== "string" || data.length > MAX_COMMAND_CHARS || data.includes("\0")) {
      throw new TerminalSessionError("Invalid terminal input");
    }
    if (!this.child || !this.connected) throw new TerminalSessionError("Shell is not available", 409, "shell_unavailable");
    const deviceAttributes = /^\x1b\[\?[\d;]+c$/.test(data);
    // A first attachment may contain ConPTY's still-unanswered startup query.
    // Allow that handshake once; replaying old queries must never type replies
    // into an already-running shell. Live application queries remain unchanged.
    if (replay && !(process.platform === "win32" && deviceAttributes && !this.deviceAttributesAnswered)) return;
    if (deviceAttributes) this.deviceAttributesAnswered = true;
    this.child.write(data);
    this.touch();
  }

  resize(cols: unknown, rows: unknown): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || (cols as number) < 2 || (cols as number) > 500 || (rows as number) < 1 || (rows as number) > 300) {
      throw new TerminalSessionError("Invalid terminal dimensions");
    }
    this.cols = cols as number;
    this.rows = rows as number;
    this.child?.resize(this.cols, this.rows);
  }

  clear(): TerminalSnapshot {
    this.output = "";
    this.revision += 1;
    this.emit({ type: "clear", revision: this.revision });
    this.touch();
    return this.snapshot();
  }

  restart(): TerminalSnapshot {
    this.stop(false);
    return this.start();
  }

  stop(announce = true): TerminalSnapshot {
    this.touch();
    const child = this.child;
    this.generation += 1;
    this.child = null;
    this.connected = false;
    if (child) { try { child.kill(); } catch { /* Already exited. */ } }
    if (announce) this.append("\r\n\u001b[2m[terminal stopped]\u001b[0m\r\n");
    this.emitStatus();
    return this.snapshot();
  }

  subscribe(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    this.touch();
    return () => {
      this.listeners.delete(listener);
      this.touch();
    };
  }

  async dispose(): Promise<void> {
    const closed = this.closed;
    this.stop(false);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.listeners.clear();
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      void closed.then(() => { clearTimeout(timeout); resolve(); });
    });
  }

  private append(chunk: string): void {
    if (!chunk) return;
    this.output = `${this.output}${chunk}`;
    if (this.output.length > MAX_OUTPUT_CHARS) this.output = this.output.slice(-MAX_OUTPUT_CHARS);
    this.revision += 1;
    this.emit({ type: "output", output: chunk, revision: this.revision });
    this.touch();
  }

  private emitStatus(): void {
    this.revision += 1;
    this.emit({ type: "status", connected: this.connected, revision: this.revision, shell: this.shell });
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.listeners.size > 0) {
        this.touch();
        return;
      }
      terminalSessions().delete(terminalKey(this.cwd));
      this.dispose();
    }, IDLE_DISPOSE_MS);
    this.idleTimer.unref?.();
  }
}

declare global {
  var __pioraTerminalSessions: Map<string, TerminalSession> | undefined;
}

function terminalSessions(): Map<string, TerminalSession> {
  return globalThis.__pioraTerminalSessions ??= new Map();
}

export function getTerminalSession(cwd: string): TerminalSession {
  const key = terminalKey(cwd);
  const existing = terminalSessions().get(key);
  if (existing) return existing;
  const created = new TerminalSession(cwd);
  terminalSessions().set(key, created);
  return created;
}

export async function resetTerminalSessionsForTests(): Promise<void> {
  await Promise.all([...terminalSessions().values()].map(async (session) => await session.dispose()));
  terminalSessions().clear();
}
