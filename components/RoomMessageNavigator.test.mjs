import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getRoomMessagePreview } = await jiti.import("../lib/room-message-navigation.ts");

test("room message navigation lists only user prompts and exposes clickable jump targets", async () => {
  const source = await readFile(new URL("./RoomMessageNavigator.tsx", import.meta.url), "utf8");
  const base = { id: "m1", createdAt: 1, content: "  完成\n验证  " };
  assert.equal(getRoomMessagePreview({ ...base, author: { kind: "user", id: "u", name: "你" } }), "你：完成 验证");
  assert.equal(getRoomMessagePreview({ ...base, author: { kind: "user", id: "u", name: "你" }, content: "*bold* <tag> @dev_name\nnext" }), "你：*bold* <tag> @dev_name next");
  assert.doesNotMatch(source, /MarkdownBody|dangerouslySetInnerHTML/);
  assert.match(source, /author\.kind === "user"/);
  assert.match(source, /userMessages\.map\(\(message, index\)/);
  assert.match(source, /群聊记录/);
  assert.match(source, /piora:chat-timeline-pinned:v1/);
  assert.match(source, /aria-pressed=\{previewPinned\}/);
  assert.match(source, /previewOpen \|\| previewPinned/);
  assert.match(source, /chat\.timelineUnpin/);
  assert.match(source, /跳转到第 \$\{node\.index \+ 1\} 条消息/);
  assert.match(source, /scrollEl\.scrollTo/);
});

test("room workspace preserves history position and offers one-click latest navigation", async () => {
  const source = await readFile(new URL("./RoomWorkspace.tsx", import.meta.url), "utf8");
  assert.match(source, /shouldShowScrollToBottom/);
  assert.match(source, /pinnedToBottomRef/);
  assert.match(source, /forceScrollToBottomRef/);
  assert.match(source, /aria-label="滚动到最新消息"/);
  assert.match(source, /<RoomMessageNavigator/);
});
