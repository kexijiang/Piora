import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkTestFixture as fixture } from "./pi-sdk-test-fixture.mjs";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = async check => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for SDK acceptance boundary");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test("Pi 1.0 restores canonical history, context edits and independent sessions", async t => {
  const f = await fixture(t);
  const first = await f.create();
  await first.prompt("ORIGINAL_HISTORY");
  const file = first.sessionFile;
  first.dispose();
  const restored = await f.create(SessionManager.open(file));
  restored.agent.state.messages = [];
  await restored.prompt("RESTORED_REQUEST");
  assert.match(JSON.stringify(f.requests.at(-1).messages), /ORIGINAL_HISTORY/);
  const original = restored.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "user");
  restored.sessionManager.appendContextEdit(original.id, null);
  restored.refreshContext();
  await restored.prompt("EDITED_REQUEST");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /ORIGINAL_HISTORY/);
  assert.match(JSON.stringify(restored.sessionManager.getEntry(original.id)), /ORIGINAL_HISTORY/);
  const second = await f.create();
  await second.prompt("INDEPENDENT_SESSION");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /RESTORED_REQUEST|EDITED_REQUEST/);
  assert.notEqual(second.sessionId, restored.sessionId);
  assert.notEqual(second.modelRuntime, restored.modelRuntime);
});

test("Piora statistics match installed SDK whole-session totals and refresh after new usage", async t => {
  const { summarizeSessionStats } = await createJiti(import.meta.url).import("./session-stats.ts");
  const f = await fixture(t);
  const session = await f.create();
  await session.prompt("stats");
  session.sessionManager.appendUsage("classifier", "fixture", "fixture", { ...usage, cost: { ...usage.cost, total: 2 } });
  const stats = summarizeSessionStats(session.sessionManager);
  const sdk = session.getSessionStats();
  for (const key of ["userMessages", "assistantMessages", "toolCalls", "toolResults", "totalMessages", "tokens", "cost"]) assert.deepEqual(stats[key], sdk[key], key);
  session.sessionManager.appendUsage("image", "fixture", "fixture", { ...usage, cost: { ...usage.cost, total: 3 } });
  assert.equal(summarizeSessionStats(session.sessionManager).cost, stats.cost + 3);
});

test("Pi 1.0 queues steering and follow-up input and persists tools and boundary edits", async t => {
  const gate = deferred();
  let firstStarted = false, boundaries = 0, executed = 0;
  const f = await fixture(t, {
    toolNames: ["migration_probe"],
    step: async request => {
      if (request.index === 0) { firstStarted = true; await gate.promise; return [{ type: "toolCall", id: "probe-call", name: "migration_probe", arguments: { value: "tool-input" } }]; }
      return [{ type: "text", text: "BOUNDARY_RESULT" }];
    },
    extension: pi => {
      pi.registerTool({ name: "migration_probe", label: "Probe", description: "Acceptance tool", parameters: Type.Object({ value: Type.String() }), execute: async (_id, args) => { executed++; return { content: [{ type: "text", text: args.value }], details: { accepted: true } }; } });
      pi.on("turn_end", event => {
        assert.ok(event.messageEntryId);
        assert.ok(Array.isArray(event.entries));
        assert.ok(Array.isArray(event.context.llmMessages));
        boundaries++;
        if (boundaries === 1) return { entries: [...event.entries, { type: "custom", customType: "migration-boundary", data: { accepted: true } }] };
      });
    },
  });
  const session = await f.create(); session.setActiveToolsByName(["migration_probe"]);
  assert.ok(session.getActiveToolNames().includes("migration_probe"), JSON.stringify(session.getAllTools()));
  const pending = session.prompt("INITIAL_TASK");
  await wait(() => firstStarted);
  assert.equal(await session.steer("STEERING_INPUT"), "queued");
  assert.equal(await session.followUp("FOLLOWUP_INPUT"), "queued");
  assert.equal(session.pendingMessageCount, 2);
  gate.resolve(); await pending;
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(executed, 1, JSON.stringify(session.sessionManager.getEntries()));
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[0].tools.some(tool => tool.name === "migration_probe"));
  assert.match(JSON.stringify(f.requests[1].messages), /tool-input|STEERING_INPUT/);
  assert.match(JSON.stringify(f.requests[2].messages), /FOLLOWUP_INPUT/);
  assert.ok(session.sessionManager.getEntries().some(entry => entry.customType === "migration-boundary"));
  assert.ok(f.lifecycle.includes("agent_settled"));
});

test("Pi 1.0 automatic threshold compaction runs and continues from a persisted summary", async t => {
  const f = await fixture(t, { compaction: true, step: () => [{ type: "text", text: "COMPLETED_HISTORY " + "completed detail ".repeat(100) }] });
  const session = await f.create();
  assert.equal(session.model.contextWindow, 1000);
  await session.prompt("OLD_HISTORY " + "historical detail ".repeat(200));
  await session.prompt("NEXT_REQUEST");
  assert.ok(f.lifecycle.includes("compact:threshold"), JSON.stringify({ lifecycle: f.lifecycle, usage: session.getContextUsage(), settings: session.settingsManager.getCompactionSettings() }));
  assert.ok(session.sessionManager.getEntries().some(entry => entry.type === "compaction"));
  assert.match(JSON.stringify(f.requests.at(-1).messages), /ACCEPTANCE_SUMMARY/);
  assert.equal(session.isCompacting, false);
});

test("Piora fences SDK async input cancellation and handles extension commands without starting a model", { timeout: 30000 }, async t => {
  const gate = deferred(); let hookStarted = false;
  t.after(() => gate.resolve());
  const f = await fixture(t, { extension: pi => {
    pi.registerCommand("migration-handled", { description: "Acceptance command", handler: async () => {} });
    pi.on("input", async event => { if (event.text === "CANCEL_IN_PREFLIGHT") { hookStarted = true; await gate.promise; } });
  } });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start();
  wrapper.setForceEmptySystemPrompt(true);
  t.after(async () => { wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  await wrapper.waitUntilReady();
  const events = []; wrapper.onEvent(event => events.push(event));
  await wrapper.send({ type: "prompt", message: "/migration-handled" });
  await wait(() => events.some(event => event.type === "prompt_done"));
  assert.equal(f.requests.length, 0);
  events.length = 0;
  await wrapper.send({ type: "prompt", message: "CANCEL_IN_PREFLIGHT" });
  await wait(() => hookStarted);
  await wrapper.send({ type: "abort" });
  gate.resolve();
  await wait(() => wrapper.getRuntime() === "idle");
  assert.equal(f.requests.length, 0);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(events.some(event => event.type === "prompt_error"), false);
  assert.ok(events.some(event => event.type === "prompt_done" && event.aborted));
  await wrapper.send({ type: "prompt", message: "AFTER_CANCELLATION" });
  await wait(() => f.requests.length === 1 && wrapper.getRuntime() === "idle");
  assert.match(JSON.stringify(f.requests[0].messages), /AFTER_CANCELLATION/);
  assert.equal(f.requests[0].systemPrompt, "");
  assert.deepEqual(f.requests[0].tools, []);
});

for (const type of ["steer", "follow_up"]) test(`Piora drains cancelled async ${type} admission before the next prompt`, async t => {
  const gate = deferred(); let hookStarted = false;
  const f = await fixture(t, {
    step: async (request, options) => {
      if (request.index === 0) await new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("Acceptance cancelled")), { once: true }));
      return [{ type: "text", text: "completed" }];
    },
    extension: pi => pi.on("input", async event => {
      if (event.text === "HANDLED_INPUT") return { action: "handled" };
      if (event.text === "CANCELLED_QUEUE_INPUT") { hookStarted = true; await gate.promise; }
    }),
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); await wrapper.waitUntilReady();
  t.after(async () => { gate.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  assert.deepEqual(await wrapper.send({ type, message: "HANDLED_INPUT" }), { disposition: "handled" });
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(f.requests.length, 0);
  await wrapper.send({ type: "prompt", message: "ACTIVE_REQUEST" });
  await wait(() => f.requests.length === 1);
  const admission = wrapper.send({ type, message: "CANCELLED_QUEUE_INPUT" });
  const rejected = assert.rejects(admission, /cancelled/);
  await wait(() => hookStarted);
  await wrapper.send({ type: "abort" });
  assert.equal(wrapper.getRuntime(), "stopping");
  await assert.rejects(wrapper.send({ type: "prompt", message: "TOO_EARLY" }), /busy/);
  gate.resolve(); await rejected;
  await wait(() => wrapper.getRuntime() === "idle");
  assert.equal(session.pendingMessageCount, 0);
  await wrapper.send({ type: "prompt", message: "NEXT_REQUEST" });
  await wait(() => f.requests.length === 2 && wrapper.getRuntime() === "idle");
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).messages), /CANCELLED_QUEUE_INPUT|TOO_EARLY/);
});

test("chat commands preserve real SDK arguments and execute while the model is busy without steering", async t => {
  const gate = deferred();
  const invocations = [];
  const f = await fixture(t, {
    step: async request => { if (request.index === 0) await gate.promise; return [{ type: "text", text: "done" }]; },
    extension: pi => pi.registerCommand("command-probe", { description: "Command probe", handler: async args => { invocations.push(args); } }),
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); await wrapper.waitUntilReady();
  t.after(async () => { gate.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  await wrapper.send({ type: "prompt", message: "ACTIVE_MODEL" });
  await wait(() => f.requests.length === 1);
  const runId = wrapper.getActivePromptRunId();
  await wrapper.executeChatCommand("probe-command", '/command-probe "中文 参数"  line\nsecond');
  assert.deepEqual(invocations, ['"中文 参数"  line\nsecond']);
  assert.equal(wrapper.getActivePromptRunId(), runId);
  assert.equal(session.pendingMessageCount, 0);
  assert.equal(f.requests.length, 1);
  gate.resolve();
  await wait(() => wrapper.getRuntime() === "idle");
});

test("chat command settlement owns unawaited SDK model work and propagates real extension errors", async t => {
  const gate = deferred();
  const f = await fixture(t, {
    step: async () => { await gate.promise; return [{ type: "text", text: "CHILD_COMPLETE" }]; },
    extension: pi => {
      pi.registerCommand("command-child", { handler: async () => { pi.sendUserMessage("CHILD_PROMPT"); } });
      pi.registerCommand("command-error", { handler: async () => { throw new Error("COMMAND_HANDLER_FAILED"); } });
    },
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); await wrapper.waitUntilReady();
  t.after(async () => { gate.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  let settled = false;
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  const execution = wrapper.executeChatCommand("child-command", "/command-child").then(() => { settled = true; });
  await wait(() => f.requests.length === 1);
  assert.equal(settled, false);
  assert.ok(wrapper.getActivePromptRunId());
  gate.resolve(); await execution;
  assert.equal(settled, true);
  assert.equal(wrapper.getActivePromptRunId(), undefined);
  assert.match(JSON.stringify(session.sessionManager.getBranch()), /CHILD_COMPLETE/);
  await assert.rejects(wrapper.executeChatCommand("error-command", "/command-error"), /COMMAND_HANDLER_FAILED/);
});

test("late extension timers start a distinct owned run instead of reviving a settled command", async t => {
  const launch = deferred(), model = deferred();
  const f = await fixture(t, {
    step: async () => { await model.promise; return [{ type: "text", text: "LATE_MODEL_DONE" }]; },
    extension: pi => pi.registerCommand("command-late", { handler: async () => {
      setTimeout(() => { void launch.promise.then(() => pi.sendUserMessage("LATE_MODEL_INPUT")); }, 0);
    } }),
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(async () => { launch.resolve(); model.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  const events = []; wrapper.onEvent(event => events.push(event));
  await wrapper.executeChatCommand("original-late-command", "/command-late");
  assert.equal(f.requests.length, 0);
  assert.equal(wrapper.getActivePromptRunId(), undefined);
  launch.resolve();
  await wait(() => f.requests.length === 1);
  const started = events.find(event => event.type === "prompt_started");
  assert.ok(started?.runId);
  assert.notEqual(started.commandId, "original-late-command");
  assert.equal(wrapper.getActivePromptRunId(), started.runId);
  const { getActivePromptRun } = await createJiti(import.meta.url).import("./prompt-run-registry.ts");
  assert.equal(getActivePromptRun(session.sessionId).source, "extension");
  model.resolve();
  await wait(() => wrapper.getRuntime() === "idle");
  assert.equal(wrapper.getActivePromptRunId(), undefined);
  assert.ok(events.some(event => event.type === "prompt_done" && event.commandId === started.commandId));
});

test("SDK templates and skills expand before text materials and local-file context are attached", async t => {
  const f = await fixture(t, { resourceFiles: {
    ".pi/prompts/check.md": "---\ndescription: Template probe\n---\nTEMPLATE_START\nFirst: $1\nAll: $ARGUMENTS\nTEMPLATE_END",
    ".pi/skills/probe/SKILL.md": "---\nname: probe\ndescription: Skill probe\n---\nSKILL_BODY",
  } });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const { savePromptMaterials } = await createJiti(import.meta.url).import("./prompt-materials.ts");
  const materials = savePromptMaterials([{ name: "notes.txt", content: "MATERIAL_BODY" }]).map(({ id }) => ({ id }));
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(async () => { wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  assert.ok(session.promptTemplates.some(template => template.name === "check"));
  assert.ok(session.resourceLoader.getSkills().skills.some(skill => skill.name === "probe"));
  for (const message of ['/check "参数 一" two', "/skill:probe 中文问题"]) {
    const count = f.requests.length;
    await wrapper.send({ type: "prompt", message, materials, promptSuffix: "LOCAL_FILE_CONTEXT /workspace/example.pdf" });
    await wait(() => f.requests.length > count && wrapper.getRuntime() === "idle");
    const lastUser = [...f.requests.at(-1).messages].reverse().find(entry => entry.role === "user");
    const text = lastUser.content.filter(block => block.type === "text").map(block => block.text).join("\n");
    assert.match(text, /notes.txt/);
    assert.match(text, /LOCAL_FILE_CONTEXT \/workspace\/example.pdf/);
    if (message.startsWith("/check")) {
      assert.match(text, /TEMPLATE_START/);
      assert.match(text, /First: 参数 一/);
      assert.match(text, /TEMPLATE_END\n\nLOCAL_FILE_CONTEXT/);
    } else assert.match(text, /SKILL_BODY/);
    assert.doesNotMatch(text, /The user's accompanying request is:\n\/(?:check|skill:probe)/);
  }
});

for (const delivery of ["steer", "followUp"]) test(`busy SDK template ${delivery} keeps expanded parameters and attachments on the exact queued message`, async t => {
  const gate = deferred();
  const f = await fixture(t, { resourceFiles: { ".pi/prompts/queued-check.md": "---\ndescription: Queued template\n---\nQUEUED_TEMPLATE $1" },
    step: async request => { if (request.index === 0) await gate.promise; return [{ type: "text", text: "done" }]; },
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const { savePromptMaterials } = await createJiti(import.meta.url).import("./prompt-materials.ts");
  const materials = savePromptMaterials([{ name: "queued-notes.txt", content: "queued body" }]).map(({ id }) => ({ id }));
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(async () => { gate.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  await wrapper.send({ type: "prompt", message: "ACTIVE_BEFORE_QUEUE" });
  await wait(() => f.requests.length === 1);
  const parentRun = wrapper.getActivePromptRunId();
  let finished = false;
  const command = wrapper.executeModelCommand(`queued-${delivery}`, '/queued-check "中文 参数"', { delivery, materials, promptSuffix: "QUEUED_LOCAL_FILE" }, () => {}).then(() => { finished = true; });
  await wait(() => session.pendingMessageCount === 1);
  assert.equal(finished, false);
  assert.equal(wrapper.getActivePromptRunId(), parentRun);
  gate.resolve(); await command;
  await wait(() => wrapper.getRuntime() === "idle");
  assert.equal(f.requests.length, 2);
  const lastUser = [...f.requests[1].messages].reverse().find(message => message.role === "user");
  const text = lastUser.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  assert.match(text, /QUEUED_TEMPLATE 中文 参数/);
  assert.match(text, /queued-notes.txt/);
  assert.match(text, /QUEUED_LOCAL_FILE/);
});

test("failed SDK model descendants fail their chat command instead of reporting handler success", async t => {
  const f = await fixture(t, {
    step: async () => { throw new Error("COMMAND_CHILD_PROVIDER_FAILED"); },
    extension: pi => pi.registerCommand("command-provider-error", { handler: async () => { pi.sendUserMessage("CHILD_FAILURE"); } }),
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(async () => { wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  await assert.rejects(wrapper.executeChatCommand("failed-child", "/command-provider-error"), /COMMAND_CHILD_PROVIDER_FAILED/);
});

test("literal slash inputs bypass real SDK extension and template dispatch during steering", async t => {
  const gate = deferred();
  let invoked = 0;
  const f = await fixture(t, {
    step: async request => { if (request.index === 0) await gate.promise; return [{ type: "text", text: "done" }]; },
    extension: pi => pi.registerCommand("literal-probe", { handler: async () => { invoked++; } }),
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); await wrapper.waitUntilReady();
  t.after(async () => { gate.resolve(); wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  await wrapper.send({ type: "prompt", message: "START" });
  await wait(() => f.requests.length === 1);
  await wrapper.send({ type: "steer", message: "/literal-probe 参数", inputMode: "text" });
  assert.equal(invoked, 0);
  assert.equal(session.pendingMessageCount, 1);
  gate.resolve();
  await wait(() => f.requests.length === 2 && wrapper.getRuntime() === "idle");
  assert.match(JSON.stringify(f.requests[1].messages), /literal-probe 参数/);
});

test("Piora hides streamed SDK system messages while preserving canonical provider history", async t => {
  const f = await fixture(t);
  const session = await f.create();
  const sdkRoles = [], uiRoles = [];
  session.subscribe(event => { if (event.type.startsWith("message_")) sdkRoles.push(event.message.role); });
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); await wrapper.waitUntilReady();
  t.after(async () => { wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  wrapper.onEvent(event => { if (event.type.startsWith("message_")) uiRoles.push(event.message.role); });
  await wrapper.send({ type: "prompt", message: "STREAM_ACCEPTANCE" });
  await wait(() => f.requests.length === 1 && wrapper.getRuntime() === "idle");
  assert.ok(sdkRoles.includes("system"), "the real SDK must exercise the migrated system-event contract");
  assert.ok(session.sessionManager.getEntries().some(entry => entry.type === "message" && entry.message.role === "system"));
  assert.ok(f.requests[0].systemPrompt.length > 0, "provider instructions must remain present");
  assert.equal(uiRoles.includes("system"), false);
  assert.ok(uiRoles.includes("user") && uiRoles.includes("assistant"));
});
