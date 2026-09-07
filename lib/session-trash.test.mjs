import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Isolate the trash root under a temp dir by pointing the SDK's agent dir at
// it (getAgentDir reads PI_CODING_AGENT_DIR on every call).
const sandbox = mkdtempSync(join(tmpdir(), "pi-trash-test-"));
process.env.PI_CODING_AGENT_DIR = sandbox;

const jiti = createJiti(import.meta.url);
const {
  getTrashRoot,
  trashSession,
  restoreSession,
  purgeExpiredTrash,
  readTrashManifest,
  TRASH_UNDO_WINDOW_MS,
  TRASH_RETENTION_MS,
  listTrashSessions,
} = await jiti.import("./session-trash.ts");

function makeSessionFile(dir, name, parentSession) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  const header = { type: "session", version: 3, id: name.slice(0, 8), timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
  if (parentSession) header.parentSession = parentSession;
  writeFileSync(file, `${JSON.stringify(header)}\n{"type":"message"}\n`, "utf8");
  return file;
}

test("trash root lives outside the sessions tree and resolves to a temp agent dir", () => {
  assert.equal(getTrashRoot(), join(sandbox, "trash", "sessions"));
});

test("trashSession moves the whole subtree and writes a manifest before any move", () => {
  const dir = join(sandbox, "sessions", "project-a");
  const root = makeSessionFile(dir, "10000000_aaa.jsonl");
  const child = makeSessionFile(dir, "10000001_bbb.jsonl", root);

  const manifest = trashSession("id-1", [root, child]);
  assert.equal(manifest.entries.length, 2);
  assert.ok(readTrashManifest("id-1"), "manifest survives the move");
  assert.ok(!existsSync(root), "root no longer at original path");
  assert.ok(!existsSync(child), "child no longer at original path");
  assert.ok(manifest.entries.every((entry) => existsSync(entry.trashed)), "every file exists in trash");
});

test("restoreSession moves every file back and clears the manifest", () => {
  const dir = join(sandbox, "sessions", "project-b");
  const root = makeSessionFile(dir, "20000000_aaa.jsonl");
  const child = makeSessionFile(dir, "20000001_bbb.jsonl", root);

  trashSession("id-2", [root, child]);
  assert.equal(restoreSession("id-2"), true);
  assert.ok(existsSync(root), "root restored");
  assert.ok(existsSync(child), "child restored");
  // Content intact, including the child's parentSession link to the root path
  // (JSON-escaped on disk, so compare against the escaped form).
  assert.ok(readFileSync(child, "utf8").includes(JSON.stringify(root).slice(1, -1)), "parentSession link preserved");
  assert.equal(readTrashManifest("id-2"), null, "manifest removed");
});

test("restore of an unknown or purged session returns false", () => {
  assert.equal(restoreSession("does-not-exist"), false);
});

test("missing files cannot produce a successful partial delete or restore", () => {
  const file = makeSessionFile(join(sandbox, "sessions", "missing"), "missing.jsonl");
  assert.throws(() => trashSession("missing-delete", [file, join(sandbox, "not-there.jsonl")]), /changed during deletion/);
  assert.ok(existsSync(file), "rollback restores the first file");
  assert.equal(readTrashManifest("missing-delete"), null);
  const manifest = trashSession("missing-restore", [file]);
  rmSync(manifest.entries[0].trashed);
  assert.throws(() => restoreSession("missing-restore"), /Recovery was not completed/);
  assert.ok(readTrashManifest("missing-restore"), "retain metadata for inspection instead of claiming success");
});

test("purgeExpiredTrash removes files past the undo window and keeps fresh ones", () => {
  const dir = join(sandbox, "sessions", "project-c");
  const fresh = makeSessionFile(dir, "30000000_fresh.jsonl");
  const stale = makeSessionFile(dir, "30000001_stale.jsonl");

  trashSession("fresh", [fresh]);
  // Simulate an old manifest by rewriting its timestamp.
  const manifestPath = join(getTrashRoot(), "stale.manifest.json");
  const staleManifest = {
    id: "stale",
    trashedAt: Date.now() - TRASH_UNDO_WINDOW_MS - 1,
    entries: [{ original: stale, trashed: join(getTrashRoot(), "stale", "f.jsonl") }],
  };
  writeFileSync(manifestPath, JSON.stringify(staleManifest));
  mkdirSync(join(getTrashRoot(), "stale"), { recursive: true });
  writeFileSync(staleManifest.entries[0].trashed, "stale-content");

  purgeExpiredTrash(TRASH_UNDO_WINDOW_MS);
  assert.ok(readTrashManifest("fresh"), "fresh session keeps its manifest");
  assert.equal(readTrashManifest("stale"), null, "stale manifest swept");
  assert.ok(!existsSync(staleManifest.entries[0].trashed), "stale files removed");
});

test("default retention outlives the toast and exposes recovery metadata", () => {
  const file = makeSessionFile(join(sandbox, "sessions", "retained"), "40000000_old.jsonl");
  const manifest = trashSession("retained", [file], { title: "Recover me", cwd: "project" });
  manifest.trashedAt = Date.now() - 60_000;
  writeFileSync(join(getTrashRoot(), "retained.manifest.json"), JSON.stringify(manifest));
  purgeExpiredTrash();
  const item = listTrashSessions().find((item) => item.id === "retained");
  assert.equal(item.title, "Recover me");
  assert.equal(item.expiresAt - item.trashedAt, TRASH_RETENTION_MS);
  assert.equal(restoreSession("retained"), true);
});

test("restore refuses to overwrite a recreated conversation", () => {
  const file = makeSessionFile(join(sandbox, "sessions", "conflict"), "50000000_old.jsonl");
  const manifest = trashSession("conflict", [file]);
  writeFileSync(file, "new user content");
  assert.throws(() => restoreSession("conflict"), /already exists/);
  assert.equal(readFileSync(file, "utf8"), "new user content");
  assert.ok(existsSync(manifest.entries[0].trashed));
  assert.ok(readTrashManifest("conflict"));
});

test("a forged trash path cannot escape the recycle bin", () => {
  const outside = join(sandbox, "outside.txt");
  writeFileSync(outside, "keep");
  writeFileSync(join(getTrashRoot(), "forged.manifest.json"), JSON.stringify({ id: "forged", trashedAt: 0, entries: [{ original: outside, trashed: outside }] }));
  purgeExpiredTrash();
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(readTrashManifest("forged"), null);
});

test.after(() => {
  rmSync(sandbox, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});
