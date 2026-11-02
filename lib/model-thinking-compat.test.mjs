import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, clampThinkingLevel } from "@earendil-works/pi-ai/models";

const { withModelThinkingCompat, installModelThinkingCompat } = await createJiti(import.meta.url).import("./model-thinking-compat.ts");
const base = { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017-Q4_K_M", api: "openai-completions", reasoning: true, provider: "fixture" };

test("V4.1 and Flash 1017/quantized IDs use valid default tiers without overriding explicit or unrelated models", () => {
  for (const id of [base.id, "dsv4.1", "dsv4.1-1017-zwei", "org/dsv4.1-1017-zwei", "DeepSeek-V4.1", "deepseek-ai/DeepSeek-V4.1", "DeepSeek-V4.1-1017", "DeepSeek-V4.1-Flash", "DeepSeek v4.1flash", "org/DeepSeek-V4_1-Flash-1017-FP8"]) {
    const model = withModelThinkingCompat({ ...base, id });
    assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "high", "xhigh", "max"]);
    assert.equal(clampThinkingLevel(model, "medium"), "high");
    assert.equal(clampThinkingLevel(model, "minimal"), "low");
  }
  assert.equal(base.thinkingLevelMap, undefined, "catalog input must not be mutated");
  for (const model of [
    { ...base, id: "dsv4.10-1017-zwei" }, { ...base, id: "prefix-dsv4.1-1017-zwei" }, { ...base, id: "DeepSeek-V4.10" }, { ...base, id: "DeepSeek-V4.1foo" }, { ...base, id: "DeepSeek-V4-Flash" }, { ...base, id: "DeepSeek-V4.10-Flash" },
    { ...base, id: "DeepSeek-V4.1-Flashlight" }, { ...base, id: "distill-DeepSeek-V4.1-Flash" },
    { ...base, reasoning: false }, { ...base, api: "anthropic-messages" },
    { ...base, thinkingLevelMap: { medium: "75", off: null } },
    { ...base, compat: { thinkingFormat: "openrouter" } },
  ]) assert.equal(withModelThinkingCompat(model), model);
  assert.deepEqual(getSupportedThinkingLevels(withModelThinkingCompat({ ...base, compat: { thinkingFormat: "deepseek" } })), ["off", "low", "high", "max"]);
});

test("real SDK requests reject the old medium value, then serialize valid efforts after runtime refresh", { timeout: 90000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "piora-thinking-compat-"));
  const payloads = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); payloads.push(body);
    const effort = body.chat_template_kwargs?.reasoning_effort ?? body.reasoning_effort;
    if (effort !== undefined && !["none", "low", "high", "xhigh", "max"].includes(effort)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "DeepSeek V4.1 reasoning_effort must be low,high,xhigh,max,or an integer within [1,100] in chat_template_kwargs" } })); return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const modelsPath = join(root, "models.json");
    const definition = { ...base, contextWindow: 32000, maxTokens: 8192 };
    const config = { providers: { fixture: { api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "fixture", models: [definition] } } };
    writeFileSync(modelsPath, JSON.stringify(config));
    const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json"), modelsStorePath: join(root, "catalog.json"), refreshOnCreate: false });
    const stale = runtime.getModel("fixture", base.id);
    const context = { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] };
    const send = (model, reasoning) => runtime.completeSimple(model, context, { reasoning, maxRetries: 0, timeoutMs: 5000 });
    const failed = await send(stale, "medium");
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage, /reasoning_effort must/);
    installModelThinkingCompat(runtime);
    const wrapped = runtime.streamSimple;
    installModelThinkingCompat(runtime);
    assert.equal(runtime.streamSimple, wrapped, "installation is idempotent");
    for (const [level, expected] of [[undefined, "none"], ["minimal", "low"], ["low", "low"], ["medium", "high"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]]) {
      const result = await send(stale, level);
      assert.notEqual(result.stopReason, "error", result.errorMessage);
      assert.equal(payloads.at(-1).reasoning_effort, expected);
    }
    await runtime.refresh({ allowNetwork: false });
    for (const model of [runtime.getModel("fixture", base.id), ...runtime.getModels("fixture"), ...await runtime.getAvailable("fixture")]) {
      assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "high", "xhigh", "max"]);
    }
    const templateModel = { ...stale, id: "dsv4.1-1017-zwei", compat: { thinkingFormat: "chat-template", chatTemplateKwargs: {
      thinking: { $var: "thinking.enabled" }, reasoning_effort: { $var: "thinking.effort", omitWhenOff: true },
    } } };
    for (const [level, expected] of [[undefined, { thinking: false }], ["medium", { thinking: true, reasoning_effort: "high" }]]) {
      assert.notEqual((await send(templateModel, level)).stopReason, "error");
      assert.deepEqual(payloads.at(-1).chat_template_kwargs, expected);
    }
    const nativeModel = { ...stale, compat: { thinkingFormat: "deepseek" } };
    assert.notEqual((await send(nativeModel, "medium")).stopReason, "error");
    assert.equal(payloads.at(-1).reasoning_effort, "high");
    assert.deepEqual(payloads.at(-1).thinking, { type: "enabled" });
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
