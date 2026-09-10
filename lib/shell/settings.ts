import { getShellStore } from "./store";
import { ShellError } from "./errors";
import type { ShellModelPreference, ShellSettings, HistorySource } from "./types";

export const DEFAULT_SHELL_SETTINGS: ShellSettings = { executable: null, model: null, importSystemHistory: true, importPiHistory: true, sources: [] };
export function normalizeShellModel(value: unknown): ShellModelPreference | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object") throw new ShellError("Invalid Shell model");
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || typeof model.modelId !== "string" || !model.provider.trim() || !model.modelId.trim()) throw new ShellError("Model provider and id are required");
  const thinkingLevel = typeof model.thinkingLevel === "string" ? model.thinkingLevel : undefined;
  if (thinkingLevel && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel)) throw new ShellError("Invalid thinking level");
  return { provider: model.provider.trim(), modelId: model.modelId.trim(), ...(thinkingLevel ? { thinkingLevel } : {}) };
}
export function normalizeShellSettings(value: unknown): ShellSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShellError("Invalid Shell settings");
  const raw = value as Record<string, unknown>;
  const executable = typeof raw.executable === "string" ? raw.executable.trim() || null : null;
  if (executable && (executable.includes("\0") || executable.length > 4096)) throw new ShellError("Invalid Shell executable");
  const sources: HistorySource[] = [];
  if (raw.sources !== undefined && (!Array.isArray(raw.sources) || raw.sources.length > 50)) throw new ShellError("Invalid history sources");
  for (const item of (raw.sources || []) as unknown[]) {
    if (!item || typeof item !== "object") throw new ShellError("Invalid history source");
    const source = item as HistorySource;
    if (typeof source.id !== "string" || !/^[\w:.-]{1,160}$/.test(source.id) || typeof source.path !== "string" || source.path.includes("\0") || !["powershell", "bash", "zsh"].includes(source.kind)) throw new ShellError("Invalid history source");
    sources.push({ id: source.id, path: source.path, kind: source.kind, enabled: source.enabled !== false });
  }
  return { executable, model: normalizeShellModel(raw.model), importSystemHistory: raw.importSystemHistory !== false, importPiHistory: raw.importPiHistory !== false, sources };
}
export async function readShellSettings(): Promise<ShellSettings> {
  const store = getShellStore(); await store.ready;
  return normalizeShellSettings(await store.call("getValue", { key: "settings" }) || DEFAULT_SHELL_SETTINGS);
}
export async function writeShellSettings(value: unknown): Promise<ShellSettings> {
  const settings = normalizeShellSettings(value);
  const store = getShellStore(); await store.ready;
  await store.call("setValue", { key: "settings", value: settings }); return settings;
}
