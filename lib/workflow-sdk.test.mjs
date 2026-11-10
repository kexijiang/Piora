import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { createJiti } from "jiti";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { WorkflowStore } = await jiti.import("./workflow-store.ts");
const { getWorkflowRuntime } = await jiti.import("./workflow-runtime.ts");
const { createWorkflowExtension } = await jiti.import("../extensions/piora-workflows.ts");
const { writeLaboratorySettings } = await jiti.import("./laboratory-settings.ts");
function enableLaboratory(t, agentDir) {
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeLaboratorySettings({ planGoalEnabled: true });
  t.after(() => {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
  });
}
function tool(id, name, args) { return { type: "toolCall", id, name, arguments: args }; }
test("real SDK plan blocks writes, saves review, and continues the approved plan", { timeout: 20_000 }, async t => {
  let store;
  const fixture = await createSdkTestFixture(t, { toolNames: null,
    extension: api => createWorkflowExtension({ store })(api),
    step: request => {
      if (request.index === 0) return [tool("blocked-write", "write", { path: "must-not-exist.txt", content: "bad" })];
      if (request.index === 1) return [tool("plan", "piora_submit_plan", { title: "Implement safely", markdown: "# Goal\nCreate the approved file\n# Steps\nWrite approved.txt\n# Verify\nRead it" })];
      if (request.index === 3) return [tool("approved-write", "write", { path: "approved.txt", content: "ok" })];
      return [{ type: "text", text: "Finished this turn" }];
    },
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create();
  const runtime = getWorkflowRuntime(session.sessionId, store);
  assert.equal(runtime.isAttached, true);
  runtime.configure({ mode: "plan" }); runtime.preparePrompt("Create the approved file");
  await session.prompt("Create the approved file");
  await assert.rejects(access(join(fixture.cwd, "must-not-exist.txt")));
  assert.equal(runtime.getSnapshot().current.status, "awaiting_approval");
  const state = runtime.getSnapshot();
  const { prompt } = runtime.action({ action: "approve", runId: state.current.id, expectedRevision: state.revision });
  await session.prompt(prompt); runtime.onPromptSettled();
  await access(join(fixture.cwd, "approved.txt"));
  assert.equal(runtime.getSnapshot().current.status, "completed");
});
test("real SDK goal continues across agent_end and stops at the configured turn budget", { timeout: 20_000 }, async t => {
  let store;
  const fixture = await createSdkTestFixture(t, { toolNames: null, extension: api => createWorkflowExtension({ store })(api), step: request => [{ type: "text", text: `Progress turn ${request.index}` }] });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal", turnBudget: 2 }); runtime.preparePrompt("Complete all acceptance requirements");
  await session.prompt("Complete all acceptance requirements");
  assert.equal(fixture.requests.length, 2);
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
  assert.equal(runtime.getSnapshot().current.turnsUsed, 2);
  assert.ok(fixture.requests.every(request => request.systemPrompt.includes("Complete all acceptance requirements")));
});

test("real SDK completion records evidence, stops continuation, and keeps third-party commands available", { timeout: 20_000 }, async t => {
  let store;
  const invoked = [];
  const fixture = await createSdkTestFixture(t, { toolNames: null,
    extension: api => {
      api.registerCommand("plan", { handler: async () => { invoked.push("plan"); } });
      api.registerCommand("goal", { handler: async () => { invoked.push("goal"); } });
      createWorkflowExtension({ store })(api);
    },
    step: request => request.index === 0 ? [tool("complete-goal", "piora_update_goal", {
      progress: "Verified required output", status: "completed", criteria: [{ id: "output", text: "Output observed", evidence: "Observed output in the controlled test", status: "verified" }],
    })] : [{ type: "text", text: "Goal complete" }],
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal", turnBudget: 10 }); runtime.preparePrompt("Produce the required output");
  await session.prompt("Produce the required output");
  assert.equal(fixture.requests.length, 2); // Tool call and final answer, one logical goal turn.
  assert.equal(runtime.getSnapshot().current.status, "completed");
  assert.equal(runtime.getSnapshot().current.turnsUsed, 1);
  assert.equal(runtime.getSnapshot().current.criteria[0].evidence, "Observed output in the controlled test");
  await session.prompt("/plan"); await session.prompt("/goal");
  assert.deepEqual(invoked, ["plan", "goal"]);
});

test("real SDK cancellation stops queued goals and explicit resume preserves the objective", { timeout: 20_000 }, async t => {
  let store, started;
  const ready = new Promise(resolve => { started = resolve; });
  let hold = true;
  const fixture = await createSdkTestFixture(t, { toolNames: null, extension: api => createWorkflowExtension({ store })(api),
    step: async request => {
      if (hold) { started(); await new Promise(() => {}); }
      return [{ type: "text", text: `Resumed ${request.index}` }];
    },
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal", turnBudget: 1 }); runtime.preparePrompt("Preserve this exact goal");
  const running = session.prompt("Preserve this exact goal"); await ready;
  runtime.onAbort(); await session.abort(); await running;
  assert.equal(runtime.getSnapshot().current.status, "paused");
  assert.equal(fixture.requests.length, 1);
  const state = runtime.getSnapshot(); hold = false;
  const result = runtime.action({ action: "resume", runId: state.current.id, expectedRevision: state.revision });
  runtime.preparePrompt(result.prompt); await session.prompt(result.prompt);
  assert.equal(runtime.getSnapshot().current.objective, "Preserve this exact goal");
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
});

test("latest goal state is re-injected after real SDK context compaction", { timeout: 20_000 }, async t => {
  let store;
  const fixture = await createSdkTestFixture(t, { toolNames: null, compaction: true, extension: api => createWorkflowExtension({ store })(api),
    step: () => [{ type: "text", text: "Investigating the goal" }],
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal", turnBudget: 2 }); runtime.preparePrompt("Keep this objective after compaction");
  await session.prompt("Keep this objective after compaction");
  assert.ok(fixture.lifecycle.some(event => event.startsWith("compact:")));
  assert.ok(fixture.requests.at(-1).messages.some(message => JSON.stringify(message).includes("Keep this objective after compaction")));
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
});

test("real SDK cancellation fences a write waiting in an earlier extension tool hook", { timeout: 20_000 }, async t => {
  let store, releaseGate, enterGate;
  const gateEntered = new Promise(resolve => { enterGate = resolve; });
  const gate = new Promise(resolve => { releaseGate = resolve; });
  const fixture = await createSdkTestFixture(t, { toolNames: null,
    extension: api => {
      api.on("tool_call", async event => {
        if (event.toolName === "write") { enterGate(); await gate; }
      });
      createWorkflowExtension({ store })(api);
    },
    step: request => request.index === 0
      ? [tool("cancelled-write", "write", { path: "cancelled-write.txt", content: "must never be written" })]
      : [{ type: "text", text: "Finished" }],
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal" }); runtime.preparePrompt("Write only while this goal is active");
  const running = session.prompt("Write only while this goal is active");
  try {
    await gateEntered;
    const state = runtime.getSnapshot();
    runtime.action({ action: "cancel", runId: state.current.id, expectedRevision: state.revision });
    const aborting = session.abort();
    releaseGate();
    await aborting; await running;
    await assert.rejects(access(join(fixture.cwd, "cancelled-write.txt")), { code: "ENOENT" });
    assert.equal(runtime.getSnapshot().current.status, "cancelled");
    assert.equal(runtime.getSnapshot().mode, "agent");
  } finally {
    releaseGate(); await session.abort(); await running;
  }
});

test("real SDK stops automatic Goal continuation after laboratory is disabled and resumes only after opt-in", { timeout: 20_000 }, async t => {
  let store;
  const fixture = await createSdkTestFixture(t, { toolNames: null, extension: api => createWorkflowExtension({ store })(api),
    step: request => {
      if (request.index === 0) writeLaboratorySettings({ planGoalEnabled: false });
      return [{ type: "text", text: "Completed the current investigation turn" }];
    },
  });
  enableLaboratory(t, fixture.agentDir);
  store = new WorkflowStore(join(fixture.agentDir, "workflows"));
  const session = await fixture.create(); const runtime = getWorkflowRuntime(session.sessionId, store);
  runtime.configure({ mode: "goal", turnBudget: 2 }); runtime.preparePrompt("Keep the complete original goal");
  await session.prompt("Keep the complete original goal");
  const paused = runtime.getSnapshot();
  assert.equal(fixture.requests.length, 1);
  assert.equal(paused.current.status, "paused");
  assert.equal(paused.current.reason, "laboratory_disabled");
  assert.equal(paused.current.turnsUsed, 1);
  const resume = { action: "resume", runId: paused.current.id, expectedRevision: paused.revision };
  assert.throws(() => runtime.action(resume), /Settings > Laboratory/);
  writeLaboratorySettings({ planGoalEnabled: true });
  assert.deepEqual(runtime.getSnapshot(), paused);
  const result = runtime.action(resume);
  runtime.preparePrompt(result.prompt); await session.prompt(result.prompt);
  assert.equal(fixture.requests.length, 2);
  assert.equal(runtime.getSnapshot().current.id, paused.current.id);
  assert.equal(runtime.getSnapshot().current.objective, paused.current.objective);
  assert.equal(runtime.getSnapshot().current.status, "budget_exhausted");
});
