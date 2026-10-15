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
  const backdrop = styles.match(/\.backdrop\s*\{([^}]+)\}/)?.[1];
  const dialog = styles.match(/\.dialog\s*\{([^}]+)\}/)?.[1];
  assert.ok(backdrop, "search backdrop styles must exist");
  assert.ok(dialog, "search dialog styles must exist");
  assert.doesNotMatch(backdrop, /backdrop-filter\s*:/, "the overlay must not blur the page before the dialog samples it");
  assert.match(dialog, /backdrop-filter:\s*var\(--floating-filter\)/, "search must use the shared adjustable glass filter");
  assert.match(source, /\{result\.snippet\.slice\(0, start\)\}/);
  assert.match(source, /<mark>\{result\.snippet\.slice\(start, end\)\}<\/mark>/);
  assert.doesNotMatch(source, /MarkdownBody|dangerouslySetInnerHTML/);
});
