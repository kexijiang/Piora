export type CommandShortcut = {
  id: string;
  name: string;
  group: string;
  target: "device" | "local";
  command: string;
  kind: "shared" | "sandbox";
  bundleName?: string;
  favorite: boolean;
};

const MAX_SHORTCUTS = 20;
const MAX_ARCHIVE_CHARS = 256 * 1024;
const PARAMETER_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** Placeholders are whole shell arguments. Quoted placeholders are rejected to avoid mixed quote contexts. */
export function shortcutParameters(command: string): string[] {
  const names: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      if (command.slice(index + 1, index + 3) === "{{") throw new Error("Escaped placeholders are not supported");
      index++; continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (!quote) quote = char;
      continue;
    }
    if (char !== "{" || command[index + 1] !== "{") continue;
    const end = command.indexOf("}}", index + 2);
    if (end < 0) throw new Error("Close every {{parameter}} placeholder");
    const name = command.slice(index + 2, end);
    if (quote || !PARAMETER_NAME.test(name)) throw new Error("Placeholders must have simple names and stay outside shell quotes");
    if (!names.includes(name)) names.push(name);
    if (names.length > 10) throw new Error("A shortcut can use at most 10 parameters");
    index = end + 1;
  }
  return names;
}

function validShortcut(value: unknown): CommandShortcut | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(item.id)
    || typeof item.name !== "string" || !item.name.trim() || item.name.length > 60
    || typeof item.command !== "string" || !item.command.trim() || item.command.length > 8192
    || (item.kind !== "shared" && item.kind !== "sandbox")
    || (item.target !== undefined && item.target !== "device" && item.target !== "local")
    || (item.group !== undefined && (typeof item.group !== "string" || item.group.length > 40))
    || (item.bundleName !== undefined && (typeof item.bundleName !== "string" || item.bundleName.length > 256))) return null;
  if (item.kind === "sandbox" && item.target !== "local" && (!item.bundleName || typeof item.bundleName !== "string")) return null;
  try { shortcutParameters(item.command); } catch { return null; }
  return {
    id: item.id, name: item.name.trim(), group: typeof item.group === "string" ? item.group.trim() : "",
    target: item.target === "local" ? "local" : "device", command: item.command,
    kind: item.kind, ...(item.bundleName ? { bundleName: item.bundleName } : {}), favorite: item.favorite === true,
  };
}

/** Keep old localStorage arrays readable while rejecting malformed records. */
export function normalizeCommandShortcuts(value: unknown): CommandShortcut[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.map(validShortcut).filter((item): item is CommandShortcut => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id); return true;
  }).slice(0, MAX_SHORTCUTS);
}

export function parseShortcutArchive(text: string): CommandShortcut[] {
  if (text.length > MAX_ARCHIVE_CHARS) throw new Error("Shortcut archive is too large");
  const archive = JSON.parse(text) as { format?: unknown; version?: unknown; shortcuts?: unknown };
  if (!archive || archive.format !== "piora-harmony-shortcuts" || archive.version !== 1 || !Array.isArray(archive.shortcuts)
    || archive.shortcuts.length > MAX_SHORTCUTS) throw new Error("Unsupported shortcut archive");
  const parsed = normalizeCommandShortcuts(archive.shortcuts);
  if (parsed.length !== archive.shortcuts.length) throw new Error("Shortcut archive contains invalid or duplicate entries");
  return parsed;
}

export function serializeShortcutArchive(shortcuts: CommandShortcut[]): string {
  return `${JSON.stringify({ format: "piora-harmony-shortcuts", version: 1, shortcuts }, null, 2)}\n`;
}

export function expandShortcut(shortcut: CommandShortcut, values: Record<string, string>): string {
  const names = shortcutParameters(shortcut.command);
  const replacements = new Map<string, string>();
  for (const name of names) {
    const value = values[name];
    if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Enter a single-line value for ${name}`);
    if (shortcut.target === "local") {
      if (!/^[\p{L}\p{N}._:/@\\-]+$/u.test(value)) throw new Error(`Local parameter ${name} accepts only plain path or identifier characters`);
      replacements.set(name, value);
    } else replacements.set(name, `'${value.replaceAll("'", "'\\''")}'`);
  }
  return shortcut.command.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,31})\}\}/g, (_, name: string) => replacements.get(name) ?? "");
}

export function mergeCommandShortcuts(existing: CommandShortcut[], incoming: CommandShortcut[], newId: () => string): { shortcuts: CommandShortcut[]; added: number; skipped: number } {
  const next = [...existing];
  let added = 0, skipped = 0;
  for (const item of incoming) {
    if (next.some(current => current.group === item.group && current.name === item.name && current.target === item.target)) { skipped++; continue; }
    if (next.length >= MAX_SHORTCUTS) throw new Error("Import would exceed 20 shortcuts; remove some before importing");
    next.push({ ...item, id: newId() }); added++;
  }
  return { shortcuts: next, added, skipped };
}
