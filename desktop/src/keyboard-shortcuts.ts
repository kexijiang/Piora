export const DESKTOP_SHORTCUT_IDS = [
  "navigate.newSession",
  "navigate.chooseProject",
  "navigate.searchFiles",
  "navigate.searchChats",
  "palette.open",
  "panel.toggleSidebar",
  "panel.files",
  "panel.commands",
  "panel.review",
  "panel.browser",
  "companion.togglePanel",
  "companion.clipboard",
  "settings.general",
] as const;

export type DesktopShortcutId = typeof DESKTOP_SHORTCUT_IDS[number];
export type DesktopShortcutBindings = Record<DesktopShortcutId, string | null>;

export const DEFAULT_DESKTOP_SHORTCUT_BINDINGS: DesktopShortcutBindings = {
  "navigate.newSession": "Mod+Alt+N",
  "navigate.chooseProject": "Mod+O",
  "navigate.searchFiles": "Mod+P",
  "navigate.searchChats": "Mod+Shift+F",
  "palette.open": "Mod+K",
  "panel.toggleSidebar": "Mod+B",
  "panel.files": "Mod+J",
  "panel.commands": "Mod+Backquote",
  "panel.review": "Mod+Shift+G",
  "panel.browser": "Mod+T",
  "companion.togglePanel": "Ctrl+Space",
  "companion.clipboard": "Mod+Alt+V",
  "settings.general": "Mod+,",
};

const ID_SET = new Set<string>(DESKTOP_SHORTCUT_IDS);
const RESERVED = new Set(["Mod+A", "Mod+C", "Mod+F", "Mod+Q", "Mod+V", "Mod+W", "Mod+X", "Mod+Y", "Mod+Z", "Mod+Shift+Z"]);
const MODIFIERS = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const NAMED_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Backquote", "Delete", "End", "Enter", "Home", "Insert", "PageDown", "PageUp", "Space", "Tab"]);

function normalizeKey(raw: string): string | null {
  if (raw.length === 1 && /^[A-Z0-9,.\/[\]\\;='-]$/.test(raw)) return raw;
  if (/^F(?:[1-9]|1[0-2])$/.test(raw) || NAMED_KEYS.has(raw)) return raw;
  return null;
}

function normalizeBinding(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return undefined;
  const parts = raw.split("+");
  const key = normalizeKey(parts.at(-1) ?? "");
  if (!key) return undefined;
  const seen = new Set<string>();
  for (const modifier of parts.slice(0, -1)) {
    if (!MODIFIERS.includes(modifier as typeof MODIFIERS[number]) || seen.has(modifier)) return undefined;
    seen.add(modifier);
  }
  if (seen.size === 0 && !key.startsWith("F")) return undefined;
  const normalized = [...MODIFIERS.filter((modifier) => seen.has(modifier)), key].join("+");
  return RESERVED.has(normalized) ? undefined : normalized;
}

export function parseDesktopShortcutBindings(input: unknown): DesktopShortcutBindings | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input);
  if (entries.length !== DESKTOP_SHORTCUT_IDS.length || entries.some(([id]) => !ID_SET.has(id))) return null;
  const result = {} as DesktopShortcutBindings;
  const used = new Set<string>();
  for (const id of DESKTOP_SHORTCUT_IDS) {
    if (!Object.prototype.hasOwnProperty.call(input, id)) return null;
    const binding = normalizeBinding((input as Record<string, unknown>)[id]);
    if (binding === undefined || (binding !== null && used.has(binding))) return null;
    result[id] = binding;
    if (binding) used.add(binding);
  }
  return result;
}

export function toElectronAccelerator(binding: string | null): string | undefined {
  return binding?.replace(/^Mod(?=\+|$)/, "CmdOrCtrl").replace(/\+Backquote$/, "+`") || undefined;
}
