import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { UiGenerationPrototype, copyGenerationJournal, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { readOnlySessionManager } = await jiti.import("./session-readonly-manager.ts");
const { sessionOwnershipPath } = await jiti.import("./session-file-ownership.ts");
const { readUiOutput, readUiSnapshots } = await jiti.import("./intelligent-ui/read-output.ts");
const { copyAnswerOutputState, answerOutputExportAppendix } = await jiti.import("./answer-output-server.ts");
const { saveSurfaceState, intelligentUiStatePath } = await jiti.import("./intelligent-ui/store.ts");
const plan = () => ({ planVersion: 1, id: "bill", title: "Bill", inputs: [{ id: "people", valueType: "number", label: "People", value: 4, min: 1, max: 20 }], derived: [], views: [{ id: "count", kind: "metric", label: "Count", value: { input: "people" } }] });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-generation-copy-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions")); manager.appendMessage({ role: "user", content: "create", timestamp: Date.now() });
  return { root, manager, source: manager.getSessionId(), sourceFile: manager.getSessionFile(), host: new UiGenerationPrototype({ manager, root }) };
}
async function create(f, call, revision, commit = true) {
  const context = await f.host.captureContext("bill");
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: call, name: "piora_render_ui_plan", arguments: plan() }], timestamp: Date.now() });
  const item = await f.host.createCandidate(context.contextId, call, compileUiPlan(plan(), { revision }));
  await f.host.persistCandidate(item.operationId);
  return { ...item, ...(commit ? await f.host.commitCandidate(item.operationId) : {}) };
}
function fork(f, leaf = f.manager.getLeafId()) {
  const file = f.manager.createBranchedSession(leaf), target = f.manager.getSessionId();
  return { source: f.source, target, sourceFile: f.sourceFile, targetFile: file, retainedEntryIds: f.manager.getBranch().map(entry => entry.id), sourceLeafId: leaf, root: f.root };
}
test("SDK fork inherits only retained committed receipts and parameters with independent ownership", async t => {
  const f = fixture(t); await f.host.startRun(); const first = await create(f, "first", 1);
  await f.host.saveParameters(first.operationId, first.stateRevision, { people: 7 });
  const retainedLeaf = f.manager.getLeafId();
  f.manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
  const later = await create(f, "later", 2);
  await f.host.saveParameters(later.operationId, later.stateRevision, { people: 9 });
  const sourceBytes = readFileSync(generationJournalPath(f.source, f.root));
  const options = fork(f, retainedLeaf); assert.equal((await copyGenerationJournal(options)).copied, 1);
  const copied = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.equal(copied.epoch, null); assert.equal(copied.records.length, 1); assert.equal(copied.records[0].epoch, "inherited");
  assert.equal(copied.records[0].source.sessionId, options.target); assert.equal(copied.records[0].operationId, first.operationId);
  assert.equal(copied.states.at(-1).state.people, 7);
  const target = new UiGenerationPrototype({ manager: f.manager, root: f.root });
  const active = await target.readActive("bill"); assert.deepEqual(active.state, { people: 7 });
  await target.saveParameters(first.operationId, active.stateRevision, { people: 11 });
  assert.deepEqual(readFileSync(generationJournalPath(f.source, f.root)), sourceBytes);
  assert.equal((await readUiOutput(readOnlySessionManager(options.targetFile), "first", { root: f.root })).state.people, 11);
});
for (const committed of [true, false]) test(`title ancestry survives SDK label removal and two forks (${committed ? "committed" : "candidate"})`, async t => {
  const f = fixture(t); await f.host.startRun();
  const label = f.manager.appendLabelChange(f.manager.getLeafId(), "request boundary");
  const context = await f.host.captureContext("bill");
  assert.equal(context.leafId, label);
  const title = f.manager.appendSessionInfo("Automatic title during generation");
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "titled", name: "piora_render_ui_plan", arguments: plan() }], timestamp: Date.now() });
  const candidate = await f.host.createCandidate(context.contextId, "titled", compileUiPlan(plan(), { revision: 1 }));
  await f.host.persistCandidate(candidate.operationId);
  if (committed) await f.host.commitCandidate(candidate.operationId);
  const original = JSON.parse(readFileSync(generationJournalPath(f.source, f.root), "utf8")).records[0];
  for (let index = 0; index < 2; index++) {
    const options = fork(f); await copyGenerationJournal(options);
    const journal = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
    const record = committed ? journal.records[0] : journal.excludedOutputs[0];
    assert.equal(record.callEntryHash, original.callEntryHash);
    assert.equal(record.source.leafId, context.leafId);
    assert.equal(record.contextTitles[0].entryId, title);
    assert.equal(record.contextTitles[0].entryHash, original.contextTitles[0].entryHash);
    assert.equal(record.contextTitles[0].forkCall.removedLabels[0].entry.id, label);
    const result = await readUiOutput(readOnlySessionManager(options.targetFile), "titled", { root: f.root });
    assert.equal(result.publication.status, committed ? "committed" : "aborted");
    assert.deepEqual(result.state, { people: 4 });
    f.source = options.target; f.sourceFile = options.targetFile;
  }
});

test("duplicate retains committed history and frozen ancestor values, excluding candidate and aborted work", async t => {
  const f = fixture(t); await f.host.startRun(); const first = await create(f, "first", 1);
  await f.host.saveParameters(first.operationId, first.stateRevision, { people: 6 });
  await create(f, "candidate", 2, false); await f.host.cancelRun();
  const options = fork(f); await copyGenerationJournal(options);
  const copied = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.equal(copied.records.length, 1); assert.equal(copied.records[0].status, "committed");
  assert.equal(copied.active.length, 1); assert.ok(copied.states.every(state => state.operationId === first.operationId));
  const target = new UiGenerationPrototype({ manager: f.manager, root: f.root });
  assert.deepEqual((await target.readActive("bill")).state, { people: 6 });
  const reader = readOnlySessionManager(options.targetFile);
  const aborted = await readUiOutput(reader, "candidate", { root: f.root });
  assert.equal(aborted.publication.status, "aborted"); assert.equal(aborted.revision, 0);
  assert.equal(copied.excludedOutputs.length, 1);
  assert.match((await readUiSnapshots(reader, f.root)).join("\n"), /Count: 6/);
});

test("fork keeps frozen child parameters when an ancestor was edited later", async t => {
  const f = fixture(t); await f.host.startRun(); const first = await create(f, "first", 1);
  const revision = await f.host.saveParameters(first.operationId, first.stateRevision, { people: 6 });
  const ancestor = f.manager.getLeafId();
  const child = f.manager.appendMessage({ role: "user", content: "existing child", timestamp: Date.now() });
  f.manager.branch(ancestor);
  await f.host.saveParameters(first.operationId, revision, { people: 8 });
  const source = JSON.parse(readFileSync(generationJournalPath(f.source, f.root), "utf8"));
  assert.equal(source.states.find(state => state.anchor === child).state.people, 6);
  const options = fork(f, child); await copyGenerationJournal(options);
  const copied = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.equal(copied.states.find(state => state.anchor === ancestor).state.people, 8);
  assert.equal(copied.states.find(state => state.anchor === child).state.people, 6);
  const target = new UiGenerationPrototype({ manager: f.manager, root: f.root });
  assert.equal((await target.readActive("bill")).state.people, 6);
  f.manager.branch(ancestor);
  assert.equal((await target.readActive("bill")).state.people, 8);
});

test("generic copy and export preserve both legacy and multiple committed generations", async t => {
  const f = fixture(t), previousRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.root;
  t.after(() => { if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousRoot; });
  const legacySurface = { version: 1, revision: 1, id: "legacy", title: "Legacy", nodes: [{ id: "old", type: "number", label: "Old", value: 1 }] };
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "legacy-call", name: "piora_render_ui", arguments: {} }], timestamp: Date.now() });
  f.manager.appendMessage({ role: "toolResult", toolCallId: "legacy-call", toolName: "piora_render_ui", content: [{ type: "text", text: "Old: 1" }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "Old: 1", payload: legacySurface } }, timestamp: Date.now() });
  await saveSurfaceState({ sessionId: f.source, toolCallId: "legacy-call", leafId: f.manager.getLeafId(), expectedRevision: 0, state: { old: 7 }, branch: () => f.manager.getBranch(), enabled: () => true, root: f.root });
  await f.host.startRun(); const first = await create(f, "first", 1);
  await f.host.saveParameters(first.operationId, first.stateRevision, { people: 6 });
  f.manager.appendMessage({ role: "user", content: "revise", timestamp: Date.now() });
  const second = await create(f, "second", 2);
  await f.host.saveParameters(second.operationId, second.stateRevision, { people: 9 });
  const sourceLegacy = readFileSync(intelligentUiStatePath(f.source, f.root)), sourceJournal = readFileSync(generationJournalPath(f.source, f.root));
  const options = fork(f);
  await copyAnswerOutputState(options.source, options.target, options.retainedEntryIds, options);
  const reader = readOnlySessionManager(options.targetFile);
  assert.equal((await readUiOutput(reader, "legacy-call", { root: f.root })).state.old, 7);
  const firstOutput = await readUiOutput(reader, "first", { root: f.root });
  assert.equal(firstOutput.state.people, 6); assert.equal(firstOutput.publication.status, "superseded");
  const secondOutput = await readUiOutput(reader, "second", { root: f.root });
  assert.equal(secondOutput.state.people, 9); assert.equal(secondOutput.publication.status, "committed");
  const appendix = await answerOutputExportAppendix(options.target, options.targetFile);
  assert.match(appendix, /Old: 7/); assert.match(appendix, /Count: 9/); assert.doesNotMatch(appendix, /Count: 6/);
  assert.deepEqual(readFileSync(intelligentUiStatePath(f.source, f.root)), sourceLegacy);
  assert.deepEqual(readFileSync(generationJournalPath(f.source, f.root)), sourceJournal);
});
test("cut before a committed result inherits no editable generation", async t => {
  const f = fixture(t); await f.host.startRun(); const first = await create(f, "first", 1);
  const call = f.manager.getEntry(first.entryId).parentId, options = fork(f, call);
  assert.equal((await copyGenerationJournal(options)).copied, 0);
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), false);
});
test("target disk mismatch is rejected instead of manufacturing a fresh receipt", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "first", 1); const options = fork(f);
  const lines = readFileSync(options.targetFile, "utf8").trimEnd().split("\n").map(JSON.parse);
  lines.at(-1).message.details.answerOutput.payload.title = "wrong";
  writeFileSync(options.targetFile, lines.map(JSON.stringify).join("\n") + "\n");
  await assert.rejects(copyGenerationJournal(options), error => error.code === "RECEIPT");
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), false);
});
test("copy revalidates target ownership immediately before publication", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "first", 1); const options = fork(f);
  const original = readFileSync(generationJournalPath(f.source, f.root));
  await assert.rejects(copyGenerationJournal({ ...options, beforePublish() {
    const stale = new Date(Date.now() - 180_000); utimesSync(sessionOwnershipPath(options.target, f.root), stale, stale);
  } }), error => error.code === "SESSION_IN_USE");
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), false);
  assert.deepEqual(readFileSync(generationJournalPath(f.source, f.root)), original);
});

test("copy checks target bytes again after syncing and never publishes a changed receipt", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "first", 1); const options = fork(f);
  await assert.rejects(copyGenerationJournal({ ...options, beforePublish() {
    const rows = readFileSync(options.targetFile, "utf8").trimEnd().split("\n").map(JSON.parse);
    rows[1].message.content = "late target mutation"; writeFileSync(options.targetFile, rows.map(JSON.stringify).join("\n") + "\n");
  } }), error => error.code === "RECEIPT");
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), false);
});

test("SDK label rechain preserves original receipts and parameter meaning across a second fork", async t => {
  const f = fixture(t), user = f.manager.getLeafId();
  const sourceLabel = f.manager.appendLabelChange(user, "Before UI");
  await f.host.startRun(); const first = await create(f, "first", 1);
  await f.host.saveParameters(first.operationId, first.stateRevision, { people: 6 });
  f.manager.appendLabelChange(user, "After UI");
  const active = await f.host.readActive("bill");
  await f.host.saveParameters(first.operationId, active.stateRevision, { people: 9 });
  const original = JSON.parse(readFileSync(generationJournalPath(f.source, f.root), "utf8")).records[0];
  const options = fork(f); await copyGenerationJournal(options);
  const copied = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.deepEqual(copied.records[0].receipt, original.receipt);
  assert.equal(copied.records[0].callEntryHash, original.callEntryHash);
  assert.equal(copied.records[0].forkCall.removedLabels[0].entry.id, sourceLabel);
  assert.equal(copied.records[0].forkCall.targetParentId, user);
  assert.equal((await readUiOutput(readOnlySessionManager(options.targetFile), "first", { root: f.root })).state.people, 9);
  const second = fork({ ...f, source: options.target, sourceFile: options.targetFile });
  await copyGenerationJournal(second);
  const repeated = JSON.parse(readFileSync(generationJournalPath(second.target, f.root), "utf8"));
  assert.deepEqual(repeated.records[0].receipt, original.receipt);
  assert.equal(repeated.records[0].callEntryHash, original.callEntryHash);
  assert.deepEqual(repeated.records[0].forkCall, copied.records[0].forkCall);
  assert.equal((await readUiOutput(readOnlySessionManager(second.targetFile), "first", { root: f.root })).state.people, 9);
});

test("a live candidate is inherited only as explicit read-only history, including another fork", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "pending", 1, false);
  const options = fork(f); assert.equal((await copyGenerationJournal(options)).copied, 0);
  const journal = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.equal(journal.records.length, 0); assert.equal(journal.active.length, 0); assert.equal(journal.states.length, 0); assert.equal(journal.epoch, null);
  assert.equal(journal.excludedOutputs[0].sourceStatus, "candidate");
  assert.equal((await readUiOutput(readOnlySessionManager(options.targetFile), "pending", { root: f.root })).publication.status, "aborted");
  assert.deepEqual(await readUiSnapshots(readOnlySessionManager(options.targetFile), f.root), []);
  const second = fork({ ...f, source: options.target, sourceFile: options.targetFile }); await copyGenerationJournal(second);
  assert.equal((await readUiOutput(readOnlySessionManager(second.targetFile), "pending", { root: f.root })).publication.status, "aborted");
  const target = new UiGenerationPrototype({ manager: f.manager, root: f.root });
  await assert.rejects(target.saveOutput({ toolCallId: "pending", leafId: f.manager.getLeafId(), expectedRevision: 0, state: { people: 8 }, enabled: () => true }), error => error.code === "IDENTITY");
});

test("an excluded output never permits fallback for damaged evidence or a missing journal record", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "pending", 1, false);
  const options = fork(f); await copyGenerationJournal(options);
  const path = generationJournalPath(options.target, f.root), original = readFileSync(path, "utf8"), journal = JSON.parse(original);
  journal.excludedOutputs[0].receipt.entryHash = "wrong"; writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(readUiOutput(readOnlySessionManager(options.targetFile), "pending", { root: f.root }), error => error.code === "RECEIPT");
  journal.excludedOutputs = []; writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(readUiOutput(readOnlySessionManager(options.targetFile), "pending", { root: f.root }), error => error.code === "CORRUPT");
  writeFileSync(path, original);
});

test("fork distinguishes a disk-observed unacknowledged candidate from a source publication receipt", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "pending", 1, false);
  const path = generationJournalPath(f.source, f.root), journal = JSON.parse(readFileSync(path, "utf8"));
  delete journal.records[0].receipt; writeFileSync(path, JSON.stringify(journal));
  const options = fork(f); await copyGenerationJournal(options);
  const inherited = JSON.parse(readFileSync(generationJournalPath(options.target, f.root), "utf8"));
  assert.equal(inherited.records.length, 0); assert.equal(inherited.excludedOutputs[0].evidenceOrigin, "fork-observed-jsonl");
  assert.equal((await readUiOutput(readOnlySessionManager(options.targetFile), "pending", { root: f.root })).publication.status, "aborted");
});

test("fork verifies the SDK compaction first-kept label rewrite", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "first", 1);
  const label = f.manager.appendLabelChange(f.manager.getLeafId(), "kept start");
  const next = f.manager.appendMessage({ role: "user", content: "after label", timestamp: Date.now() });
  const compact = f.manager.appendCompaction("summary", label, 1000);
  const options = fork(f); await copyGenerationJournal(options);
  const reader = readOnlySessionManager(options.targetFile);
  assert.equal(reader.getEntry(compact).firstKeptEntryId, next);
  assert.equal((await readUiOutput(reader, "first", { root: f.root })).publication.status, "committed");
});

test("reusing target IDs does not authorize edits to retained non-label messages", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "first", 1); const options = fork(f);
  const rows = readFileSync(options.targetFile, "utf8").trimEnd().split("\n").map(JSON.parse);
  rows[1].message.content = "changed user message";
  writeFileSync(options.targetFile, rows.map(JSON.stringify).join("\n") + "\n");
  await assert.rejects(copyGenerationJournal(options), error => error.code === "RECEIPT");
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), false);
});

for (const mixed of [false, true]) test(`${mixed ? "mixed v1/v2" : "v1-only"} copy maps removed label states in branch order and preserves frozen descendants`, async t => {
  const f = fixture(t), previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = f.root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const surface = { version: 1, revision: 1, id: "legacy", title: "Legacy", nodes: [{ id: "old", type: "number", label: "Old", value: 1 }] };
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "old-call", name: "piora_render_ui", arguments: {} }], timestamp: Date.now() });
  const result = f.manager.appendMessage({ role: "toolResult", toolCallId: "old-call", toolName: "piora_render_ui", content: [{ type: "text", text: "Old: 1" }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: "Old: 1", payload: surface } }, timestamp: Date.now() });
  const save = (value, expectedRevision) => saveSurfaceState({ sessionId: f.source, toolCallId: "old-call", leafId: f.manager.getLeafId(), expectedRevision, state: { old: value }, branch: () => f.manager.getBranch(), allEntries: () => f.manager.getEntries(), enabled: () => true, root: f.root });
  const labelOne = f.manager.appendLabelChange(result, "one"); const six = await save(6, 0);
  f.manager.appendLabelChange(result, "two"); await save(8, six.revision);
  const child = f.manager.appendMessage({ role: "user", content: "retained child", timestamp: Date.now() });
  f.manager.branch(labelOne); await save(9, six.revision); f.manager.branch(child);
  if (mixed) { await f.host.startRun(); await create(f, "generated", 1); }
  const options = fork(f); await copyAnswerOutputState(options.source, options.target, options.retainedEntryIds, options);
  const reader = readOnlySessionManager(options.targetFile);
  assert.equal((await readUiOutput(reader, "old-call", { root: f.root })).state.old, 8, "nearest state in source branch wins even if an ancestor was edited later");
  assert.equal(existsSync(generationJournalPath(options.target, f.root)), mixed, "v1-only inheritance does not manufacture a generation journal");
  if (mixed) assert.equal((await readUiOutput(reader, "generated", { root: f.root })).publication.status, "committed");
});
