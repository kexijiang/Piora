import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const jiti = createJiti(import.meta.url);
const { UiGenerationPrototype, copyGenerationJournal, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");
const { readUiDecisionRecords, readUiSnapshots } = await jiti.import("./intelligent-ui/read-output.ts");
const { intelligentUiStatePath } = await jiti.import("./intelligent-ui/store.ts");
const { uiSessionLockPath } = await jiti.import("./intelligent-ui/session-lock.ts");
const { acquireExclusiveFileLease } = await jiti.import("./session-file-ownership.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const register = (await jiti.import("../extensions/piora-intelligent-ui.ts")).default;
const plan = id => ({ planVersion: 1, id, title: `Saved ${id}`, inputs: [{ id: "people", valueType: "number", label: "People", value: 4, min: 1, max: 20 }], derived: [], views: [{ id: "count", kind: "metric", label: "Count", value: { input: "people" } }] });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-ui-read-snapshot-"));
  const previous = process.env.PI_CODING_AGENT_DIR, previousProtocol = process.env.PIORA_UI_INPUT_PROTOCOL;
  process.env.PI_CODING_AGENT_DIR = root; process.env.PIORA_UI_INPUT_PROTOCOL = "surface";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousProtocol === undefined) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = previousProtocol;
    rmSync(root, { recursive: true, force: true });
  });
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Create adjustable counts", timestamp: 1 });
  return { root, manager, host: new UiGenerationPrototype({ manager, root }) };
}
async function create(f, id, commit = true) {
  const context = await f.host.captureContext(id), input = plan(id);
  f.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id, name: "piora_render_ui_plan", arguments: input }], timestamp: 2 });
  const candidate = await f.host.createCandidate(context.contextId, id, compileUiPlan(input, { revision: 1 }));
  await f.host.persistCandidate(candidate.operationId);
  return commit ? f.host.commitCandidate(candidate.operationId) : candidate;
}

test("all decision records and export values are frozen under one session, legacy and journal lock", async t => {
  const f = fixture(t); await f.host.startRun(); const a = await create(f, "a"), b = await create(f, "b");
  let observed = 0, saving;
  const manager = { getSessionId: () => f.manager.getSessionId(), getSessionFile: () => f.manager.getSessionFile(),
    getLeafId() {
      observed++;
      for (const path of [uiSessionLockPath(f.manager.getSessionId(), f.root), `${intelligentUiStatePath(f.manager.getSessionId(), f.root)}.lock`, `${generationJournalPath(f.manager.getSessionId(), f.root)}.lock`]) {
        assert.throws(() => { const lease = acquireExclusiveFileLease(path); lease.release(); }, error => error.code === "ELOCKED", "a writer cannot enter between two surface reads");
      }
      saving ??= (async () => {
        await f.host.saveParameters(a.operationId, a.stateRevision, { people: 8 });
        await f.host.saveParameters(b.operationId, b.stateRevision, { people: 8 });
      })();
      return f.manager.getLeafId();
    } };
  const before = await readUiDecisionRecords(manager, f.root);
  assert.equal(observed, 1, "one snapshot captures its branch once while all locks are held");
  assert.deepEqual(before.records.map(record => record.state.people), [4, 4]);
  await saving;
  assert.deepEqual(before.records.map(record => record.state.people), [4, 4], "later saves cannot mutate captured records");
  const after = await readUiDecisionRecords(f.manager, f.root);
  assert.deepEqual(after.records.map(record => [record.toolCallId, record.protocolVersion, record.state.people]), [["a", 2, 8], ["b", 2, 8]]);
  assert.deepEqual((await readUiSnapshots(f.manager, f.root)).map(text => text.match(/Count: (\d+)/)[1]), ["8", "8"]);
});

test("the real default extension model context reads v2 saved values and refuses a Surface overwrite", async t => {
  const f = fixture(t); await f.host.startRun(); const committed = await create(f, "bill");
  await f.host.saveParameters(committed.operationId, committed.stateRevision, { people: 8 });
  writeBetaFeatures({ intelligentUi: true }, f.root);
  const requests = [], usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const services = await createAgentSessionServices({ cwd: f.root, agentDir: f.root,
    settingsManager: SettingsManager.create(f.root, f.root, { projectTrusted: true }), resourceLoaderOptions: {
      additionalExtensionPaths: [resolve(import.meta.dirname, "../extensions/piora-intelligent-ui.ts")], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [api => api.registerProvider("read-snapshot-fixture", { api: "read-snapshot-fixture-api", apiKey: "fixture", baseUrl: "https://unused.invalid",
        models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 20000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model, input) {
          requests.push({ tools: getCurrentTools(input.messages), text: JSON.stringify(input.messages) });
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "There are eight people." }], timestamp: Date.now(), usage, stopReason: "stop" };
            stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message });
          });
          return stream;
        },
      })],
    } });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: f.manager, model: services.modelRuntime.getModel("read-snapshot-fixture", "test") });
  try {
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    await session.bindExtensions({});
    await session.prompt("Explain the saved result without generating another UI.");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].tools.filter(tool => tool.name.startsWith("piora_render_ui")).map(tool => tool.name), ["piora_render_ui"]);
    assert.match(requests[0].text, /Saved bill/); assert.match(requests[0].text, /People: 8/); assert.match(requests[0].text, /Count: 8/);
    assert.match(requests[0].text, /stateRevision/);
    const tools = []; register({ registerTool: tool => tools.push(tool), on() {} });
    const bytes = readFileSync(generationJournalPath(f.manager.getSessionId(), f.root)), updates = [];
    const result = await tools[0].execute("rollback", { id: "bill", title: "Wrong default", nodes: [{ id: "people", type: "number", label: "People", value: 1 }] }, undefined, value => updates.push(value), { sessionManager: f.manager });
    assert.equal(result.isError, true); assert.equal(result.details.intelligentUiDiagnostic.code, "UI_PROTOCOL_UNAVAILABLE");
    assert.equal(result.details.intelligentUiDiagnostic.repairable, false); assert.deepEqual(updates, []);
    assert.deepEqual(readFileSync(generationJournalPath(f.manager.getSessionId(), f.root)), bytes);
    const active = await f.host.readActive("bill"); assert.equal(active.state.people, 8);
    await f.host.saveParameters(committed.operationId, active.stateRevision, { people: 9 });
    assert.equal((await f.host.readActive("bill")).state.people, 9, "rollback rejection preserves editing of the existing UI");
  } finally { await session.abort(); session.dispose(); }
});

test("batch snapshots reject missing or damaged v2 evidence instead of falling back to defaults", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "bill");
  const path = generationJournalPath(f.manager.getSessionId(), f.root), bytes = readFileSync(path);
  rmSync(path);
  await assert.rejects(readUiDecisionRecords(f.manager, f.root), error => error.code === "CORRUPT");
  writeFileSync(path, bytes);
  const journal = JSON.parse(bytes); journal.records[0].receipt.entryHash = "damaged"; writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(readUiSnapshots(f.manager, f.root), error => error.code === "RECEIPT");
});

test("excluded candidate evidence is checked even when a batch has no published surfaces", async t => {
  const f = fixture(t); await f.host.startRun(); await create(f, "pending", false);
  const source = f.manager.getSessionId(), sourceFile = f.manager.getSessionFile(), sourceLeafId = f.manager.getLeafId();
  const targetFile = f.manager.createBranchedSession(sourceLeafId), target = f.manager.getSessionId();
  await copyGenerationJournal({ source, sourceFile, sourceLeafId, target, targetFile, retainedEntryIds: f.manager.getBranch().map(entry => entry.id), root: f.root });
  assert.deepEqual((await readUiDecisionRecords(f.manager, f.root)).records, []);
  const path = generationJournalPath(target, f.root), journal = JSON.parse(readFileSync(path, "utf8"));
  journal.excludedOutputs[0].receipt.entryHash = "damaged"; writeFileSync(path, JSON.stringify(journal));
  await assert.rejects(readUiDecisionRecords(f.manager, f.root), error => error.code === "RECEIPT");
});
