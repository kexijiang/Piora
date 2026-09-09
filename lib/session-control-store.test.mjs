import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionControlStore } = await jiti.import("./session-control-store.ts");

function command(sessionId, suffix, acceptedAt = Date.now()) {
  return {
    commandId: `cmd-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    targetSessionId: sessionId,
    content: `message-${suffix}`,
    delivery: "next_turn",
    source: "remote",
    acceptedAt,
    status: "accepted",
  };
}

test("session control journals tolerate a damaged tail and preserve event cursors", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-control-store-"));
  try {
    const store = new SessionControlStore({ root });
    const first = command("session-a", "one");
    await store.appendCommand(first);
    await store.appendStatus(first, "queued", { queuedAt: Date.now() });
    appendFileSync(store.commandsPath("session-a"), "{damaged tail\n", "utf8");
    const loaded = store.loadCommands("session-a");
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].status, "queued");
    assert.equal(store.findByIdempotencyKey("key-one", "session-a")?.commandId, "cmd-one");

    const events = await Promise.all([1, 2, 3].map((index) => store.appendEvent({
      type: "command_queued",
      sessionId: "session-a",
      commandId: first.commandId,
      status: "queued",
      timestamp: Date.now() + index,
    })));
    assert.deepEqual(events.map((event) => event.cursor).sort((a, b) => a - b), [1, 2, 3]);
    assert.equal(store.listEvents("session-a").length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compaction removes only old terminal commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-control-compact-"));
  try {
    const store = new SessionControlStore({ root, retentionDays: 1 });
    const old = command("session-a", "old", Date.now() - 3 * 24 * 60 * 60 * 1000);
    const current = command("session-a", "current");
    await store.appendCommand(old);
    await store.appendStatus(old, "completed");
    await store.appendCommand(current);
    const stoppedUi = { ...command("session-a", "stopped-ui", old.acceptedAt), source: "ui" };
    await store.appendCommand(stoppedUi);
    await store.appendStatus(stoppedUi, "cancelled");
    await store.appendStatus(current, "queued");
    await store.compact("session-a");
    assert.equal(store.findByCommandId("cmd-old"), undefined);
    assert.equal(store.findByCommandId("cmd-current")?.status, "queued");
    assert.equal(store.findByCommandId("cmd-stopped-ui")?.content, "message-stopped-ui");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
