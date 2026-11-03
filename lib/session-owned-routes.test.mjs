import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { cacheSessionPath, invalidateSessionPathCache, resolveSessionPath } = await jiti.import("./session-reader.ts");
const { bindSessionAgentRuntimeProfile, readSessionAgentRuntimeProfile } = await jiti.import("./agent-profile-store.ts");
const { trackSessionShutdown } = await jiti.import("./session-mutation.ts");
const { retainSessionFileOwnership } = await jiti.import("./session-file-ownership.ts");
const { getSurfaceState, saveSurfaceState } = await jiti.import("./intelligent-ui/store.ts");
const { appendSessionSystemPromptBinding, readLatestSessionSystemPromptBinding } = await jiti.import("./session-system-prompt.ts");
const { PATCH: rename } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { POST: duplicate } = await jiti.import("../app/api/sessions/[id]/duplicate/route.ts");

function ownerKeys() { return [...(globalThis.__pioraSessionFileOwners?.keys() ?? [])].sort(); }
function deadline(promise, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not finish; the operation may be waiting for itself`)), 5000);
  })]).finally(() => clearTimeout(timer));
}
function request(route, id, body) {
  return route(new Request(`http://localhost/api/sessions/${id}`, {
    method: body ? "PATCH" : "POST",
    ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  }), { params: Promise.resolve({ id }) });
}
function observe(promise) {
  const state = { settled: false };
  state.result = promise.finally(() => { state.settled = true; });
  return state;
}
async function assertWaitingForOldShutdown(id, operation) {
  const started = Date.now();
  while (!operation.settled && (globalThis.__pioraSessionFileOperations?.get(id)?.size ?? 0) < 2) {
    assert.ok(Date.now() - started < 5000, "route must admit its own operation beside the old shutdown writer");
    await nextTurn();
  }
  await nextTurn();
  assert.equal(operation.settled, false, "route must wait until the retired runtime finishes writing");
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-owned-routes-"));
  const previousAgent = process.env.PI_CODING_AGENT_DIR, previousProfile = process.env.PIORA_RUNTIME_PROFILE;
  const baselineOwners = ownerKeys(), ids = new Set(), releases = [], shutdowns = [];
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.PIORA_RUNTIME_PROFILE = "normal";
  const manager = SessionManager.create(root, join(root, "sessions"));
  const id = manager.getSessionId(); ids.add(id);
  manager.appendMessage({ role: "user", content: "Original request", timestamp: 1 });
  manager.appendSessionInfo("Original conversation");
  const file = manager.getSessionFile();
  cacheSessionPath(id, file);
  await bindSessionAgentRuntimeProfile(id, "normal");
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled(shutdowns);
    try {
      for (const sessionId of ids) {
        invalidateSessionPathCache(sessionId);
        assert.equal(globalThis.__pioraSessionShutdowns?.has(sessionId) ?? false, false);
        assert.equal(globalThis.__pioraSessionFileOperations?.has(sessionId) ?? false, false);
      }
      assert.deepEqual(ownerKeys(), baselineOwners, "routes and retired runtimes must release every ownership reference");
    } finally {
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
      if (previousProfile === undefined) delete process.env.PIORA_RUNTIME_PROFILE; else process.env.PIORA_RUNTIME_PROFILE = previousProfile;
      assert.equal(dirname(root), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  return {
    root, manager, id, file, ids,
    retire: write => {
      const owner = retainSessionFileOwnership(id, root);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      releases.push(release);
      const shutdown = trackSessionShutdown(id, (async () => {
        try { await gate; owner.assertOwned(); await write(); }
        finally { owner.release(); }
      })());
      shutdowns.push(shutdown);
      return { release, shutdown };
    },
  };
}

test("offline rename opens after old shutdown history is durable and does not wait for its own operation", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let finalEntryId;
  const retired = f.retire(() => {
    finalEntryId = f.manager.appendMessage({ role: "user", content: "Written by the retiring runtime", timestamp: 2 });
  });
  const before = await readFile(f.file, "utf8");
  const operation = observe(request(rename, f.id, { name: " Renamed after shutdown " }));
  await assertWaitingForOldShutdown(f.id, operation);
  assert.equal(await readFile(f.file, "utf8"), before, "rename cannot write while the old runtime still owns pending history");
  retired.release();
  const response = await deadline(operation.result, "rename");
  assert.equal(response.status, 200, await response.text());
  await retired.shutdown;
  const restored = SessionManager.open(f.file);
  assert.equal(restored.getSessionId(), f.id);
  assert.equal(restored.getSessionName(), "Renamed after shutdown");
  assert.equal(restored.getEntry(finalEntryId).message.content, "Written by the retiring runtime");
  assert.equal(restored.getLeafEntry().parentId, finalEntryId, "rename must extend the final shutdown leaf, not an earlier snapshot");
});

test("duplicate waits for final shutdown history and parameters, then retains source history under an independent identity", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const binding = { version: 1, revision: 4, source: "template", templateId: "research", templateName: "Research", prompt: "Check source evidence", appliedAt: new Date().toISOString() };
  appendSessionSystemPromptBinding(f.manager, binding);
  const surface = { id: "shopping", title: "Shopping", version: 1, revision: 1, nodes: [
    { id: "people", type: "slider", label: "People", value: 2, min: 1, max: 20 },
    { id: "bread", type: "metric", label: "Bread", value: { op: "multiply", args: [{ ref: "people" }, 2] } },
  ] };
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ui-call", name: "piora_render_ui", arguments: { surface } }], timestamp: 2 });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "ui-call", toolName: "piora_render_ui", content: [{ type: "text", text: "People: 2; Bread: 4" }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "People: 2; Bread: 4", payload: surface } }, timestamp: 3 });
  const save = (manager, sessionId, people, expectedRevision) => saveSurfaceState({
    sessionId, toolCallId: "ui-call", leafId: manager.getLeafId(), expectedRevision, state: { people },
    branch: () => manager.getBranch(), allEntries: () => manager.getEntries(), enabled: () => true,
  });
  await save(f.manager, f.id, 4, 0);
  let finalSource, finalHistory, finalEntryId;
  const retired = f.retire(async () => {
    finalEntryId = f.manager.appendMessage({ role: "user", content: "Final shutdown history", timestamp: 4 });
    await save(f.manager, f.id, 9, 1);
    finalSource = await readFile(f.file, "utf8");
    finalHistory = f.manager.getBranch();
  });
  const before = await readFile(f.file, "utf8"), filesBefore = await readdir(join(f.root, "sessions"));
  const operation = observe(request(duplicate, f.id));
  await assertWaitingForOldShutdown(f.id, operation);
  assert.equal(await readFile(f.file, "utf8"), before);
  assert.deepEqual(await readdir(join(f.root, "sessions")), filesBefore, "no duplicate may be created from an unfinished source");
  retired.release();
  const response = await deadline(operation.result, "duplicate");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  await retired.shutdown;
  assert.notEqual(body.sessionId, f.id); f.ids.add(body.sessionId);
  assert.equal(body.runtimeProfile, "normal");
  assert.equal(readSessionAgentRuntimeProfile(body.sessionId), "normal");
  const duplicatePath = await resolveSessionPath(body.sessionId);
  const copy = SessionManager.open(duplicatePath);
  assert.equal(copy.getSessionId(), body.sessionId);
  assert.notEqual(duplicatePath, f.file);
  assert.equal(copy.getHeader().parentSession, f.file);
  assert.equal(copy.getSessionName(), "Original conversation copy");
  assert.deepEqual(copy.getBranch().slice(0, finalHistory.length), finalHistory);
  assert.equal(copy.getEntry(finalEntryId).message.content, "Final shutdown history");
  const copiedBinding = readLatestSessionSystemPromptBinding(copy.getEntries());
  assert.equal(copiedBinding.prompt, binding.prompt);
  assert.equal(copiedBinding.templateId, binding.templateId);
  assert.equal(copiedBinding.revision, 1);
  assert.equal(await readFile(f.file, "utf8"), finalSource, "duplication must preserve the complete source file byte for byte");
  const copiedState = getSurfaceState(body.sessionId, copy.getBranch(), "ui-call");
  assert.deepEqual(copiedState.state, { people: 9 });
  await save(copy, body.sessionId, 7, copiedState.revision);
  assert.deepEqual(getSurfaceState(body.sessionId, copy.getBranch(), "ui-call").state, { people: 7 });
  assert.deepEqual(getSurfaceState(f.id, f.manager.getBranch(), "ui-call").state, { people: 9 });
  assert.equal(await readFile(f.file, "utf8"), finalSource);
});

test("a foreign process lease makes rename and duplicate return 409 without modifying the source or creating a copy", { timeout: 15000 }, async t => {
  const f = await fixture(t), script = join(f.root, "foreign-owner.mjs");
  await writeFile(script, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
const { retainSessionFileOwnership } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./session-file-ownership.ts", import.meta.url).href)});
const owner = retainSessionFileOwnership(process.argv[3], process.argv[2]);
console.log('owned');
process.stdin.once('data', () => { owner.release(); process.exit(0); });
`);
  const child = spawn(process.execPath, [script, f.root, f.id], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const [chunk] = await deadline(once(child.stdout, "data"), "foreign owner acquisition");
    assert.match(chunk.toString(), /owned/);
    const before = await readFile(f.file, "utf8"), filesBefore = await readdir(join(f.root, "sessions"));
    const renameResponse = await request(rename, f.id, { name: "Forbidden rename" });
    const duplicateResponse = await request(duplicate, f.id);
    assert.equal(renameResponse.status, 409, await renameResponse.text());
    assert.equal(duplicateResponse.status, 409, await duplicateResponse.text());
    assert.equal(await readFile(f.file, "utf8"), before);
    assert.deepEqual(await readdir(join(f.root, "sessions")), filesBefore);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.stdin.write("release\n");
      try { assert.equal((await deadline(stopped, "foreign owner release"))[0], 0); }
      finally { if (child.exitCode === null) child.kill(); }
    }
  }
});
