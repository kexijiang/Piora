import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("unified search combines recent chats, message matches, and settings in a compact keyboard palette", async () => {
  const [source, styles] = await Promise.all([
    readFile(new URL("./ConversationSearchDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ConversationSearchDialog.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(source, /filterSettingsSearchItems/);
  assert.match(source, /conversationSearch\.groupRecent/);
  assert.match(source, /conversationSearch\.groupMessages/);
  assert.match(source, /conversationSearch\.groupSettings/);
  assert.match(source, /onOpenSettings\(item\.section, item\.id\)/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(styles, /width: min\(590px, 100%\)/);
  assert.match(styles, /backdrop-filter: blur/);
});
