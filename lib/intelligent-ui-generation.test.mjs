import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { formatSnapshot } = await jiti.import("./intelligent-ui/protocol.ts");
const { saveSurfaceState, intelligentUiStatePath } = await jiti.import("./intelligent-ui/store.ts");
const { readUiOutput, readUiSnapshots } = await jiti.import("./intelligent-ui/read-output.ts");
const { withUiSessionLock } = await jiti.import("./intelligent-ui/session-lock.ts");
const { sessionOwnershipPath } = await jiti.import("./session-file-ownership.ts");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const plan = () => ({ planVersion: 1, id: "bill", title: "分账", inputs: [{ id: "people", valueType: "number", label: "人数", value: 4, min: 1, max: 20 }], derived: [{ id: "total", op: "multiply", args: [{ input: "people" }, { literal: 12 }] }], views: [{ id: "amount", kind: "metric", label: "总价", value: { derived: "total" } }] });
const compiled = (revision = 1) => compileUiPlan(plan(), { revision });
function appendCall(manager, id, args = plan(), name = "piora_render_ui_plan") {
  return manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", usage, timestamp: Date.now(), content: [{ type: "toolCall", id, name, arguments: args }] });
}
function fixture(t, fault) {
  const root = mkdtempSync(join(tmpdir(), "piora-generation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "帮我做个能改人数的分账器", timestamp: Date.now() });
  const host = new UiGenerationPrototype({ manager, root, fault });
  return { root, manager, host, read: () => JSON.parse(readFileSync(generationJournalPath(manager.getSessionId(), root), "utf8")) };
}
async function candidate(fixture, callId = "call-1", value = compiled()) {
  const context = await fixture.host.captureContext("bill");
  appendCall(fixture.manager, callId);
  const result = await fixture.host.createCandidate(context.contextId, callId, value);
  return { ...result, context };
}
async function published(fixture) {
  await fixture.host.startRun();
  const created = await candidate(fixture);
  const receipt = await fixture.host.persistCandidate(created.operationId);
  const commit = await fixture.host.commitCandidate(created.operationId);
  return { ...created, receipt, commit };
}
const code = expected => error => error?.code === expected;

test("real SDK result becomes active only after exact disk receipt and atomic journal commit", async t => {
  const f = fixture(t); await f.host.startRun();
  const item = await candidate(f);
  assert.equal(await f.host.readActive("bill"), null);
  assert.equal(f.read().records[0].status, "candidate");
  await assert.rejects(f.host.commitCandidate(item.operationId), code("RECEIPT"));
  const receipt = await f.host.persistCandidate(item.operationId);
  const disk = SessionManager.open(f.manager.getSessionFile());
  const entry = disk.getEntry(receipt.entryId);
  assert.equal(entry.type, "message");
  assert.equal(entry.message.role, "toolResult");
  assert.equal(entry.message.toolCallId, "call-1");
  assert.equal(entry.message.details.answerOutput.version, 2);
  assert.equal(await f.host.readActive("bill"), null);
  const commit = await f.host.commitCandidate(item.operationId);
  assert.deepEqual(commit.state, { people: 4 });
  const active = await f.host.readActive("bill");
  assert.equal(active.operationId, item.operationId);
  const journal = f.read();
  assert.equal(journal.records[0].status, "committed");
  assert.equal(journal.active[0].anchor, receipt.entryId);
  assert.equal(journal.states[0].revision, commit.stateRevision);
});

test("candidate replay is idempotent and changed content cannot reuse a tool call", async t => {
  const f = fixture(t); await f.host.startRun();
  const item = await candidate(f);
  const replay = await f.host.createCandidate(item.context.contextId, "call-1", compiled());
  assert.equal(replay.operationId, item.operationId);
  const changed = compiled(); changed.surface.title = "Changed";
  await assert.rejects(f.host.createCandidate(item.context.contextId, "call-1", changed), code("CONFLICT"));
  const first = await f.host.persistCandidate(item.operationId), second = await f.host.persistCandidate(item.operationId);
  assert.deepEqual(second, first);
  const commit = await f.host.commitCandidate(item.operationId);
  assert.deepEqual(await f.host.commitCandidate(item.operationId), commit);
  assert.equal(f.read().records.length, 1);
  assert.equal(f.read().active.length, 1);
});

test("context captures source before generation and cannot be replaced by caller mutation", async t => {
  const f = fixture(t), first = await published(f);
  const context = await f.host.captureContext("bill");
  assert.deepEqual(context.state, { people: 4 });
  context.source.stateRevision = 999; context.state.people = 999;
  appendCall(f.manager, "call-2");
  await f.host.saveParameters(first.operationId, first.commit.stateRevision, { people: 8 });
  await assert.rejects(f.host.createCandidate(context.contextId, "call-2", compiled(2)), code("CONFLICT"));
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 8 });
});

test("parameter CAS is repeated after receipt so an intervening edit survives", async t => {
  const f = fixture(t), first = await published(f);
  const next = await candidate(f, "call-2", compiled(2));
  await f.host.persistCandidate(next.operationId);
  await f.host.saveParameters(first.operationId, first.commit.stateRevision, { people: 9 });
  await assert.rejects(f.host.commitCandidate(next.operationId), code("CONFLICT"));
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 9 });
  assert.equal(f.read().records[1].status, "candidate");
});

test("successful revision preserves compatible saved parameters and rejects obsolete writes", async t => {
  const f = fixture(t), first = await published(f);
  const revision = await f.host.saveParameters(first.operationId, first.commit.stateRevision, { people: 7 });
  const next = await candidate(f, "call-2", compiled(2));
  await f.host.persistCandidate(next.operationId); await f.host.commitCandidate(next.operationId);
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 7 });
  await assert.rejects(f.host.saveParameters(first.operationId, revision, { people: 11 }), code("CONFLICT"));
  assert.equal(f.read().records[0].state.people, 4, "original publication remains available for history");
});

test("changed semantic labels or constraints require explicit migration", async t => {
  const f = fixture(t), first = await published(f);
  const changed = compiled(2); changed.surface.nodes[0].label = "房间数";
  const next = await candidate(f, "call-2", changed);
  await f.host.persistCandidate(next.operationId);
  await assert.rejects(f.host.commitCandidate(next.operationId), code("MIGRATION_REQUIRED"));
  assert.equal((await f.host.readActive("bill")).operationId, first.operationId);
});

test("only exact assistant and result edges may advance captured context", async t => {
  const f = fixture(t); await f.host.startRun();
  const context = await f.host.captureContext("bill");
  f.manager.appendSessionInfo("A title cannot hide an unrelated message");
  f.manager.appendMessage({ role: "user", content: "new unrelated request", timestamp: Date.now() });
  appendCall(f.manager, "call-1");
  await assert.rejects(f.host.createCandidate(context.contextId, "call-1", compiled()), code("CONFLICT"));
  const nextContext = await f.host.captureContext("bill");
  appendCall(f.manager, "call-2");
  const item = await f.host.createCandidate(nextContext.contextId, "call-2", compiled());
  await f.host.persistCandidate(item.operationId);
  f.manager.appendSessionInfo("a later unrelated write");
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CONFLICT"));
  assert.equal(await f.host.readActive("bill"), null);
});

test("captured title receipts reject mutation and retain history after sibling branches", async t => {
  const f = fixture(t); await f.host.startRun();
  const context = await f.host.captureContext("bill"), title = f.manager.appendSessionInfo("Automatic title");
  appendCall(f.manager, "with-title");
  const item = await f.host.createCandidate(context.contextId, "with-title", compiled());
  await f.host.persistCandidate(item.operationId); await f.host.commitCandidate(item.operationId);
  const publicationLeaf = f.manager.getLeafId();
  f.manager.branch(context.leafId);
  f.manager.appendMessage({ role: "user", content: "another branch", timestamp: Date.now() });
  f.manager.branch(publicationLeaf);
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 4 });
  const file = f.manager.getSessionFile(), original = readFileSync(file, "utf8");
  for (const mutation of [entry => { entry.name = "Edited title"; }, entry => { entry.type = "custom"; }, entry => { entry.parentId = null; }]) {
    const lines = original.trimEnd().split("\n").map(JSON.parse);
    mutation(lines.find(entry => entry.id === title));
    writeFileSync(file, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    await assert.rejects(f.host.readActive("bill"), code("RECEIPT"));
  }
  writeFileSync(file, original);
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 4 });
});

test("navigation, cancellation and a superseding epoch prevent stale publication", async t => {
  const f = fixture(t); await f.host.startRun();
  const item = await candidate(f); await f.host.persistCandidate(item.operationId);
  f.manager.branch(item.context.leafId);
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CONFLICT"));
  await f.host.cancelRun();
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CANCELLED"));
  assert.equal(f.read().records[0].status, "aborted");
  const reopened = SessionManager.open(f.manager.getSessionFile());
  const other = new UiGenerationPrototype({ root: f.root, manager: reopened });
  await other.startRun();
  await assert.rejects(f.host.captureContext("bill"), code("CANCELLED"));
});

for (const stage of ["candidate-written", "tool-result-written", "receipt-written", "before-commit", "committed"]) {
  test(`crash at ${stage} preserves an unambiguous recovery state`, async t => {
    let fired = false;
    const f = fixture(t, point => { if (point === stage && !fired) { fired = true; throw new Error("injected crash"); } });
    await f.host.startRun();
    let operationId;
    await assert.rejects(async () => {
      operationId = (await candidate(f)).operationId;
      await f.host.persistCandidate(operationId);
      await f.host.commitCandidate(operationId);
    }, /injected crash/);
    operationId ??= f.read().records[0].operationId;
    const diskManager = SessionManager.open(f.manager.getSessionFile());
    const recovery = new UiGenerationPrototype({ root: f.root, manager: diskManager });
    await recovery.startRun();
    if (stage === "committed") {
      assert.equal((await recovery.readActive("bill")).operationId, operationId);
      const result = await recovery.commitCandidate(operationId);
      assert.deepEqual(result.state, { people: 4 });
      assert.equal(f.read().active.length, 1, "acknowledgment loss must not duplicate publication");
    } else {
      assert.equal(await recovery.readActive("bill"), null);
      assert.equal(f.read().records[0].status, "aborted");
      await assert.rejects(recovery.commitCandidate(operationId), code("CANCELLED"));
    }
  });
}

test("same-epoch retry after SDK append finds the exact disk record instead of appending twice", async t => {
  let once = false;
  const f = fixture(t, stage => { if (stage === "tool-result-written" && !once) { once = true; throw new Error("lost result acknowledgment"); } });
  await f.host.startRun(); const item = await candidate(f);
  await assert.rejects(f.host.persistCandidate(item.operationId), /acknowledgment/);
  const receipt = await f.host.persistCandidate(item.operationId);
  assert.equal(f.manager.getEntries().filter(entry => entry.message?.role === "toolResult").length, 1);
  assert.equal(receipt.entryId, f.manager.getLeafId());
  await f.host.commitCandidate(item.operationId);
});

test("tampered receipt, payload, assistant or partial disk record fails closed", async t => {
  for (const tamper of ["payload", "assistant", "partial", "duplicate"]) {
    const f = fixture(t); await f.host.startRun(); const item = await candidate(f); await f.host.persistCandidate(item.operationId);
    const path = f.manager.getSessionFile();
    const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
    if (tamper === "payload") rows.at(-1).message.details.answerOutput.payload.title = "changed";
    if (tamper === "assistant") rows.at(-2).message.content[0].id = "other-tool-call";
    if (tamper === "duplicate") rows.push(rows.at(-1));
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + (tamper === "partial" ? "" : "\n"));
    await assert.rejects(f.host.commitCandidate(item.operationId), error => ["RECEIPT", "CORRUPT"].includes(error.code));
    assert.equal(f.read().records[0].status, "candidate");
  }
});

test("legacy parameters are included in source CAS and never rewritten by publication", async t => {
  const f = fixture(t), legacy = compiled().surface;
  appendCall(f.manager, "legacy-call", {}, "piora_render_ui");
  f.manager.appendMessage({ role: "toolResult", toolCallId: "legacy-call", toolName: "piora_render_ui", isError: false, content: [{ type: "text", text: formatSnapshot(legacy) }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: formatSnapshot(legacy), payload: legacy } }, timestamp: Date.now() });
  const save = (expectedRevision, people) => saveSurfaceState({ root: f.root, sessionId: f.manager.getSessionId(), toolCallId: "legacy-call", leafId: f.manager.getLeafId(), expectedRevision, state: { people }, enabled: () => true, branch: () => f.manager.getBranch() });
  await save(0, 7); await f.host.startRun();
  const item = await candidate(f, "call-1", compiled(2));
  assert.equal(item.context.source.origin, "legacy");
  await f.host.persistCandidate(item.operationId);
  const legacyPath = intelligentUiStatePath(f.manager.getSessionId(), f.root), original = readFileSync(legacyPath, "utf8");
  await f.host.commitCandidate(item.operationId);
  assert.equal(readFileSync(legacyPath, "utf8"), original);
  assert.deepEqual((await f.host.readActive("bill")).state, { people: 7 });
});

test("a legacy writer inserted after candidate persistence prevents publication", async t => {
  const f = fixture(t), legacy = compiled().surface;
  appendCall(f.manager, "legacy-call", {}, "piora_render_ui");
  f.manager.appendMessage({ role: "toolResult", toolCallId: "legacy-call", toolName: "piora_render_ui", isError: false, content: [], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: formatSnapshot(legacy), payload: legacy } }, timestamp: Date.now() });
  await f.host.startRun(); const item = await candidate(f, "call-1", compiled(2)); await f.host.persistCandidate(item.operationId);
  await saveSurfaceState({ root: f.root, sessionId: f.manager.getSessionId(), toolCallId: "legacy-call", leafId: f.manager.getLeafId(), expectedRevision: 0, state: { people: 10 }, enabled: () => true, branch: () => f.manager.getBranch() });
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CONFLICT"));
  assert.equal(f.read().active.length, 0);
});

test("another SDK writer advancing disk prevents commit even when local manager leaf is stale", async t => {
  const f = fixture(t); await f.host.startRun(); const item = await candidate(f); await f.host.persistCandidate(item.operationId);
  const originalLeaf = f.manager.getLeafId();
  const other = SessionManager.open(f.manager.getSessionFile());
  other.appendMessage({ role: "user", content: "another window", timestamp: Date.now() });
  assert.equal(f.manager.getLeafId(), originalLeaf, "SDK instance does not automatically reload another writer");
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CONFLICT"));
  assert.equal(f.read().records[0].status, "candidate");
});

test("lost committed pointer and disk receipt corruption remain explicit recovery errors", async t => {
  const f = fixture(t); await published(f);
  const journal = f.read(); journal.active = [];
  writeFileSync(generationJournalPath(f.manager.getSessionId(), f.root), JSON.stringify(journal));
  await assert.rejects(f.host.readActive("bill"), code("CORRUPT"));
});

test("session lock serializes local writers and rejects a foreign writer until ownership releases", async t => {
  const f = fixture(t), counter = join(f.root, "counter"), worker = join(f.root, "worker.mjs");
  writeFileSync(counter, "0");
  const modulePath = new URL("./intelligent-ui/session-lock.ts", import.meta.url).href;
  writeFileSync(worker, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};\nimport { readFileSync, writeFileSync } from 'node:fs';\nconst { withUiSessionLock } = await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});\nawait withUiSessionLock(process.argv[2], process.argv[3], async () => { const value = Number(readFileSync(process.argv[4], 'utf8')); await new Promise(resolve => setTimeout(resolve, 80)); writeFileSync(process.argv[4], String(value + 1)); });\n`);
  const run = promisify(execFile);
  await withUiSessionLock(f.manager.getSessionId(), f.root, async () => {
    await assert.rejects(run(process.execPath, [worker, f.manager.getSessionId(), f.root, counter]), error => /SessionOwnershipError/.test(error.stderr));
    assert.equal(readFileSync(counter, "utf8"), "0", "a foreign writer must not enter the critical section");
  });
  await Promise.all([1, 2].map(() => withUiSessionLock(f.manager.getSessionId(), f.root, async () => {
    const value = Number(readFileSync(counter, "utf8"));
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(counter, String(value + 1));
  })));
  assert.equal(readFileSync(counter, "utf8"), "2", "same-process writers still serialize without lost updates");
  await run(process.execPath, [worker, f.manager.getSessionId(), f.root, counter]);
  assert.equal(readFileSync(counter, "utf8"), "3", "a foreign process may write after all owners release");
});

test("publication rechecks the process lease immediately before replacing the journal", async t => {
  const f = fixture(t, stage => {
    if (stage !== "before-commit") return;
    const stale = new Date(Date.now() - 180_000);
    utimesSync(sessionOwnershipPath(f.manager.getSessionId(), f.root), stale, stale);
  });
  await f.host.startRun(); const item = await candidate(f); await f.host.persistCandidate(item.operationId);
  await assert.rejects(f.host.commitCandidate(item.operationId), error => error.code === "SESSION_IN_USE");
  assert.equal(f.read().records[0].status, "candidate");
  assert.deepEqual(f.read().active, []);
  assert.equal((await f.host.readOutput("call-1")).publication.status, "candidate");
});

test("a foreign runtime writer leaves committed outputs readable but excludes parameter writes", async t => {
  const f = fixture(t); await f.host.startRun();
  const item = await candidate(f);
  await f.host.persistCandidate(item.operationId); await f.host.commitCandidate(item.operationId);
  const worker = join(f.root, "read-owner.mjs");
  writeFileSync(worker, `import { createJiti } from ${JSON.stringify(import.meta.resolve("jiti"))};
const { retainSessionFileOwnership } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./session-file-ownership.ts", import.meta.url).href)});
const owner = retainSessionFileOwnership(process.argv[2], process.argv[3]);
console.log('owned'); process.stdin.once('data', () => { owner.release(); process.exit(0); });`);
  const child = spawn(process.execPath, [worker, f.manager.getSessionId(), f.root], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const [chunk] = await once(child.stdout, "data"); assert.match(chunk.toString(), /owned/);
    const saved = await f.host.readOutput("call-1");
    assert.equal(saved.publication.status, "committed");
    assert.equal(saved.state.people, 4);
    await assert.rejects(f.host.saveParameters(item.operationId, saved.revision, { people: 8 }), error => error.code === "SESSION_IN_USE");
    assert.equal((await f.host.readActive("bill")).state.people, 4);
    const stopped = once(child, "exit"); child.stdin.write("release\n");
    assert.equal((await stopped)[0], 0);
    await f.host.saveParameters(item.operationId, saved.revision, { people: 8 });
    assert.equal((await f.host.readActive("bill")).state.people, 8);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
  }
});

function appendResult(manager, callId, details, name = "piora_render_ui_plan") {
  return manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: name, isError: false,
    content: [{ type: "text", text: "fixture result" }], details, timestamp: Date.now() });
}
function appendBatch(manager, calls) {
  return manager.appendMessage({ role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    stopReason: "toolUse", usage, timestamp: Date.now(), content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })) });
}

test("request snapshot covers new identities and caller mutation cannot change the generation basis", async t => {
  const f = fixture(t); await f.host.startRun();
  const request = await f.host.captureRequestContext();
  const source = f.host.contextForSurface(request.requestId, "bill");
  assert.equal(source.source.origin, "none");
  source.source.surfaceRevision = 99;
  request.surfaces.push({ source: { surfaceId: "bill", surfaceRevision: 99 }, state: {} });
  assert.equal(f.host.contextForSurface(request.requestId, "bill").source.surfaceRevision, 0);
  appendCall(f.manager, "new");
  const item = await f.host.createCandidate(request.requestId, "new", compiled());
  assert.equal(f.read().records[0].source.leafId, source.leafId);
  await f.host.cancelRun();
  assert.throws(() => f.host.contextForSurface(request.requestId, "bill"), code("IDENTITY"));
  await assert.rejects(f.host.observePersistedCandidate(item.operationId, { messageEntryId: "unknown", toolResultEntryIds: [] }), code("CANCELLED"));
});

test("observer accepts exact SDK-persisted multi-tool receipts without appending or duplicating records", async t => {
  const f = fixture(t); await f.host.startRun();
  const request = await f.host.captureRequestContext();
  const messageEntryId = appendBatch(f.manager, [["query", "fixture_query"], ["first", "piora_render_ui_plan"], ["second", "piora_render_ui_plan"]]);
  const queryEntry = appendResult(f.manager, "query", undefined, "fixture_query");
  const first = await f.host.createCandidate(request.requestId, "first", compiled());
  const firstEntry = appendResult(f.manager, "first", first.details);
  const secondPlan = plan(); secondPlan.id = "other";
  const second = await f.host.createCandidate(request.requestId, "second", compileUiPlan(secondPlan, { revision: 1 }));
  const secondEntry = appendResult(f.manager, "second", second.details);
  const boundary = { messageEntryId, toolResultEntryIds: [queryEntry, firstEntry, secondEntry] };
  const before = readFileSync(f.manager.getSessionFile(), "utf8");
  assert.equal((await f.host.observePersistedCandidate(first.operationId, boundary)).entryId, firstEntry);
  await f.host.observePersistedCandidate(second.operationId, boundary);
  await f.host.commitCandidate(first.operationId); await f.host.commitCandidate(second.operationId);
  await f.host.observePersistedCandidate(first.operationId, boundary);
  assert.equal(readFileSync(f.manager.getSessionFile(), "utf8"), before, "observing and committing never append to SDK history");
  assert.equal(f.read().records.length, 2);
  assert.equal((await f.host.readActive("bill")).operationId, first.operationId);
  assert.equal((await f.host.readActive("other")).operationId, second.operationId);
});

test("SDK receipt cannot omit a result, substitute an entry, or accept a later unrelated message", async t => {
  const f = fixture(t); await f.host.startRun();
  const request = await f.host.captureRequestContext();
  const messageEntryId = appendBatch(f.manager, [["query", "fixture_query"], ["ui", "piora_render_ui_plan"]]);
  const item = await f.host.createCandidate(request.requestId, "ui", compiled());
  const resultEntry = appendResult(f.manager, "ui", item.details);
  await assert.rejects(f.host.observePersistedCandidate(item.operationId, { messageEntryId, toolResultEntryIds: [resultEntry] }), code("RECEIPT"));
  const queryEntry = appendResult(f.manager, "query", undefined, "fixture_query");
  await assert.rejects(f.host.observePersistedCandidate(item.operationId, { messageEntryId, toolResultEntryIds: [resultEntry, "forged"] }), code("RECEIPT"));
  await assert.rejects(f.host.observePersistedCandidate(item.operationId, { messageEntryId: "other", toolResultEntryIds: [resultEntry, queryEntry] }), code("RECEIPT"));
  await f.host.observePersistedCandidate(item.operationId, { messageEntryId, toolResultEntryIds: [resultEntry, queryEntry] });
  f.manager.appendMessage({ role: "user", content: "unrelated later turn", timestamp: Date.now() });
  await assert.rejects(f.host.commitCandidate(item.operationId), code("CONFLICT"));
  assert.equal(f.read().records[0].status, "candidate");
});

test("two candidates for one task from a single request cannot both publish the same next version", async t => {
  const f = fixture(t); await f.host.startRun();
  const request = await f.host.captureRequestContext();
  const messageEntryId = appendBatch(f.manager, [["first", "piora_render_ui_plan"], ["second", "piora_render_ui_plan"]]);
  const first = await f.host.createCandidate(request.requestId, "first", compiled());
  const firstEntry = appendResult(f.manager, "first", first.details);
  const second = await f.host.createCandidate(request.requestId, "second", compiled());
  const secondEntry = appendResult(f.manager, "second", second.details);
  const boundary = { messageEntryId, toolResultEntryIds: [firstEntry, secondEntry] };
  await f.host.observePersistedCandidate(first.operationId, boundary); await f.host.observePersistedCandidate(second.operationId, boundary);
  await f.host.commitCandidate(first.operationId);
  await assert.rejects(f.host.commitCandidate(second.operationId), code("CONFLICT"));
  assert.equal((await f.host.readActive("bill")).operationId, first.operationId);
});

test("reading a candidate or cancelled result never activates it or replaces the committed export", async t => {
  const f = fixture(t); await published(f);
  const saved = await f.host.readActive("bill");
  await f.host.saveParameters(saved.operationId, saved.stateRevision, { people: 7 });
  const item = await candidate(f, "next", compiled(2)); await f.host.persistCandidate(item.operationId);
  const before = readFileSync(generationJournalPath(f.manager.getSessionId(), f.root), "utf8");
  const preview = await readUiOutput(f.manager, "next", { root: f.root });
  assert.equal(preview.publication.status, "candidate");
  assert.deepEqual(preview.state, { people: 4 });
  assert.deepEqual(await readUiSnapshots(f.manager, f.root), ["分账\n人数: 7\n总价: 84"]);
  assert.equal(readFileSync(generationJournalPath(f.manager.getSessionId(), f.root), "utf8"), before);
  await f.host.cancelRun();
  assert.equal((await readUiOutput(f.manager, "next", { root: f.root })).publication.status, "aborted");
  assert.deepEqual(await readUiSnapshots(f.manager, f.root), ["分账\n人数: 7\n总价: 84"]);
});

test("committed readers use saved values and identify superseded outputs on the selected branch", async t => {
  const f = fixture(t); const old = await published(f);
  const oldLeaf = f.manager.getLeafId();
  await f.host.saveParameters(old.operationId, old.commit.stateRevision, { people: 8 });
  const next = await candidate(f, "next", compiled(2)); await f.host.persistCandidate(next.operationId); await f.host.commitCandidate(next.operationId);
  const previous = await readUiOutput(f.manager, "call-1", { root: f.root });
  assert.equal(previous.publication.status, "superseded");
  assert.equal(previous.publication.currentToolCallId, "next");
  const current = await readUiOutput(f.manager, "next", { root: f.root });
  assert.equal(current.publication.status, "committed");
  assert.deepEqual(current.state, { people: 8 });
  assert.deepEqual(await readUiSnapshots(f.manager, f.root), ["分账\n人数: 8\n总价: 96"]);
  assert.equal((await readUiOutput(f.manager, "call-1", { root: f.root, leafId: oldLeaf })).publication.status, "committed");
  await assert.rejects(readUiOutput(f.manager, "next", { root: f.root, leafId: oldLeaf }), /does not belong to this branch/);
});

test("a later legacy result supersedes journal output in branch order and rejects old parameter writes", async t => {
  const f = fixture(t); const item = await published(f);
  const legacy = compiled(2).surface;
  appendCall(f.manager, "rollback", {}, "piora_render_ui");
  appendResult(f.manager, "rollback", { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "legacy", payload: legacy } }, "piora_render_ui");
  assert.equal(await f.host.readActive("bill"), null);
  const previous = await readUiOutput(f.manager, "call-1", { root: f.root });
  assert.equal(previous.publication.status, "superseded");
  assert.equal(previous.publication.currentToolCallId, "rollback");
  await assert.rejects(f.host.saveParameters(item.operationId, item.commit.stateRevision, { people: 9 }), code("CONFLICT"));
  const context = await f.host.captureContext("bill");
  assert.equal(context.source.origin, "legacy");
  assert.equal(context.source.surfaceRevision, 2);
  assert.deepEqual(await readUiSnapshots(f.manager, f.root), ["分账\n人数: 4\n总价: 48"]);
});

test("missing journal or altered disk payload produces an explicit read error, never assumed committed state", async t => {
  for (const damage of ["missing", "payload"]) {
    const f = fixture(t); await published(f);
    if (damage === "missing") rmSync(generationJournalPath(f.manager.getSessionId(), f.root));
    else {
      const path = f.manager.getSessionFile(), rows = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
      rows.at(-1).message.details.answerOutput.payload.title = "damaged";
      writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    await assert.rejects(readUiOutput(f.manager, "call-1", { root: f.root }), error => ["CORRUPT", "RECEIPT"].includes(error.code));
    await assert.rejects(readUiSnapshots(f.manager, f.root));
  }
});
