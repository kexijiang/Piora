import {
  formatShortcutBinding,
  isReservedShortcutBinding,
  normalizeShortcutBinding,
  recordShortcutFromEvent,
  shortcutMatchesEvent,
} from "./keyboard-shortcuts";

export type SendShortcut = string | null;
export type ChatShortcutAction = "send" | "steer" | "newline";
export interface ChatShortcutBindings { send: SendShortcut; steer: SendShortcut; newline: SendShortcut }
export type ChatShortcutError = "invalid" | "reserved" | "conflict";
export const DEFAULT_SEND_SHORTCUT = "Enter";
export const DEFAULT_CHAT_SHORTCUTS: ChatShortcutBindings = { send: DEFAULT_SEND_SHORTCUT, steer: null, newline: "Shift+Enter" };
export const SEND_SHORTCUT_STORAGE_KEY = "piora-send-shortcut:v1";
export const CHAT_SHORTCUT_STORAGE_KEY = "piora-chat-shortcuts:v2";

export interface SendShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export function isPlainEnter(event: SendShortcutKeyEvent): boolean {
  return event.key === "Enter" && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

export function normalizeChatShortcut(value: unknown): string | null {
  return value === "Enter" ? value : normalizeShortcutBinding(value);
}

export function isReservedChatShortcut(binding: string): boolean {
  const canonical = binding.replace(/^Ctrl\+/, "Mod+");
  return binding.endsWith("Tab")
    || /^(?:Mod|Ctrl)\+(?:.*\+)?[YZ]$/.test(binding)
    || /^Shift\+(?:[A-Z0-9]|Space|Arrow\w+|Home|End|PageUp|PageDown)$/.test(binding)
    || isReservedShortcutBinding(canonical);
}

export function validateChatShortcut(bindings: ChatShortcutBindings, action: ChatShortcutAction, value: unknown): ChatShortcutError | null {
  if (value === null) return null;
  const binding = normalizeChatShortcut(value);
  if (!binding) return "invalid";
  if (isReservedChatShortcut(binding)) return "reserved";
  if (Object.entries(bindings).some(([otherAction, other]) => otherAction !== action && other && formatShortcutBinding(other) === formatShortcutBinding(binding))) return "conflict";
  return null;
}

export function parseStoredSendShortcut(value: string | null): SendShortcut {
  return value === "ctrl-enter" ? "Ctrl+Enter" : DEFAULT_SEND_SHORTCUT;
}

export function parseChatShortcuts(raw: string | null, legacy: string | null = null): ChatShortcutBindings {
  const fallback = { ...DEFAULT_CHAT_SHORTCUTS, send: parseStoredSendShortcut(legacy) };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 2 || !parsed.bindings || typeof parsed.bindings !== "object") return fallback;
    const result: ChatShortcutBindings = { send: null, steer: null, newline: null };
    for (const action of ["send", "steer", "newline"] as const) {
      const value = parsed.bindings[action] === undefined ? DEFAULT_CHAT_SHORTCUTS[action] : parsed.bindings[action];
      if (!validateChatShortcut(result, action, value)) result[action] = value === null ? null : normalizeChatShortcut(value);
      else if (!validateChatShortcut(result, action, DEFAULT_CHAT_SHORTCUTS[action])) result[action] = DEFAULT_CHAT_SHORTCUTS[action];
    }
    return result;
  } catch {
    return fallback;
  }
}

export function recordChatShortcut(event: SendShortcutKeyEvent): string | null {
  return isPlainEnter(event) ? "Enter" : recordShortcutFromEvent(event);
}

export function matchesSendShortcut(event: SendShortcutKeyEvent, shortcut: SendShortcut): boolean {
  return shortcutMatchesEvent(event, shortcut);
}

export function matchesSteerShortcut(event: SendShortcutKeyEvent, shortcut: SendShortcut): boolean {
  return shortcutMatchesEvent(event, shortcut);
}
