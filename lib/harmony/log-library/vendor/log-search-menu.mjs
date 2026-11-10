// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: Apache-2.0; see third_party/harmony-log-workbench/SOURCE.md.
/**
 * Keyboard and filtering rules for the log search boxes.
 *
 * This is the single implementation shared by both log views: dshHarmony imports
 * it at build time for its live pane, and dshE2E uses it for the session-log
 * viewer. Keep it free of imports so it can be bundled for a browser, a Node
 * test, or copied into the plugin's `lib/` directory.
 */

/**
 * An IME candidate confirmation must never be treated as a shortcut.
 *
 * React synthetic events do not always copy `isComposing` onto the wrapper, so
 * the native event is checked as well; `keyCode 229` is the cross-browser
 * marker for "a composition is in progress".
 */
export function isComposingKey(event) {
  const native = event?.nativeEvent;
  if (native?.isComposing === true || native?.keyCode === 229) return true;
  return event?.isComposing === true || event?.keyCode === 229;
}

/** Arrow keys move inside an open history; Escape closes the history first. */
export function historyKeyAction(event, state) {
  if (isComposingKey(event)) return null;
  if (!state?.open) return null;
  if (event.key === "Escape") return "close";
  if (event.key === "ArrowUp") return "up";
  if (event.key === "ArrowDown") return "down";
  // Enter only applies a history entry the person explicitly reached.
  if (event.key === "Enter" && !event.shiftKey && state.selected && state.count > 0) return "apply";
  return null;
}

export function nextCursor(current, delta, count) {
  if (count <= 0) return 0;
  const base = Number.isFinite(current) ? current : 0;
  return ((base + delta) % count + count) % count;
}

/** Typing narrows the visible history without changing the stored list. */
export function filterHistoryEntries(entries, value) {
  const text = String(value ?? "").trim().toLocaleLowerCase();
  if (!text) return entries;
  return entries.filter(entry => String(entry.query).toLocaleLowerCase().includes(text));
}
