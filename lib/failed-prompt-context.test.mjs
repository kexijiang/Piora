import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { omitFailedPromptHistory } = await jiti.import("./failed-prompt-context.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (stopReason, content = []) => ({ role: "assistant", api: "fixture", provider: "fixture", model: "model", content, timestamp: Date.now(), usage, stopReason });

test("context omission preserves raw history, successful retries, system state and branches", () => {
  const manager = SessionManager.inMemory();
  const user = text => manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  user("successful retry"); manager.appendMessage(assistant("error")); manager.appendMessage(assistant("stop"));
  const branchPoint = manager.getLeafId();
  user("failed with tools"); manager.appendMessage(assistant("toolUse", [{ type: "toolCall", id: "call", name: "read", arguments: {} }]));
  manager.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "result" }], isError: false, timestamp: Date.now() });
  manager.appendMessage(assistant("error"));
  const rawCount = manager.getBranch().length;
  assert.equal(omitFailedPromptHistory(manager), 4);
  assert.equal(omitFailedPromptHistory(manager), 0, "omissions are idempotent");
  const projected = manager.buildSessionProjection().messages;
  assert.equal(projected.filter(m => m.role === "user").length, 1);
  assert.equal(projected.some(m => m.role === "toolResult"), false, "tool calls and results are excluded together");
  assert.equal(manager.getBranch().filter(e => e.type !== "context_edit").length, rawCount);
  assert.equal(buildSessionContext(manager.getEntries()).messages.filter(m => m.role === "user").length, 2, "failed input stays visible");
  manager.branch(branchPoint);
  user("other branch"); manager.appendMessage(assistant("stop"));
  assert.equal(omitFailedPromptHistory(manager), 0, "failed sibling branch does not affect current context");
});

test("real wrapper sends only fresh input after connection failures and reload; same-run retry is retained", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-failed-context-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let wrapper, session;
  try {
    await mkdir(cwd); await mkdir(agentDir);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }));
    const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
    const requests = [];
    let failures = 0;
    const create = async manager => {
      const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir), resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => pi.registerProvider("fixture", { api: "fixture", apiKey: "local", baseUrl: "https://unused.invalid",
          models: [{ id: "model", name: "model", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(_model, context) {
            requests.push(structuredClone(context.messages));
            const failed = failures-- > 0;
            const message = { ...assistant(failed ? "error" : "stop", failed ? [] : [{ type: "text", text: "OK" }]), ...(failed ? { errorMessage: "503 connection unavailable" } : {}) };
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push(failed ? { type: "error", reason: "error", error: message } : { type: "done", reason: "stop", message }); });
            return stream;
          },
        })],
      } });
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager ?? SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel("fixture", "model"), tools: [] }));
      wrapper = new AgentSessionWrapper(session);
      wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    };
    const send = async text => {
      let unsubscribe;
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { unsubscribe?.(); reject(new Error("Prompt did not settle")); }, 15000);
        unsubscribe = wrapper.onEvent(event => { if (event.type === "prompt_done") { clearTimeout(timer); unsubscribe(); resolve(); } });
      });
      await wrapper.send({ type: "prompt", message: text });
      await done;
    };
    const users = messages => messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(b => b.type === "text").map(b => b.text).join(""));
    await create();
    await send("successful history");
    failures = 2;
    await send("old failed A");
    await send("old failed B");
    assert.deepEqual(users(requests.at(-1)), ["successful history", "old failed B"]);
    const file = session.sessionFile;
    await wrapper.shutdownForFileMutation(); wrapper = undefined;
    await create(SessionManager.open(file));
    await send("fresh after reconnect");
    assert.deepEqual(users(requests.at(-1)), ["successful history", "fresh after reconnect"]);
    const ui = buildSessionContext(session.sessionManager.getEntries());
    assert.deepEqual(users(ui.messages), ["successful history", "old failed A", "old failed B", "fresh after reconnect"]);
    session.setAutoRetryEnabled(true);
    failures = 1;
    await send("retry current request");
    assert.ok(users(requests.at(-2)).includes("retry current request"));
    assert.ok(users(requests.at(-1)).includes("retry current request"), "retry keeps its current input");
    await send("after retry success");
    assert.deepEqual(users(requests.at(-1)), ["successful history", "fresh after reconnect", "retry current request", "after retry success"]);
    failures = 2;
    await send("exhaust retries");
    await send("fresh after exhausted retries");
    assert.ok(!users(requests.at(-1)).includes("exhaust retries"), "exhausted retry history does not leak to the next request");
    assert.ok(users(requests.at(-1)).includes("fresh after exhausted retries"));
  } finally {
    if (wrapper) await wrapper.shutdownForFileMutation();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
