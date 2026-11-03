import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, rmSync, rmdirSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { retainSessionFileOwnership, withSessionFileOwnership, sessionOwnershipPath, isSessionOwnershipError } = await jiti.import("./session-file-ownership.ts");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-session-owner-"));
  t.after(() => { assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); });
  return root;
}
function worker(root) {
  const path = join(root, "owner-worker.mjs");
  writeFileSync(path, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
import { createInterface } from 'node:readline';
const { retainSessionFileOwnership } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./session-file-ownership.ts", import.meta.url).href)});
try {
  const owner = retainSessionFileOwnership(process.argv[3], process.argv[2]);
  if (process.argv[4] === 'hold') {
    console.log('owned');
    createInterface({ input: process.stdin }).on('line', line => {
      if (line === 'assert') { try { owner.assertOwned(); console.log('owned'); } catch (error) { console.log(error.code ?? 'error'); } }
      else if (line === 'exit') { process.exit(0); }
      else if (line === 'observe') { owner.onCompromised(() => console.log('compromised')); console.log('watching'); }
      else { owner.release(); process.exit(0); }
    });
  }
  else { owner.assertOwned(); owner.release(); console.log('available'); }
} catch (error) { console.log(error.code ?? 'error'); process.exitCode = error.code === 'SESSION_IN_USE' ? 9 : 1; }
`);
  return path;
}
test("local references keep ownership until the last writer releases and unrelated sessions remain independent", async t => {
  const root = fixture(t), first = retainSessionFileOwnership("chat", root), second = retainSessionFileOwnership("chat", root);
  first.release(); first.release();
  assert.throws(first.assertOwned, /no longer active/);
  second.assertOwned(); assert.ok(existsSync(sessionOwnershipPath("chat", root)));
  await withSessionFileOwnership("other", owner => owner.assertOwned(), root);
  assert.equal(existsSync(sessionOwnershipPath("other", root)), false);
  second.release(); assert.equal(existsSync(sessionOwnershipPath("chat", root)), false);
  assert.equal(globalThis.__pioraSessionFileOwners.size, 0);
});

test("lockSync continues heartbeating and synchronous assertions accept the renewed lease", async t => {
  const root = fixture(t), owner = retainSessionFileOwnership("heartbeat", root);
  t.after(() => owner.release());
  const before = statSync(sessionOwnershipPath("heartbeat", root)).mtimeMs;
  await delay(10_500);
  const after = statSync(sessionOwnershipPath("heartbeat", root)).mtimeMs;
  assert.ok(after > before, "the synchronous lock must renew its lease");
  owner.assertOwned();
});

test("a writer returning after its lease deadline fails closed before the next heartbeat", t => {
  const root = fixture(t), owner = retainSessionFileOwnership("expired", root);
  let compromised = 0;
  owner.onCompromised(() => { compromised++; });
  const now = Date.now;
  try {
    Date.now = () => now() + 121_000;
    assert.throws(owner.assertOwned, error => error.code === "SESSION_IN_USE");
  } finally { Date.now = now; }
  assert.equal(compromised, 1);
  assert.throws(owner.assertOwned, error => error.code === "SESSION_IN_USE");
  assert.equal(compromised, 1);
  owner.release();
});

async function startOwner(t, root) {
  const child = spawn(process.execPath, [worker(root), root, "chat", "hold"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
  });
  const lines = createInterface({ input: child.stdout });
  const first = once(lines, "line");
  assert.equal((await first)[0], "owned");
  return { child, lines };
}

test("an old process cannot assert or release a replacement lock even with the same mtime", async t => {
  const root = fixture(t), { child, lines } = await startOwner(t, root);
  const path = sessionOwnershipPath("chat", root), original = statSync(path);
  assert.equal(dirname(path), join(root, "piora", "session-owners"));
  rmdirSync(path);
  const replacement = retainSessionFileOwnership("chat", root);
  t.after(() => replacement.release());
  // Preserve the replacement owner's captured timestamp, but give the old
  // owner its original timestamp to prove the directory identity also matters.
  // Both acquisitions may occur within the same precision-probe second.
  const replacementTime = statSync(path).mtime;
  utimesSync(path, original.atime, original.mtime);
  const checked = once(lines, "line"); child.stdin.write("assert\n");
  assert.equal((await checked)[0], "SESSION_IN_USE");
  utimesSync(path, replacementTime, replacementTime);
  const stopped = once(child, "exit"); child.stdin.write("release\n");
  assert.equal((await stopped)[0], 0);
  assert.ok(existsSync(path), "obsolete release must not remove the new owner's lock");
  replacement.assertOwned(); replacement.release();
});

test("a stale lock taken by another process is rejected synchronously before heartbeat detection", async t => {
  const root = fixture(t), { child, lines } = await startOwner(t, root);
  const path = sessionOwnershipPath("chat", root), stale = new Date(Date.now() - 121_000);
  utimesSync(path, stale, stale);
  const replacement = retainSessionFileOwnership("chat", root);
  t.after(() => replacement.release());
  const checked = once(lines, "line"); child.stdin.write("assert\n");
  assert.equal((await checked)[0], "SESSION_IN_USE");
  const stopped = once(child, "exit"); child.stdin.write("release\n");
  assert.equal((await stopped)[0], 0);
  replacement.assertOwned(); assert.ok(existsSync(path));
});

for (const command of ["release", "exit"]) {
  test(`an obsolete process's ${command} preserves a replacement lock without a prior assertion`, async t => {
    const root = fixture(t), { child } = await startOwner(t, root);
    const path = sessionOwnershipPath("chat", root), stale = new Date(Date.now() - 121_000);
    utimesSync(path, stale, stale);
    const replacement = retainSessionFileOwnership("chat", root);
    t.after(() => replacement.release());
    const stopped = once(child, "exit"); child.stdin.write(`${command}\n`);
    assert.equal((await stopped)[0], 0);
    replacement.assertOwned(); assert.ok(existsSync(path));
  });
}

test("a heartbeat detects a replaced lease once and cannot renew the new owner's directory", { timeout: 20_000 }, async t => {
  const root = fixture(t), { child, lines } = await startOwner(t, root);
  const watching = once(lines, "line"); child.stdin.write("observe\n");
  assert.equal((await watching)[0], "watching");
  const path = sessionOwnershipPath("chat", root), stale = new Date(Date.now() - 121_000);
  utimesSync(path, stale, stale);
  const replacement = retainSessionFileOwnership("chat", root);
  t.after(() => replacement.release());
  assert.equal((await once(lines, "line"))[0], "compromised");
  replacement.assertOwned();
  const checked = once(lines, "line"); child.stdin.write("assert\n");
  assert.equal((await checked)[0], "SESSION_IN_USE");
  const stopped = once(child, "exit"); child.stdin.write("release\n");
  assert.equal((await stopped)[0], 0);
  replacement.assertOwned();
});
test("a second process cannot write a locally owned session and can acquire it after release", async t => {
  const root = fixture(t), script = worker(root), owner = retainSessionFileOwnership("chat", root);
  const run = promisify(execFile);
  try { await assert.rejects(run(process.execPath, [script, root, "chat"]), error => error.code === 9 && error.stdout.trim() === "SESSION_IN_USE"); }
  finally { owner.release(); }
  assert.equal((await run(process.execPath, [script, root, "chat"])).stdout.trim(), "available");
});
test("a live foreign owner excludes the parent until its verified process releases", async t => {
  const root = fixture(t), script = worker(root);
  const child = spawn(process.execPath, [script, root, "chat", "hold"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [chunk] = await once(child.stdout, "data"); assert.match(chunk.toString(), /owned/);
  assert.throws(() => retainSessionFileOwnership("chat", root), error => error.code === "SESSION_IN_USE");
  const stopped = once(child, "exit"); child.stdin.write("release\n");
  const [code] = await stopped; assert.equal(code, 0);
  const owner = retainSessionFileOwnership("chat", root); owner.assertOwned(); owner.release();
});
test("throwing operations release ownership and arbitrary IDs never become paths", async t => {
  const root = fixture(t);
  await assert.rejects(withSessionFileOwnership("../../other", () => { throw new Error("operation failed"); }, root), /operation failed/);
  const path = sessionOwnershipPath("../../other", root);
  assert.equal(dirname(path), join(root, "piora", "session-owners"));
  assert.equal(existsSync(path), false);
});

test("ownership errors are recognized across independent module instances without matching unrelated conflicts", () => {
  const foreign = Object.assign(new Error("foreign owner"), { name: "SessionOwnershipError", code: "SESSION_IN_USE" });
  assert.equal(isSessionOwnershipError(foreign), true);
  assert.equal(isSessionOwnershipError({ name: "SessionOwnershipError", code: "SESSION_IN_USE" }), true);
  assert.equal(isSessionOwnershipError({ code: "SESSION_IN_USE" }), false);
  assert.equal(isSessionOwnershipError({ name: "SessionOwnershipError", code: "ELOCKED" }), false);
  assert.equal(isSessionOwnershipError(null), false);
});
