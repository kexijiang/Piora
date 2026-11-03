import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { readOnlySessionManager } = await jiti.import("./session-readonly-manager.ts");
const { intelligentUiSessionReader } = await jiti.import("./intelligent-ui/session.ts");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-readonly-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const last = manager.appendMessage({ role: "user", content: "last", timestamp: 2 });
  t.after(() => globalThis.__piSessions?.delete(manager.getSessionId()));
  return { manager, first, last, path: manager.getSessionFile() };
}
function unchanged(path, action) {
  const before = readFileSync(path), mtime = statSync(path).mtimeMs;
  const result = action(); assert.deepEqual(readFileSync(path), before); assert.equal(statSync(path).mtimeMs, mtime); return result;
}
test("read-only SDK snapshot exposes identity and readers but cannot persist or repair the file", t => {
  const f = fixture(t); writeFileSync(f.path, readFileSync(f.path, "utf8").trimEnd());
  const reader = unchanged(f.path, () => readOnlySessionManager(f.path, { expectedSessionId: f.manager.getSessionId() }));
  assert.equal(reader.getSessionFile(), f.path);
  assert.equal(reader.getSessionId(), f.manager.getSessionId());
  assert.deepEqual(reader.getBranch().map(entry => entry.id), [f.first, f.last]);
  assert.equal(reader.appendMessage, undefined); assert.equal(reader.setSessionFile, undefined); assert.equal(reader.createBranchedSession, undefined);
  assert.equal(Object.isFrozen(reader), true);
});
test("old session versions migrate only in memory", t => {
  const f = fixture(t), rows = readFileSync(f.path, "utf8").trimEnd().split("\n").map(JSON.parse);
  rows[0].version = 2; writeFileSync(f.path, rows.map(JSON.stringify).join("\n"));
  const reader = unchanged(f.path, () => readOnlySessionManager(f.path));
  assert.equal(reader.getHeader().version, 3); assert.equal(reader.getEntries().length, 2);
});
test("partial records, unsupported versions and mismatched identities fail without repairing disk", t => {
  const f = fixture(t), original = readFileSync(f.path, "utf8");
  unchanged(f.path, () => assert.throws(() => readOnlySessionManager(f.path, { expectedSessionId: "different" }), /identity/));
  writeFileSync(f.path, original + '{"type":');
  unchanged(f.path, () => assert.throws(() => readOnlySessionManager(f.path), /incomplete|invalid/));
  const rows = original.trimEnd().split("\n").map(JSON.parse); rows[0].version = 99;
  writeFileSync(f.path, rows.map(JSON.stringify).join("\n"));
  unchanged(f.path, () => assert.throws(() => readOnlySessionManager(f.path), /Unsupported/));
});
test("UI reader preserves the live branch selection but uses only disk-backed entries", async t => {
  const f = fixture(t); f.manager.branch(f.first);
  globalThis.__piSessions ??= new Map(); globalThis.__piSessions.set(f.manager.getSessionId(), { isAlive: () => true, inner: { sessionManager: f.manager } });
  const read = await intelligentUiSessionReader(f.manager.getSessionId(), f.path);
  const reader = unchanged(f.path, read);
  assert.equal(reader.getLeafId(), f.first); assert.deepEqual(reader.getBranch().map(entry => entry.id), [f.first]);
  assert.notEqual(reader, f.manager);
  const noLeaf = readOnlySessionManager(f.path, { leafId: null }); assert.equal(noLeaf.getLeafId(), null); assert.deepEqual(noLeaf.getBranch(), []);
});
