import type { ShellEvent, ShellSnapshot, ShellTimelinePage } from "./types";
import { resolveWorkspaceFilePath } from "../file-links";

/** Resolve output against the command's original cwd, even after the tab moved. */
export function resolveShellOutputFile(file: string, cwd: string): string | null {
  const clean = file.trim().replace(/:\d+(?::\d+)?$/, "");
  const normalized = /^[a-zA-Z]:[\\/]|^\\\\/.test(cwd) ? clean.replaceAll("\\", "/") : clean;
  return resolveWorkspaceFilePath(/^[a-zA-Z]:[\\/]|^[\\/]/.test(normalized) ? normalized : `${cwd}/${normalized}`);
}

export function mergeShellTimeline(current: ShellSnapshot, archive: Pick<ShellTimelinePage, "commands" | "runs">): ShellSnapshot {
  return { ...current, commands: [...new Map([...archive.commands, ...current.commands].map(command => [command.id, command])).values()], runs: [...new Map([...archive.runs, ...current.runs].map(run => [run.id, run])).values()] };
}

export async function shellRequest<T>(endpoint: string, body?: unknown, options: { method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api/shell/${endpoint}`, { method: options.method || (body === undefined ? "GET" : "POST"), headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal, cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value as T;
}
export function applyShellEvent(current: ShellSnapshot | null, event: ShellEvent): ShellSnapshot | null {
  if (current && current.session.id !== event.terminalId) return current;
  if (current && (event.generation < current.session.generation || event.generation === current.session.generation && event.sequence < current.sequence)) return current;
  if (event.type === "snapshot") return event.snapshot;
  if (!current || event.sequence <= current.sequence && event.generation === current.session.generation) return current;
  const next = { ...current, sequence: event.sequence, session: { ...current.session, generation: event.generation } };
  if (event.type === "session") next.session = event.session;
  else if (event.type === "command") next.commands = [...next.commands.filter(item => item.id !== event.command.id), event.command].sort((a, b) => (a.startedAt || Number.MAX_SAFE_INTEGER) - (b.startedAt || Number.MAX_SAFE_INTEGER));
  else if (event.type === "run") next.runs = [...next.runs.filter(item => item.id !== event.run.id), event.run].sort((a, b) => a.startedAt - b.startedAt);
  else if (event.type === "output") next.output = (next.output + event.data).slice(-500_000);
  else if (event.type === "clear") next.output = "";
  return next;
}
