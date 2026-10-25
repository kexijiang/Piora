"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  CHAT_SHORTCUT_STORAGE_KEY,
  DEFAULT_CHAT_SHORTCUTS,
  SEND_SHORTCUT_STORAGE_KEY,
  normalizeChatShortcut,
  parseChatShortcuts,
  validateChatShortcut,
  type ChatShortcutAction,
  type ChatShortcutBindings,
  type SendShortcut,
} from "@/lib/send-shortcut";

const listeners = new Set<() => void>();
let currentBindings = DEFAULT_CHAT_SHORTCUTS;
let storageListenerAttached = false;

function commitBindings(bindings: ChatShortcutBindings, persist: boolean): void {
  if (persist) {
    try {
      window.localStorage.setItem(CHAT_SHORTCUT_STORAGE_KEY, JSON.stringify({ version: 2, bindings }));
    } catch {
      // Keep the preference active for this renderer when storage is unavailable.
    }
  }
  if (bindings.send === currentBindings.send && bindings.steer === currentBindings.steer && bindings.newline === currentBindings.newline) return;
  currentBindings = bindings;
  listeners.forEach((listener) => listener());
}

function readStorage(): void {
  try {
    commitBindings(parseChatShortcuts(window.localStorage.getItem(CHAT_SHORTCUT_STORAGE_KEY), window.localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY)), false);
  } catch {
    // Keep the current preference when storage is unavailable.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!storageListenerAttached && typeof window !== "undefined") {
    storageListenerAttached = true;
    window.addEventListener("storage", (event) => {
      if (event.key === null || event.key === CHAT_SHORTCUT_STORAGE_KEY || event.key === SEND_SHORTCUT_STORAGE_KEY) readStorage();
    });
  }
  return () => listeners.delete(listener);
}

function getSnapshot(): ChatShortcutBindings { return currentBindings; }
function getServerSnapshot(): ChatShortcutBindings { return DEFAULT_CHAT_SHORTCUTS; }

export function useSendShortcut() {
  const bindings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(readStorage, []);

  const setBinding = useCallback((action: ChatShortcutAction, value: SendShortcut) => {
    const error = validateChatShortcut(currentBindings, action, value);
    if (error) return error;
    commitBindings({ ...currentBindings, [action]: value === null ? null : normalizeChatShortcut(value) }, true);
    return null;
  }, []);
  const setShortcut = useCallback((value: SendShortcut) => setBinding("send", value), [setBinding]);
  return { bindings, shortcut: bindings.send, steerShortcut: bindings.steer, newlineShortcut: bindings.newline, setShortcut, setBinding };
}
