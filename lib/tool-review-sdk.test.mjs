import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { runToolReviewModel } = await jiti.import("./tool-review-model.ts");
const allowed = { decision: "allow", authorization: "explicit", risk: "low", reason: "Authorized scoped operation.", question: "" };

async function runPrompt(wrapper, message) {
  let remove;
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { remove?.(); reject(new Error("Prompt did not settle")); }, 15000);
    remove = wrapper.onEvent(event => {
      if (["prompt_done", "prompt_error"].includes(event.type)) { clearTimeout(timeout); remove(); resolve(event); }
    });
  });
  await wrapper.startTrackedPrompt({ commandId: "cmd-review-test", source: "ui", message });
  return done;
}
function agentDirectory(t, root) {
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; });
}

test("real SDK reviews extension-final arguments and nested tools, persists completion and replays only state", { timeout: 30000 }, async t => {
  const executions = [], contexts = [], questions = [];
  const f = await createSdkTestFixture(t, { toolNames: ["outer", "inner"],
    step: request => request.index === 0 ? [{ type: "toolCall", id: "outer-call", name: "outer", arguments: { value: "original" } }] : [{ type: "text", text: "done" }],
    extension: pi => {
      pi.on("tool_call", event => { if (event.toolName === "outer") event.input.value = "final value"; });
      pi.registerTool({ name: "inner", label: "Inner", description: "A scoped test operation", parameters: Type.Object({}), async execute() { executions.push("inner"); return { content: [{ type: "text", text: "done" }] }; } });
      pi.registerTool({ name: "outer", label: "Outer", description: "Run a nested test and ask a business question", parameters: Type.Object({ value: Type.String() }), async execute(_id, args, _signal, _update, ctx) {
        executions.push(args.value);
        const result = await ctx.executeTool("inner", {});
        await ctx.ui.confirm("Business choice", "Choose an option");
        return result;
      } });
    },
  });
  agentDirectory(t, f.agentDir);
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session, "normal", { reviewInvoker: async input => { contexts.push(JSON.parse(input.context)); return { decision: allowed, tokens: 12 }; } });
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "set_tool_permission", mode: "review" });
  wrapper.onEvent(event => {
    if (event.type === "extension_ui_request" && event.method === "confirm") {
      questions.push(event);
      void wrapper.send({ type: "extension_ui_response", id: event.id, confirmed: true });
    }
  });
  await runPrompt(wrapper, "Run the nested test and ask me for the business choice.");
  assert.deepEqual(executions, ["final value", "inner"]);
  assert.equal(contexts.length, 2);
  assert.equal(contexts[0].operation.args.value, "final value");
  assert.equal(contexts[0].authorization[0].source, "ui");
  assert.equal(questions.length, 1);
  assert.equal(questions[0].toolApproval, undefined, "business questions are never answered by the reviewer");
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.toolReviews.length, 2);
  assert.ok(state.toolReviews.every(record => record.status === "completed"));
  const recovered = [];
  wrapper.onEvent(event => { if (event.type === "tool_review") recovered.push(event.review); })();
  assert.equal(recovered.length, 2);
  assert.equal(contexts.length, 2, "reconnecting only replays state");
});

test("real SDK hard refusal stops the run before execution and cannot be bypassed by a second tool", { timeout: 30000 }, async t => {
  let executed = 0, reviewed = 0;
  const f = await createSdkTestFixture(t, { toolNames: ["danger"],
    step: () => [{ type: "toolCall", id: `call-${reviewed}`, name: "danger", arguments: {} }],
    extension: pi => pi.registerTool({ name: "danger", label: "Danger", description: "Danger fixture", parameters: Type.Object({}), async execute() { executed++; return { content: [{ type: "text", text: "unexpected" }] }; } }),
  });
  agentDirectory(t, f.agentDir);
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session, "normal", { reviewInvoker: async () => { reviewed++; return { decision: { ...allowed, decision: "deny", risk: "critical", reason: "Prohibited destructive operation." } }; } });
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady(); t.after(() => wrapper.destroy());
  await wrapper.send({ type: "set_tool_permission", mode: "review" });
  await runPrompt(wrapper, "Inspect the project.");
  assert.equal(executed, 0); assert.equal(reviewed, 1);
  assert.ok((await wrapper.send({ type: "get_state" })).toolReviews.some(record => record.status === "denied"));
  await wrapper.send({ type: "set_tool_permission", mode: "full" });
  const blocked = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "danger", toolCallId: "retry-via-another-tool", input: {} });
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);
});

test("model adapter sends an independent tool-free request with fixed budgets and no fallback", async t => {
  const original = ModelRuntime.create;
  t.after(() => { ModelRuntime.create = original; });
  let calls = 0;
  ModelRuntime.create = async options => {
    assert.deepEqual(Object.keys(options).sort(), ["authPath", "modelsPath"]);
    return {
      getModel(provider, id) { assert.equal(provider, "selected"); assert.equal(id, "reviewer"); return { provider, id, cost: { input: 1, output: 1 } }; },
      async completeSimple(model, context, options) {
        calls++;
        assert.equal(model.id, "reviewer");
        assert.equal(context.tools, undefined);
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0].content, "host evidence only");
        assert.match(context.systemPrompt, /UNTRUSTED/);
        assert.equal(options.maxRetries, 0);
        assert.equal(options.maxTokens, 700);
        assert.equal(options.timeoutMs, 30000);
        return { content: [{ type: "text", text: JSON.stringify(allowed) }], stopReason: "stop", usage: { totalTokens: 25, cost: { total: 0.001 } } };
      },
    };
  };
  const result = await runToolReviewModel({ context: "host evidence only", model: { provider: "selected", id: "reviewer" }, signal: new AbortController().signal });
  assert.equal(result.decision.decision, "allow");
  assert.equal(result.tokens, 25); assert.equal(result.cost, 0.001); assert.equal(calls, 1);
});
