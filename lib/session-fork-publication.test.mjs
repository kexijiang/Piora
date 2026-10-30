import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { createSessionForkPublication } = await jiti.import("./session-fork-publication.ts");
const { openOwnedSessionManager } = await jiti.import("./session-owned-manager.ts");
const { readOnlySessionManager } = await jiti.import("./session-readonly-manager.ts");
const { listAllSessions, resolveSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { readUiOutput } = await jiti.import("./intelligent-ui/read-output.ts");
const { copyAnswerOutputState } = await jiti.import("./answer-output-server.ts");
const { sessionOwnershipPath, acquireExclusiveFileLease } = await jiti.import("./session-file-ownership.ts");
const { uiSessionLockPath } = await jiti.import("./intelligent-ui/session-lock.ts");
const { POST: duplicate } = await jiti.import("../app/api/sessions/[id]/duplicate/route.ts");

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-fork-publication-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const source = SessionManager.create(root, join(root, "sessions", "project")), id = source.getSessionId();
  source.appendMessage({ role: "user", content: "A parameterized result", timestamp: 1 });
  const host = new UiGenerationPrototype({ manager: source, root }); await host.startRun();
  const context = await host.captureContext("bill"), plan = { planVersion: 1, id: "bill", title: "Bill", inputs: [{ id: "value", valueType: "number", label: "Value", value: 1 }], derived: [], views: [{ id: "result", kind: "metric", label: "Result", value: { input: "value" } }] };
  source.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ui", name: "piora_render_ui_plan", arguments: plan }], timestamp: 2 });
  const candidate = await host.createCandidate(context.contextId, "ui", compileUiPlan(plan, { revision: 1 }));
  await host.persistCandidate(candidate.operationId); const committed = await host.commitCandidate(candidate.operationId);
  await host.saveParameters(candidate.operationId, committed.stateRevision, { value: 7 });
  const sourceFile = source.getSessionFile(), sourceLeafId = source.getLeafId();
  const publication = createSessionForkPublication(sourceFile, { root }), owned = openOwnedSessionManager(sourceFile, publication.stagingDir, root);
  const stagedFile = owned.manager.createBranchedSession(sourceLeafId), target = owned.manager.getSessionId();
  t.after(() => {
    publication.dispose(owned); owned.release();
    invalidateSessionPathCache(id); invalidateSessionPathCache(target); invalidateSessionListCache();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const copy = () => copyAnswerOutputState(id, target, owned.manager.getBranch().map(entry => entry.id), { sourceFile, targetFile: stagedFile, sourceLeafId });
  const visibleIds = async () => { invalidateSessionListCache(); return (await listAllSessions()).map(session => session.id); };
  return { root, id, target, sourceFile, sourceLeafId, stagedFile, publication, owned, copy, visibleIds };
}

test("real SDK fork is invisible to catalog and path resolution until complete publication", async t => {
  const f = await fixture(t);
  assert.equal(dirname(f.stagedFile), f.publication.stagingDir);
  assert.deepEqual(await f.visibleIds(), [f.id]); assert.equal(await resolveSessionPath(f.target), null);
  await f.copy(); f.owned.manager.appendSessionInfo("Finished fork metadata");
  assert.deepEqual(await f.visibleIds(), [f.id]); assert.equal(await resolveSessionPath(f.target), null);
  const exactBytes = readFileSync(f.stagedFile), finalFile = f.publication.publish(f.owned);
  assert.equal(dirname(finalFile), dirname(f.sourceFile)); assert.equal(existsSync(f.stagedFile), false);
  assert.deepEqual(readFileSync(finalFile), exactBytes, "publication does not rewrite IDs or receipts");
  assert.ok((await f.visibleIds()).includes(f.target)); assert.equal(await resolveSessionPath(f.target), finalFile);
  const reader = readOnlySessionManager(finalFile);
  assert.equal(reader.getSessionName(), "Finished fork metadata"); assert.equal(reader.getHeader().parentSession, f.sourceFile);
  assert.equal((await readUiOutput(reader, "ui", { root: f.root })).state.value, 7);
  assert.equal(f.publication.dispose(f.owned), true); assert.equal(existsSync(f.publication.stagingDir), false);
});

test("failed inheritance leaves no visible or resolvable copy and preserves source data", async t => {
  const f = await fixture(t), source = readFileSync(f.sourceFile), journal = readFileSync(generationJournalPath(f.id, f.root));
  const rows = readFileSync(f.stagedFile, "utf8").trimEnd().split("\n").map(JSON.parse); rows[1].message.content = "tampered staged source";
  writeFileSync(f.stagedFile, rows.map(JSON.stringify).join("\n") + "\n");
  await assert.rejects(f.copy(), error => error.code === "RECEIPT");
  assert.equal(f.publication.dispose(f.owned), true);
  assert.deepEqual(await f.visibleIds(), [f.id]); assert.equal(await resolveSessionPath(f.target), null);
  assert.deepEqual(readFileSync(f.sourceFile), source); assert.deepEqual(readFileSync(generationJournalPath(f.id, f.root)), journal);
});

test("lost target ownership refuses publication and retains only hidden recovery data", async t => {
  const f = await fixture(t); await f.copy();
  const stale = new Date(Date.now() - 180_000); utimesSync(sessionOwnershipPath(f.target, f.root), stale, stale);
  assert.throws(() => f.publication.publish(f.owned), error => error.code === "SESSION_IN_USE");
  assert.equal(f.publication.dispose(f.owned), false); assert.equal(existsSync(f.stagedFile), true);
  assert.deepEqual(await f.visibleIds(), [f.id]); assert.equal(await resolveSessionPath(f.target), null);
});

test("publication never overwrites an existing destination", async t => {
  const f = await fixture(t); await f.copy();
  const existing = join(dirname(f.sourceFile), basename(f.stagedFile)); writeFileSync(existing, "reserved destination");
  assert.throws(() => f.publication.publish(f.owned), /already exists/);
  assert.equal(readFileSync(existing, "utf8"), "reserved destination"); assert.equal(existsSync(f.stagedFile), true);
});

test("production duplicate endpoint keeps its in-progress SDK file hidden while parameter copy waits", async t => {
  const f = await fixture(t); f.publication.dispose(f.owned); f.owned.release();
  const lease = acquireExclusiveFileLease(uiSessionLockPath(f.id, f.root));
  let released = false;
  try {
    const result = duplicate(new Request(`http://localhost/api/sessions/${f.id}/duplicate`, { method: "POST" }), { params: Promise.resolve({ id: f.id }) });
    const stagingRoot = join(f.root, "piora", "session-forks");
    let staged;
    for (let attempts = 0; attempts < 100 && !staged; attempts++) {
      staged = readdirSync(stagingRoot).flatMap(directory => readdirSync(join(stagingRoot, directory)).filter(name => name.endsWith(".jsonl")).map(name => join(stagingRoot, directory, name)))[0];
      if (!staged) await delay(10);
    }
    assert.ok(staged, "SDK must have created a hidden fork before parameter-copy admission");
    const target = readOnlySessionManager(staged).getSessionId(); t.after(() => invalidateSessionPathCache(target));
    assert.deepEqual(await f.visibleIds(), [f.id]); assert.equal(await resolveSessionPath(target), null);
    lease.release(); released = true;
    const response = await result, body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.sessionId, target);
    const published = await resolveSessionPath(target); assert.equal(dirname(published), dirname(f.sourceFile));
    assert.equal((await readUiOutput(readOnlySessionManager(published), "ui", { root: f.root })).state.value, 7);
  } finally { if (!released) lease.release(); }
});
