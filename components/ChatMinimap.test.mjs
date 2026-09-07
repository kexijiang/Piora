import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");

test("chat timeline lists only user prompts and keeps both jump targets clickable", async () => {
  const [component, chatWindow, styles] = await Promise.all([
    readFile(new URL("./ChatMinimap.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8"),
    readFile(new URL("./ChatMinimap.module.css", import.meta.url), "utf8"),
  ]);

  assert.match(component, /if \(message\.role !== "user"\) continue/);
  assert.match(component, /data-minimap-node-index/);
  assert.match(component, /data-minimap-preview-user/);
  assert.match(component, /piora:chat-timeline-pinned:v1/);
  assert.match(component, /chat\.timelineUnpin/);
  assert.match(component, /aria-pressed=\{previewPinned\}/);
  assert.match(component, /previewOpen \|\| previewPinned/);
  assert.match(component, /onClick=\{\(\) => scrollToNode\(index\)\}/);
  assert.match(component, /onRevealHistory\(target\)/);
  assert.doesNotMatch(component, /ReactMarkdown|AssistantOutline|assistantPreviews|data-minimap-preview-assistant/);
  assert.doesNotMatch(chatWindow, /streamingMessage=\{streamState\.streamingMessage\}/);
  assert.match(styles, /\.previewText[\s\S]*white-space:\s*nowrap/);
});

test("chat timeline labels are available in English and Chinese", () => {
  const keys = [
    "chat.timeline",
    "chat.timelineCount",
    "chat.timelineJump",
    "chat.timelineAttachmentOnly",
    "chat.timelinePin",
    "chat.timelineUnpin",
  ];

  for (const locale of [enLocale, zhCNLocale]) {
    for (const key of keys) {
      assert.equal(typeof locale.messages[key], "string", `${locale.id} is missing ${key}`);
      assert.notEqual(locale.messages[key].trim(), "", `${locale.id} has an empty ${key}`);
    }
  }
});
