import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isModelUnavailable, availableFallbackModels, runPromptWithModelFallback, MAX_MODEL_FALLBACKS } = await jiti.import("./model-fallback.ts");
const model = (provider, id = "large", input = ["text", "image"]) => ({ provider, id, name: id, input, contextWindow: 128000 });
const ref = (value) => `${value.provider}/${value.id}`;

function fixture({ error = "503 Service unavailable", enabled = true, models = [model("primary"), model("backup")], patterns } = {}) {
  const messages = [];
  const switched = [];
  const notices = [];
  let promptCount = 0;
  let continuationCount = 0;
  let cancelled = false;
  const session = {
    model: models[0],
    agent: { state: { messages } },
    settingsManager: { getEnabledModels: () => patterns, reload: () => {} },
    getContextUsage: () => undefined,
    modelRuntime: { getAvailable: async () => models },
    setModel: async (next) => { switched.push(ref(next)); session.model = next; },
    sendCustomMessage: async (notice, options) => {
      notices.push(notice);
      messages.push({ role: "custom", ...notice });
      if (options.triggerTurn) {
        continuationCount += 1;
        messages.push({ role: "assistant", stopReason: "stop", content: "Done" });
      }
    },
  };
  const options = {
    session,
    enabled: () => enabled,
    assertActive: () => { if (cancelled) throw new Error("Prompt cancelled"); },
    onSwitch: () => {},
    prompt: async (admitted) => {
      promptCount += 1;
      admitted();
      messages.push({ role: "user", content: "Finish the task" });
      messages.push({ role: "toolResult", toolCallId: "already-done", content: "Saved file" });
      messages.push({ role: "assistant", stopReason: "error", errorMessage: error });
    },
  };
  return { session, messages, switched, notices, options, cancel: () => { cancelled = true; }, get promptCount() { return promptCount; }, get continuationCount() { return continuationCount; } };
}

test("classifies availability errors without treating tool/request/content errors as outages", () => {
  for (const error of ["401 Unauthorized", "402 Payment Required", "403 AccessDenied.Unpurchased", "404 endpoint missing", "429 insufficient_quota", "500 Internal Server Error", "502 Bad Gateway", "503 unavailable", "504 timeout", "529 overloaded", "No API key for provider/model", "Model not found: foo", "fetch failed", "余额不足"]) assert.equal(isModelUnavailable(error), true, error);
  for (const error of ["This operation was aborted", "Prompt cancelled", "400 invalid tool schema", "400 invalid parameter", "403 content_filter policy violation", "Maximum context length is 128000 tokens", "Too many tokens", "SyntaxError in extension"]) assert.equal(isModelUnavailable(error), false, error);
});

test("401, 402, and 500 each resume the same history without resubmitting the task", async () => {
  for (const error of ["401 Unauthorized", "402 insufficient credit", "500 Internal Server Error"]) {
    const f = fixture({ error });
    await runPromptWithModelFallback(f.options);
    assert.equal(f.promptCount, 1);
    assert.equal(f.continuationCount, 1);
    assert.deepEqual(f.switched, ["backup/large"]);
    assert.equal(f.messages.filter((m) => m.role === "user").length, 1);
    assert.equal(f.messages.filter((m) => m.toolCallId === "already-done").length, 1);
    assert.equal(f.notices[0].display, true);
    assert.deepEqual(f.notices[0].details, { from: "primary/large", to: "backup/large", attempt: 1 });
  }
});

test("disabled switch surfaces failure and never discovers or switches models", async () => {
  const f = fixture({ enabled: false });
  f.session.modelRuntime.getAvailable = async () => { throw new Error("must not discover"); };
  await assert.rejects(runPromptWithModelFallback(f.options), /503/);
  assert.deepEqual(f.switched, []);
});

test("successful tool-error handling does not switch models", async () => {
  const f = fixture();
  f.options.prompt = async (admitted) => {
    admitted();
    f.messages.push({ role: "toolResult", isError: true, content: "500 script failed" });
    f.messages.push({ role: "assistant", stopReason: "stop", content: "Please fix the script" });
  };
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, []);
});

test("credential preflight failure retries the user prompt only after selecting a model", async () => {
  const f = fixture();
  let calls = 0;
  f.options.prompt = async (admitted) => {
    calls += 1;
    if (calls === 1) throw new Error("No API key found for primary");
    admitted();
    f.messages.push({ role: "user", content: "task" }, { role: "assistant", stopReason: "stop" });
  };
  await runPromptWithModelFallback(f.options);
  assert.equal(calls, 2);
  assert.equal(f.continuationCount, 0);
  assert.equal(f.messages.filter((m) => m.role === "user").length, 1);
});

test("thrown extension/preflight errors do not replay input hooks", async () => {
  const f = fixture();
  f.options.prompt = async () => { throw new Error("500 extension hook failed"); };
  await assert.rejects(runPromptWithModelFallback(f.options), /extension hook/);
  assert.deepEqual(f.switched, []);
});

test("fallback attempts are bounded and never revisit a failed model", async () => {
  const f = fixture({ models: [model("primary"), ...Array.from({ length: 8 }, (_, i) => model(`backup-${i}`))] });
  f.session.sendCustomMessage = async () => { f.messages.push({ role: "assistant", stopReason: "error", errorMessage: "500 still down" }); };
  await assert.rejects(runPromptWithModelFallback(f.options), /500 still down/);
  assert.equal(f.switched.length, MAX_MODEL_FALLBACKS);
  assert.equal(new Set(f.switched).size, MAX_MODEL_FALLBACKS);
});

test("scopes and credentials constrain candidates; stale scopes do not open all providers", async () => {
  const models = [model("allowed"), model("disabled")];
  const runtime = { getAvailable: async () => models };
  assert.deepEqual((await availableFallbackModels(runtime, ["allowed/*:high"])).map(ref), ["allowed/large"]);
  assert.deepEqual(await availableFallbackModels(runtime, ["missing/*"]), []);
  const f = fixture({ models, patterns: ["allowed/*"] });
  await assert.rejects(runPromptWithModelFallback(f.options), /503/);
  assert.deepEqual(f.switched, []);
});

test("image context never falls back to a text-only model", async () => {
  const f = fixture({ models: [model("primary"), model("text", "large", ["text"]), model("vision")] });
  f.messages.push({ role: "user", content: [{ type: "image", data: "image" }] });
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, ["vision/large"]);
});

test("cancellation during model selection prevents any continuation", async () => {
  const f = fixture();
  f.session.setModel = async () => { f.cancel(); };
  await assert.rejects(runPromptWithModelFallback(f.options), /cancelled/);
  assert.equal(f.notices.length, 0);
});

test("does not switch a long conversation into an undersized context window", async () => {
  const f = fixture({ models: [model("primary"), { ...model("small"), contextWindow: 32000 }, model("large")] });
  f.session.getContextUsage = () => ({ tokens: 64000 });
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, ["large/large"]);
});

test("turning the switch off during discovery prevents selecting a backup", async () => {
  const f = fixture();
  let enabled = true;
  f.options.enabled = () => enabled;
  f.session.modelRuntime.getAvailable = async () => { enabled = false; return [model("primary"), model("backup")]; };
  await assert.rejects(runPromptWithModelFallback(f.options), /503/);
  assert.deepEqual(f.switched, []);
});

test("failed credential checks skip a candidate within the same bounded budget", async () => {
  const f = fixture({ models: [model("primary"), model("expired"), model("working")] });
  f.session.setModel = async (next) => {
    if (next.provider === "expired") throw new Error("No API key for expired");
    f.switched.push(ref(next)); f.session.model = next;
  };
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, ["working/large"]);
});

test("model failures do not poison another session's candidate list", async () => {
  const first = fixture({ enabled: false });
  await assert.rejects(runPromptWithModelFallback(first.options));
  const second = fixture({ models: [model("other"), model("primary")] });
  await runPromptWithModelFallback(second.options);
  assert.deepEqual(second.switched, ["primary/large"]);
});

test("a stale previous error does not fail a new extension command", async () => {
  const f = fixture();
  f.messages.push({ role: "assistant", stopReason: "error", errorMessage: "500 previous run" });
  f.options.prompt = async () => {};
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, []);
});

test("records a terminal model error even when compaction removed it from state", async () => {
  const f = fixture();
  let latest;
  f.options.lastAssistant = () => latest;
  f.options.prompt = async (admitted) => {
    admitted();
    f.messages.push({ role: "user", content: "task" });
    latest = { role: "assistant", stopReason: "error", errorMessage: "500 unavailable" };
  };
  const sendCustom = f.session.sendCustomMessage;
  f.session.sendCustomMessage = async (...args) => { await sendCustom(...args); latest = f.messages.at(-1); };
  await runPromptWithModelFallback(f.options);
  assert.deepEqual(f.switched, ["backup/large"]);
});
