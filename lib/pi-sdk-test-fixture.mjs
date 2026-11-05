import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export async function createSdkTestFixture(context, { step = () => [{ type: "text", text: "completed" }], streamProvider, extension = () => {}, compaction, toolNames = [], resourceFiles = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "piora-pi1-acceptance-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  for (const [name, content] of Object.entries(resourceFiles)) {
    await mkdir(dirname(join(cwd, name)), { recursive: true });
    await writeFile(join(cwd, name), content);
  }
  const sessions = [], requests = [], lifecycle = [];
  const provider = "piora-migration-test";
  let index = 0;
  const create = async manager => {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    if (compaction) settingsManager.getCompactionSettings = () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 });
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      noExtensions: true, noSkills: !Object.keys(resourceFiles).length, noPromptTemplates: !Object.keys(resourceFiles).length, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider(provider, {
          api: "piora-migration-api", baseUrl: "https://unused.invalid", apiKey: "controlled-test-credential",
          models: [{ id: "model", name: "Controlled acceptance model", reasoning: false, input: ["text", "image"], contextWindow: compaction ? 1000 : 128000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, input, options) {
            assert.equal(input.systemPrompt, undefined);
            assert.equal(input.tools, undefined);
            const request = { index: index++, messages: structuredClone(input.messages), systemPrompt: getCurrentSystemPrompt(input.messages), tools: getCurrentTools(input.messages) };
            requests.push(request);
            if (streamProvider) return streamProvider(model, input, options);
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
              let removeAbort = () => {};
              try {
                const content = await new Promise((resolveStep, rejectStep) => {
                  const abort = () => rejectStep(new Error("Acceptance cancelled"));
                  if (options?.signal?.aborted) { abort(); return; }
                  options?.signal?.addEventListener("abort", abort, { once: true });
                  removeAbort = () => options?.signal?.removeEventListener("abort", abort);
                  Promise.resolve().then(() => step(request, options)).then(resolveStep, rejectStep);
                });
                const message = { role: "assistant", api: model.api, provider, model: model.id, content, timestamp: Date.now(), usage: { ...usage, ...(compaction ? { input: 950, totalTokens: 951 } : {}) }, stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop" };
                stream.push({ type: "start", partial: message });
                for (const [contentIndex, block] of content.entries()) if (block.type === "text") stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
                stream.push({ type: "done", reason: message.stopReason, message });
              } catch (error) {
                stream.push({ type: "error", reason: options?.signal?.aborted ? "aborted" : "error", error: { role: "assistant", api: model.api, provider, model: model.id, content: [], timestamp: Date.now(), usage, stopReason: options?.signal?.aborted ? "aborted" : "error", errorMessage: error.message } });
              } finally { removeAbort(); }
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
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager ?? SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel(provider, "model"), ...(toolNames === null ? {} : { tools: toolNames }) });
    sessions.push(session);
    session.setAutoRetryEnabled(false);
    session.setAutoCompactionEnabled(Boolean(compaction));
    await session.bindExtensions({ mode: "rpc" });
    return session;
  };
  context.after(async () => {
    for (const session of sessions) { await session.abort(); session.dispose(); }
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { create, requests, lifecycle, cwd, agentDir };
}
