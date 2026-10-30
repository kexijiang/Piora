import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { Type } from "@earendil-works/pi-ai";
import { patchAdmissionLoopSource, patchAdmissionAgentSource, patchAdmissionSessionSource, patchIntelligentUiAdmission, verifyIntelligentUiAdmission } from "../scripts/patch-intelligent-ui-admission.mjs";

const jiti = createJiti(import.meta.url);
const { UiAdmissionBudget } = await jiti.import("./intelligent-ui/admission.ts");
const names = ["piora_render_ui", "piora_render_ui_plan"];
const call = (id, args = { count: 2 }, name = names[0]) => ({ id, name, arguments: args });
const ok = value => ({ isError: false, result: { content: [{ type: "text", text: String(value) }], details: { value } } });
const invalid = { isError: true, result: { content: [{ type: "text", text: "secret user arguments" }] } };
const code = outcome => outcome.result.details.intelligentUiDiagnostic.code;
function budget(t, options = {}) {
  const result = new UiAdmissionBudget({ sessionId: "session", runId: "run-1", toolNames: names, isActive: () => true, ...options });
  t.after(() => result.cancel());
  return result;
}
const admit = (b, c, signal) => b.admit({ toolCall: c }, signal);
const settle = (lease, outcome = ok(4), phase = "execution") => lease.settle(outcome, phase);

test("one run shares the total budget across surfaces, aliases and successful updates", async t => {
  const b = budget(t);
  for (let n = 0; n < 3; n++) settle(await admit(b, call(`c${n}`, { count: n }, names[n % 2])));
  assert.equal(code((await admit(b, call("fourth"))).immediate), "UI_ATTEMPTS_EXHAUSTED");
  assert.equal(b.snapshot().attempts, 3);
});

test("invalid schema consumes an attempt and exactly one objective correction", async t => {
  const b = budget(t);
  const first = settle(await admit(b, call("bad-1")), invalid, "validation");
  assert.equal(code(first), "UI_ARGUMENTS_INVALID");
  assert.doesNotMatch(JSON.stringify(first), /secret/);
  settle(await admit(b, call("bad-2", { anotherSurface: true }, names[1])), invalid, "validation");
  assert.deepEqual([b.snapshot().attempts, b.snapshot().corrections], [2, 1]);
  assert.equal(code((await admit(b, call("renamed"))).immediate), "UI_CORRECTIONS_EXHAUSTED");
});

test("a corrected answer can be followed by one more successful operation", async t => {
  const b = budget(t);
  settle(await admit(b, call("bad")), invalid, "validation");
  settle(await admit(b, call("fixed")));
  settle(await admit(b, call("second-ui")));
  assert.equal(b.snapshot().corrections, 1);
  assert.equal(b.snapshot().attempts, 3);
});

test("replays return independent cached results without executing or spending a correction", async t => {
  const b = budget(t);
  settle(await admit(b, call("a", { a: 1, b: 2 })), ok(17));
  const replay = await admit(b, call("a", { b: 2, a: 1 }));
  replay.immediate.result.details.value = 99;
  assert.equal((await admit(b, call("a", { a: 1, b: 2 }))).immediate.result.details.value, 17);
  assert.equal(b.snapshot().attempts, 1);
  assert.equal(code((await admit(b, call("a", { a: 1, b: 3 }))).immediate), "UI_CALL_ID_CONFLICT");
});

test("in-flight replay joins the same operation; a different overlapping call cannot race correction accounting", async t => {
  const b = budget(t);
  const lease = await admit(b, call("a"));
  const duplicate = admit(b, call("a"));
  assert.equal(code((await admit(b, call("b"))).immediate), "UI_CALL_IN_PROGRESS");
  settle(lease, ok(42));
  assert.equal((await duplicate).immediate.result.details.value, 42);
  assert.equal(b.snapshot().attempts, 1);
});

test("cached validation failures are replayable even after correction exhaustion", async t => {
  const b = budget(t);
  settle(await admit(b, call("a")), invalid, "validation");
  const failed = settle(await admit(b, call("b")), invalid, "validation");
  assert.deepEqual((await admit(b, call("b"))).immediate, failed);
  assert.equal(b.snapshot().attempts, 2);
});

test("deadline starts at first UI attempt; fallback does not renew it", async t => {
  let now = 500_000;
  const b = budget(t, { now: () => now });
  assert.equal(b.snapshot().deadline, undefined);
  now += 10_000;
  settle(await admit(b, call("a")));
  const deadline = b.snapshot().deadline;
  now += 59_999;
  settle(await admit(b, call("fallback-call")));
  assert.equal(b.snapshot().deadline, deadline);
  now += 1;
  assert.equal(code((await admit(b, call("late"))).immediate), "UI_DEADLINE_EXCEEDED");
});

test("cancellation revokes old and pending calls; a new explicit run receives its own budget", async t => {
  const b = budget(t);
  const lease = await admit(b, call("a"));
  const duplicate = admit(b, call("a"));
  b.cancel();
  assert.equal(lease.signal.aborted, true);
  assert.equal(code((await duplicate).immediate), "UI_CANCELLED");
  assert.equal(code(settle(lease, ok("late payload"))), "UI_CANCELLED");
  assert.equal(code((await admit(b, call("new"))).immediate), "UI_CANCELLED");
  const next = budget(t, { runId: "run-2" });
  assert.ok((await admit(next, call("a"))).settle);
});

test("authoritative run identity and original signal are checked at admission and completion", async t => {
  let active = true;
  const b = budget(t, { isActive: () => active });
  const lease = await admit(b, call("a"));
  active = false;
  assert.equal(code(settle(lease)), "UI_CANCELLED");
  const controller = new AbortController(); controller.abort();
  assert.equal(code((await admit(budget(t), call("a"), controller.signal)).immediate), "UI_CANCELLED");
});

test("repeated denial requests runtime termination and carries SDK terminate flag", async t => {
  let stops = 0;
  const b = budget(t, { onRepeatedDenial: () => { stops++; } });
  for (let i = 0; i < 3; i++) settle(await admit(b, call(String(i))));
  assert.equal((await admit(b, call("4"))).immediate.result.terminate, undefined);
  assert.equal((await admit(b, call("5"))).immediate.result.terminate, true);
  await admit(b, call("6"));
  assert.equal(stops, 1);
});

test("unsupported and oversized nested argument objects cannot bypass admission", async t => {
  for (const args of [{ value: "x".repeat(256_001) }, { count: NaN }, (() => { const a = {}; a.self = a; return a; })()]) {
    const b = budget(t);
    assert.equal(code((await admit(b, call("bad", args))).immediate), "UI_INPUT_INVALID_OR_TOO_LARGE");
    assert.equal(b.snapshot().attempts, 1);
  }
});

test("unrelated tools do not consume UI budget", async t => {
  const b = budget(t);
  assert.equal(await admit(b, call("read", {}, "read")), undefined);
  assert.equal(b.snapshot().attempts, 0);
});

const root = fileURLToPath(new URL("../", import.meta.url));
const corePath = join(root, "node_modules/@earendil-works/pi-agent-core/dist");
const sessionPath = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
const loopSource = readFileSync(join(corePath, "agent-loop.js"), "utf8");
const agentSource = readFileSync(join(corePath, "agent.js"), "utf8");
const sessionSource = readFileSync(sessionPath, "utf8");
function absoluteImports(source, originalPath, overrides = {}) {
  return source.replace(/(from\s+|import\s*\()(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
    if (specifier.startsWith("node:")) return match;
    const resolved = overrides[specifier] ?? (specifier.startsWith(".") ? pathToFileURL(join(dirname(originalPath), specifier)).href : import.meta.resolve(specifier));
    return `${prefix}${quote}${resolved}${quote}`;
  });
}
async function sdk(t) {
  const folder = mkdtempSync(join(tmpdir(), "piora-ui-admission-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const loopUrl = pathToFileURL(join(folder, "loop.mjs")).href;
  const sessionUrl = pathToFileURL(join(folder, "session.mjs")).href;
  const agentUrl = pathToFileURL(join(folder, "agent.mjs")).href;
  writeFileSync(join(folder, "loop.mjs"), absoluteImports(patchAdmissionLoopSource(loopSource), join(corePath, "agent-loop.js")));
  writeFileSync(join(folder, "agent.mjs"), absoluteImports(patchAdmissionAgentSource(agentSource), join(corePath, "agent.js"), { "./agent-loop.js": loopUrl }));
  writeFileSync(join(folder, "session.mjs"), absoluteImports(patchAdmissionSessionSource(sessionSource), sessionPath, { "@earendil-works/pi-agent-core": loopUrl }));
  return { ...(await import(loopUrl)), ...(await import(sessionUrl)), ...(await import(agentUrl)) };
}
function fixture(b) {
  let executions = 0;
  let permissions = 0;
  const tools = names.map(name => ({ name, description: "Fixture", parameters: Type.Object({ count: Type.Number() }, { additionalProperties: false }), executionMode: "sequential", execute: async (_id, args) => { executions++; return ok(args.count * 2).result; } }));
  const message = { role: "assistant", content: [{ type: "toolCall", ...call("parent", {}, "wrapper") }] };
  return { tools, message, executions: () => executions, permissions: () => permissions, options: { tools, context: { messages: [message], tools }, assistantMessage: message, admitToolCall: b.admit, beforeToolCall: () => { permissions++; } } };
}

test("SDK patch validates reviewed source fingerprints and is idempotent", () => {
  for (const [source, patch] of [[loopSource, patchAdmissionLoopSource], [agentSource, patchAdmissionAgentSource], [sessionSource, patchAdmissionSessionSource]]) {
    const patched = patch(source);
    assert.equal(patch(patched), patched);
    assert.throws(() => patch(`${source}\n// outside the patched function`), /commitment/);
    assert.throws(() => patch(`${patched}\n// outside the patched function`), /commitment/);
    assert.throws(() => patch(patched.replaceAll("\n", "\r\n")), /commitment/);
  }
  assert.throws(() => patchAdmissionLoopSource(loopSource.replace("const validatedArgs = validateToolArguments", "const validatedArgs = modifiedValidation")), /commitment/);
  assert.throws(() => patchAdmissionLoopSource(patchAdmissionLoopSource(loopSource).replace("const validatedArgs = validateToolArguments", "const validatedArgs = modifiedValidation")), /commitment/);
});

test("installer patches all reviewed SDK paths idempotently and rejects unsupported versions before writes", async t => {
  const folder = mkdtempSync(join(tmpdir(), "piora-ui-admission-install-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const core = join(folder, "node_modules/@earendil-works/pi-agent-core");
  const coding = join(folder, "node_modules/@earendil-works/pi-coding-agent");
  mkdirSync(join(core, "dist"), { recursive: true }); mkdirSync(join(coding, "dist/core/extensions"), { recursive: true });
  writeFileSync(join(core, "package.json"), readFileSync(join(corePath, "../package.json")));
  writeFileSync(join(coding, "package.json"), readFileSync(join(dirname(sessionPath), "../../package.json")));
  writeFileSync(join(core, "dist/agent-loop.js"), loopSource);
  writeFileSync(join(core, "dist/agent.js"), agentSource);
  writeFileSync(join(coding, "dist/core/agent-session.js"), sessionSource);
  writeFileSync(join(coding, "dist/core/extensions/runner.js"), readFileSync(join(dirname(sessionPath), "extensions/runner.js")));
  writeFileSync(join(coding, "dist/core/nested-tool-calls.js"), readFileSync(join(dirname(sessionPath), "nested-tool-calls.js")));
  await patchIntelligentUiAdmission(folder);
  assert.deepEqual(await patchIntelligentUiAdmission(folder), { version: 2, updated: 0 });
  assert.deepEqual(await verifyIntelligentUiAdmission(folder), { version: 2, state: "patched" });
  const patched = readFileSync(join(core, "dist/agent-loop.js"), "utf8");
  writeFileSync(join(coding, "package.json"), JSON.stringify({ version: "1.4.1" }));
  await assert.rejects(patchIntelligentUiAdmission(folder), /manifest/);
  assert.equal(readFileSync(join(core, "dist/agent-loop.js"), "utf8"), patched);
});

test("real SDK runToolCall counts schema failures before permission and execution, across aliases", async t => {
  const runtime = await sdk(t);
  const b = budget(t); const f = fixture(b);
  const first = await runtime.runToolCall(call("bad", { count: "secret" }), f.options);
  const second = await runtime.runToolCall(call("bad-again", {}, names[1]), f.options);
  const rejected = await runtime.runToolCall(call("good", { count: 3 }), f.options);
  assert.equal(code(first), "UI_ARGUMENTS_INVALID");
  assert.equal(code(second), "UI_ARGUMENTS_INVALID");
  assert.equal(code(rejected), "UI_CORRECTIONS_EXHAUSTED");
  assert.equal(first.toolCall.arguments.count, "secret"); // The original call remains in SDK history.
  assert.doesNotMatch(JSON.stringify(first.result), /secret/); // Diagnostics do not duplicate user data.
  assert.equal(f.permissions(), 0); assert.equal(f.executions(), 0);
  assert.equal(b.snapshot().attempts, 2);
});

test("real SDK execution retains permission checks and returns cached results on replay", async t => {
  const runtime = await sdk(t); const b = budget(t); const f = fixture(b);
  const first = await runtime.runToolCall(call("a", { count: 4 }), f.options);
  const replay = await runtime.runToolCall(call("a", { count: 4 }), f.options);
  assert.equal(first.result.details.value, 8); assert.equal(replay.result.details.value, 8);
  assert.equal(f.permissions(), 1); assert.equal(f.executions(), 1);
  const denied = await runtime.runToolCall(call("b"), { ...f.options, beforeToolCall: () => ({ block: true, reason: "permission denied" }) });
  assert.equal(denied.isError, true); assert.equal(f.executions(), 1);
  assert.equal(b.snapshot().terminal, "UI_OPERATION_FAILED");
  assert.equal(b.snapshot().corrections, 0);
});

test("actual SDK AgentSession nested executor uses the same prevalidation budget as direct calls", async t => {
  const runtime = await sdk(t); const b = budget(t); const f = fixture(b);
  const session = Object.create(runtime.AgentSession.prototype);
  session.agent = { state: { messages: [f.message], tools: f.tools }, toolExecution: "sequential", admitToolCall: b.admit };
  session._getCallableTools = () => f.tools;
  session._findLastAssistantMessage = () => f.message;
  session._extensionRunner = { emit: async () => undefined };
  session._emit = () => undefined;
  session._beforeToolCall = f.options.beforeToolCall;
  session._afterToolCall = () => undefined;
  const direct = await runtime.runToolCall(call("direct-invalid", { count: "wrong" }), f.options);
  assert.equal(code(direct), "UI_ARGUMENTS_INVALID");
  const nested = await session._executeNestedToolCall("parent", names[1], {}, { pioraAdmission: b.admit });
  const blocked = await session._executeNestedToolCall("parent", names[0], { count: 5 }, { pioraAdmission: b.admit });
  assert.equal(nested.isError, true); assert.equal(blocked.isError, true);
  assert.equal(f.executions(), 0); assert.equal(f.permissions(), 0);
  assert.deepEqual([b.snapshot().attempts, b.snapshot().corrections], [2, 1]);
});

test("actual Agent model loop enforces prevalidation on malformed and truncated calls and stops repeated denial", async t => {
  for (const stopReason of ["toolUse", "length"]) {
    const runtime = await sdk(t); const b = budget(t); const f = fixture(b);
    let requests = 0;
    const agent = new runtime.Agent({
      initialState: { tools: f.tools },
      streamFn: async () => {
        requests++;
        assert.ok(requests <= 4, "budget must stop the model loop");
        const response = { ...f.message, content: [{ type: "toolCall", ...call(`generated-${requests}`, { count: "invalid" }) }], stopReason, timestamp: 0,
          usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        return { result: async () => response, async *[Symbol.asyncIterator]() { yield { type: "done", message: response }; } };
      },
    });
    assert.equal(agent.pioraToolAdmissionVersion, 2);
    agent.admitToolCall = b.admit;
    await agent.prompt("Generate a calculator");
    assert.equal(requests, 4);
    assert.equal(b.snapshot().attempts, 2);
    assert.equal(b.snapshot().corrections, 1);
    assert.equal(f.executions(), 0);
    const results = agent.state.messages.filter(m => m.role === "toolResult");
    assert.equal(results.length, 4);
    assert.equal(results.at(-1).isError, true);
  }
});
