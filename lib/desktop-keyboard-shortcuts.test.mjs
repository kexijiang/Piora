import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

test("desktop accepts a complete conflict-free shortcut map and converts accelerators", async () => {
  const subject = await jiti.import("../desktop/src/keyboard-shortcuts.ts");
  const parsed = subject.parseDesktopShortcutBindings(subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS);
  assert.deepEqual(parsed, subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS);
  assert.equal(subject.toElectronAccelerator("Mod+Shift+F"), "CmdOrCtrl+Shift+F");
  assert.equal(parsed["companion.togglePanel"], "Ctrl+Space");
  assert.equal(parsed["composer.voiceInput"], "Mod+Shift+M");
  assert.equal(parsed["harmony.screenshot"], "Alt+Shift+S");
  assert.equal(subject.toElectronAccelerator("Ctrl+Space"), "Ctrl+Space");
  assert.equal(subject.toElectronAccelerator("Mod+Backquote"), "CmdOrCtrl+`");
  assert.equal(subject.toElectronAccelerator(null), undefined);
});

test("renderer device capture participates in validated settings without becoming a desktop command", async () => {
  const subject = await jiti.import("../desktop/src/keyboard-shortcuts.ts");
  const renderer = await jiti.import("./keyboard-shortcuts.ts");
  assert.deepEqual(subject.parseDesktopShortcutBindings(renderer.resolveShortcutBindings({})), subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS);
  assert.equal(subject.parseDesktopShortcutBindings({ ...subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS, "harmony.screenshot": null })["harmony.screenshot"], null);
  assert.equal(subject.parseDesktopShortcutBindings({ ...subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS, "harmony.screenshot": "Mod+P" }), null);
});

test("desktop rejects unknown, reserved, incomplete, and duplicate bindings", async () => {
  const subject = await jiti.import("../desktop/src/keyboard-shortcuts.ts");
  const defaults = subject.DEFAULT_DESKTOP_SHORTCUT_BINDINGS;
  assert.equal(subject.parseDesktopShortcutBindings({ ...defaults, unknown: "Mod+L" }), null);
  assert.equal(subject.parseDesktopShortcutBindings({ ...defaults, "panel.browser": "Mod+F" }), null);
  assert.equal(subject.parseDesktopShortcutBindings({ ...defaults, "panel.browser": defaults["navigate.searchFiles"] }), null);
  const incomplete = { ...defaults };
  delete incomplete["panel.browser"];
  assert.equal(subject.parseDesktopShortcutBindings(incomplete), null);
});
