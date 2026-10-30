import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createOwnedSessionManager, openOwnedSessionManager } = await jiti.import("./session-owned-manager.ts");
const { sessionOwnershipPath } = await jiti.import("./session-file-ownership.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-owned-manager-"));
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function user(text = "hello") { return { role: "user", content: text, timestamp: Date.now() }; }
function header(id, cwd, version = 3) { return { type: "session", id, cwd, version, timestamp: new Date().toISOString() }; }
function ownerRecord(root, id) {
  const path = sessionOwnershipPath(id, root);
  return globalThis.__pioraSessionFileOwners.get(process.platform === "win32" ? path.toLowerCase() : path);
}
function revoke(root, id) {
  const record = ownerRecord(root, id);
  assert.ok(record);
  record.compromised = true;
  for (const listener of record.listeners) listener();
}
async function holdForeignOwner(t, root, id) {
  const script = join(root, "foreign-owner.mjs");
  writeFileSync(script, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
const { retainSessionFileOwnership } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./session-file-ownership.ts", import.meta.url).href)});
const owner = retainSessionFileOwnership(process.argv[3], process.argv[2]);
console.log('owned');
process.stdin.once('data', () => { owner.release(); process.exit(0); });
`);
  const child = spawn(process.execPath, [script, root, id], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const [chunk] = await once(child.stdout, "data");
  assert.match(chunk.toString(), /owned/);
  return async () => {
    const stopped = once(child, "exit");
    child.stdin.write("release\n");
    const [code] = await stopped;
    assert.equal(code, 0);
  };
}

test("real SDK creation remains lazy and guards initial flush, append and late writes after release", t => {
  const root = fixture(t);
  const owned = createOwnedSessionManager(root, join(root, "sessions"), root);
  t.after(owned.release);
  const manager = owned.manager, id = manager.getSessionId(), file = manager.getSessionFile();
  assert.ok(manager instanceof SessionManager);
  assert.ok(existsSync(sessionOwnershipPath(id, root)));
  assert.equal(existsSync(file), false);
  manager.appendModelChange("test", "model");
  assert.equal(existsSync(file), false);
  manager.appendMessage(user());
  manager.appendCustomEntry("test", { durable: true });
  const before = readFileSync(file, "utf8");
  assert.match(before, /durable/);
  const entries = manager.getEntries().length;
  owned.release();
  owned.release();
  assert.equal(existsSync(sessionOwnershipPath(id, root)), false);
  assert.throws(() => manager.appendMessage(user("late")), error => error.code === "SESSION_IN_USE");
  assert.throws(() => manager._rewriteFile(), error => error.code === "SESSION_IN_USE");
  assert.equal(manager.getEntries().length, entries);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("opening acquires ownership before newline repair and legacy migration", async t => {
  const root = fixture(t), file = join(root, "legacy.jsonl"), id = "legacy-session";
  const content = JSON.stringify(header(id, root, 2));
  writeFileSync(file, content);
  const releaseForeign = await holdForeignOwner(t, root, id);
  assert.throws(() => openOwnedSessionManager(file, undefined, root), error => error.code === "SESSION_IN_USE");
  assert.equal(readFileSync(file, "utf8"), content);
  await releaseForeign();
  const owned = openOwnedSessionManager(file, undefined, root);
  t.after(owned.release);
  assert.equal(owned.manager.getSessionId(), id);
  const migrated = readFileSync(file, "utf8");
  assert.ok(migrated.endsWith("\n"));
  assert.equal(JSON.parse(migrated.trim()).version, 3);
  assert.ok(existsSync(sessionOwnershipPath(id, root)));
});

test("newSession acquires before changing identity and retains all IDs until release", async t => {
  const root = fixture(t), dir = join(root, "sessions");
  const owned = createOwnedSessionManager(root, dir, root);
  t.after(owned.release);
  const manager = owned.manager, oldId = manager.getSessionId(), oldFile = manager.getSessionFile();
  manager.appendMessage(user());
  const releaseForeign = await holdForeignOwner(t, root, "next-session");
  assert.throws(() => manager.newSession({ id: "next-session" }), error => error.code === "SESSION_IN_USE");
  assert.equal(manager.getSessionId(), oldId);
  assert.equal(manager.getSessionFile(), oldFile);
  assert.equal(manager.getEntries().length, 1);
  await releaseForeign();
  manager.newSession({ id: "next-session" });
  manager.appendMessage(user("next"));
  assert.ok(existsSync(sessionOwnershipPath(oldId, root)));
  assert.ok(existsSync(sessionOwnershipPath("next-session", root)));
  owned.release();
  assert.equal(existsSync(sessionOwnershipPath(oldId, root)), false);
  assert.equal(existsSync(sessionOwnershipPath("next-session", root)), false);
});

test("branch destination is owned before the SDK changes its ID and writes the file", t => {
  const root = fixture(t), dir = join(root, "sessions");
  const owned = createOwnedSessionManager(root, dir, root);
  t.after(owned.release);
  const manager = owned.manager, oldId = manager.getSessionId();
  const leaf = manager.appendMessage(user());
  const owners = globalThis.__pioraSessionFileOwners;
  const originalSet = owners.set;
  let acquiredBeforeAssignment = false;
  owners.set = function(key, value) {
    acquiredBeforeAssignment = true;
    assert.equal(manager.getSessionId(), oldId);
    return originalSet.call(this, key, value);
  };
  let file;
  try { file = manager.createBranchedSession(leaf); }
  finally { owners.set = originalSet; }
  assert.ok(acquiredBeforeAssignment);
  const newId = manager.getSessionId();
  assert.notEqual(newId, oldId);
  assert.ok(existsSync(sessionOwnershipPath(newId, root)));
  assert.ok(existsSync(sessionOwnershipPath(oldId, root)));
  assert.equal(JSON.parse(readFileSync(file, "utf8").split("\n")[0]).id, newId);
  owned.release();
  assert.equal(existsSync(sessionOwnershipPath(newId, root)), false);
  assert.equal(existsSync(sessionOwnershipPath(oldId, root)), false);
});

test("compromised ownership stops append and rewrite before bytes or in-memory history change", t => {
  const root = fixture(t), owned = createOwnedSessionManager(root, join(root, "sessions"), root);
  t.after(owned.release);
  const manager = owned.manager, id = manager.getSessionId();
  const leaf = manager.appendMessage(user());
  const file = manager.getSessionFile(), before = readFileSync(file, "utf8");
  let notified = 0;
  owned.onCompromised(() => { notified++; });
  revoke(root, id);
  assert.equal(notified, 1);
  assert.throws(owned.assertOwned, error => error.code === "SESSION_IN_USE");
  assert.throws(() => manager.appendMessage(user("lost")), error => error.code === "SESSION_IN_USE");
  assert.throws(() => manager._rewriteFile(), error => error.code === "SESSION_IN_USE");
  assert.throws(() => manager.createBranchedSession(leaf), error => error.code === "SESSION_IN_USE");
  assert.equal(manager.getEntries().length, 1);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(readdirSync(join(root, "sessions")).length, 1);
});

test("setSessionFile protects its target before repair and preserves original manager on refusal", async t => {
  const root = fixture(t), target = join(root, "target.jsonl");
  const owned = createOwnedSessionManager(root, join(root, "sessions"), root);
  t.after(owned.release);
  const manager = owned.manager, oldId = manager.getSessionId(), oldFile = manager.getSessionFile();
  const content = JSON.stringify(header("target", root));
  writeFileSync(target, content);
  const releaseForeign = await holdForeignOwner(t, root, "target");
  assert.throws(() => manager.setSessionFile(target), error => error.code === "SESSION_IN_USE");
  assert.equal(manager.getSessionId(), oldId);
  assert.equal(manager.getSessionFile(), oldFile);
  assert.equal(readFileSync(target, "utf8"), content);
  await releaseForeign();
  manager.setSessionFile(target);
  assert.equal(manager.getSessionId(), "target");
  assert.equal(readFileSync(target, "utf8"), `${content}\n`);
});

test("empty and missing files acquire generated IDs; invalid files remain untouched without leaking owners", t => {
  const root = fixture(t), empty = join(root, "empty.jsonl"), absent = join(root, "absent.jsonl"), bad = join(root, "bad.jsonl");
  writeFileSync(empty, "");
  for (const file of [empty, absent]) {
    const owned = openOwnedSessionManager(file, undefined, root);
    try {
      assert.ok(existsSync(sessionOwnershipPath(owned.manager.getSessionId(), root)));
      owned.manager.appendMessage(user());
      assert.equal(owned.manager.getSessionFile(), file);
      assert.match(readFileSync(file, "utf8"), /hello/);
    } finally { owned.release(); }
  }
  writeFileSync(bad, "not a session");
  const count = globalThis.__pioraSessionFileOwners.size;
  assert.throws(() => openOwnedSessionManager(bad, undefined, root), /not a valid/);
  assert.equal(readFileSync(bad, "utf8"), "not a session");
  assert.equal(globalThis.__pioraSessionFileOwners.size, count);
});
