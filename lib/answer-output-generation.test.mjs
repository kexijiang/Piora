import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { bindAnswerOutputGeneration, getAnswerOutputGeneration } = await jiti.import("./answer-output-generation.ts");
const { createOwnedSessionManager } = await jiti.import("./session-owned-manager.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { acquireExclusiveFileLease } = await jiti.import("./session-file-ownership.ts");
const { uiSessionLockPath } = await jiti.import("./intelligent-ui/session-lock.ts");
const { uiPlanSchema } = await jiti.import("./intelligent-ui/plan-schema.ts");
const { uiRichPlanSchema } = await jiti.import("./intelligent-ui/rich-plan-schema.ts");
const { intelligentUiDecisionPrompt } = await jiti.import("./intelligent-ui/decision-policy.ts");
const { loadedBetaFeatureSignature, betaFeatureSignature } = await jiti.import("./beta-feature-types.ts");
const { isAnswerOutputBlock } = await jiti.import("./answer-output.ts");
const { writeBetaFeatures } = await jiti.import("./beta-features.ts");
const register = (await jiti.import("../extensions/piora-intelligent-ui.ts")).default;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-generation-binding-"));
  const owned = createOwnedSessionManager(root, join(root, "sessions"), root), manager = owned.manager;
  manager.appendMessage({ role: "user", content: "First request", timestamp: Date.now() });
  owned.assertOwned(); persistLazySessionManager(manager);
  const bindings = [];
  const options = { manager, identity: { sessionId: manager.getSessionId(), runId: "run" }, root,
    loadedTools: [{ name: "piora_render_ui_plan" }], isActive: () => true, assertOwned: owned.assertOwned };
  t.after(async () => {
    await Promise.all(bindings.map(binding => binding.cancel().catch(() => {})));
    owned.release(); assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
  });
  return { root, manager, options, bind: overrides => { const binding = bindAnswerOutputGeneration({ ...options, ...overrides }); bindings.push(binding); return binding; } };
}

test("off and Surface bindings do not import the generation runtime or inspect a manager", async () => {
  const source = `import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
const { bindAnswerOutputGeneration } = await createJiti(import.meta.url).import(${JSON.stringify(new URL("./answer-output-generation.ts", import.meta.url).href)});
for (const loadedTools of [[], [{name:'piora_render_ui'}]]) {
  const binding = bindAnswerOutputGeneration({manager:{}, identity:{sessionId:'s',runId:'r'}, root:'.', loadedTools,
    isActive(){throw new Error('off active check')}, assertOwned(){throw new Error('off ownership check')}});
  await binding.ready; await binding.cancel();
}
console.log(JSON.stringify(Object.keys(createRequire(import.meta.url).cache).filter(path => /intelligent-ui[\\\\/]generation-runtime/.test(path))));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", source], { windowsHide: true });
  assert.deepEqual(JSON.parse(stdout.trim()), []);
});

test("ready registers the exact manager and cancel revokes synchronously before draining", async t => {
  const f = fixture(t), binding = f.bind();
  await binding.ready;
  const runtime = getAnswerOutputGeneration(f.manager); assert.ok(runtime);
  await runtime.captureContext();
  const stopped = binding.cancel();
  assert.equal(getAnswerOutputGeneration(f.manager), undefined);
  assert.equal(binding.cancel(), stopped);
  await stopped;
  assert.equal((await runtime.executePlan("old", {})).details.intelligentUiDiagnostic.code, "UI_RUN_UNAVAILABLE");
});

test("cancel before lazy import settles never registers a runtime", async t => {
  const f = fixture(t), binding = f.bind();
  const stopped = binding.cancel();
  await Promise.all([binding.ready, stopped]);
  assert.equal(getAnswerOutputGeneration(f.manager), undefined);
});

test("a failed ready preserves its startup error while cancel still settles", async t => {
  const f = fixture(t), binding = f.bind({ assertOwned() { throw new Error("ownership unavailable"); } });
  await assert.rejects(binding.ready, /ownership unavailable/);
  await binding.cancel();
  assert.equal(getAnswerOutputGeneration(f.manager), undefined);
});

test("cancel waits for the in-flight context operation after revoking it", async t => {
  const f = fixture(t), binding = f.bind(); await binding.ready;
  const runtime = getAnswerOutputGeneration(f.manager), lock = acquireExclusiveFileLease(uiSessionLockPath(f.manager.getSessionId(), f.root));
  let pending, stopping, drained = false;
  try {
    pending = assert.rejects(runtime.captureContext());
    await new Promise(resolve => setImmediate(resolve));
    stopping = binding.cancel().then(() => { drained = true; });
    assert.equal(getAnswerOutputGeneration(f.manager), undefined);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
  } finally { lock.release(); }
  await Promise.all([pending, stopping]);
  assert.equal(drained, true);
});

function registrationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-plan-extension-")), previousRoot = process.env.PI_CODING_AGENT_DIR, previousProtocol = process.env.PIORA_UI_INPUT_PROTOCOL;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousRoot;
    if (previousProtocol === undefined) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = previousProtocol;
    assert.equal(dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true });
  });
  return { root, register(protocol) {
    if (protocol === undefined) delete process.env.PIORA_UI_INPUT_PROTOCOL; else process.env.PIORA_UI_INPUT_PROTOCOL = protocol;
    const tools = [], handlers = {};
    register({ registerTool: tool => tools.push(tool), on: (name, callback) => { handlers[name] = callback; } });
    return { tools, handlers };
  } };
}

test("Beta off registers nothing and each enabled instance exposes exactly one authoring contract", t => {
  const f = registrationFixture(t);
  for (const protocol of [undefined, "surface", "plan-1", "plan-2"]) assert.deepEqual(f.register(protocol).tools, []);
  writeBetaFeatures({ intelligentUi: true }, f.root);
  const defaultTools = f.register().tools;
  assert.deepEqual(defaultTools.map(tool => tool.name), ["piora_render_ui_plan"]);
  assert.deepEqual(JSON.parse(JSON.stringify(defaultTools[0].parameters)), JSON.parse(JSON.stringify(uiRichPlanSchema)));
  assert.deepEqual(f.register("surface").tools.map(tool => tool.name), ["piora_render_ui"]);
  assert.deepEqual(f.register("unknown").tools.map(tool => tool.name), ["piora_render_ui"]);
  const plan = f.register("plan-1");
  assert.deepEqual(plan.tools.map(tool => tool.name), ["piora_render_ui_plan"]);
  assert.deepEqual(Object.keys(plan.handlers).sort(), ["context", "turn_end"]);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.tools[0].parameters)), JSON.parse(JSON.stringify(uiPlanSchema)));
  for (const rule of intelligentUiDecisionPrompt().promptGuidelines) assert.ok(plan.tools[0].promptGuidelines.includes(rule));
  assert.match(plan.tools[0].promptSnippet, /piora_render_ui_plan/);
  const rich = f.register("plan-2");
  assert.deepEqual(rich.tools.map(tool => tool.name), ["piora_render_ui_plan"]);
  assert.deepEqual(JSON.parse(JSON.stringify(rich.tools[0].parameters)), JSON.parse(JSON.stringify(uiRichPlanSchema)));
  assert.deepEqual(Object.keys(rich.handlers).sort(), ["context", "turn_end"]);
  assert.match(rich.tools[0].promptGuidelines.join("\n"), /planVersion:2/);
  f.register(); assert.equal(plan.tools[0].name, "piora_render_ui_plan", "later environment changes cannot mutate a loaded instance");
});

test("a loaded rich extension fixes the host compiler version independently of model arguments and later settings", async t => {
  const f = registrationFixture(t); writeBetaFeatures({ intelligentUi: true }, f.root);
  const { tools } = f.register("plan-2"), manager = {}, calls = [];
  globalThis.__pioraUiGenerationRuntimes ??= new WeakMap();
  globalThis.__pioraUiGenerationRuntimes.set(manager, { isAvailable: () => true, executePlan(...args) {
    calls.push(args); return { content: [] };
  } });
  t.after(() => globalThis.__pioraUiGenerationRuntimes.delete(manager));
  f.register("plan-1");
  await tools[0].execute("call", { planVersion: 1 }, undefined, undefined, { sessionManager: manager });
  assert.equal(calls[0][3], 2, "the model cannot downgrade the compiler by changing its planVersion");
});

test("plan handlers capture their originating runtime before awaiting and pass only exact boundary evidence", async t => {
  const f = registrationFixture(t); writeBetaFeatures({ intelligentUi: true }, f.root);
  const { tools, handlers } = f.register("plan-1"), manager = {}, gate = deferred(), contextGate = deferred(), turnGate = deferred();
  const observed = [], calls = [], result = { content: [{ type: "text", text: "candidate" }], details: { answerOutput: { version: 2 } } };
  const first = { isAvailable: () => true,
    executePlan(id, value) { calls.push({ id, value }); return gate.promise; },
    captureContext() { return contextGate.promise; },
    onTurnEnd(receipt) { observed.push(receipt); return turnGate.promise; },
  };
  const replacement = { isAvailable: () => true, executePlan() { assert.fail("borrowed a new run"); }, captureContext() { assert.fail("borrowed context"); } };
  globalThis.__pioraUiGenerationRuntimes ??= new WeakMap();
  t.after(() => globalThis.__pioraUiGenerationRuntimes.delete(manager));
  globalThis.__pioraUiGenerationRuntimes.set(manager, first);
  const updates = [], execution = tools[0].execute("tool-call", { planVersion: 1 }, undefined, value => updates.push(value), { sessionManager: manager });
  const context = handlers.context({ messages: [] }, { sessionManager: manager });
  let ended = false;
  const ending = handlers.turn_end({ messageEntryId: "assistant-entry", toolResultEntryIds: ["result-entry"], outcome: "completed", message: { secret: "ignored" }, toolResults: ["ignored"] }, { sessionManager: manager }).then(() => { ended = true; });
  globalThis.__pioraUiGenerationRuntimes.set(manager, replacement);
  gate.resolve(result); contextGate.resolve({ content: "old acknowledged controls" });
  assert.equal(await execution, result); assert.deepEqual(updates, [result]);
  assert.deepEqual(calls, [{ id: "tool-call", value: { planVersion: 1 } }]);
  assert.equal((await context).messages[0].content, "old acknowledged controls");
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ended, false);
  assert.deepEqual(observed, [{ messageEntryId: "assistant-entry", toolResultEntryIds: ["result-entry"], outcome: "completed" }]);
  turnGate.resolve({ committed: [], rejected: [] }); await ending;
});

test("missing runtime and corrupted context fail closed without reusing stale saved values", async t => {
  const f = registrationFixture(t); writeBetaFeatures({ intelligentUi: true }, f.root);
  const { tools, handlers } = f.register("plan-1"), manager = {};
  const result = await tools[0].execute("old", {}, undefined, undefined, { sessionManager: manager });
  assert.deepEqual(result.details.intelligentUiDiagnostic, { code: "UI_RUN_UNAVAILABLE", repairable: false });
  const context = await handlers.context({ messages: [{ role: "custom", customType: "piora-ui-state", content: "stale values" }] }, { sessionManager: manager });
  assert.equal(context.messages.length, 1); assert.doesNotMatch(context.messages[0].content, /stale values/);
  assert.match(context.messages[0].content, /unavailable/);
  globalThis.__pioraUiGenerationRuntimes ??= new WeakMap();
  globalThis.__pioraUiGenerationRuntimes.set(manager, { isAvailable: () => true, captureContext() { throw new Error("private broken journal bytes"); } });
  try {
    const corrupted = await handlers.context({ messages: [] }, { sessionManager: manager });
    assert.match(corrupted.messages[0].content, /unavailable/);
    assert.doesNotMatch(corrupted.messages[0].content, /private broken journal bytes/);
  } finally { globalThis.__pioraUiGenerationRuntimes.delete(manager); }
});

test("both tool names are recognized as answers and as one enabled beta capability", () => {
  for (const name of ["piora_render_ui", "piora_render_ui_plan"]) {
    assert.equal(isAnswerOutputBlock({ type: "toolCall", toolName: name }), true);
    assert.equal(loadedBetaFeatureSignature([{ name }]), betaFeatureSignature({ intelligentUi: true }));
  }
  assert.equal(loadedBetaFeatureSignature([{ name: "piora_render_ui_plan_extra" }]), betaFeatureSignature({ intelligentUi: false }));
  assert.equal(isAnswerOutputBlock({ type: "toolCall", toolName: "piora_render_ui_plan_extra" }), false);
});
