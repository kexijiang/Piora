import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const vision = await jiti.import("./vision-agent.ts");

const image = {
  type: "image",
  mimeType: "image/png",
  data: Buffer.from("synthetic-image-bytes").toString("base64"),
};

const config = {
  enabled: true,
  provider: "qwen",
  modelId: "qwen-vl",
};

function user(content) {
  return { role: "user", content, timestamp: Date.now() };
}

test("visual agent configuration is opt-in, fail-closed, and follows the selected agent directory", () => {
  assert.deepEqual(vision.parseVisionAgentConfig(undefined), {
    enabled: false,
    provider: null,
    modelId: null,
  });
  assert.deepEqual(vision.parseVisionAgentConfig('{"enabled":true,"provider":7}'), {
    enabled: false,
    provider: null,
    modelId: null,
  });

  const root = mkdtempSync(join(tmpdir(), "piora-vision-agent-"));
  try {
    const written = vision.writeVisionAgentConfig(config, root);
    assert.deepEqual(written, config);
    assert.deepEqual(vision.readVisionAgentConfig(root), config);
    assert.equal(
      vision.visionAgentConfigPath(root),
      join(root, "piora", "vision-agent.json"),
    );
    assert.match(readFileSync(vision.visionAgentConfigPath(root), "utf8"), /"qwen-vl"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model capability routing uses declared image input instead of provider or model names", () => {
  assert.equal(vision.modelSupportsImages({ input: ["text"] }), false);
  assert.equal(vision.modelSupportsImages({ input: ["text", "image"] }), true);
  assert.equal(vision.modelSupportsImages(undefined), false);
});

test("visual analysis reuses the active session registry so custom proxy overlays stay effective", async () => {
  let completedWith;
  const model = {
    provider: "qwen",
    id: "qwen-vl",
    name: "Qwen VL through proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.test/v1",
    input: ["text", "image"],
  };
  const registry = {
    getError: () => undefined,
    find: (provider, modelId) => provider === model.provider && modelId === model.id ? model : undefined,
    hasConfiguredAuth: (candidate) => candidate === model,
    complete: async (candidate, context) => {
      completedWith = { candidate, context };
      return {
        role: "assistant",
        content: [{ type: "text", text: "SUMMARY\nThe image reached the configured proxy model." }],
        stopReason: "stop",
        timestamp: Date.now(),
      };
    },
  };

  const observation = await vision.analyzeImagesWithVisionModel({
    config,
    images: [image],
    question: "Did the image arrive?",
    modelRegistry: registry,
    cwd: "this-must-not-create-a-second-runtime",
  });

  assert.equal(completedWith.candidate, model);
  assert.equal(completedWith.context.messages[0].content.some((block) => block.type === "image"), true);
  assert.match(observation, /configured proxy model/);
});

test("text-only context receives an observation while the persisted source message keeps its image", async () => {
  const source = user([
    { type: "text", text: "这张截图里报了什么错误？" },
    image,
  ]);
  let observedQuestion = "";
  let cached;
  const observationStarts = [];
  const transformed = await vision.transformContextForTextOnlyModel({
    messages: [source],
    config,
    observe: async (_images, question) => {
      observedQuestion = question;
      return "SUMMARY\nA settings screen shows an Access denied error.";
    },
    onObservationStart: (imageCount) => { observationStarts.push(imageCount); },
    onCacheEntry: (entry) => { cached = entry; },
  });

  assert.equal(observedQuestion, "这张截图里报了什么错误？");
  assert.deepEqual(observationStarts, [1]);
  assert.equal(source.content.some((block) => block.type === "image"), true);
  assert.equal(transformed[0].content.some((block) => block.type === "image"), false);
  assert.match(transformed[0].content.map((block) => block.text ?? "").join("\n"), /Access denied/);
  assert.equal(cached.provider, "qwen");
  assert.equal(cached.modelId, "qwen-vl");
  assert.equal("data" in cached, false);
});

test("a persisted observation cache prevents duplicate visual model calls", async () => {
  let calls = 0;
  let starts = 0;
  let entry;
  const messages = [user([{ type: "text", text: "Describe it" }, image])];
  await vision.transformContextForTextOnlyModel({
    messages,
    config,
    observe: async () => {
      calls += 1;
      return "SUMMARY\nCached observation";
    },
    onObservationStart: () => { starts += 1; },
    onCacheEntry: (value) => { entry = value; },
  });
  const cache = vision.restoreVisionObservationCache([{
    type: "custom",
    customType: vision.VISION_OBSERVATION_ENTRY_TYPE,
    data: entry,
  }]);
  const transformed = await vision.transformContextForTextOnlyModel({
    messages,
    config,
    cache,
    observe: async () => {
      calls += 1;
      return "should not run";
    },
    onObservationStart: () => { starts += 1; },
  });
  assert.equal(calls, 1);
  assert.equal(starts, 1);
  assert.match(transformed[0].content.map((block) => block.text ?? "").join("\n"), /Cached observation/);
});

test("a follow-up that references an earlier image requests a targeted fresh observation", async () => {
  const questions = [];
  const messages = [
    user([{ type: "text", text: "先看看这张图" }, image]),
    { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: Date.now() },
    user("这张图右上角的按钮是什么颜色？"),
  ];
  await vision.transformContextForTextOnlyModel({
    messages,
    config,
    observe: async (_images, question) => {
      questions.push(question);
      return "SUMMARY\nThe top-right button is blue.";
    },
  });
  assert.deepEqual(questions, ["这张图右上角的按钮是什么颜色？"]);
});

test("plain-text follow-ups do not retry uncached history, including messages about vision failures", async () => {
  const source = user([{ type: "text", text: "识别图片" }, image]);
  for (const prompt of ["继续修复设置页", "为什么识别图片失败，后面不带图片还调用视觉模型？", "Why did image recognition fail?", "Generate a diagram of this workflow"]) {
    let starts = 0;
    const messages = await vision.transformContextForTextOnlyModel({
      messages: [source, user(prompt)], config,
      observe: async () => { assert.fail("must not resend historical attachments"); },
      onObservationStart: () => { starts++; },
      onObservationFailure: () => { assert.fail("no new failure occurred"); },
    });
    assert.equal(starts, 0);
    assert.equal(messages[0].content.some(block => block.type === "image"), false);
    assert.match(messages[0].content.map(block => block.text ?? "").join("\n"), /historical image/);
    assert.equal(source.content.some(block => block.type === "image"), true, "original attachment survives");
  }
});

test("a failed observation is attempted only once across tool rounds in the same prompt", async () => {
  const failedAttempts = new Set(); let calls = 0, failures = 0;
  const source = user([{ type: "text", text: "inspect" }, image]);
  const options = {
    config, failedAttempts,
    observe: async () => { calls++; throw new Error("Request was aborted"); },
    onObservationFailure: () => { failures++; },
  };
  await vision.transformContextForTextOnlyModel({ ...options, messages: [source] });
  await vision.transformContextForTextOnlyModel({ ...options, messages: [source, { role: "toolResult", content: [{ type: "text", text: "tool result" }] }] });
  assert.equal(calls, 1);
  assert.equal(failures, 1);
  failedAttempts.clear();
  await vision.transformContextForTextOnlyModel({ ...options, messages: [source, user("重新识别上图")] });
  assert.equal(calls, 2, "an explicit retry is allowed in the next prompt");
});

test("new attachments and fresh tool screenshots are analyzed while historical successes are reused", async () => {
  const old = user([{ type: "text", text: "old image" }, image]);
  const cache = new Map(); let calls = 0;
  const options = {
    config, cache,
    observe: async () => { calls++; return "SUMMARY\nExisting observation"; },
    onCacheEntry: entry => cache.set(entry.key, entry),
  };
  await vision.transformContextForTextOnlyModel({ ...options, messages: [old] });
  const followup = user("Continue editing");
  const messages = await vision.transformContextForTextOnlyModel({ ...options, messages: [old, followup] });
  assert.equal(calls, 1);
  assert.match(messages[0].content.map(block => block.text ?? "").join("\n"), /Existing observation/);
  const freshImage = { ...image, data: Buffer.from("new screenshot").toString("base64") };
  await vision.transformContextForTextOnlyModel({ ...options, messages: [old, followup, { role: "toolResult", content: [freshImage] }] });
  assert.equal(calls, 2);
  await vision.transformContextForTextOnlyModel({ ...options, messages: [old, user([{ type: "text", text: "new question" }, image])] });
  assert.equal(calls, 3);
});

test("visual analysis failure strips user and tool-result images and tells the primary model not to guess", async () => {
  const messages = [
    user([{ type: "text", text: "inspect" }, image]),
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "screenshot",
      content: [{ type: "text", text: "screen" }, image],
      isError: false,
      timestamp: Date.now(),
    },
  ];
  let cacheWrites = 0;
  const failureReasons = [];
  const transformed = await vision.transformContextForTextOnlyModel({
    messages,
    config,
    observe: async () => { throw new Error("provider failed with private details"); },
    onCacheEntry: () => { cacheWrites += 1; },
    onObservationFailure: (reason) => { failureReasons.push(reason); },
  });
  assert.equal(cacheWrites, 0);
  // The status bar gets the failure reason (once per image group); the
  // conversation only gets a privacy-safe placeholder.
  assert.deepEqual(failureReasons, [
    "provider failed with private details",
    "provider failed with private details",
  ]);
  for (const message of transformed) {
    assert.equal(message.content.some((block) => block.type === "image"), false);
    const text = message.content.map((block) => block.text ?? "").join("\n");
    assert.match(text, /Do not guess/);
    assert.doesNotMatch(text, /private details/);
  }
});

test("disabled visual routing leaves the context untouched", async () => {
  const source = user([{ type: "text", text: "inspect" }, image]);
  let calls = 0;
  const transformed = await vision.transformContextForTextOnlyModel({
    messages: [source],
    config: { ...config, enabled: false },
    observe: async () => { calls += 1; return "unused"; },
  });
  assert.equal(calls, 0);
  assert.equal(transformed[0].content.some((block) => block.type === "image"), true);
});

test("aborting the prompt cancels visual routing instead of starting the primary request", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  await assert.rejects(
    vision.transformContextForTextOnlyModel({
      messages: [user([{ type: "text", text: "inspect" }, image])],
      config,
      signal: controller.signal,
      observe: async () => {
        controller.abort();
        throw reason;
      },
    }),
    reason,
  );
});

test("the first-party extension gates on runtime capability and never switches the primary model", () => {
  const extension = readFileSync(new URL("../extensions/piora-vision-agent.ts", import.meta.url), "utf8");
  assert.match(extension, /modelSupportsImages\(ctx\.model\)/);
  assert.match(extension, /api\.on\("context"/);
  assert.match(extension, /api\.on\("before_agent_start"/);
  assert.match(extension, /api\.on\("message_start"/);
  assert.match(extension, /api\.on\("agent_settled"/);
  assert.match(extension, /onObservationStart/);
  assert.match(extension, /modelRegistry:\s*ctx\.modelRegistry/);
  assert.match(extension, /cwd:\s*ctx\.cwd/);
  assert.doesNotMatch(extension, /setModel\(/);
  assert.doesNotMatch(extension, /provider\s*===\s*["'](?:glm|qwen)/i);
});

test("the settings API validates same-origin JSON and image-capable model availability", () => {
  const route = readFileSync(new URL("../app/api/vision-agent/route.ts", import.meta.url), "utf8");
  assert.match(route, /isApiRequestAllowed\(request\)/);
  assert.match(route, /hasJsonContentType\(request\)/);
  assert.match(route, /listVisionAgentModels\(cwd\)/);
  assert.match(route, /selected visual model is unavailable/i);
  assert.match(route, /resolveModelRequestCwd/);
  assert.match(route, /analyzeImagesWithVisionModel/);
});
