import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync, rmdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { acquireExclusiveFileLease, sessionOwnershipPath } = await jiti.import("../session-file-ownership.ts");
const { withUiFileLock, uiSessionLockPath } = await jiti.import("./session-lock.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-ui-file-lock-")), cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  return { root, cleanup: work => cleanups.push(work) };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function expire(path) {
  const stale = new Date(Date.now() - 11_000);
  utimesSync(path, stale, stale);
}

test("UI mutexes remain exclusive within one process and retain their existing lock path", async t => {
  const { root, cleanup } = fixture(t), path = uiSessionLockPath("chat", root), gate = deferred();
  const order = [];
  const first = withUiFileLock(path, async assertOwned => { order.push("first"); await gate.promise; assertOwned(); });
  cleanup(() => gate.resolve());
  assert.ok(existsSync(path));
  assert.throws(() => acquireExclusiveFileLease(path), error => error.code === "ELOCKED");
  const second = withUiFileLock(path, assertOwned => { assertOwned(); order.push("second"); });
  await delay(30);
  assert.deepEqual(order, ["first"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(existsSync(path), false);
  await withUiFileLock(path, () => withUiFileLock(`${path}.journal`, () => {}));
});

test("UI lock contention has bounded retries and never runs the rejected operation", { timeout: 10_000 }, async t => {
  const { root, cleanup } = fixture(t), path = join(root, "busy.lock"), owner = acquireExclusiveFileLease(path);
  cleanup(() => owner.release());
  await assert.rejects(withUiFileLock(path, () => assert.fail("busy operation ran")), error => error.code === "SESSION_IN_USE");
  owner.assertOwned();
});

test("an old same-process UI lease cannot release or stop the heartbeat of its replacement", async t => {
  const { root, cleanup } = fixture(t), path = join(root, "replaced.lock"), gate = deferred();
  const old = withUiFileLock(path, async () => { await gate.promise; });
  const rejected = assert.rejects(old, error => error.code === "SESSION_IN_USE");
  cleanup(() => gate.resolve());
  expire(path);
  const replacement = acquireExclusiveFileLease(path, { staleMs: 2_000, updateMs: 1_000 });
  cleanup(() => replacement.release());
  const before = statSync(path).mtimeMs;
  gate.resolve(); await rejected;
  replacement.assertOwned();
  await delay(1_100);
  assert.ok(statSync(path).mtimeMs > before, "obsolete release must not cancel the new owner's library timer");
  replacement.assertOwned();
});

test("directory identity rejects a replacement even when its timestamp matches", t => {
  const { root, cleanup } = fixture(t), path = join(root, "identity.lock"), old = acquireExclusiveFileLease(path);
  cleanup(() => old.release());
  const original = statSync(path);
  assert.equal(dirname(path), root);
  rmdirSync(path);
  const replacement = acquireExclusiveFileLease(path);
  cleanup(() => replacement.release());
  const replacementTime = statSync(path).mtime;
  utimesSync(path, original.atime, original.mtime);
  assert.throws(old.assertOwned, error => error.code === "SESSION_IN_USE");
  old.release();
  assert.ok(existsSync(path));
  utimesSync(path, replacementTime, replacementTime);
  replacement.assertOwned();
});

test("a lease that resumes after expiry fails synchronously and notifies once", t => {
  const { root, cleanup } = fixture(t), owner = acquireExclusiveFileLease(join(root, "expired.lock"));
  cleanup(() => owner.release());
  let notifications = 0;
  owner.onCompromised(() => { notifications++; });
  const now = Date.now;
  try {
    Date.now = () => now() + 11_000;
    assert.throws(owner.assertOwned, error => error.code === "SESSION_IN_USE");
  } finally { Date.now = now; }
  assert.throws(owner.assertOwned, error => error.code === "SESSION_IN_USE");
  assert.equal(notifications, 1);
});

async function startReader(fixture) {
  const script = join(fixture.root, "reader.mjs");
  writeFileSync(script, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
import { createInterface } from 'node:readline';
const { withUiSessionReadLock } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./session-lock.ts", import.meta.url).href)});
const lines = createInterface({ input: process.stdin });
try {
  await withUiSessionReadLock('chat', process.argv[2], () => new Promise(resolve => {
    console.log('reading');
    lines.on('line', line => { if (line === 'exit') process.exit(0); else resolve(); });
  }));
  console.log('finished');
} catch (error) { console.log(error.code ?? error.message); }
finally { lines.close(); }
`);
  const child = spawn(process.execPath, [script, fixture.root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  fixture.cleanup(async () => {
    if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
  });
  const lines = createInterface({ input: child.stdout });
  assert.equal((await once(lines, "line"))[0], "reading");
  assert.equal(existsSync(sessionOwnershipPath("chat", fixture.root)), false, "reading must not claim the session writer lease");
  return { child, lines };
}

for (const command of ["finish", "exit"]) {
  test(`a stale foreign reader's ${command} preserves the replacement UI mutex`, { timeout: 15_000 }, async t => {
    const data = fixture(t), { child, lines } = await startReader(data), path = uiSessionLockPath("chat", data.root);
    expire(path);
    const replacement = acquireExclusiveFileLease(path);
    data.cleanup(() => replacement.release());
    const stopped = once(child, "exit");
    const result = command === "finish" ? once(lines, "line") : null;
    child.stdin.write(`${command}\n`);
    if (result) assert.equal((await result)[0], "SESSION_IN_USE");
    assert.equal((await stopped)[0], 0);
    assert.ok(existsSync(path)); replacement.assertOwned();
  });
}
