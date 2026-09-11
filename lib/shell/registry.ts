import { randomUUID } from "node:crypto";
import path from "node:path";
import { validateTerminalCwd } from "../terminal-session";
import { getShellStore } from "./store";
import { ManagedShellSession } from "./session";
import { resolveShellProfile } from "./profiles";
import { readShellSettings } from "./settings";
import { ShellError, shellId } from "./errors";
import type { ShellSession } from "./types";

declare global {
  var __pioraManagedShells: Map<string, ManagedShellSession> | undefined;
  var __pioraManagedShellLoads: Map<string, Promise<ManagedShellSession>> | undefined;
  var __pioraDefaultShells: Map<string, Promise<ManagedShellSession>> | undefined;
}
const registry = () => globalThis.__pioraManagedShells ??= new Map();
export async function ensureDefaultShell(cwd: string): Promise<ManagedShellSession> {
  const validated = await validateTerminalCwd(cwd);
  const key = process.platform === "win32" ? validated.toLowerCase() : validated;
  const defaults = globalThis.__pioraDefaultShells ??= new Map();
  const existing = defaults.get(key); if (existing) return existing;
  const pending = (async () => { const sessions = await listShells(validated); return sessions.length ? getShell(sessions[0].id) : createShell(validated); })().finally(() => defaults.delete(key));
  defaults.set(key, pending); return pending;
}
export async function createShell(cwd: string, executable?: string | null, workspaceCwd = cwd): Promise<ManagedShellSession> {
  cwd = await validateTerminalCwd(cwd);
  workspaceCwd = await validateTerminalCwd(workspaceCwd);
  const settings = await readShellSettings();
  const profile = await resolveShellProfile(executable || settings.executable);
  const now = Date.now();
  const state: ShellSession = { id: randomUUID(), title: path.basename(cwd), initialCwd: cwd, workspaceCwd, cwd, profile, createdAt: now, updatedAt: now, generation: 0, connected: false, integration: "starting", integrationError: null, owner: "human", activeCommandId: null, activeRunId: null, model: null, draft: "", closed: false };
  const store = getShellStore(); await store.put("session", state.id, state);
  const session = new ManagedShellSession(state, store); registry().set(state.id, session);
  return session;
}
export async function getShell(id: string): Promise<ManagedShellSession> {
  shellId(id);
  const existing = registry().get(id);
  if (existing) { await validateTerminalCwd(existing.state.initialCwd); return existing; }
  const loads = globalThis.__pioraManagedShellLoads ??= new Map();
  const pending = loads.get(id); if (pending) return pending;
  const load = (async () => {
    const store = getShellStore();
    const state = await store.get<ShellSession>("session", id);
    if (!state || state.closed) throw new ShellError("Terminal not found", 404);
    await validateTerminalCwd(state.initialCwd);
    // Existing automatically selected PowerShell tabs adopt the packaged shell.
    // Explicit custom shell preferences are still honored.
    if (state.profile.kind === "powershell" && !state.profile.bundled && process.env.PIORA_BUNDLED_PWSH) {
      const settings = await readShellSettings();
      if (!settings.executable && !process.env.PI_TERMINAL_SHELL) state.profile = await resolveShellProfile();
    }
    const session = new ManagedShellSession(state, store); await session.hydrate(); registry().set(id, session); return session;
  })().finally(() => loads.delete(id));
  loads.set(id, load); return load;
}
export async function listShells(cwd: string): Promise<ShellSession[]> {
  const validated = await validateTerminalCwd(cwd);
  const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const sessions = await getShellStore().list<ShellSession>("session", undefined, 1000);
  return sessions.filter(session => !session.closed && key(session.workspaceCwd || session.initialCwd) === key(validated)).map(session => registry().get(session.id)?.snapshot().session || session);
}
export async function closeShell(id: string): Promise<void> {
  const session = await getShell(id);
  if (session.state.activeRunId) throw new ShellError("Stop the Agent task before closing this terminal", 409);
  session.state.closed = true; await session.dispose(); registry().delete(id);
}
