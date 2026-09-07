import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(path.join(tmpdir(), "piora-delete-route-"));
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const route = await jiti.import("../app/api/sessions/[id]/route.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
const { readTrashManifest, restoreSession } = await jiti.import("./session-trash.ts");
const { assertSessionNotMutating } = await jiti.import("./session-mutation.ts");

test.after(() => { rmSync(root, { recursive: true, force: true }); });

test("deleting a parent drains child writers before moving the tree, then restores intact", async () => {
  const directory = path.join(root, "sessions", "project");
  mkdirSync(directory, { recursive: true });
  const sessions = ["parent", "child", "unrelated"].map((id) => {
    const file = path.join(directory, `${id}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "session", id, cwd: directory }) + "\n");
    cacheSessionPath(id, file);
    return { id, path: file, cwd: directory, name: id, ...(id === "child" ? { parentSessionId: "parent" } : {}) };
  });
  globalThis.__piSessionListCache = { data: sessions, ts: Date.now() };
  const stopped = [];
  globalThis.__piSessions = new Map(sessions.map((session) => [session.id, {
    isAlive: () => true,
    isRunning: () => session.id === 'child',
    shutdownForFileMutation: async () => {
      assert.throws(() => assertSessionNotMutating(session.id));
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(existsSync(session.path), "do not move files until writers settle");
      writeFileSync(session.path, "last complete write\n", { flag: "a" });
      stopped.push(session.id);
    },
  }]));
  const previewRoute = await jiti.import('../app/api/sessions/deletion/route.ts');
  const preview = await previewRoute.POST(new Request('http://local/api/sessions/deletion', {method:'POST',body:JSON.stringify({ids:['child','parent']})}));
  const affected = await preview.json();
  assert.equal(affected.count,2, 'overlapping selections are counted once');
  assert.equal(affected.running,1);
  assert.equal(affected.unarchived,2);
  assert.equal(affected.rootIds[0],'parent', 'move ancestor first so recovery retains one subtree');
  const changedScope = await route.DELETE(new Request('http://local/api/sessions/parent', {method:'DELETE',body:JSON.stringify({expectedSessionIds:['parent']})}), {params:Promise.resolve({id:'parent'})});
  assert.equal(changedScope.status,409);
  assert.deepEqual(stopped,[]);
  assert.ok(existsSync(sessions[1].path));
  const response = await route.DELETE(new Request("http://local/api/sessions/parent", { method: "DELETE" }), { params: Promise.resolve({ id: "parent" }) });
  assert.equal(response.status, 200);
  assert.deepEqual(new Set(stopped), new Set(["parent", "child"]));
  assert.equal(existsSync(sessions[2].path), true);
  assert.equal(existsSync(sessions[1].path), false);
  assert.equal(readTrashManifest("parent").entries.length, 2);
  assert.equal(restoreSession("parent"), true);
  assert.match(readFileSync(sessions[1].path, "utf8"), /last complete write/);
  assert.doesNotThrow(() => assertSessionNotMutating("child"));
});

test("a fork completing during the drain is checked against the confirmed scope", async () => {
  const directory = path.join(root, "sessions", "late-fork");
  mkdirSync(directory, { recursive: true });
  const parent = { id: "late-parent", path: path.join(directory, "parent.jsonl"), cwd: directory };
  const child = { id: "late-child", parentSessionId: parent.id, path: path.join(directory, "child.jsonl"), cwd: directory };
  writeFileSync(parent.path, JSON.stringify({ type: "session", id: parent.id, cwd: directory }) + "\n");
  cacheSessionPath(parent.id, parent.path);
  globalThis.__piSessionListCache = { data: [parent], ts: Date.now() };
  let childDrained = false;
  globalThis.__piSessions = new Map([[parent.id, {
    shutdownForFileMutation: async () => {
      writeFileSync(child.path, JSON.stringify({ type: "session", id: child.id, cwd: directory }) + "\n");
      cacheSessionPath(child.id, child.path);
      globalThis.__piSessionListCache = { data: [parent, child], ts: Date.now() };
      globalThis.__piSessions.set(child.id, { shutdownForFileMutation: async () => { childDrained = true; assert.ok(existsSync(child.path)); } });
    },
  }]]);
  const request = (expectedSessionIds) => new Request("http://local/api/sessions/late-parent", { method: "DELETE", body: JSON.stringify({ expectedSessionIds }) });
  const params = { params: Promise.resolve({ id: parent.id }) };
  const changed = await route.DELETE(request([parent.id]), params);
  assert.equal(changed.status, 409);
  assert.ok(existsSync(parent.path));
  assert.ok(existsSync(child.path));
  assert.doesNotThrow(() => assertSessionNotMutating(parent.id));
  const confirmed = await route.DELETE(request([parent.id, child.id]), params);
  assert.equal(confirmed.status, 200);
  assert.equal(childDrained, true);
  assert.equal(readTrashManifest(parent.id).entries.length, 2);
});
