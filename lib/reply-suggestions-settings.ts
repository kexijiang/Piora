import { defaultReplySettings, validateReplySettings, type ReplySettings } from "./reply-suggestions";
export const REPLY_SETTINGS_KEY = "piora-reply-suggestions-settings-v1";
export const REPLY_SETTINGS_EVENT = "piora:reply-suggestions-settings";
export const OPEN_REPLY_SETTINGS_EVENT = "piora:open-reply-settings";
export function readReplySettings(): ReplySettings {
  try { const raw = localStorage.getItem(REPLY_SETTINGS_KEY); return raw ? validateReplySettings(JSON.parse(raw)) : defaultReplySettings(); } catch { return defaultReplySettings(); }
}
export function saveReplySettings(value: ReplySettings) {
  localStorage.setItem(REPLY_SETTINGS_KEY, JSON.stringify(validateReplySettings(value)));
  window.dispatchEvent(new Event(REPLY_SETTINGS_EVENT));
}
export function subscribeReplySettings(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === REPLY_SETTINGS_KEY) listener(); };
  window.addEventListener(REPLY_SETTINGS_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(REPLY_SETTINGS_EVENT, listener); window.removeEventListener("storage", storage); };
}
