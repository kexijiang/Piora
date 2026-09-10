import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateTerminalCwd, type TerminalEvent, type TerminalSnapshot } from "../terminal-session";
import { getShellStore } from "./store";
import { ensureDefaultShell, getShell } from "./registry";
import { controlShellAgent } from "./agent";
import { ShellError, isShellError, shellText } from "./errors";
import type { ManagedShellSession } from "./session";
import type { ShellEvent } from "./types";

declare global { var __pioraLegacyShellLocks: Map<string, Promise<ManagedShellSession>> | undefined }

/** Pin the cwd-only legacy API to one persisted session, even as other tabs run. */
export async function getLegacyTerminal(value: unknown): Promise<ManagedShellSession> {
  const cwd = await validateTerminalCwd(value);
  const normalized = path.resolve(cwd);
  const key = `legacy-terminal:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
  const locks = globalThis.__pioraLegacyShellLocks ??= new Map();
  const pending = locks.get(key); if (pending) return pending;
  const load = (async () => {
    const store = getShellStore(); await store.ready;
    const id = await store.call<string | null>("getValue", { key });
    if (id) {
      try { return await getShell(id); }
      catch (error) { if (!isShellError(error) || error.status !== 404) throw error; }
    }
    const terminal = await ensureDefaultShell(cwd);
    await store.call("setValue", { key, value: terminal.state.id });
    return terminal;
  })().finally(() => locks.delete(key));
  locks.set(key, load); return load;
}

export function legacyTerminalSnapshot(terminal: ManagedShellSession): TerminalSnapshot {
  const snapshot = terminal.snapshot();
  return { connected: snapshot.session.connected, cwd: snapshot.session.cwd, output: snapshot.output, revision: snapshot.sequence, shell: snapshot.session.profile.label };
}
export function legacyTerminalEvent(event: ShellEvent): TerminalEvent | { type: "error"; error: string } | null {
  if (event.type === "output") return { type: "output", output: event.data, revision: event.sequence };
  if (event.type === "clear") return { type: "clear", revision: event.sequence };
  if (event.type === "session") return { type: "status", connected: event.session.connected, shell: event.session.profile.label, revision: event.sequence };
  if (event.type === "error") return { type: "error", error: event.error };
  return null;
}

export async function legacyTerminalAction(terminal: ManagedShellSession, body: Record<string, unknown>): Promise<TerminalSnapshot | { success: true }> {
  switch (body.action) {
    case "input": if (typeof body.data !== "string") throw new ShellError("Invalid terminal input"); terminal.input(body.data, body.replay === true); return { success: true };
    case "resize": terminal.resize(Number(body.cols), Number(body.rows)); return { success: true };
    case "start": await terminal.connect(); break;
    case "run": {
      const command = shellText(body.command, "command"); await terminal.start();
      if (terminal.state.integration === "ready") await terminal.execute(command, typeof body.clientRequestId === "string" ? body.clientRequestId : randomUUID());
      else terminal.input(`${command}\r`);
      break;
    }
    case "clear": terminal.clear(); break;
    case "stop": case "restart":
      if (terminal.state.activeRunId) await controlShellAgent(terminal, "cancel");
      await terminal.stop(); if (body.action === "restart") await terminal.connect(); break;
    default: throw new ShellError("Unsupported terminal action");
  }
  return legacyTerminalSnapshot(terminal);
}
