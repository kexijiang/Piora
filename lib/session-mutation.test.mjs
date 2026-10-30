import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireSessionMutation, assertSessionNotMutating, collectSessionSubtree, runSessionFileOperation, drainSessionFileOperations, trackSessionFileOperation, trackSessionShutdown, drainSessionShutdown } from "./session-mutation.ts";
import { retainSessionFileOwnership, sessionOwnershipPath } from "./session-file-ownership.ts";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-session-mutation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("collects descendants once, handles cycles and excludes unrelated tasks", () => {
  const tasks = [{ id: "a", parentSessionId: "c" }, { id: "b", parentSessionId: "a" }, { id: "c", parentSessionId: "b" }, { id: "other" }];
  assert.deepEqual(collectSessionSubtree(tasks, "a").map((s) => s.id), ["a", "b", "c"]);
});

test("mutation exclusion is atomic and releases all descendants", t => {
  const root = fixture(t);
  const release = acquireSessionMutation(["root", "child", "child"], root);
  try {
    assert.throws(() => assertSessionNotMutating("child"));
    assert.throws(() => acquireSessionMutation(["other", "child"], root));
    assert.doesNotThrow(() => assertSessionNotMutating("other"));
  } finally { release(); release(); }
  assert.doesNotThrow(() => assertSessionNotMutating("child"));
});

test("deletion waits for file creators already admitted and excludes late creators", async t => {
  const root = fixture(t);
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  let created = false;
  const creation = runSessionFileOperation("fork-source", async () => { await gate; created = true; }, root);
  const release = acquireSessionMutation(["fork-source"], root);
  try {
    await assert.rejects(runSessionFileOperation("fork-source", async () => assert.fail("late fork"), root));
    let drained = false;
    const drain = drainSessionFileOperations(["fork-source"]).then(() => { drained = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    finish();
    await Promise.all([creation, drain]);
    assert.equal(created, true);
    assert.equal(globalThis.__pioraSessionFileOperations.size, 0);
    assert.ok(existsSync(sessionOwnershipPath("fork-source", root)), "deletion retains ownership after the old writer stops");
  } finally { release(); }
  assert.equal(existsSync(sessionOwnershipPath("fork-source", root)), false);
});

test("draining includes shutdown enqueued by a finishing fork", async t => {
  const root = fixture(t);
  let finishFork, finishShutdown;
  const forkGate = new Promise((resolve) => { finishFork = resolve; });
  const shutdownGate = new Promise((resolve) => { finishShutdown = resolve; });
  const fork = runSessionFileOperation("chain", async () => {
    await forkGate;
    void trackSessionFileOperation("chain", shutdownGate);
  }, root);
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

test("foreign writer blocks mutations atomically and prevents file-operation callbacks", async t => {
  const root = fixture(t), owner = retainSessionFileOwnership("z-owned", root);
  const source = `import { acquireSessionMutation, runSessionFileOperation } from ${JSON.stringify(new URL("./session-mutation.ts", import.meta.url).href)};
const root = process.argv[1];
let mutation, operation, ran = false;
try { acquireSessionMutation(['a-free', 'z-owned'], root)(); } catch (error) { mutation = error.code; }
try { await runSessionFileOperation('z-owned', async () => { ran = true; }, root); } catch (error) { operation = error.code; }
console.log(JSON.stringify({ mutation, operation, ran, mutationLocks: [...(globalThis.__pioraSessionMutations ?? [])] }));`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, root], { windowsHide: true });
    assert.deepEqual(JSON.parse(stdout.trim()), { mutation: "SESSION_IN_USE", operation: "SESSION_IN_USE", ran: false, mutationLocks: [] });
    assert.equal(existsSync(sessionOwnershipPath("a-free", root)), false, "partially acquired descendants must release on failure");
    owner.assertOwned();
  } finally { owner.release(); }
});

test("offline operation waits for retired runtime shutdown without waiting for itself", async t => {
  const root = fixture(t); let finish;
  const order = [];
  const shutdown = trackSessionShutdown("retired", new Promise(resolve => { finish = () => { order.push("shutdown"); resolve(); }; }));
  const operation = runSessionFileOperation("retired", async owner => {
    await drainSessionShutdown("retired"); owner.assertOwned(); order.push("offline-write");
  }, root);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, []);
  finish(); await Promise.all([shutdown, operation]);
  assert.deepEqual(order, ["shutdown", "offline-write"]);
  assert.equal(globalThis.__pioraSessionShutdowns.size, 0);
});
