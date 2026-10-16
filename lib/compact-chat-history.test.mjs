import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { buildCompactChatHistoryRows: plan, commandPreviewTail } = await createJiti(import.meta.url).import("./compact-chat-history.ts");
const { parseCompactProcessPreference, DEFAULT_COMPACT_PROCESS } = await import("./compact-process-preference.ts");
const text = (text) => ({ type: "text", text });
const assistant = (content, extra = {}) => ({ role: "assistant", content, timestamp: 2000, ...extra });
const call = (id, name = "bash", input = { command: "echo hello" }) => ({ type: "toolCall", toolCallId: id, toolName: name, input });
const result = (id, output, extra = {}) => ({ role: "toolResult", toolCallId: id, content: [text(output)], timestamp: 4000, ...extra });
const user = { role: "user", content: "work", timestamp: 1000 };
const ids = ["u", "step", "result", "answer"];

test("compact display defaults on and an explicit off survives parsing", () => {
  assert.equal(DEFAULT_COMPACT_PROCESS, true);
  for (const value of [null, "true", "bad", ""]) assert.equal(parseCompactProcessPreference(value), true);
  assert.equal(parseCompactProcessPreference("false"), false);
});

test("completed tools and thinking fold into one row while the formal answer stays visible", () => {
  const messages = [user, assistant([{ type: "thinking", thinking: "reason" }, call("shell")]), result("shell", "hello"), assistant([text("answer")])];
  const { rows, entryRows } = plan(messages, ids, false, new Set());
  assert.equal(rows.length, 3);
  assert.equal(rows[1].compactProcess.count, 2);
  assert.equal(rows[1].compactProcess.active, false);
  assert.equal(rows[2].message.content[0].text, "answer");
  assert.equal(entryRows.get("step"), "compact-process:u");
  const open = plan(messages, ids, false, new Set(["compact-process:u"]));
  assert.equal(open.rows.length, 4);
  assert.equal(open.rows[2].secondary, true);
  assert.equal(open.entryRows.get("step"), "compact-step:step");
});

test("running snapshots update a bounded three-line preview and preserve explicit expansion on finish", () => {
  const messages = [user, assistant([call("shell")]), result("shell", "one\ntwo\nthree\nfour", { isStreaming: true })];
  const running = plan(messages, ids, true, new Set());
  assert.equal(running.rows[1].compactProcess.preview[0].output, "two\nthree\nfour");
  assert.equal(running.rows[1].compactProcess.preview[0].status, "running");
  messages[2] = result("shell", "one\ntwo\nthree\nfour\nfive", { isStreaming: true });
  assert.equal(plan(messages, ids, true, new Set()).rows[1].compactProcess.preview[0].output, "three\nfour\nfive");
  messages[2] = result("shell", "done"); messages.push(assistant([text("answer")]));
  const finished = plan(messages, ids, false, new Set(["compact-process:u"]));
  assert.equal(finished.rows[1].compactProcess.expanded, true);
  assert.equal(finished.rows[1].compactProcess.active, false);
});

test("live thinking and answer are split without changing source content or deferred indices", () => {
  const thinking = { type: "thinking", thinking: "", deferred: true, deferredBlockIndex: 0 };
  const message = assistant([thinking, text("typing answer")]);
  const { rows } = plan([user, message], ["u"], true, new Set(["compact-process:u"]), 1);
  assert.equal(rows[1].compactProcess.preview[0].status, "running");
  assert.equal(rows[2].message.content[0], thinking);
  assert.equal(rows[3].message.content[0].text, "typing answer");
  assert.equal(rows[3].isStreaming, true);
  assert.equal(message.content.length, 2);
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length);
});

test("errors, browser handoffs and assistant cancellation notices are never hidden", () => {
  for (const [tool, toolResult] of [
    [call("a"), result("a", "failed", { isError: true })],
    [call("a", "browser", { action: "wait_for_user" }), null],
    [call("a", "browser", { action: "wait_for_user" }), result("a", "unsupported", { details: { status: "unsupported" } })],
  ]) {
    const messages = [user, assistant([tool]), ...(toolResult ? [toolResult] : []), assistant([text("answer")])];
    const { rows } = plan(messages, ids, true, new Set());
    assert.equal(rows[1].compactProcess.attention, true);
    assert.ok(rows.some((row) => row.secondary && row.message.content[0].toolCallId === "a"));
  }
  for (const stopReason of ["aborted", "error"]) {
    const message = assistant([], { stopReason, errorMessage: stopReason === "error" ? "provider failed" : undefined });
    const { rows } = plan([user, assistant([call("a")]), message], ids, false, new Set());
    assert.ok(rows.some((row) => row.message === message));
    assert.equal(rows[1].compactProcess.preview[0].status, "unknown");
  }
});

test("each turn gets its own stable group; custom cards remain visible and old tools do not appear running", () => {
  const custom = { role: "custom", customType: "approval", content: "action needed", display: true };
  const messages = [user, assistant([call("a")]), custom, assistant([text("first answer")]),
    { ...user, content: "next" }, assistant([call("b")])];
  const { rows } = plan(messages, [], true, new Set());
  const groups = rows.filter((row) => row.compactProcess);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].compactProcess.active, false);
  assert.equal(groups[0].compactProcess.preview[0].status, "unknown");
  assert.equal(groups[1].compactProcess.active, true);
  assert.ok(rows.some((row) => row.message === custom));
});

test("large expanded processes stay individually windowable and previews remain bounded", () => {
  const messages = [user, ...Array.from({ length: 6000 }, (_, i) => assistant([call(String(i), "read", { path: "a" })])), assistant([text("done")])];
  const collapsed = plan(messages, [], false, new Set());
  assert.equal(collapsed.rows.length, 3);
  assert.equal(collapsed.rows[1].compactProcess.preview.length, 3);
  assert.equal(plan(messages, [], false, new Set(["compact-process:0"])).rows.length, 6003);
});

test("preview tails remove terminal controls, limit long lines and retain only the latest output", () => {
  assert.equal(commandPreviewTail("old\n\x1b[32mnew\x1b[0m\nlast\nend\n"), "new\nlast\nend");
  assert.equal(commandPreviewTail("step1\rstep2\rstep3\rstep4"), "step2\nstep3\nstep4");
  assert.ok(commandPreviewTail("x".repeat(100000)).length <= 241);
});
