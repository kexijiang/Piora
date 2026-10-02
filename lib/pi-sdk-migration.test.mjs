import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

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

// Real installed SDK sessions/extensions/providers. Only the remote model's
// response is controlled; no Piora lifecycle, queue or persistence is mocked.
async function fixture(t, { step = () => [{ type: "text", text: "completed" }], extension = () => {}, compaction, toolNames = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "piora-pi1-acceptance-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const sessions = [], requests = [], lifecycle = [];
  const provider = "piora-migration-test";
  let index = 0;
  const create = async manager => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    if (compaction) {
      settingsManager.getCompactionSettings = () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 });
    }
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(provider, {
          api: "piora-migration-api", baseUrl: "https://unused.invalid", apiKey: "controlled-test-credential",
          models: [{ id: "model", name: "Controlled acceptance model", reasoning: false, input: ["text", "image"], contextWindow: compaction ? 1000 : 128000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, context, options) {
            assert.equal(context.systemPrompt, undefined);
            assert.equal(context.tools, undefined);
            const request = { index: index++, messages: structuredClone(context.messages), systemPrompt: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages) };
            requests.push(request);
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              try {
                const content = await step(request, options);
                const message = { role: "assistant", api: model.api, provider, model: model.id, content, timestamp: Date.now(), usage: { ...usage, ...(compaction ? { input: 950, totalTokens: 951 } : {}) }, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop" };
                stream.push({ type: "start", partial: message });
                for (const [contentIndex, block] of content.entries()) if (block.type === "text") {
                  stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
                }
                stream.push({ type: "done", reason: message.stopReason, message });
              } catch (error) {
                stream.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: { role: "assistant", api: model.api, provider, model: model.id, content: [], timestamp: Date.now(), usage, stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error.message } });
              }
            });
            return stream;
          },
        });
        for (const event of ["session_start", "session_shutdown", "agent_settled"]) pi.on(event, () => { lifecycle.push(event); });
        if (compaction) pi.on("session_before_compact", event => {
          lifecycle.push(`compact:${event.reason}`);
          return { compaction: { summary: "ACCEPTANCE_SUMMARY", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
        });
        extension(pi);
      }],
    } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager ?? SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel(provider, "model"), tools: toolNames });
    sessions.push(session);
    session.setAutoRetryEnabled(false);
    session.setAutoCompactionEnabled(Boolean(compaction));
    await session.bindExtensions({ mode: "rpc" });
    return session;
  };
  t.after(async () => {
    for (const session of sessions) { await session.abort(); session.dispose(); }
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { create, requests, lifecycle, cwd, agentDir };
}

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

test("Piora fences SDK async input cancellation and handles extension commands without starting a model", async t => {
  const gate = deferred(); let hookStarted = false;
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
