import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { bindSessionAgentRuntimeProfile } = await jiti.import("./agent-profile-store.ts");
const { resolveProject } = await jiti.import("./worktree.ts");
const { getWorkflowRuntime } = await jiti.import("./workflow-runtime.ts");
const { createWorkflowExtension } = await jiti.import("../extensions/piora-workflows.ts");
const { writeLaboratorySettings } = await jiti.import("./laboratory-settings.ts");
const { POST: workflowPost } = await jiti.import("../app/api/agent/[id]/workflow/route.ts");

async function fixture(t, options = {}) {
  let invoked = 0;
  const sdk = await createSdkTestFixture(t, { toolNames: null, ...options, extension: api => {
    api.registerCommand("plan", { handler: async () => { invoked++; } });
    createWorkflowExtension()(api);
    options.extension?.(api);
  } });
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = sdk.agentDir;
  writeLaboratorySettings({ planGoalEnabled: true });
  let wrapper;
  t.after(async () => {
    wrapper?.destroy(); await wrapper?.shutdownForFileMutation();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });
  const session = await sdk.create();
  wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  return { sdk, session, wrapper, runtime: getWorkflowRuntime(session.sessionId), invoked: () => invoked };
}
async function settled(wrapper) {
  const deadline = Date.now() + 5000;
  while (wrapper.isRunning()) {
    assert.ok(Date.now() < deadline, "wrapper settles");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("invalid prompt materials fail before creating or changing a workflow", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, sdk } = await fixture(t);
  await assert.rejects(wrapper.startTrackedPrompt({ commandId: "invalid-material", source: "ui", message: "Full goal", workflow: { mode: "goal", turnBudget: 2 }, materials: [{ id: "12345678-1234-4123-8123-123456789abc" }] }));
  assert.equal(runtime.getSnapshot().mode, "agent");
  assert.equal(runtime.getSnapshot().current, null);
  assert.equal(sdk.requests.length, 0);
});

test("synchronous prompt admission refusal does not activate a goal", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, sdk } = await fixture(t);
  const previous = globalThis.__pioraDesktopUpdateLease;
  try {
    globalThis.__pioraDesktopUpdateLease = { token: "workflow-admission-test", expiresAt: Date.now() + 60_000 };
    await assert.rejects(wrapper.startTrackedPrompt({ commandId: "refused-admission", source: "ui", message: "Full goal", workflow: { mode: "goal" } }), /installing an update/);
    assert.equal(runtime.getSnapshot().mode, "agent");
    assert.equal(runtime.getSnapshot().current, null);
    assert.equal(sdk.requests.length, 0);
  } finally { globalThis.__pioraDesktopUpdateLease = previous; }
  await wrapper.startTrackedPrompt({ commandId: "retried-admission", source: "ui", message: "Full goal", workflow: { mode: "goal", turnBudget: 1 } });
  await settled(wrapper);
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
});

test("legacy prompt and direct extension commands cannot bypass selected Plan mode", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, sdk, invoked } = await fixture(t);
  await wrapper.send({ type: "workflow_configure", workflow: { mode: "plan" }, expectedRevision: runtime.getSnapshot().revision });
  await assert.rejects(wrapper.send({ type: "prompt", message: "/plan", source: "ui" }), /Agent mode/);
  await assert.rejects(wrapper.executeChatCommand("direct-plan", "/plan"), /Agent mode/);
  assert.equal(invoked(), 0); assert.equal(sdk.requests.length, 0);
  // Literal slash-prefixed text is still a legitimate planning prompt.
  await wrapper.startTrackedPrompt({ commandId: "literal-plan", source: "ui", message: "/plan is the route to inspect", inputMode: "text" });
  await settled(wrapper);
  assert.equal(invoked(), 0);
  assert.equal(sdk.requests.length, 1);
  assert.equal(runtime.getSnapshot().current.status, "waiting");
});

test("manual shell requires Agent mode and honors an explicit Agent selection", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, session } = await fixture(t);
  await wrapper.send({ type: "workflow_configure", workflow: { mode: "plan" }, expectedRevision: runtime.getSnapshot().revision });
  const calls = [];
  const original = session.executeBash;
  session.executeBash = async command => { calls.push(command); return { output: "ok", exitCode: 0, cancelled: false, truncated: false }; };
  try {
    await assert.rejects(wrapper.send({ type: "bash", command: "echo do not execute" }), /Agent mode/);
    assert.deepEqual(calls, []);
    await wrapper.send({ type: "bash", command: "echo explicit", workflow: { mode: "agent" } });
    assert.deepEqual(calls, ["echo explicit"]);
    assert.equal(runtime.getSnapshot().mode, "agent");
  } finally { session.executeBash = original; }
});

test("terminal SDK provider failure records a failed goal instead of completed", { timeout: 20_000 }, async t => {
  const { wrapper, runtime } = await fixture(t, { step: () => { throw new Error("Controlled terminal provider failure"); } });
  await wrapper.startTrackedPrompt({ commandId: "failed-goal", source: "ui", message: "Full original goal", workflow: { mode: "goal" } });
  await settled(wrapper);
  assert.equal(runtime.getSnapshot().current.status, "failed");
  assert.match(runtime.getSnapshot().current.reason, /Controlled terminal/);
});

test("SDK retry can finish the same goal without a premature failed state or extra budget turn", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, session, sdk } = await fixture(t, { step: request => {
    if (request.index === 0) throw new Error("503 temporary unavailable");
    if (request.index === 1) return [{ type: "toolCall", id: "verified-after-retry", name: "piora_update_goal", arguments: {
      progress: "Recovered and verified", status: "completed",
      criteria: [{ id: "output", text: "Required output observed", status: "verified", evidence: "Controlled SDK retry observed the output" }],
    } }];
    return [{ type: "text", text: "Completed after retry" }];
  } });
  session.setAutoRetryEnabled(true);
  session.settingsManager.getRetrySettings = () => ({ enabled: true, maxRetries: 1, baseDelayMs: 1, maxAgentDelayMs: 1 });
  const statuses = [];
  const unsubscribe = runtime.subscribe(snapshot => statuses.push(snapshot.current?.status));
  t.after(unsubscribe);
  await wrapper.startTrackedPrompt({ commandId: "retry-goal", source: "ui", message: "Full original goal", workflow: { mode: "goal", turnBudget: 1 } });
  await settled(wrapper);
  assert.equal(sdk.requests.length, 3);
  assert.equal(statuses.includes("failed"), false);
  assert.equal(runtime.getSnapshot().current.status, "completed");
  assert.equal(runtime.getSnapshot().current.turnsUsed, 1);
  assert.equal(runtime.getSnapshot().current.objective, "Full original goal");
});

test("replacement start waits for the old real SDK extension shutdown before loading a session", { timeout: 20_000 }, async t => {
  let releaseShutdown, enterShutdown;
  const shutdownEntered = new Promise(resolve => { enterShutdown = resolve; });
  const shutdownGate = new Promise(resolve => { releaseShutdown = resolve; });
  const lifecycle = [];
  const { wrapper, session, sdk } = await fixture(t, { extension: api => {
    api.on("session_shutdown", async () => {
      lifecycle.push("shutdown_entered"); enterShutdown();
      await shutdownGate;
      lifecycle.push("shutdown_finished");
    });
  } });
  // All startup preparation uses this test's isolated agent directory. A missing
  // session file stops startup before model/settings/service construction.
  await bindSessionAgentRuntimeProfile(session.sessionId, "normal");
  await resolveProject(sdk.cwd);
  wrapper.destroy();
  await shutdownEntered;
  let startupSettled = false;
  const startup = startRpcSession(session.sessionId, join(sdk.agentDir, "missing-session.jsonl"), sdk.cwd)
    .then(result => { startupSettled = true; result.session.destroy(); return result; }, error => {
      startupSettled = true; lifecycle.push("startup_rejected"); throw error;
    });
  const rejected = assert.rejects(startup, /Session file no longer exists/);
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(globalThis.__piStartLocks?.has(`normal:${session.sessionId}`), "replacement startup acquired its lock");
    assert.equal(startupSettled, false, "new session loading must not run while old shutdown is blocked");
    assert.deepEqual(lifecycle, ["shutdown_entered"]);
  } finally {
    releaseShutdown();
    await wrapper.shutdownForFileMutation();
    await rejected;
  }
  assert.deepEqual(lifecycle, ["shutdown_entered", "shutdown_finished", "startup_rejected"]);
  assert.equal(sdk.requests.length, 0);
});

test("direct workflow HTTP configuration and legacy prompt admission cannot bypass disabled laboratory", { timeout: 20_000 }, async t => {
  const { wrapper, runtime, session, sdk, invoked } = await fixture(t);
  await bindSessionAgentRuntimeProfile(session.sessionId, "normal");
  const registry = globalThis.__piSessions ??= new Map();
  registry.set(session.sessionId, wrapper);
  t.after(() => { if (registry.get(session.sessionId) === wrapper) registry.delete(session.sessionId); });
  writeLaboratorySettings({ planGoalEnabled: false });
  const response = await workflowPost(new Request("http://localhost/api/agent/test/workflow", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "configure", mode: "goal", expectedRevision: runtime.getSnapshot().revision }),
  }), { params: Promise.resolve({ id: session.sessionId }) });
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, "WORKFLOW_LABORATORY_DISABLED");
  await wrapper.startTrackedPrompt({ commandId: "disabled-goal", source: "ui", message: "Bypass UI selection", workflow: { mode: "goal" } });
  await settled(wrapper);
  assert.equal(runtime.getSnapshot().mode, "agent");
  assert.equal(runtime.getSnapshot().current, null);
  assert.equal(sdk.requests.length, 0);
  await wrapper.executeChatCommand("third-party-plan", "/plan");
  assert.equal(invoked(), 1, "third-party commands remain independent of the laboratory switch");
  writeLaboratorySettings({ planGoalEnabled: true });
  runtime.configure({ mode: "plan" }); runtime.preparePrompt("Preserve this review artifact"); runtime.beginTurn();
  runtime.submitPlan("Review before disabling", "Exact content awaiting approval");
  const review = runtime.getSnapshot();
  writeLaboratorySettings({ planGoalEnabled: false });
  // A decision accepted earlier by the router still has to pass the switch at
  // actual model admission, after any time spent in its durable queue.
  await wrapper.startTrackedPrompt({ commandId: "queued-disabled-approval", source: "ui", message: "Execute the approved plan.", inputMode: "text",
    workflowAction: { action: "approve", runId: review.current.id, expectedRevision: review.revision },
  });
  await settled(wrapper);
  assert.deepEqual(runtime.getSnapshot(), review);
  assert.equal(sdk.requests.length, 0);
});
