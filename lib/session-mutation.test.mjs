import assert from "node:assert/strict";
import test from "node:test";
import { acquireSessionMutation, assertSessionNotMutating, collectSessionSubtree, runSessionFileOperation, drainSessionFileOperations, trackSessionFileOperation } from "./session-mutation.ts";

test("collects descendants once, handles cycles and excludes unrelated tasks", () => {
  const tasks = [{ id: "a", parentSessionId: "c" }, { id: "b", parentSessionId: "a" }, { id: "c", parentSessionId: "b" }, { id: "other" }];
  assert.deepEqual(collectSessionSubtree(tasks, "a").map((s) => s.id), ["a", "b", "c"]);
});

test("mutation exclusion is atomic and releases all descendants", () => {
  const release = acquireSessionMutation(["root", "child"]);
  try {
    assert.throws(() => assertSessionNotMutating("child"));
    assert.throws(() => acquireSessionMutation(["other", "child"]));
    assert.doesNotThrow(() => assertSessionNotMutating("other"));
  } finally { release(); }
  assert.doesNotThrow(() => assertSessionNotMutating("child"));
});

test("deletion waits for file creators already admitted and excludes late creators", async () => {
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let created = false;
  const creation = runSessionFileOperation("fork-source", async () => { await gate; created = true; });
  const release = acquireSessionMutation(["fork-source"]);
  try {
    await assert.rejects(runSessionFileOperation("fork-source", async () => assert.fail("late fork")));
    let drained = false;
    const drain = drainSessionFileOperations(["fork-source"]).then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    finish();
    await Promise.all([creation, drain]);
    assert.equal(created, true);
    assert.equal(globalThis.__pioraSessionFileOperations.size, 0);
  } finally { release(); }
});

test("draining includes shutdown enqueued by a finishing fork", async () => {
  let finishFork, finishShutdown;
  const forkGate = new Promise((resolve) => { finishFork = resolve; });
  const shutdownGate = new Promise((resolve) => { finishShutdown = resolve; });
  const fork = runSessionFileOperation("chain", async () => {
    await forkGate;
    void trackSessionFileOperation("chain", shutdownGate);
  });
  let drained = false;
  const drain = drainSessionFileOperations(["chain"]).then(() => { drained = true; });
  finishFork();
  await fork;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  finishShutdown();
  await drain;
  assert.equal(drained, true);
});
