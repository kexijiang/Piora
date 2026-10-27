import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, createDiscoveryAbort, parseDiscoveredModels, requestDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("reads context and max output from known provider fields and drops illegal pairs", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "or", context_length: 200000, top_provider: { max_completion_tokens: 8192 } }] }), [
    { id: "or", contextWindow: 200000, maxTokens: 8192 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "order", context_length: 0, context_window: 4096, max_output_tokens: 1.5, max_completion_tokens: 128 }] }), [
    { id: "order", contextWindow: 4096, maxTokens: 128 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "nested", top_provider: { context_length: 1000, max_completion_tokens: 100 } }] }), [
    { id: "nested", contextWindow: 1000, maxTokens: 100 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "vllm", max_model_len: 32768 }] }), [
    { id: "vllm", contextWindow: 32768 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini", inputTokenLimit: 1000000, outputTokenLimit: 8192 }] }), [
    { id: "gemini", contextWindow: 1000000, maxTokens: 8192 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "claude", max_input_tokens: 200000, max_tokens: 4096 }] }, { api: "anthropic-messages" }), [
    { id: "claude", contextWindow: 200000, maxTokens: 4096 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "openai", max_tokens: 4096, limit: { context: 8000, output: 1000 } }] }), [
    { id: "openai", contextWindow: 8000, maxTokens: 1000 },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "bad", context_length: 100, max_completion_tokens: 101 }, { id: "text", context_length: "100", max_tokens: 50 }] }), [
    { id: "bad" },
    { id: "text" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "skip", context_length: -1, max_model_len: Infinity, inputTokenLimit: 32, max_completion_tokens: Number.NaN }] }), [
    { id: "skip", contextWindow: 32 },
  ]);
});

test("discovery aborts on timeout or parent cancel and omits saved models", async () => {
  const timed = createDiscoveryAbort(undefined, 30);
  await new Promise((resolve) => timed.signal.addEventListener("abort", resolve, { once: true }));
  assert.equal(timed.timedOut(), true);
  timed.dispose();

  const parent = new AbortController();
  const child = createDiscoveryAbort(parent.signal, 5_000);
  parent.abort();
  assert.equal(child.signal.aborted, true);
  assert.equal(child.timedOut(), false);
  child.dispose();

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ models: [{ id: "m", contextWindow: 10, maxTokens: 4 }], endpoint: "https://example.invalid/v1/models" }), { status: 200 });
  };
  try {
    const result = await requestDiscoveredModels({
      providerName: "p",
      provider: { baseUrl: "https://example.invalid/v1", apiKey: "secret", models: [{ id: "old" }] },
    });
    assert.equal(calls[0].provider.apiKey, "secret");
    assert.equal(calls[0].provider.models, undefined);
    assert.deepEqual(result.models, [{ id: "m", contextWindow: 10, maxTokens: 4 }]);
  } finally {
    globalThis.fetch = original;
  }

  const route = readFileSync(new URL("../app/api/models-config/discover/route.ts", import.meta.url), "utf8");
  assert.match(route, /parseDiscoveredModels\(payload,\s*\{\s*api\s*\}\)/);
  assert.match(route, /AbortSignal\.any\(\[req\.signal,\s*AbortSignal\.timeout\(MODEL_DISCOVERY_TIMEOUT_MS\)\]\)/);
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});
