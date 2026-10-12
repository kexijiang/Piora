import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  APPLICATION_SHORTCUTS,
  findShortcutConflict,
  formatShortcutBinding,
  isReservedShortcutBinding,
  normalizeShortcutBinding,
  parseShortcutOverrides,
  recordShortcutFromEvent,
  resolveShortcutBindings,
  serializeShortcutOverrides,
  shortcutMatchesEvent,
} from "./keyboard-shortcuts.ts";

test("normalizes, records, displays, and matches portable Mod shortcuts", () => {
  assert.equal(normalizeShortcutBinding("shift+mod+f"), "Mod+Shift+F");
  assert.equal(recordShortcutFromEvent({ key: "f", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, false), "Mod+Shift+F");
  assert.equal(recordShortcutFromEvent({ key: "f", ctrlKey: false, metaKey: true, altKey: false, shiftKey: true }, true), "Mod+Shift+F");
  assert.equal(formatShortcutBinding("Mod+Shift+F", false), "Ctrl+Shift+F");
  assert.equal(formatShortcutBinding("Mod+Shift+F", true), "Cmd+Shift+F");
  assert.equal(shortcutMatchesEvent({ key: "f", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true }, "Mod+Shift+F", false), true);
  assert.equal(shortcutMatchesEvent({ key: "f", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, "Mod+Shift+F", false), false);
});

test("keeps native editing and window bindings reserved", () => {
  for (const binding of ["Mod+F", "Mod+C", "Mod+W", "Mod+Q", "Mod+Shift+Z"]) {
    assert.equal(isReservedShortcutBinding(binding), true, binding);
  }
  assert.equal(isReservedShortcutBinding("Mod+P"), false);
});

test("device capture defaults, customization, disabling and conflicts use a separate identity", () => {
  assert.equal(resolveShortcutBindings({})["harmony.screenshot"], "Alt+Shift+S");
  const overrides = parseShortcutOverrides(serializeShortcutOverrides({ "harmony.screenshot": "Mod+Alt+S" }));
  assert.equal(resolveShortcutBindings(overrides)["harmony.screenshot"], "Mod+Alt+S");
  assert.equal(resolveShortcutBindings({ "harmony.screenshot": null })["harmony.screenshot"], null);
  // The desktop capture shortcut was removed, so its old Ctrl+Alt+A default no longer owns a conflict.
  assert.equal(findShortcutConflict(resolveShortcutBindings({}), "harmony.screenshot", "Ctrl+Alt+A"), null);
  assert.equal(findShortcutConflict(resolveShortcutBindings({}), "harmony.screenshot", "Mod+Shift+M"), "composer.voiceInput");
});

test("persists only valid known overrides and detects duplicate assignments", () => {
  const raw = serializeShortcutOverrides({ "navigate.searchFiles": "Mod+Shift+P", "panel.browser": null });
  assert.deepEqual(parseShortcutOverrides(raw), { "navigate.searchFiles": "Mod+Shift+P", "panel.browser": null });
  assert.deepEqual(parseShortcutOverrides(JSON.stringify({ version: 1, overrides: { unknown: "Mod+K", "panel.browser": "Mod+F" } })), {});
  const bindings = resolveShortcutBindings({ "panel.browser": "Mod+P" });
  assert.equal(findShortcutConflict(bindings, "panel.browser", "Mod+P"), "navigate.searchFiles");
  assert.equal(bindings["panel.browser"], null);
  assert.equal(new Set(APPLICATION_SHORTCUTS.map((item) => item.defaultBinding)).size, APPLICATION_SHORTCUTS.length);
  assert.equal(resolveShortcutBindings({})["composer.voiceInput"], "Mod+Shift+M");
});

test("settings, renderer dispatch, and Electron bridge share the shortcut registry", () => {
  const settings = fs.readFileSync(new URL("../components/ShortcutSettings.tsx", import.meta.url), "utf8");
  const shell = fs.readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../desktop/src/preload.ts", import.meta.url), "utf8");
  assert.match(settings, /data-app-shortcuts="preserve"/);
  assert.match(settings, /shortcuts\.conflict/);
  assert.match(settings, /SHORTCUT_GROUPS/);
  assert.match(settings, /styles\.keycaps/);
  assert.match(settings, /styles\.changedBadge/);
  assert.match(shell, /setKeyboardShortcuts/);
  assert.match(shell, /openConversationSearch/);
  assert.match(shell, /shortcut\.id === "composer\.voiceInput"/);
  assert.match(settings, /shortcuts\.group\.input/);
  assert.match(preload, /pi:set-keyboard-shortcuts/);
});
