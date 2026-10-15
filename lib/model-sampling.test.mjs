import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import ts from "typescript";
import { createJiti } from "jiti";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as models from "@earendil-works/pi-ai/models";
import * as options from "@earendil-works/pi-ai/api/simple-options";

const sampling = await createJiti(import.meta.url).import("./model-sampling.ts");

test("sampling validation allows free-form keys but rejects invalid objects, known values and provider level names", () => {
  for (const value of [undefined, {}, { temperature: 0, top_p: 1, seed: -12, top_k: -1, vendor: { nested: [true, null] } }]) {
    assert.equal(sampling.samplingParamsError(value), null);
  }
  for (const value of [null, [], "{bad", { temperature: NaN }, { top_p: 1.1 }, { top_k: 1.5 }, { seed: Infinity }, JSON.parse('{"vendor":{"number":1e999}}')]) {
    assert.ok(sampling.samplingParamsError(value));
  }
  assert.match(sampling.modelSamplingError({ samplingParamsByThinkingLevel: { provider_high: {} } }), /Pi thinking level/);
  assert.match(sampling.modelSamplingError({ samplingParamsByThinkingLevel: { high: [] } }), /JSON object/);
  assert.throws(() => sampling.validateModelSamplingConfig({ providers: { p: { modelOverrides: { builtin: { samplingParams: [] } } } } }));
});

function loadTestRoute(directory) {
  const source = fs.readFileSync("app/api/models-config/test/route.ts", "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const dependencies = {
    "next/server": { NextResponse: Response }, fs, os, path,
    "@earendil-works/pi-coding-agent": { ModelRuntime: { create: args => ModelRuntime.create({
      ...args, authPath: path.join(directory, "auth.json"), modelsStorePath: path.join(directory, "catalog.json"), refreshOnCreate: false,
    }) } },
    "@earendil-works/pi-ai/models": models,
    "@earendil-works/pi-ai/api/simple-options": options,
    "@/lib/model-sampling": sampling,
    "@/lib/request-security": { isApiRequestAllowed: () => true, hasJsonContentType: () => true },
    "@/lib/model-runtime-context": { ModelRequestCwdError: class extends Error {} },
  };
  const exports = {};
  new Function("require", "exports", js)(id => { assert.ok(id in dependencies, id); return dependencies[id]; }, exports);
  return async body => {
    const response = await exports.POST(new Request("http://localhost/api/models-config/test", { method: "POST", body: JSON.stringify(body) }));
    return { httpStatus: response.status, ...await response.json() };
  };
}

test("draft preview and controlled provider payload agree for all supported APIs; rejection stays intact", { timeout: 90000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piora-sampling-"));
  const payloads = [];
  let rejectParameter = false;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    payloads.push(body);
    if (rejectParameter) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unsupported parameter: vendor_custom", type: "invalid_request_error", code: "unsupported_parameter" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url.includes("chat/completions")) {
      res.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    } else {
      const events = [
        { type: "response.created", response: { id: "fixture", status: "in_progress" } },
        { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] } },
        { type: "response.completed", response: { id: "fixture", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ];
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const post = loadTestRoute(directory);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const definition = {
    id: "fixture-model", reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, high: "provider-high" },
    samplingParams: { temperature: 0.6, top_p: 0.9, vendor_custom: { inherited: true } },
    samplingParamsByThinkingLevel: { off: { temperature: 0.1 }, medium: { top_p: 0.5 }, high: { temperature: 0.8 } },
  };
  try {
    for (const api of sampling.SAMPLING_APIS) {
      const body = { providerName: "piora-sampling-fixture", provider: { api, baseUrl, apiKey: "fixture-key" }, model: definition };
      for (const [thinkingLevel, effective, levelParams] of [
        ["off", "off", { temperature: 0.1 }], ["low", "medium", { top_p: 0.5 }],
        ["max", "high", { temperature: 0.8 }],
      ]) {
        const requestSamplingParams = { top_p: 0.7, request_only: true };
        const expected = { ...definition.samplingParams, ...levelParams, ...requestSamplingParams };
        const before = payloads.length;
        const preview = await post({ ...body, thinkingLevel, requestSamplingParams, previewOnly: true });
        assert.equal(preview.ok, true, JSON.stringify(preview));
        assert.equal(payloads.length, before, "preview must never contact a provider");
        assert.equal(preview.samplingPreview.effectiveThinkingLevel, effective);
        assert.deepEqual(preview.samplingPreview.params, expected);
        const result = await post({ ...body, thinkingLevel, requestSamplingParams });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.responseText, "OK");
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(payloads.at(-1)[key], value, `${api}: ${key}`);
      }
      const withoutOverride = await post({ ...body, model: { ...definition, samplingParamsByThinkingLevel: undefined }, thinkingLevel: "medium", previewOnly: true });
      assert.deepEqual(withoutOverride.samplingPreview.params, definition.samplingParams);
      const unconfigured = await post({ ...body, model: { id: "fixture-model" } });
      assert.equal(unconfigured.ok, true, JSON.stringify(unconfigured));
      for (const key of ["temperature", "top_p", "vendor_custom"]) assert.equal(Object.hasOwn(payloads.at(-1), key), false);
      const nonReasoning = await post({ ...body, model: { ...definition, reasoning: false }, thinkingLevel: "max", previewOnly: true });
      assert.equal(nonReasoning.samplingPreview.effectiveThinkingLevel, "off");
      assert.equal(nonReasoning.samplingPreview.params.temperature, 0.1);
      rejectParameter = true;
      const requestsBeforeRejection = payloads.length;
      const rejected = await post(body);
      assert.equal(rejected.ok, false);
      assert.equal(payloads.length, requestsBeforeRejection + 1, "must not retry with guessed parameters");
      assert.match(rejected.error, /Unsupported parameter: vendor_custom/);
      rejectParameter = false;
    }
    const before = payloads.length;
    const unsupported = await post({ providerName: "piora-sampling-fixture", provider: { api: "anthropic-messages", baseUrl, apiKey: "fixture" }, model: definition, previewOnly: true });
    assert.equal(unsupported.ok, true, JSON.stringify(unsupported));
    assert.equal(unsupported.samplingPreview.applicable, false);
    assert.equal(unsupported.samplingPreview.params, null);
    assert.equal(payloads.length, before);
    const invalid = await post({ providerName: "fixture", provider: {}, model: { id: "x", samplingParams: "{oops" }, previewOnly: true });
    assert.equal(invalid.httpStatus, 400);
    assert.equal(payloads.length, before);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
