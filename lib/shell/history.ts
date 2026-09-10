import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { readdir, access } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getShellStore } from "./store";
import { readShellSettings } from "./settings";
import type { HistorySource } from "./types";

const sourceId = (value: string) => "file:" + createHash("sha256").update(process.platform === "win32" ? value.toLowerCase() : value).digest("hex");
export async function discoverHistorySources(): Promise<HistorySource[]> {
  const home = homedir();
  const candidates: Array<{ path: string; kind: HistorySource["kind"] }> = [
    { path: path.join(home, ".bash_history"), kind: "bash" }, { path: path.join(home, ".zsh_history"), kind: "zsh" },
  ];
  const powershell = process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "PowerShell", "PSReadLine") : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "powershell", "PSReadLine");
  try { for (const name of await readdir(powershell)) if (name.endsWith("_history.txt")) candidates.push({ path: path.join(powershell, name), kind: "powershell" }); } catch { /* Not installed. */ }
  const existing = await Promise.all(candidates.map(async candidate => { try { await access(candidate.path); return { ...candidate, id: sourceId(candidate.path), enabled: true }; } catch { return null; } }));
  return existing.filter((item): item is HistorySource => item !== null);
}
declare global { var __pioraShellHistorySync: { promise: Promise<HistorySource[]> | null; nextAt: number } | undefined }
export async function syncShellHistory(force = false): Promise<HistorySource[]> {
  const state = globalThis.__pioraShellHistorySync ??= { promise: null, nextAt: 0 };
  if (state.promise) return state.promise;
  const store = getShellStore(); await store.ready;
  if (!force && Date.now() < state.nextAt) return await store.call<HistorySource[] | null>("getValue", { key: "source-status" }) || [];
  state.promise = (async () => {
    const settings = await readShellSettings();
    const discovered = settings.importSystemHistory ? await discoverHistorySources() : [];
    const sources = new Map(discovered.map(source => [source.id, source]));
    for (const source of settings.sources) sources.set(source.id, source);
    const result = await store.call<HistorySource[]>("importSources", { sources: [...sources.values()], piDirectory: settings.importPiHistory ? path.join(getAgentDir(), "sessions") : undefined });
    state.nextAt = Date.now() + 30_000;
    return result;
  })().finally(() => { state.promise = null; });
  return state.promise;
}
export function redactShellSecrets(value: string): string {
  return value
    .replace(/((?:--?(?:api[-_]?key|token|password|secret)|(?:API[_-]?KEY|ACCESS[_-]?TOKEN|PASSWORD|SECRET))\s*(?:=|\s)\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
