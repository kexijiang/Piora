import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [chatInput, settingsDialog, shortcutSettings, hook, autoScrollHook, roomComposer] = await Promise.all([
  readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8"),
  readFile(new URL("./SettingsDialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("./ChatShortcutSettings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useSendShortcut.ts", import.meta.url), "utf8"),
  readFile(new URL("../hooks/useLiveOutputAutoScrollPreference.ts", import.meta.url), "utf8"),
  readFile(new URL("./RoomComposer.tsx", import.meta.url), "utf8"),
]);

test("conversation settings expose three independently recordable actions", () => {
  assert.match(settingsDialog, /<ChatShortcutSettings \/>/);
  assert.match(shortcutSettings, /const actions = \["send", "steer", "newline"\]/);
  assert.match(shortcutSettings, /capture\(action, event\)/);
  assert.match(shortcutSettings, /save\(action, DEFAULT_CHAT_SHORTCUTS\[action\]\)/);
  assert.match(shortcutSettings, /save\(action, null\)/);
});

test("individual and group chats share the send preference while steering stays explicit", () => {
  for (const source of [chatInput, roomComposer]) {
    assert.match(source, /useSendShortcut\(\)/);
    assert.match(source, /matchesSendShortcut\(/);
    assert.doesNotMatch(source, /streamingSendPreference/);
  }
  assert.match(chatInput, /if \(matchesSendShortcut\(e, sendShortcut\)\)/);
  assert.match(chatInput, /matchesSteerShortcut\(e, steerShortcut\)/);
  assert.match(chatInput, /sendQueued\("steer"\)/);
  assert.match(chatInput, /sendQueued\("followup"\)/);
});

test("the preference synchronizes all mounted consumers and browser tabs", () => {
  assert.match(hook, /useSyncExternalStore/);
  assert.match(hook, /listeners\.forEach/);
  assert.match(hook, /window\.localStorage\.setItem\(CHAT_SHORTCUT_STORAGE_KEY,/);
  assert.match(hook, /window\.addEventListener\("storage"/);
});

test("legacy default steering settings and dropdown are removed", () => {
  assert.doesNotMatch(settingsDialog, /useStreamingSendPreference|streamingSendDefault|conversation.streamingSend/);
  assert.doesNotMatch(chatInput, /streaming-action-toggle|streamingActionMenu/);
});

test("conversation settings expose a synchronized live-output auto-scroll switch", () => {
  assert.match(settingsDialog, /aria-checked=\{liveOutputAutoScrollEnabled\}/);
  assert.match(settingsDialog, /setLiveOutputAutoScrollEnabled\(!liveOutputAutoScrollEnabled\)/);
  assert.match(autoScrollHook, /useSyncExternalStore/);
  assert.match(autoScrollHook, /LIVE_OUTPUT_AUTO_SCROLL_STORAGE_KEY/);
  assert.match(autoScrollHook, /window\.addEventListener\("storage"/);
});
