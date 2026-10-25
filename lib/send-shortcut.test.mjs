import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { DEFAULT_CHAT_SHORTCUTS, isPlainEnter, matchesSendShortcut, matchesSteerShortcut, parseChatShortcuts, parseStoredSendShortcut, recordChatShortcut, validateChatShortcut } = await jiti.import("./send-shortcut.ts");
const keyEvent = (overrides = {}) => ({ key: "Enter", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...overrides });

test("defaults and legacy preferences preserve sending without assigning steering", () => {
  assert.deepEqual(parseChatShortcuts(null), { send: "Enter", steer: null, newline: "Shift+Enter" });
  assert.deepEqual(parseChatShortcuts(null, "ctrl-enter"), { send: "Ctrl+Enter", steer: null, newline: "Shift+Enter" });
  assert.equal(parseStoredSendShortcut("invalid"), "Enter");
  for (const raw of ["invalid", "null", "{}", '{"version":1,"bindings":{}}']) assert.deepEqual(parseChatShortcuts(raw), DEFAULT_CHAT_SHORTCUTS);
});

test("custom bindings and explicitly cleared actions survive serialization", () => {
  for (const bindings of [
    { send: "Ctrl+Enter", steer: "Alt+S", newline: "Enter" },
    { send: null, steer: null, newline: null },
    { send: "F8", steer: "Mod+Shift+S", newline: "Alt+Enter" },
  ]) assert.deepEqual(parseChatShortcuts(JSON.stringify({ version: 2, bindings })), bindings);
  assert.deepEqual(parseChatShortcuts(JSON.stringify({ version: 2, bindings: { send: "Enter", steer: "Enter", newline: "Shift+Enter" } })), DEFAULT_CHAT_SHORTCUTS);
  assert.deepEqual(parseChatShortcuts(JSON.stringify({ version: 2, bindings: { send: "Ctrl+C", steer: 123, newline: "bogus" } })), DEFAULT_CHAT_SHORTCUTS);
});

test("each binding matches only its exact key and modifiers", () => {
  const bindings = { send: "Ctrl+Enter", steer: "Ctrl+Shift+Enter", newline: "Shift+Enter" };
  for (let modifiers = 0; modifiers < 16; modifiers++) {
    const event = keyEvent({ ctrlKey: Boolean(modifiers & 1), shiftKey: Boolean(modifiers & 2), altKey: Boolean(modifiers & 4), metaKey: Boolean(modifiers & 8) });
    assert.equal(matchesSendShortcut(event, bindings.send), modifiers === 1);
    assert.equal(matchesSteerShortcut(event, bindings.steer), modifiers === 3);
    assert.equal(matchesSendShortcut(event, bindings.newline), modifiers === 2);
    assert.equal(matchesSteerShortcut(event, null), false);
  }
  assert.equal(isPlainEnter(keyEvent()), true);
  assert.equal(isPlainEnter(keyEvent({ shiftKey: true })), false);
  assert.equal(matchesSendShortcut(keyEvent(), "Enter"), true);
  assert.equal(matchesSendShortcut(keyEvent({ key: "F8" }), "F8"), true);
  assert.equal(matchesSteerShortcut(keyEvent({ key: "s", altKey: true }), "Alt+S"), true);
  assert.equal(matchesSendShortcut(keyEvent({ key: "NumpadEnter", ctrlKey: true }), bindings.send), false);
});

test("three actions reject conflicts and preserve editing keys while allowing independent newline choices", () => {
  assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "steer", "Enter"), "conflict");
  assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "send", "Shift+Enter"), "conflict");
  assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "newline", "Ctrl+Enter"), null);
  assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "send", null), null);
  assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "send", "A"), "invalid");
  for (const binding of ["Ctrl+C", "Mod+V", "Ctrl+Z", "Ctrl+Alt+Z", "Mod+Shift+Y", "Shift+Tab", "Shift+A"]) assert.equal(validateChatShortcut(DEFAULT_CHAT_SHORTCUTS, "send", binding), "reserved");
  assert.equal(recordChatShortcut(keyEvent()), "Enter");
  assert.equal(recordChatShortcut(keyEvent({ shiftKey: true })), "Shift+Enter");
  assert.equal(recordChatShortcut(keyEvent({ key: "a" })), null);
});
