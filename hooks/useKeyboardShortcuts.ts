"use client";

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

/**
 * Register the non-configurable emergency shortcut for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component.
 */
export function useGlobalKeyboardShortcuts(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || document.querySelector("[data-history-workbench]")) return;
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;

        const tag = (e.target as HTMLElement)?.tagName;
        // Let textarea/input handle Esc internally (ChatInput menus / stop).
        if (tag === "TEXTAREA" || tag === "INPUT") return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
