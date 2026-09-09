import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./terminal-input.ts");
}

function key(keyValue, modifiers = {}) {
  return {
    key: keyValue,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

test("replay response detection does not swallow typed text, navigation or paste", async () => {
  const { isTerminalProtocolReply } = await loadSubject();
  for (const reply of ["\x1b[?1;2c", "\x1b[1;10R", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\"]) assert.equal(isTerminalProtocolReply(reply), true);
  for (const input of ["hello", " ", "\r", "\x1b[A", "\x1b[1;5C", "\x1b[3~", "\x1b[200~hello\x1b[201~"]) assert.equal(isTerminalProtocolReply(input), false);
});

test("maps navigation and editing keys to terminal sequences", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("ArrowDown")), "\x1b[B");
  assert.equal(toTerminalKeyData(key("Home")), "\x1b[H");
  assert.equal(toTerminalKeyData(key("Delete")), "\x1b[3~");
  assert.equal(toTerminalKeyData(key("Tab", { shiftKey: true })), "\x1b[Z");
  assert.equal(toTerminalKeyData(key("Enter", { shiftKey: true })), "\n");
});

test("maps legacy control and alt keys used by pi-tui", async () => {
  const { toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("c", { ctrlKey: true })), "\x03");
  assert.equal(toTerminalKeyData(key("]", { ctrlKey: true })), "\x1d");
  assert.equal(toTerminalKeyData(key("ArrowLeft", { altKey: true })), "\x1bb");
  assert.equal(toTerminalKeyData(key("x", { altKey: true })), "\x1bx");
  assert.equal(toTerminalKeyData(key("v", { ctrlKey: true })), null);
  assert.equal(toTerminalKeyData(key("x", { metaKey: true })), null);
});

test("leaves printable text to the text input and wraps pasted text", async () => {
  const { asBracketedPaste, toTerminalKeyData } = await loadSubject();

  assert.equal(toTerminalKeyData(key("a")), null);
  assert.equal(toTerminalKeyData(key(" ")), null);
  assert.equal(asBracketedPaste("first\nsecond"), "\x1b[200~first\nsecond\x1b[201~");
});
