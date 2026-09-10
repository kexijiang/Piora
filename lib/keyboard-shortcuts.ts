export const KEYBOARD_SHORTCUT_STORAGE_KEY = "piora-keyboard-shortcuts:v1";

export const APPLICATION_SHORTCUTS = [
  { id: "navigate.newSession", titleKey: "commands.newSession", descriptionKey: "shortcuts.newSessionDescription", defaultBinding: "Mod+Alt+N" },
  { id: "navigate.chooseProject", titleKey: "commands.chooseProject", descriptionKey: "shortcuts.chooseProjectDescription", defaultBinding: "Mod+O" },
  { id: "navigate.searchFiles", titleKey: "commands.searchFiles", descriptionKey: "shortcuts.searchFilesDescription", defaultBinding: "Mod+P" },
  { id: "navigate.searchChats", titleKey: "commands.searchChats", descriptionKey: "shortcuts.searchChatsDescription", defaultBinding: "Mod+Shift+F" },
  { id: "palette.open", titleKey: "shortcuts.commandPalette", descriptionKey: "shortcuts.commandPaletteDescription", defaultBinding: "Mod+K" },
  { id: "panel.toggleSidebar", titleKey: "commands.toggleSidebar", descriptionKey: "shortcuts.toggleSidebarDescription", defaultBinding: "Mod+B" },
  { id: "panel.files", titleKey: "commands.openFiles", descriptionKey: "shortcuts.openFilesDescription", defaultBinding: "Mod+J" },
  { id: "panel.commands", titleKey: "commands.openCommands", descriptionKey: "shortcuts.openCommandsDescription", defaultBinding: "Mod+Backquote" },
  { id: "panel.review", titleKey: "commands.openReview", descriptionKey: "shortcuts.openReviewDescription", defaultBinding: "Mod+Shift+G" },
  { id: "panel.browser", titleKey: "commands.openBrowser", descriptionKey: "shortcuts.openBrowserDescription", defaultBinding: "Mod+T" },
  { id: "companion.togglePanel", titleKey: "commands.openCompanionPanel", descriptionKey: "shortcuts.companionPanelDescription", defaultBinding: "Ctrl+Space" },
  { id: "companion.clipboard", titleKey: "commands.openClipboard", descriptionKey: "shortcuts.clipboardDescription", defaultBinding: "Mod+Alt+V" },
  { id: "settings.general", titleKey: "commands.settings", descriptionKey: "shortcuts.settingsDescription", defaultBinding: "Mod+," },
] as const;

export type ApplicationShortcutId = typeof APPLICATION_SHORTCUTS[number]["id"];
export type ShortcutOverrides = Partial<Record<ApplicationShortcutId, string | null>>;
export type ResolvedShortcutBindings = Record<ApplicationShortcutId, string | null>;

const SHORTCUT_IDS = new Set<string>(APPLICATION_SHORTCUTS.map((item) => item.id));
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const NAMED_KEYS = new Set([
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete",
  "Backquote", "End", "Enter", "Home", "Insert", "PageDown", "PageUp", "Space", "Tab",
]);
const RESERVED_SHORTCUT_BINDINGS = new Set([
  "Mod+A", "Mod+C", "Mod+F", "Mod+Q", "Mod+V", "Mod+W", "Mod+X", "Mod+Y", "Mod+Z", "Mod+Shift+Z",
]);

export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator === "undefined" ? "" : navigator.platform);
  return /mac|iphone|ipad|ipod/i.test(value);
}

function normalizeKey(rawKey: string): string | null {
  if (rawKey === " ") return "Space";
  if (rawKey === "`") return "Backquote";
  if (rawKey.length === 1) {
    if (/^[a-z]$/i.test(rawKey)) return rawKey.toUpperCase();
    if (/^[0-9`,.\/[\]\\;='-]$/.test(rawKey)) return rawKey;
    return null;
  }
  if (/^F(?:[1-9]|1[0-2])$/i.test(rawKey)) return rawKey.toUpperCase();
  const named = [...NAMED_KEYS].find((candidate) => candidate.toLowerCase() === rawKey.toLowerCase());
  return named ?? null;
}

export function normalizeShortcutBinding(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) return null;
  const parts = raw.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = normalizeKey(parts.at(-1) ?? "");
  if (!key) return null;
  const modifierSet = new Set<string>();
  for (const modifier of parts.slice(0, -1)) {
    const canonical = MODIFIER_ORDER.find((candidate) => candidate.toLowerCase() === modifier.toLowerCase());
    if (!canonical || modifierSet.has(canonical)) return null;
    modifierSet.add(canonical);
  }
  if (modifierSet.size === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key)) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifierSet.has(modifier)), key].join("+");
}

export function recordShortcutFromEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac = isMacPlatform()): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return null;
  const key = normalizeKey(event.key);
  if (!key || key === "Backspace" || key === "Delete") return null;
  const modifiers: string[] = [];
  if (mac ? event.metaKey : event.ctrlKey) modifiers.push("Mod");
  if (mac && event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return normalizeShortcutBinding([...modifiers, key].join("+"));
}

export function formatShortcutBinding(binding: string | null, mac = isMacPlatform()): string {
  if (!binding) return "";
  return binding.split("+").map((part) => part === "Mod" ? (mac ? "Cmd" : "Ctrl") : part === "Backquote" ? "`" : part).join("+");
}

export function isReservedShortcutBinding(binding: string | null): boolean {
  return Boolean(binding && RESERVED_SHORTCUT_BINDINGS.has(binding));
}

export function shortcutMatchesEvent(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, binding: string | null, mac = isMacPlatform()): boolean {
  if (!binding) return false;
  const parts = binding.split("+");
  const key = normalizeKey(event.key);
  if (!key || key !== parts.at(-1)) return false;
  const expectedPrimary = parts.includes("Mod");
  const expectedCtrl = parts.includes("Ctrl") || (!mac && expectedPrimary);
  const expectedMeta = mac && expectedPrimary;
  return event.ctrlKey === expectedCtrl
    && event.metaKey === expectedMeta
    && event.altKey === parts.includes("Alt")
    && event.shiftKey === parts.includes("Shift");
}

export function resolveShortcutBindings(overrides: ShortcutOverrides): ResolvedShortcutBindings {
  const used = new Set<string>();
  const resolved = {} as ResolvedShortcutBindings;
  for (const item of APPLICATION_SHORTCUTS) {
    const requested = Object.prototype.hasOwnProperty.call(overrides, item.id) ? overrides[item.id] ?? null : item.defaultBinding;
    const chosen = requested && used.has(requested) ? null : requested;
    resolved[item.id] = chosen;
    if (chosen) used.add(chosen);
  }
  return resolved;
}

export function findShortcutConflict(bindings: ResolvedShortcutBindings, commandId: ApplicationShortcutId, binding: string | null): ApplicationShortcutId | null {
  if (!binding) return null;
  return (APPLICATION_SHORTCUTS.find((item) => item.id !== commandId && bindings[item.id] === binding)?.id ?? null) as ApplicationShortcutId | null;
}

export function parseShortcutOverrides(raw: string | null): ShortcutOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { version?: unknown; overrides?: unknown };
    if (parsed.version !== 1 || !parsed.overrides || typeof parsed.overrides !== "object" || Array.isArray(parsed.overrides)) return {};
    const result: ShortcutOverrides = {};
    for (const [id, value] of Object.entries(parsed.overrides)) {
      if (!SHORTCUT_IDS.has(id)) continue;
      if (value === null) result[id as ApplicationShortcutId] = null;
      else {
        const normalized = normalizeShortcutBinding(value);
        if (normalized && !isReservedShortcutBinding(normalized)) result[id as ApplicationShortcutId] = normalized;
      }
    }
    return result;
  } catch {
    return {};
  }
}

export function serializeShortcutOverrides(overrides: ShortcutOverrides): string {
  return JSON.stringify({ version: 1, overrides });
}

export function shouldPreserveApplicationShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest([
    "[data-app-shortcuts='preserve']",
    "input",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='textbox']",
    ".xterm",
  ].join(",")));
}
