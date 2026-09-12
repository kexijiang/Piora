import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildHistoryIndex, historyPath, historyTurns, historyReadingAnchor, historyMarkdown, pairHistoryTools, searchHistory, selectHistoryBranch } = await jiti.import("./session-history.ts");
const { historyLocationUrl, readHistoryLocation } = await jiti.import("./history-navigation.ts");
const stamp = "2026-09-12T03:00:00.000Z";
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: stamp, message });
const text = text => ({ type: "text", text });
const user = (id, parentId, content) => entry(id, parentId, { role: "user", content });
const answer = (id, parentId, value) => entry(id, parentId, { role: "assistant", content: [text(value)] });
const entries = [
  user("question", null, "修复历史界面的滚动问题"),
  entry("call", "question", { role: "assistant", content: [{ type: "thinking", thinking: "检查滚动条占位" }, { type: "toolCall", id: "read-1", name: "read", arguments: { path: "components/MessageView.tsx" } }] }),
  entry("result-a", "call", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [text("找到卡片的布局代码"), { type: "image", data: "YWJj", mimeType: "image/png" }], isError: false }),
  answer("answer-a", "result-a", "已保留固定占位"),
  { type: "compaction", id: "compact", parentId: "answer-a", timestamp: stamp, summary: "已完成滚动修复", firstKeptEntryId: "answer-a", tokensBefore: 1000 },
  user("follow-up", "compact", "补充验证"),
  answer("leaf-a", "follow-up", "验证完成"),
  entry("result-b", "call", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [text("读取文件失败")], isError: true }),
  answer("leaf-b", "result-b", "无法读取文件"),
  { type: "custom", id: "extension", parentId: "leaf-b", timestamp: stamp, customType: "third-party-result", data: { result: "自定义检查完成" } },
];
const index = buildHistoryIndex(entries, { type: "session", version: 3, id: "session", cwd: "/workspace/piora", timestamp: stamp }, "leaf-a", "v1");

test("raw branch history retains messages before compaction and preserves turn boundaries", () => {
  const path = historyPath(index.nodes, "leaf-a");
  assert.deepEqual(path.map(node => node.id), ["question", "call", "result-a", "answer-a", "compact", "follow-up", "leaf-a"]);
  assert.deepEqual(historyTurns(path).map(turn => turn.question.id), ["question", "follow-up"]);
  assert.equal(index.branches.length, 2);
  assert.equal(index.nodes.find(node => node.id === "result-b").toolOwnerId, "call");
  assert.equal(index.nodes.find(node => node.id === "result-a").hasMedia, true);
  assert.equal(historyReadingAnchor(path, path.filter(node => node.id !== "follow-up"), "follow-up"), "compact");
});

test("a tool call shared by branches receives only the selected branch's result", () => {
  assert.deepEqual(pairHistoryTools(historyPath(entries, "leaf-a")).get("call").map(entry => entry.id), ["result-a"]);
  assert.deepEqual(pairHistoryTools(historyPath(entries, "extension")).get("call").map(entry => entry.id), ["result-b"]);
});

test("search finds Chinese text, tool paths and outputs without duplicating common ancestors", () => {
  const search = options => searchHistory(entries, index, options);
  assert.deepEqual(search({ query: "历史界面" }).hits.map(hit => hit.id), ["question"]);
  assert.deepEqual(search({ query: "MessageView.tsx", category: "tool" }).hits.map(hit => hit.id), ["call", "result-a", "result-b"]);
  assert.deepEqual(search({ query: "MessageView.tsx", failedOnly: true }).hits.map(hit => hit.id), ["result-b"]);
  assert.deepEqual(search({ query: "读取文件", category: "tool", failedOnly: true }).hits.map(hit => hit.id), ["result-b"]);
  assert.equal(search({ query: "读取文件", leafId: "leaf-a" }).total, 0);
  assert.equal(search({ query: "滚动条占位" }).total, 0);
  assert.equal(search({ query: "滚动条占位", includeThinking: true }).total, 1);
  assert.equal(search({ query: "自定义检查", category: "system" }).total, 1);
  assert.equal(search({ query: "历史界面", from: "2026-09-13T00:00:00Z" }).total, 0);
});

test("locating a shared ancestor keeps the preview branch; another branch is selected only when necessary", () => {
  assert.equal(selectHistoryBranch(index, "call", "leaf-a"), "leaf-a");
  assert.equal(selectHistoryBranch(index, "call", "extension"), "extension");
  assert.equal(selectHistoryBranch(index, "result-b", "leaf-a"), "extension");
});

test("branch Markdown preserves pre-compaction text and excludes other branches", () => {
  const markdown = historyMarkdown(historyPath(entries, "leaf-a"), "历史验证");
  assert.match(markdown, /修复历史界面/);
  assert.match(markdown, /已完成滚动修复/);
  assert.match(markdown, /检查滚动条占位/);
  assert.match(markdown, /!\[Image 1\]\(<data:image\/png;base64,YWJj>\)/);
  assert.doesNotMatch(markdown, /读取文件失败|自定义检查/);
});

test("history location round-trips session, branch and entry independently of chat navigation", () => {
  const params = new URLSearchParams(historyLocationUrl("session", "leaf-a", "result-a"));
  assert.deepEqual(readHistoryLocation(params), { open: true, leafId: "leaf-a", entryId: "result-a" });
  assert.equal(params.get("session"), "session");
  assert.equal(readHistoryLocation(new URLSearchParams("session=session")).open, false);
});
