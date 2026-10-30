import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
const { AnswerOutputPreviewStore } = await createJiti(import.meta.url).import("./answer-output-preview-client.ts");
const preview = (seq = 1, overrides = {}) => ({ version: 1, kind: "intelligent-ui", sessionId: "session", runId: "run", streamId: "stream", toolCallId: "call", seq, phase: "partial", payload: { version: 2 }, snapshot: "Preview", ...overrides });
const snapshot = (seq, previews, runId = "run") => ({ sessionId: "session", runId, seq, previews });

test("only the current connection's host start or snapshot can authorize a run", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.receive(token, preview()); assert.equal(store.getSnapshot().size, 0);
  store.started(token, "elsewhere", "run"); store.receive(token, preview()); assert.equal(store.getSnapshot().size, 0);
  store.started(token, "session", "run"); store.receive(token, preview()); assert.equal(store.getSnapshot().size, 1);
  store.receive(token, preview(2, { runId: "unknown" })); assert.equal(store.getSnapshot().get("call").runId, "run");
  const next = store.connect("session");
  store.restore(token, snapshot(3, [preview(3)])); assert.equal(store.getSnapshot().size, 0);
  store.restore(next, snapshot(3, [preview(3)])); assert.equal(store.getSnapshot().get("call").seq, 3);
});

test("global sequence and replacement snapshots reject old deltas and clear missing output", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.restore(token, snapshot(3, [preview(3)]));
  store.receive(token, preview(2)); assert.equal(store.getSnapshot().get("call").seq, 3);
  store.restore(token, snapshot(2, [])); assert.equal(store.getSnapshot().size, 1);
  store.restore(token, snapshot(4, [])); assert.equal(store.getSnapshot().size, 0);
  store.receive(token, preview(3)); assert.equal(store.getSnapshot().size, 0);
});

test("cancel, navigation and settlement revoke late events and reconnect snapshots", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.restore(token, snapshot(1, [preview()])); store.stop();
  store.receive(token, preview(2)); store.started(token, "session", "late"); assert.equal(store.getSnapshot().size, 0);
  const next = store.connect("session");
  store.restore(next, snapshot(3, [preview(3)])); assert.equal(store.getSnapshot().size, 0);
  store.started(next, "session", "new"); store.receive(next, preview(1, { runId: "new" }));
  assert.equal(store.getSnapshot().get("call").runId, "new");
  store.started(next, "session", "run"); store.receive(next, preview(50));
  assert.equal(store.getSnapshot().get("call").runId, "new");
});

test("cleared/replaced streams and durable handoffs cannot revive", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.restore(token, snapshot(1, [preview()]));
  store.receive(token, preview(2, { streamId: "next" }));
  store.receive(token, preview(3)); assert.equal(store.getSnapshot().get("call").streamId, "next");
  store.receive(token, preview(4, { streamId: "next", phase: "cleared", payload: undefined, snapshot: undefined }));
  store.receive(token, preview(5, { streamId: "next" })); assert.equal(store.getSnapshot().size, 0);
  store.receive(token, preview(6, { streamId: "final" })); store.handoff(token, "call");
  store.receive(token, preview(7, { streamId: "another" }));
  store.restore(token, snapshot(8, [preview(8, { streamId: "another" })])); assert.equal(store.getSnapshot().size, 0);
});

test("connection loss can restore an equal-sequence snapshot without accepting old connections", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.restore(token, snapshot(2, [preview(2)])); store.disconnect();
  const next = store.connect("session"); store.restore(next, snapshot(2, [preview(2)]));
  assert.equal(store.getSnapshot().get("call").seq, 2);
  store.receive(token, preview(3)); assert.equal(store.getSnapshot().get("call").seq, 2);
  store.receive(next, preview(3, { phase: "complete" })); assert.equal(store.getSnapshot().get("call").phase, "complete");
  const elsewhere = store.connect("elsewhere"); store.restore(elsewhere, snapshot(4, [preview(4)])); assert.equal(store.getSnapshot().size, 0);
});

test("malformed snapshots and oversized previews never enter observable state", () => {
  const store = new AnswerOutputPreviewStore(), token = store.connect("session");
  store.restore(token, snapshot(0, [preview()])); store.receive(token, preview()); assert.equal(store.getSnapshot().size, 0);
  store.started(token, "session", "run");
  store.receive(token, preview(1, { snapshot: "x".repeat(128001) })); assert.equal(store.getSnapshot().size, 0);
  store.receive(token, preview(1)); assert.equal(store.getSnapshot().size, 1);
});
