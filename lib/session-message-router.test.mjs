import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionMessageRouter } = await jiti.import("./session-message-router.ts");
const { SessionControlStore } = await jiti.import("./session-control-store.ts");
const { SessionCommandEventHub } = await jiti.import("./session-command-events.ts");
const { resetSessionInboxesForTests } = await jiti.import("./session-inbox.ts");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const removeTempRoot = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail(`Timed out after ${timeoutMs}ms`);
    await wait(20);
  }
}

class FakeSession {
  constructor(id, delay = 25) {
    this.sessionId = id;
    this.delay = delay;
    this.events = new Set();
    this.destroyListeners = new Set();
    this.starts = [];
    this.active = false;
    this.runId = undefined;
  }
  isAlive() { return true; }
  isRunning() { return this.active; }
  getActivePromptRunId() { return this.runId; }
  getTaskRuntimeSnapshot() { return { id: this.sessionId, runtime: this.active ? "running" : "idle", pendingApproval: false, lastPromptFailed: false }; }
  onEvent(listener) { this.events.add(listener); return () => this.events.delete(listener); }
  onDestroy(listener) { this.destroyListeners.add(listener); return () => this.destroyListeners.delete(listener); }
  emit(event) { for (const listener of this.events) listener(event); }
  async startTrackedPrompt(input) {
    this.active = true;
    this.runId = `run-${this.starts.length + 1}`;
    this.starts.push({ ...input, startedAt: Date.now(), runId: this.runId });
    this.emit({ type: "prompt_started", commandId: input.commandId, runId: this.runId });
    setTimeout(() => {
      this.active = false;
      this.starts.at(-1).finishedAt = Date.now();
      this.emit({ type: "prompt_done", commandId: input.commandId, runId: this.runId });
      this.runId = undefined;
    }, this.delay);
    return { accepted: true, sessionId: this.sessionId, commandId: input.commandId, runId: this.runId };
  }
}

function makeRouter(root, sessions) {
  const store = new SessionControlStore({ root });
  const events = new SessionCommandEventHub(store);
  return new SessionMessageRouter({
    store,
    events,
    resolver: async (sessionId) => ({ session: sessions.get(sessionId), realSessionId: sessionId, cwd: process.cwd() }),
  });
}

test("queued work resumes when stop cleanup reaches idle after prompt_done", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-stop-cleanup-"));
  try {
    const session = new FakeSession("session-stop-cleanup", 10);
    session.active = true;
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const receipt = await router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "after cleanup", source: "ui", idempotencyKey: "after-cleanup" });
    await waitFor(() => session.events.size > 0);
    session.emit({ type: "prompt_done" });
    await wait(20);
    assert.equal(session.starts.length, 0, "no overlapping run during cleanup");
    session.active = false;
    session.emit({ type: "session_idle" });
    await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
    assert.equal(session.starts.length, 1);
    await router.resumeSession(session.sessionId);
  } finally {
    removeTempRoot(root);
  }
});

test("one Session drains next_turn messages FIFO while two Sessions overlap", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-test-"));
  try {
    const sessions = new Map([["session-a", new FakeSession("session-a", 35)], ["session-b", new FakeSession("session-b", 35)]]);
    const router = makeRouter(root, sessions);
    const completed = new Set();
    const unsubscribes = ["session-a", "session-b"].map((sessionId) => router.subscribeEvents(sessionId, (event) => {
      if (event.type === "command_completed" && event.commandId) completed.add(event.commandId);
    }));
    const receipts = await Promise.all([
      router.dispatchSessionMessage({ targetSessionId: "session-a", content: "one", source: "ui", idempotencyKey: "a-1" }),
      router.dispatchSessionMessage({ targetSessionId: "session-a", content: "two", source: "room", roomContext: { roomId: "room-a", messageId: "message-a" }, idempotencyKey: "a-2" }),
      router.dispatchSessionMessage({ targetSessionId: "session-a", content: "three", source: "remote", idempotencyKey: "a-3" }),
      router.dispatchSessionMessage({ targetSessionId: "session-b", content: "parallel", source: "remote", idempotencyKey: "b-1" }),
    ]);
    await waitFor(() => receipts.every(({ commandId }) => completed.has(commandId)));
    unsubscribes.forEach((unsubscribe) => unsubscribe());
    assert.equal(receipts[0].sessionId, "session-a");
    assert.deepEqual(sessions.get("session-a").starts.map((item) => item.message), ["one", "two", "three"]);
    assert.equal(sessions.get("session-b").starts.length, 1);
    assert.ok(sessions.get("session-b").starts[0].startedAt < sessions.get("session-a").starts[0].finishedAt);
    await Promise.all([...sessions.keys()].map((sessionId) => router.resumeSession(sessionId)));
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("a material-only prompt is accepted and its reference reaches the Session runtime", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-material-"));
  try {
    const session = new FakeSession("session-material", 10);
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const receipt = await router.dispatchSessionMessage({
      targetSessionId: session.sessionId,
      content: "",
      materials: [{ id: "12345678-1234-4123-8123-123456789abc" }],
      source: "ui",
      idempotencyKey: "material-only",
    });
    await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
    // Join the fire-and-forget drain before deleting its journal. The terminal
    // status is persisted just before the worker releases its final Windows
    // filesystem access.
    await router.resumeSession(session.sessionId);
    assert.equal(receipt.accepted, true);
    assert.deepEqual(session.starts[0].materials, [{ id: "12345678-1234-4123-8123-123456789abc" }]);
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("an image-only prompt is accepted and reaches the Session runtime", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-image-only-"));
  try {
    const session = new FakeSession("session-image-only", 10);
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const image = { type: "image", mimeType: "image/png", data: "YWJj" };
    const receipt = await router.dispatchSessionMessage({
      targetSessionId: session.sessionId,
      content: "",
      images: [image],
      source: "ui",
      idempotencyKey: "image-only",
    });

    assert.equal(receipt.accepted, true);
    await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
    // Join the fire-and-forget drain before deleting its journal. The terminal
    // status can become observable just before the worker releases its final
    // Windows filesystem access.
    await router.resumeSession(session.sessionId);
    assert.deepEqual(session.starts[0].images, [image]);
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("idempotency returns the original command and does not execute twice", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-idempotency-"));
  try {
    const session = new FakeSession("session-dedupe", 10);
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const first = await router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "same", source: "remote", idempotencyKey: "same-key" });
    const duplicates = await Promise.all(Array.from({ length: 100 }, () => router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "same", source: "remote", idempotencyKey: "same-key" })));
    await waitFor(async () => (await router.getCommand(first.commandId)).status === "completed");
    await router.resumeSession(session.sessionId);
    assert.ok(duplicates.every((duplicate) => duplicate.commandId === first.commandId && duplicate.idempotent === true));
    assert.equal(session.starts.length, 1);
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("queued commands survive a router restart and resume", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-recovery-"));
  try {
    const session = new FakeSession("session-recovery", 10);
    session.active = true;
    session.runId = "existing";
    const sessions = new Map([[session.sessionId, session]]);
    const router = makeRouter(root, sessions);
    const receipt = await router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "recover me", source: "remote", idempotencyKey: "recover-1" });
    assert.equal(receipt.status, "queued");
    resetSessionInboxesForTests();
    session.active = false;
    session.runId = undefined;
    const restored = makeRouter(root, sessions);
    await restored.resumeSession(session.sessionId);
    await wait(50);
    assert.equal(session.starts.at(-1).message, "recover me");
    assert.equal((await restored.getCommand(receipt.commandId)).status, "completed");
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("cancelCommand removes only the addressed queued command", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-exact-cancel-"));
  try {
    const session = new FakeSession("session-exact-cancel", 10);
    session.active = true;
    session.runId = "unrelated-ui-run";
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const target = await router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "cancel this", source: "room", roomContext: { roomId: "room-a", messageId: "message-a" }, idempotencyKey: "cancel-target" });
    const survivor = await router.dispatchSessionMessage({ targetSessionId: session.sessionId, content: "keep this", source: "ui", idempotencyKey: "cancel-survivor" });
    const receipt = await router.cancelCommand(target.commandId);
    assert.equal(receipt.commandId, target.commandId);
    assert.equal((await router.getCommand(target.commandId)).status, "cancelled");
    assert.equal((await router.getCommand(survivor.commandId)).status, "queued");
    assert.equal(session.active, true, "the unrelated active UI prompt must not be aborted");
    session.active = false;
    session.runId = undefined;
    await router.resumeSession(session.sessionId);
    await waitFor(async () => (await router.getCommand(survivor.commandId)).status === "completed");
    assert.deepEqual(session.starts.map((item) => item.message), ["keep this"]);
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});

test("accepts log-sized prompts up to the shared 256 KiB command limit", async () => {
  resetSessionInboxesForTests();
  const root = mkdtempSync(join(tmpdir(), "piora-router-size-"));
  try {
    const session = new FakeSession("session-large", 10);
    const router = makeRouter(root, new Map([[session.sessionId, session]]));
    const content = "x".repeat(70 * 1024);
    const receipt = await router.dispatchSessionMessage({
      targetSessionId: session.sessionId,
      content,
      source: "ui",
      idempotencyKey: "large-accepted",
    });
    assert.equal(receipt.accepted, true);
    await waitFor(async () => (await router.getCommand(receipt.commandId)).status === "completed");
    assert.equal(session.starts[0].message.length, content.length);

    await assert.rejects(
      router.dispatchSessionMessage({
        targetSessionId: session.sessionId,
        content: "x".repeat(256 * 1024 + 1),
        source: "ui",
        idempotencyKey: "large-rejected",
      }),
      (error) => error?.code === "SESSION_MESSAGE_TOO_LARGE" && /256 KiB/.test(error.message),
    );
    // Join the fire-and-forget drain before deleting its journal. On Windows,
    // deleting the directory while the final status append is still settling
    // can produce a misleading ENOENT/EPERM after every assertion has passed.
    await router.resumeSession(session.sessionId);
  } finally {
    resetSessionInboxesForTests();
    removeTempRoot(root);
  }
});
