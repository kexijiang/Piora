import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { writeToolApprovalSettings } = await jiti.import("./tool-approval-settings.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

async function runPrompt(wrapper) {
  let remove;
  const settled = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { remove?.(); reject(new Error("Prompt did not settle")); }, 15000);
    remove = wrapper.onEvent(event => {
      if (["prompt_done", "prompt_error"].includes(event.type)) { clearTimeout(timer); remove(); resolve(event); }
    });
  });
  await wrapper.startTrackedPrompt({ commandId: "direct-test", source: "ui", message: "Run the nested operation and ask the business question." });
  return settled;
}

test("real SDK runs final extension inputs and nested tools with approvals disabled despite saved approval modes; ordinary questions still wait", { timeout: 30000 }, async t => {
  const executions = [], questions = [], events = [];
  const fixture = await createSdkTestFixture(t, { toolNames: ["outer", "inner"],
    step: request => request.index === 0 ? [{ type: "toolCall", id: "outer-call", name: "outer", arguments: { value: "original" } }] : [{ type: "text", text: "done" }],
    extension: pi => {
      pi.on("tool_call", event => { if (event.toolName === "outer") event.input.value = "final"; });
      pi.registerTool({ name: "inner", label: "Inner", description: "Nested operation", parameters: Type.Object({}), async execute() { executions.push("inner"); return { content: [{ type: "text", text: "done" }] }; } });
      pi.registerTool({ name: "outer", label: "Outer", description: "Run nested operation and ask a business question", parameters: Type.Object({ value: Type.String() }), async execute(_id, args, _signal, _update, ctx) {
        executions.push(args.value);
        const result = await ctx.executeTool("inner", {});
        await ctx.ui.confirm("Business choice", "Choose an option");
        return result;
      } });
    },
  });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  await mkdir(join(fixture.agentDir, "piora/tool-permissions"), { recursive: true });
  const defaultFile = join(fixture.agentDir, "piora/tool-permissions/default.json");
  const oldDefault = JSON.stringify({ mode: "review", revision: 9, schemaVersion: 2 });
  await writeFile(defaultFile, oldDefault);
  const session = await fixture.create();
  await writeFile(join(fixture.agentDir, "piora/tool-permissions", session.sessionId + ".json"), JSON.stringify({ mode: "ask", revision: 10, schemaVersion: 2 }));
  writeToolApprovalSettings({ enabled: false }, fixture.agentDir);
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(() => wrapper.destroy());
  wrapper.onEvent(event => { events.push(event); if (event.type === "extension_ui_request") questions.push(event); });
  const finished = runPrompt(wrapper);
  for (let index = 0; questions.length === 0 && index < 300; index++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(executions, ["final", "inner"]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].title, "Business choice");
  let complete = false; finished.then(() => { complete = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(complete, false, "ordinary questions must wait for the user's answer");
  await wrapper.send({ type: "extension_ui_response", id: questions[0].id, confirmed: true });
  assert.equal((await finished).type, "prompt_done");
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.toolPermission.mode, "ask", "disabling preserves the saved mode");
  assert.deepEqual(state.toolReviews, []);
  assert.equal(events.some(event => ["tool_review", "tool_permission_changed"].includes(event.type)), false);
  assert.equal(await readFile(defaultFile, "utf8"), oldDefault, "saved preferences are not overwritten");
});


test("global toggle releases a pending approval and restores the saved mode for the next call", { timeout: 30000 }, async t => {
  const fixture = await createSdkTestFixture(t, { toolNames: ["operation"],
    step: () => [{ type: "text", text: "done" }],
    extension: pi => pi.registerTool({ name: "operation", label: "Operation", description: "Test operation", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "done" }] }; } }),
  });
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
  const { readToolApprovalSettings, readEffectiveToolPermission } = await jiti.import("./tool-approval-settings.ts");
  assert.equal(readToolApprovalSettings(fixture.agentDir).enabled, true);
  assert.throws(() => writeToolApprovalSettings({ enabled: "false" }, fixture.agentDir), /boolean/);
  const session = await fixture.create();
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "set_tool_permission", mode: "ask" });
  const original = readEffectiveToolPermission(session.sessionId, fixture.agentDir);
  const requests = [];
  wrapper.onEvent(event => { if (event.type === "extension_ui_request" && event.toolApproval) requests.push(event); });
  const call = id => session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "operation", toolCallId: id, input: {} });
  const pending = call("before-disable");
  for (let i = 0; !requests.length && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(requests.length, 1);
  writeToolApprovalSettings({ enabled: false }, fixture.agentDir);
  wrapper.refreshToolApprovals();
  assert.equal(await pending, undefined);
  assert.equal(await call("disabled"), undefined);
  assert.equal(requests.length, 1);
  writeToolApprovalSettings({ enabled: true }, fixture.agentDir);
  wrapper.refreshToolApprovals();
  const restored = readEffectiveToolPermission(session.sessionId, fixture.agentDir);
  assert.equal(restored.mode, "ask");
  assert.notEqual(restored.revision, original.revision);
  const next = call("re-enabled");
  for (let i = 0; requests.length < 2 && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(requests.length, 2);
  await wrapper.send({ type: "extension_ui_response", id: requests[1].id, confirmed: false });
  assert.equal((await next).block, true);
});
