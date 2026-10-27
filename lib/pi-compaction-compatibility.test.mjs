import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  compact, generateBranchSummary, generateSummary, generateSummaryWithUsage,
  SettingsManager, shouldCompact,
} from "@earendil-works/pi-coding-agent";
import { applyCompactionThresholdSettings } from "./compaction-settings.ts";

const model = {
  id: "summary-fixture", name: "Summary fixture", api: "openai-completions", provider: "fixture",
  baseUrl: "https://unused.invalid", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 32768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const usage = { input: 200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const history = [{ role: "user", content: [{ type: "text", text: "Keep this exact context." }], timestamp: 0 }];

function summaryStream(requests, stopReason = "stop") {
  return (selected, context, options) => {
    requests.push({ selected, context, options });
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", api: selected.api, provider: selected.provider, model: selected.id,
      content: [{ type: "text", text: "VERIFIED_SUMMARY " + "detail ".repeat(100) }],
      usage, stopReason, timestamp: 1,
    };
    queueMicrotask(() => stream.push({ type: "done", reason: stopReason, message }));
    return stream;
  };
}

function assertUncapped(request) {
  assert.equal(request.selected.maxTokens, 32768);
  assert.equal(Object.hasOwn(request.options, "maxTokens"), false, "SDK must leave output limit to the model");
  assert.equal(request.options.cacheRetention, "none");
}

test("saved Piora reserve changes the real SDK threshold, not its comparison boundary", async () => {
  const records = { global: "{}", project: "{}" };
  const manager = SettingsManager.fromStorage({ withLock(scope, update) {
    const next = update(records[scope]);
    if (next !== undefined) records[scope] = next;
  } });
  for (const reserveTokens of [0, 8192, 16384]) {
    await applyCompactionThresholdSettings(manager, { reserveTokens });
    const settings = manager.getCompactionSettings();
    const threshold = model.contextWindow - reserveTokens;
    assert.equal(shouldCompact(threshold, model.contextWindow, settings), false);
    assert.equal(shouldCompact(threshold + 1, model.contextWindow, settings), true);
    assert.equal(shouldCompact(threshold + 1, model.contextWindow, { ...settings, enabled: false }), false);
  }
});

test("Pi 1.4 summary helpers preserve usage, instructions and model output limit regardless of reserve", async () => {
  const requests = [];
  const stream = summaryStream(requests);
  for (const reserve of [0, 1, 16384]) {
    const result = await generateSummaryWithUsage(history, model, reserve, "fixture-key", undefined, undefined,
      "PRESERVE_CUSTOM_INSTRUCTIONS", "PREVIOUS_SUMMARY", "high", stream);
    assert.match(result.text, /VERIFIED_SUMMARY/);
    assert.deepEqual(result.usage, usage);
    assert.ok(result.usage.output > 1);
    const request = requests.at(-1);
    assertUncapped(request);
    assert.equal(request.options.reasoning, "high");
    assert.match(JSON.stringify(request.context), /PRESERVE_CUSTOM_INSTRUCTIONS/);
    assert.match(JSON.stringify(request.context), /PREVIOUS_SUMMARY/);
  }
  assert.match(await generateSummary(history, model, 1, "fixture-key", undefined, undefined,
    undefined, undefined, undefined, stream), /VERIFIED_SUMMARY/);
  assertUncapped(requests.at(-1));
});

test("Pi 1.4 branch and split-turn summaries retain instructions without a fixed output cap", async () => {
  const requests = [];
  const stream = summaryStream(requests);
  const branch = await generateBranchSummary([
    { type: "message", id: "history", parentId: null, timestamp: new Date(0).toISOString(), message: history[0] },
  ], { model, apiKey: "fixture-key", reserveTokens: 1, customInstructions: "BRANCH_FOCUS", streamFn: stream });
  assert.match(branch.summary, /VERIFIED_SUMMARY/);
  assert.deepEqual(branch.usage, usage);
  assert.match(JSON.stringify(requests.at(-1).context), /BRANCH_FOCUS/);
  assertUncapped(requests.at(-1));
  // No newly summarized history: the split prefix alone must retain /compact instructions.
  const result = await compact({
    firstKeptEntryId: "kept", messagesToSummarize: [], turnPrefixMessages: history, isSplitTurn: true,
    tokensBefore: 1000, previousSummary: "EXISTING_SUMMARY",
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
    settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 50 },
  }, model, "fixture-key", undefined, "SPLIT_TURN_FOCUS", undefined, "high", stream);
  assert.match(result.summary, /EXISTING_SUMMARY/);
  assert.match(result.summary, /VERIFIED_SUMMARY/);
  assert.equal(result.firstKeptEntryId, "kept");
  assert.deepEqual(result.usage, usage);
  assert.match(JSON.stringify(requests.at(-1).context), /SPLIT_TURN_FOCUS/);
  assertUncapped(requests.at(-1));
});

test("uncapped SDK summaries still reject incomplete output rather than persisting it", async () => {
  await assert.rejects(generateSummary(history, model, 1, "fixture-key", undefined, undefined,
    undefined, undefined, undefined, summaryStream([], "length")), /token cap.*incomplete/);
  const branch = await generateBranchSummary([
    { type: "message", id: "history", parentId: null, timestamp: new Date(0).toISOString(), message: history[0] },
  ], { model, apiKey: "fixture-key", streamFn: summaryStream([], "length") });
  assert.match(branch.error, /token cap.*incomplete/);
  assert.equal(branch.summary, undefined);
});
