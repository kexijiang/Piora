import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { bindUiGenerationRuntime, getUiGenerationRuntime } = await jiti.import("./generation-runtime.ts");
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./generation-journal.ts");
const { createOwnedSessionManager } = await jiti.import("../session-owned-manager.ts");
const { persistLazySessionManager } = await jiti.import("../session-persistence.ts");
const { SessionOwnershipError, acquireExclusiveFileLease } = await jiti.import("../session-file-ownership.ts");
const { uiSessionLockPath } = await jiti.import("./session-lock.ts");
const { uiPlanSchema } = await jiti.import("./plan-schema.ts");
const { writeToolPermission } = await jiti.import("../tool-permission-store.ts");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const plan = (id = "bill") => ({ planVersion: 1, id, title: "分账", inputs: [{ id: "people", valueType: "number", label: "人数", value: 4, min: 1, max: 20 }], derived: [{ id: "total", op: "multiply", args: [{ input: "people" }, { literal: 12 }] }], views: [{ id: "amount", kind: "metric", label: "总价", value: { derived: "total" } }] });
const call = (id, args = plan(), name = "piora_render_ui_plan") => ({ type: "toolCall", id, name, arguments: args });
const appendCalls = (manager, calls) => manager.appendMessage({ role: "assistant", content: calls, stopReason: "toolUse", api: "openai-completions", provider: "fixture", model: "fixture", usage, timestamp: Date.now() });
const appendResult = (manager, id, result, name = "piora_render_ui_plan") => manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: name, isError: result.isError === true, ...result, timestamp: Date.now() });

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-generation-runtime-"));
  const owned = createOwnedSessionManager(root, join(root, "sessions"), root), manager = owned.manager;
  manager.appendMessage({ role: "user", content: "帮我做分账器", timestamp: Date.now() });
  owned.assertOwned(); persistLazySessionManager(manager);
  let active = "run-1", writable = true;
  const bindings = [];
  const bind = (runId = active) => {
    active = runId;
    const runtime = bindUiGenerationRuntime({ manager, root, identity: { sessionId: manager.getSessionId(), runId },
      isActive: () => active === runId, assertOwned: () => { if (!writable) throw new SessionOwnershipError(); owned.assertOwned(); } });
    bindings.push(runtime); return runtime;
  };
  t.after(async () => {
    writable = true;
    await Promise.all(bindings.map(binding => binding.cancel().catch(() => {})));
    owned.release();
    assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, owned, bind, runtime: bind(), setWritable: value => { writable = value; }, setActive: value => { active = value; },
    read: () => JSON.parse(readFileSync(generationJournalPath(manager.getSessionId(), root), "utf8")),
    reader: () => new UiGenerationPrototype({ manager, root }),
  };
}
async function publish(f, id = "ui", value = plan()) {
  await f.runtime.captureContext();
  const messageEntryId = appendCalls(f.manager, [call(id, value)]);
  const output = await f.runtime.executePlan(id, value);
  assert.equal(output.isError, undefined);
  const entryId = appendResult(f.manager, id, output);
  const result = await f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId], outcome: "completed" });
  assert.equal(result.committed.length, 1);
  return { output, result, messageEntryId, entryId };
}

test("production candidates publish only after exact SDK receipts, without appending duplicate messages", async t => {
  const f = fixture(t);
  await f.runtime.captureContext();
  const messageEntryId = appendCalls(f.manager, [call("first"), call("query", {}, "query"), call("second", plan("other"))]);
  const before = readFileSync(f.manager.getSessionFile(), "utf8");
  const first = await f.runtime.executePlan("first", plan());
  assert.match(first.content[0].text, /Candidate UI awaiting host publication/);
  assert.doesNotMatch(first.details.answerOutput.snapshot, /awaiting host publication/);
  assert.equal(readFileSync(f.manager.getSessionFile(), "utf8"), before);
  assert.equal(f.read().records[0].status, "candidate");
  const firstEntry = appendResult(f.manager, "first", first);
  const queryEntry = appendResult(f.manager, "query", { content: [{ type: "text", text: "query result" }] }, "query");
  const second = await f.runtime.executePlan("second", plan("other"));
  const secondEntry = appendResult(f.manager, "second", second);
  const history = readFileSync(f.manager.getSessionFile(), "utf8");
  const boundary = { messageEntryId, toolResultEntryIds: [firstEntry, queryEntry, secondEntry], outcome: "completed" };
  const result = await f.runtime.onTurnEnd(boundary);
  assert.deepEqual(result.committed.map(item => item.toolCallId), ["first", "second"]);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(await f.runtime.onTurnEnd(boundary), result);
  assert.equal(readFileSync(f.manager.getSessionFile(), "utf8"), history);
  assert.deepEqual(f.read().records.map(item => item.status), ["committed", "committed"]);
});

test("automatic titles between captured context and assistant preserve generation binding", async t => {
  const f = fixture(t); await f.runtime.captureContext();
  const capturedLeaf = f.manager.getLeafId();
  const titles = [f.manager.appendSessionInfo("Ticket calculator"), f.manager.appendSessionInfo("Shared ticket costs")];
  const messageEntryId = appendCalls(f.manager, [call("ui")]);
  const output = await f.runtime.executePlan("ui", plan());
  assert.equal(output.isError, undefined);
  const entryId = appendResult(f.manager, "ui", output);
  const result = await f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId] });
  assert.equal(result.committed.length, 1);
  assert.equal(f.read().records[0].source.leafId, capturedLeaf, "the request context must stay frozen");
  assert.deepEqual(f.read().records[0].contextTitles.map(receipt => receipt.entryId), titles);
  assert.deepEqual((await f.reader().readActive("bill")).state, { people: 4 });
});

test("same-turn candidates for one surface cannot publish the same next revision twice", async t => {
  const f = fixture(t); await f.runtime.captureContext();
  const messageEntryId = appendCalls(f.manager, [call("a"), call("b")]);
  const a = await f.runtime.executePlan("a", plan()), aEntry = appendResult(f.manager, "a", a);
  const b = await f.runtime.executePlan("b", plan()), bEntry = appendResult(f.manager, "b", b);
  const result = await f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [aEntry, bEntry] });
  assert.deepEqual(result.committed.map(item => item.toolCallId), ["a"]);
  assert.deepEqual(result.rejected.map(item => item.code), ["CONFLICT"]);
  assert.equal(f.read().active.length, 1);
  assert.deepEqual(f.read().records.map(item => item.status), ["committed", "aborted"]);
});

test("action facts use registered capabilities and observed permissions without becoming execution receipts", async t => {
  const f = fixture(t), value = { ...plan(), planVersion: 2,
    layout: [{ id: "group", type: "group", title: "Split", columns: 1, nodeIds: ["people", "amount"] }],
    actions: { version: 1, actions: [
      { id: "save", label: "Save", path: "trip.md", kind: "save_snapshot", format: "markdown" },
      { id: "read", label: "Read", path: "values.json", kind: "read_json_parameters" },
    ] } };
  await f.runtime.captureContext(2);
  const messageEntryId=appendCalls(f.manager,[call("actions",value)]);
  const output=await f.runtime.executePlan("actions",value,undefined,2);
  assert.equal(output.isError,undefined);
  assert.match(output.content[0].text,/"permissionModeObserved":"full"/);
  assert.match(output.content[0].text,/"overwriteSupported":false/);
  assert.match(output.content[0].text,/"representation":"indented-plain-text-snapshot"/);
  assert.match(output.content[0].text,/"execution":"not-started-by-generation"/);
  assert.match(output.content[0].text,/"changesCurrentValues":"only-after-explicit-adoption"/);
  const resultId=appendResult(f.manager,"actions",output);
  assert.equal((await f.runtime.onTurnEnd({messageEntryId,toolResultEntryIds:[resultId]})).committed.length,1);
  writeToolPermission(f.manager.getSessionId(),"review",f.root);
  const context=await f.runtime.captureContext(2),payload=JSON.parse(context.content.slice(context.content.indexOf("\n")+1));
  assert.equal(payload.actionPermissionModeObserved,"review");
  assert.equal(payload.surfaces[0].summary.actions[0].values,"acknowledged-parameters-at-click");
  assert.equal(payload.surfaces[0].summary.actions[0].overwriteSupported,false);
  assert.equal(payload.surfaces[0].summary.actions[1].changesCurrentValues,"only-after-explicit-adoption");
  assert.equal(f.read().actionOperations?.length??0,0);
  writeFileSync(join(f.root,"piora","tool-permissions",`${f.manager.getSessionId()}.json`),"invalid-json");
  const unavailable=await f.runtime.captureContext(2);
  assert.match(unavailable.content,/"actionPermissionModeObserved":"unknown"/);
  assert.doesNotMatch(unavailable.content,/"actionPermissionModeObserved":"full"/);
});

test("saved semantic hints stay bounded and mark omitted control descriptions explicitly", async t => {
  const f = fixture(t);
  const options = Array.from({ length: 40 }, (_, i) => `${i}-` + "选项".repeat(48));
  const value = { planVersion: 1, id: "choices", title: "选项配置", inputs: Array.from({ length: 8 }, (_, i) => ({
    id: `choice${i}`, label: `选择${i}`, valueType: "string", options, value: options[0],
  })), derived: [], views: [{ id: "result", kind: "metric", label: "当前选择", value: { input: "choice0" } }] };
  await publish(f, "choices", value);
  const context = await f.runtime.captureContext();
  assert.ok(context.content.length <= 12_000);
  const payload = JSON.parse(context.content.slice(context.content.indexOf("\n") + 1));
  const summary = payload.surfaces[0].summary;
  assert.equal(summary.title, "选项配置");
  assert.ok(summary.omittedControls > 0);
  assert.equal(summary.controls.length + summary.omittedControls, 8);
  assert.equal(summary.snapshotTruncated, true);
  assert.equal(Object.keys(payload.surfaces[0].controls).length, 8, "omitted descriptions do not invent or discard acknowledged values");
});

test("model hints and source stamps use the same immutable saved-control snapshot", async t => {
  const f = fixture(t), published = await publish(f);
  const old = published.result.committed[0];
  await f.reader().saveParameters(old.operationId, old.stateRevision, { people: 7 });
  const context = await f.runtime.captureContext();
  assert.deepEqual(context.savedControls[0].controls, { people: 7 });
  assert.match(context.content, /"people":7/);
  assert.match(context.content, /"title":"分账"/);
  assert.match(context.content, /"label":"人数"/);
  assert.match(context.content, /总价.*84/);
  assert.doesNotMatch(context.content, /requestId|contextId|epoch|operationId/);
  context.savedControls[0].controls.people = 999;
  f.manager.appendSessionInfo("Title metadata must not refresh captured parameters");
  appendCalls(f.manager, [call("next")]);
  const active = await f.reader().readActive("bill");
  await f.reader().saveParameters(active.operationId, active.stateRevision, { people: 8 });
  const rejected = await f.runtime.executePlan("next", plan());
  assert.equal(rejected.details.intelligentUiDiagnostic.code, "CONFLICT");
  assert.equal(rejected.details.intelligentUiDiagnostic.repairable, false);
  assert.equal(f.read().records.length, 1);
  assert.deepEqual((await f.reader().readActive("bill")).state, { people: 8 });
});

test("the host selects the next revision and migrated controls retain acknowledged values", async t => {
  const f = fixture(t), first = await publish(f);
  await f.reader().saveParameters(first.result.committed[0].operationId, first.result.committed[0].stateRevision, { people: 6 });
  const second = await publish(f, "second");
  assert.equal(second.output.details.answerOutput.payload.revision, 2);
  assert.deepEqual(second.result.committed[0].state, { people: 6 });
});

test("migration awaits explicit confirmation after normal completion and preserves old controls in model context", async t => {
  const f = fixture(t); await publish(f);
  await f.runtime.captureContext();
  f.manager.appendSessionInfo("Automatic title arriving during unit change");
  const changed = plan(); changed.inputs[0].min = 2;
  const messageEntryId = appendCalls(f.manager, [call("migration", changed)]);
  const output = await f.runtime.executePlan("migration", changed);
  assert.equal(output.isError, undefined);
  const entryId = appendResult(f.manager, "migration", output);
  const result = await f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId] });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.awaitingConfirmation.length, 1);
  assert.equal((await f.reader().readOutput("migration")).publication.status, "awaiting_confirmation");
  assert.equal((await f.reader().readMigration("migration")).status, "provisional");
  const context = await f.runtime.captureContext();
  assert.deepEqual(context.publications.at(-1), { toolCallId: "migration", status: "awaiting_confirmation", code: "MIGRATION_REQUIRED" });
  assert.deepEqual(context.savedControls[0].controls, { people: 4 });
  assert.match(context.content, /MIGRATION_REQUIRED/);
  assert.doesNotMatch(context.content, /operationId|epoch|requestId/);
  await f.runtime.finish("idle");
  assert.equal((await f.reader().readMigration("migration")).status, "ready");
});

test("invalid plans expose bounded repair diagnostics and model-supplied credentials have no authority", async t => {
  const f = fixture(t); await f.runtime.captureContext();
  const broken = plan(); broken.derived[0].args[0] = { input: "missing" };
  appendCalls(f.manager, [call("bad", broken), call("forged", { ...plan(), requestId: "fake" })]);
  const bad = await f.runtime.executePlan("bad", broken);
  assert.equal(bad.isError, true);
  assert.match(bad.details.intelligentUiDiagnostic.code, /^PLAN_/);
  assert.equal(bad.details.intelligentUiDiagnostic.repairable, true);
  assert.equal(typeof bad.details.intelligentUiDiagnostic.path, "string");
  const forged = await f.runtime.executePlan("forged", { ...plan(), requestId: "fake" });
  assert.equal(forged.isError, true); assert.equal(f.read().records.length, 0);
});

test("cancellation immediately revokes old closures and delayed results never publish in a new run", async t => {
  const f = fixture(t); await f.runtime.captureContext();
  const messageEntryId = appendCalls(f.manager, [call("late")]);
  const output = await f.runtime.executePlan("late", plan());
  const cancelled = f.runtime.cancel();
  assert.equal(getUiGenerationRuntime(f.manager), undefined);
  const denied = await f.runtime.executePlan("late", plan());
  assert.equal(denied.details.intelligentUiDiagnostic.code, "UI_RUN_UNAVAILABLE");
  await cancelled;
  const entryId = appendResult(f.manager, "late", output);
  const next = f.bind("run-2"); await next.captureContext();
  await assert.rejects(f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId] }), error => error.code === "CANCELLED");
  assert.deepEqual(f.read().records.map(item => item.status), ["aborted"]);
  assert.equal(f.read().active.length, 0);
  assert.equal(getUiGenerationRuntime(f.manager), next);
});

test("missing receipts, branch navigation, abort outcomes and tool cancellation cannot publish candidates", async t => {
  for (const scenario of ["receipt", "branch", "outcome", "signal"]) {
    await t.test(scenario, async t => {
      const f = fixture(t), controller = new AbortController(); await f.runtime.captureContext();
      const source = f.manager.getLeafId(), messageEntryId = appendCalls(f.manager, [call("ui")]);
      const output = await f.runtime.executePlan("ui", plan(), controller.signal);
      const entryId = appendResult(f.manager, "ui", output);
      if (scenario === "branch") f.manager.branch(source);
      if (scenario === "signal") controller.abort();
      const result = await f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: scenario === "receipt" ? [] : [entryId], outcome: scenario === "outcome" ? "aborted" : "completed" });
      assert.equal(result.committed.length, 0); assert.equal(result.rejected.length, 1);
      assert.equal(f.read().active.length, 0);
    });
  }
});

test("ownership and authoritative run checks are repeated before publication", async t => {
  for (const scenario of ["ownership", "run"]) {
    await t.test(scenario, async t => {
      const f = fixture(t); await f.runtime.captureContext();
      const messageEntryId = appendCalls(f.manager, [call("ui")]);
      const output = await f.runtime.executePlan("ui", plan()), entryId = appendResult(f.manager, "ui", output);
      if (scenario === "ownership") f.setWritable(false); else f.setActive("different");
      await assert.rejects(f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId] }));
      assert.equal(f.read().active.length, 0);
    });
  }
});

test("cancellation while publication awaits the UI mutex revokes the pending write before it acquires the lock", async t => {
  const f = fixture(t); await f.runtime.captureContext();
  const messageEntryId = appendCalls(f.manager, [call("ui")]);
  const output = await f.runtime.executePlan("ui", plan()), entryId = appendResult(f.manager, "ui", output);
  const mutex = acquireExclusiveFileLease(uiSessionLockPath(f.manager.getSessionId(), f.root));
  let pending, cancellation;
  try {
    pending = f.runtime.onTurnEnd({ messageEntryId, toolResultEntryIds: [entryId] });
    await new Promise(resolve => setImmediate(resolve));
    cancellation = f.runtime.cancel();
    assert.equal(getUiGenerationRuntime(f.manager), undefined);
  } finally { mutex.release(); }
  const result = await pending;
  await cancellation;
  assert.equal(result.committed.length, 0);
  assert.deepEqual(result.rejected.map(item => item.code), ["UI_RUN_UNAVAILABLE"]);
  assert.equal(f.read().active.length, 0);
  assert.deepEqual(f.read().records.map(item => item.status), ["aborted"]);
});

test("independent Jiti instances find only the binding for the exact host manager", async t => {
  const f = fixture(t);
  const other = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import("./generation-runtime.ts");
  assert.equal(other.getUiGenerationRuntime(f.manager), f.runtime);
  assert.equal(other.getUiGenerationRuntime({ getSessionId: () => f.manager.getSessionId() }), undefined);
  await f.runtime.cancel(); assert.equal(other.getUiGenerationRuntime(f.manager), undefined);
});

test("real SDK context and awaited turn_end hooks publish multiple candidates after message persistence", { timeout: 45_000 }, async t => {
  const f = fixture(t), agentDir = join(f.root, "agent"); mkdirSync(agentDir);
  let index = 0, session;
  const events = [], boundaries = [], observed = [], providerContexts = [];
  const services = await createAgentSessionServices({ cwd: f.root, agentDir,
    settingsManager: SettingsManager.create(f.root, agentDir, { projectTrusted: true }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [api => {
        api.registerTool({ name: "piora_render_ui_plan", label: "UI", description: "UI fixture", parameters: uiPlanSchema,
          executionMode: "sequential", async execute(id, value, signal, _update, ctx) {
            const runtime = getUiGenerationRuntime(ctx.sessionManager);
            assert.equal(runtime, f.runtime);
            return runtime.executePlan(id, value, signal);
          } });
        api.registerTool({ name: "query", label: "Query", description: "Query fixture", parameters: Type.Object({}),
          async execute() { return { content: [{ type: "text", text: "found" }] }; } });
        api.on("context", async (event, ctx) => {
          const snapshot = await getUiGenerationRuntime(ctx.sessionManager).captureContext();
          observed.push(snapshot);
          if (snapshot.content) return { messages: [...event.messages, { role: "custom", customType: "piora-ui-state", content: snapshot.content, display: false, timestamp: Date.now() }] };
        });
        api.on("turn_end", async (event, ctx) => {
          const results = await getUiGenerationRuntime(ctx.sessionManager).onTurnEnd(event);
          boundaries.push({ event, results });
        });
        api.registerProvider("generation-runtime-fixture", { api: "generation-runtime-api", apiKey: "test", baseUrl: "https://unused.invalid",
          models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context) {
            providerContexts.push(JSON.stringify(context.messages));
            const content = index++ === 0 ? [call("first"), call("query", {}, "query"), call("second", plan("other")), call("conflicting")] : [{ type: "text", text: "done" }];
            const reason = content[0].type === "toolCall" ? "toolUse" : "stop";
            const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: reason };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason, message }); });
            return stream;
          },
        });
      }],
    },
  });
  try {
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: f.manager,
      model: services.modelRuntime.getModel("generation-runtime-fixture", "test"), tools: ["piora_render_ui_plan", "query"] }));
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    await session.bindExtensions({ mode: "rpc" });
    session.subscribe(event => {
      events.push(event.type);
      if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolName === "piora_render_ui_plan") {
        const rows = readFileSync(f.manager.getSessionFile(), "utf8").trimEnd().split("\n").map(JSON.parse);
        assert.equal(rows.some(entry => entry.message?.role === "toolResult" && entry.message.toolCallId === event.message.toolCallId), false,
          "public message_end must not be mistaken for a disk receipt");
      }
    });
    await session.prompt("Generate two independent calculators");
    assert.equal(boundaries[0].results.committed.length, 2);
    assert.equal(boundaries[0].event.toolResultEntryIds.length, 4);
    assert.deepEqual(boundaries[0].results.rejected.map(item => item.code), ["CONFLICT"]);
    assert.deepEqual(f.read().records.map(item => item.status), ["committed", "committed", "aborted"]);
    assert.equal(observed[1].savedControls.length, 2, "the next provider request sees acknowledged controls from the committed turn");
    assert.deepEqual(observed[1].publications, [{ toolCallId: "first", status: "committed" }, { toolCallId: "second", status: "committed" }, { toolCallId: "conflicting", status: "rejected", code: "CONFLICT" }]);
    assert.match(observed[1].content, /"status":"rejected","code":"CONFLICT"/);
    assert.match(providerContexts[1], /CONFLICT/);
    assert.match(providerContexts[1], /rejected publication failed/);
    assert.ok(events.includes("turn_end"));
  } finally { await f.runtime.cancel(); await session?.abort(); session?.dispose(); }
});
