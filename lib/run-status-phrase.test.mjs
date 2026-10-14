import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH,
  RUN_STATUS_PHRASE_OUTPUT_RULE,
  RUN_STATUS_PHRASE_PROMPTS,
  RUN_STATUS_PHRASE_STYLES,
  selectRunStatusPhrasePrompt,
  buildRunStatusPhraseMessages,
  RUN_STATUS_PHRASE_SYSTEM_PROMPT,
} = await jiti.import("./run-status-phrase-prompts.ts");
const {
  buildRunStatusPhraseRequest,
  createRunStatusPhraseScheduler,
  requestRunStatusPhrase,
  resolveDisplayedRunStatusPhrase,
  sanitizeRunStatusPhrase,
  isInstructionEcho,
  parseRunStatusPhraseRequestKey,
  encodeRunStatusPhraseRequest,
} = await jiti.import("./run-status-phrase.ts");
const {
  DEFAULT_RUN_STATUS_PHRASE_PREFERENCE,
  normalizeRunStatusPhrasePreference,
  parseStoredRunStatusPhrasePreference,
  serializeRunStatusPhrasePreference,
} = await jiti.import("./run-status-phrase-settings.ts");
const { settleRunElapsedView } = await jiti.import("./run-status-phrases.ts");

const PRESET_STYLES = RUN_STATUS_PHRASE_STYLES.filter((style) => style !== "custom");

test("prompt selection follows the style and the interface language", () => {
  assert.deepEqual(PRESET_STYLES, ["poetry", "quote", "meme", "piora"]);
  for (const style of PRESET_STYLES) {
    const zh = selectRunStatusPhrasePrompt(style, "zh-CN");
    const en = selectRunStatusPhrasePrompt(style, "en");
    assert.equal(zh, RUN_STATUS_PHRASE_PROMPTS[style]["zh-CN"]);
    assert.equal(en, RUN_STATUS_PHRASE_PROMPTS[style].en);
    assert.notEqual(zh, en);
    // Style text carries no output rule; the rule lives only in the system prompt.
    assert.ok(!zh.includes(RUN_STATUS_PHRASE_OUTPUT_RULE["zh-CN"]));
    assert.ok(!en.includes(RUN_STATUS_PHRASE_OUTPUT_RULE.en));
    const messages = buildRunStatusPhraseMessages(style, "zh-CN");
    assert.equal(messages.systemPrompt, RUN_STATUS_PHRASE_SYSTEM_PROMPT["zh-CN"]);
    assert.equal(messages.userMessage, zh);
    assert.notEqual(messages.systemPrompt, messages.userMessage);
  }
  assert.match(RUN_STATUS_PHRASE_SYSTEM_PROMPT["zh-CN"], /只输出一行/);
  assert.match(RUN_STATUS_PHRASE_SYSTEM_PROMPT.en, /exactly one line/i);

  assert.equal(selectRunStatusPhrasePrompt("custom", "zh-CN", "  \n"), null);
  const custom = buildRunStatusPhraseMessages("custom", "en", "  sound like a lighthouse keeper  ");
  assert.equal(custom.userMessage, "sound like a lighthouse keeper");
  assert.equal(custom.systemPrompt, RUN_STATUS_PHRASE_SYSTEM_PROMPT.en);
  assert.ok(!custom.systemPrompt.includes("lighthouse"));
  const capped = selectRunStatusPhrasePrompt("custom", "en", "x".repeat(RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH + 50));
  assert.equal(capped.length, RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH);

  assert.equal(buildRunStatusPhraseRequest({
    provider: " ",
    modelId: "m",
    locale: "zh-CN",
    style: "poetry",
    customPrompt: "",
  }), null);
  assert.equal(buildRunStatusPhraseRequest({
    provider: "p",
    modelId: "m",
    locale: "en",
    style: "custom",
    customPrompt: "   ",
  }), null);
  const request = buildRunStatusPhraseRequest({
    provider: " p ",
    modelId: " m ",
    cwd: " /tmp/work ",
    locale: "zh-CN",
    style: "quote",
    customPrompt: "",
  });
  assert.equal(request.style, "quote");
  assert.equal("prompt" in request, false);
  assert.equal("customPrompt" in request, false);
  const customRequest = buildRunStatusPhraseRequest({
    provider: "p", modelId: "m", locale: "en", style: "custom", customPrompt: " be terse ",
  });
  assert.equal(customRequest.customPrompt, "be terse");
  assert.deepEqual(parseRunStatusPhraseRequestKey(encodeRunStatusPhraseRequest(customRequest)), customRequest);
  assert.equal(parseRunStatusPhraseRequestKey(JSON.stringify({ provider: "p", modelId: "m", locale: "en", prompt: "x" })), null);
  assert.deepEqual(
    { provider: request.provider, modelId: request.modelId, cwd: request.cwd, locale: request.locale },
    { provider: "p", modelId: "m", cwd: "/tmp/work", locale: "zh-CN" },
  );
});

test("sanitization keeps one short line and drops markup", () => {
  assert.equal(sanitizeRunStatusPhrase("  “海内存知己”\n第二行", "zh-CN"), "海内存知己");
  assert.equal(sanitizeRunStatusPhrase("```md\n**hello**\n```", "en"), "hello");
  assert.equal(sanitizeRunStatusPhrase('"**only quotes**"', "en"), "only quotes");
  assert.equal(sanitizeRunStatusPhrase("状态：海内存知己", "zh-CN"), "海内存知己");
  assert.equal(sanitizeRunStatusPhrase("   ", "en"), null);
  assert.equal(sanitizeRunStatusPhrase("!!!", "en"), null);
  assert.equal(sanitizeRunStatusPhrase(null, "en"), null);
  assert.equal(sanitizeRunStatusPhrase("字".repeat(50), "zh-CN").length, 40);
  assert.equal(Array.from(sanitizeRunStatusPhrase("a".repeat(100), "en")).length, 80);
  assert.equal(sanitizeRunStatusPhrase(RUN_STATUS_PHRASE_PROMPTS.poetry["zh-CN"], "zh-CN"), null);
  assert.equal(sanitizeRunStatusPhrase(RUN_STATUS_PHRASE_PROMPTS.poetry.en, "en"), null);
});

test("instruction echo needs an exact or long copied match", () => {
  // Short real phrases that happen to start an instruction line survive.
  assert.equal(isInstructionEcho("请随机"), false);
  assert.equal(isInstructionEcho("Give one"), false);
  assert.equal(isInstructionEcho("Write one"), false);
  assert.equal(sanitizeRunStatusPhrase("请随机", "zh-CN"), "请随机");
  assert.equal(sanitizeRunStatusPhrase("Write one more line", "en"), "Write one more line");
  assert.equal(isInstructionEcho("海内存知己，天涯若比邻"), false);
  // Exact or near-exact echoes are dropped.
  assert.equal(isInstructionEcho(RUN_STATUS_PHRASE_PROMPTS.quote["zh-CN"]), true);
  assert.equal(isInstructionEcho(` ${RUN_STATUS_PHRASE_PROMPTS.meme.en.toUpperCase()}!`), true);
  assert.equal(isInstructionEcho("请随机给出一句著名的名人名言"), true);
  assert.equal(isInstructionEcho(RUN_STATUS_PHRASE_SYSTEM_PROMPT.en), true);
});

test("generation stays off by default and falls back to the fixed phrase", () => {
  assert.equal(DEFAULT_RUN_STATUS_PHRASE_PREFERENCE.enabled, false);
  assert.equal(DEFAULT_RUN_STATUS_PHRASE_PREFERENCE.style, "piora");
  assert.deepEqual(parseStoredRunStatusPhrasePreference(null), DEFAULT_RUN_STATUS_PHRASE_PREFERENCE);
  assert.deepEqual(parseStoredRunStatusPhrasePreference("not-json"), DEFAULT_RUN_STATUS_PHRASE_PREFERENCE);
  assert.deepEqual(normalizeRunStatusPhrasePreference({ enabled: "yes", style: "later" }), {
    schemaVersion: 1,
    enabled: false,
    style: "piora",
    customPrompt: "",
  });
  const stored = {
    schemaVersion: 1,
    enabled: true,
    style: "meme",
    customPrompt: "词".repeat(RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH + 8),
  };
  const roundTrip = parseStoredRunStatusPhrasePreference(serializeRunStatusPhrasePreference(stored));
  assert.equal(roundTrip.enabled, true);
  assert.equal(roundTrip.style, "meme");
  assert.equal(Array.from(roundTrip.customPrompt).length, RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH);

  const fixedPhrase = "随身舱的灯还亮着";
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: false,
    fixedPhrase,
    generated: "新的一行",
    locale: "zh-CN",
  }), fixedPhrase);
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: true,
    fixedPhrase,
    generated: null,
    locale: "zh-CN",
  }), fixedPhrase);
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: true,
    fixedPhrase,
    generated: "   ",
    locale: "zh-CN",
  }), fixedPhrase);
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: true,
    fixedPhrase,
    generated: RUN_STATUS_PHRASE_PROMPTS.meme["zh-CN"],
    locale: "zh-CN",
  }), fixedPhrase);
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: true,
    fixedPhrase,
    generated: "“新的一行”\n解释",
    locale: "zh-CN",
  }), "新的一行");
});

test("a turn claims one generation and prefetches the next line", async () => {
  const calls = [];
  let pending = [];
  const scheduler = createRunStatusPhraseScheduler((key) => {
    calls.push(key);
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    pending.push({ key, resolve });
    return promise;
  });

  assert.equal(scheduler.claimTurn("turn-1", null), null);
  scheduler.noteIdleKey("key-a");
  assert.equal(calls.length, 0);

  const first = scheduler.claimTurn("turn-1", "key-a");
  const again = scheduler.claimTurn("turn-1", "key-a");
  assert.equal(again, first);
  await Promise.resolve();
  assert.deepEqual(calls, ["key-a", "key-a"]);
  scheduler.prefetchNext("key-a");
  assert.equal(calls.length, 2);

  pending[0].resolve("  “这一轮” ");
  pending[1].resolve("下一轮");
  assert.equal(await first, "  “这一轮” ");

  const second = scheduler.claimTurn("turn-2", "key-a");
  assert.equal(await second, "下一轮");
  assert.equal(calls.length, 3);
  scheduler.noteIdleKey("key-b");
  await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.equal(scheduler.claimTurn("turn-2", "key-b"), second);
  await Promise.resolve();
  assert.equal(calls.length, 3);

  const failedCalls = [];
  const failing = createRunStatusPhraseScheduler(async (key) => {
    failedCalls.push(key);
    throw new Error("down");
  });
  const failed = failing.claimTurn("turn-1", "key");
  assert.equal(failing.claimTurn("turn-1", "key"), failed);
  assert.equal(await failed, null);
  assert.equal(failedCalls.length, 2);
  assert.equal(resolveDisplayedRunStatusPhrase({
    enabled: true,
    fixedPhrase: "随身舱的灯还亮着",
    generated: await failed,
    locale: "zh-CN",
  }), "随身舱的灯还亮着");
});

test("dropped prefetches are aborted", async () => {
  const signals = [];
  const scheduler = createRunStatusPhraseScheduler((key, signal) => {
    signals.push({ key, signal });
    return new Promise(() => {});
  });
  scheduler.prefetchNext("key-a");
  await Promise.resolve();
  assert.equal(signals.length, 1);
  scheduler.noteIdleKey("key-b");
  assert.equal(signals[0].signal.aborted, true);
  scheduler.prefetchNext("key-a");
  await Promise.resolve();
  scheduler.dispose();
  assert.equal(signals[1].signal.aborted, true);
  scheduler.prefetchNext("key-a");
  await Promise.resolve();
  scheduler.claimTurn("turn-1", "key-a");
  await Promise.resolve();
  // The claimed request keeps running; only the new next-turn prefetch is cancellable.
  assert.equal(signals[2].signal.aborted, false);
  scheduler.dispose();
  assert.equal(signals[2].signal.aborted, false);
  assert.equal(signals[3].signal.aborted, true);
});

test("the phrase request sanitizes a model line and swallows transport failures", async () => {
  const ok = async () => new Response(JSON.stringify({ phrase: "“海内存知己”\n第二行" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(await requestRunStatusPhrase({
    provider: "p",
    modelId: "m",
    locale: "zh-CN",
    style: "poetry",
  }, ok), "海内存知己");

  const unavailable = async () => new Response(JSON.stringify({ error: "phrase_unavailable" }), { status: 502 });
  assert.equal(await requestRunStatusPhrase({
    provider: "p",
    modelId: "m",
    locale: "en",
    style: "poetry",
  }, unavailable), null);
  assert.equal(await requestRunStatusPhrase({
    provider: "p",
    modelId: "m",
    locale: "en",
    style: "poetry",
  }, async () => { throw new Error("offline"); }), null);
});

test("a server start time keeps the turn id that generation is claimed against", () => {
  const started = settleRunElapsedView({
    running: true,
    runStartedAt: null,
    now: 1_000,
    view: null,
    previousPhraseId: null,
    random: () => 0,
  });
  const adopted = settleRunElapsedView({
    running: true,
    runStartedAt: 800,
    now: 5_000,
    view: started.view,
    previousPhraseId: started.previousPhraseId,
    random: () => 0.9,
  });
  assert.equal(adopted.view.turnId, started.view.turnId);
  assert.equal(adopted.view.phraseId, started.view.phraseId);

  const finished = settleRunElapsedView({
    running: false,
    runStartedAt: null,
    now: 9_000,
    view: adopted.view,
    previousPhraseId: adopted.previousPhraseId,
    random: () => 0.9,
  });
  assert.equal(finished.view.turnId, started.view.turnId);

  const next = settleRunElapsedView({
    running: true,
    runStartedAt: 9_000,
    now: 9_000,
    view: finished.view,
    previousPhraseId: finished.previousPhraseId,
    random: () => 0,
  });
  assert.notEqual(next.view.turnId, started.view.turnId);
});

test("settings and the status line use the current model path once per turn", () => {
  const settingsDialog = readFileSync(new URL("../components/SettingsDialog.tsx", import.meta.url), "utf8");
  const status = readFileSync(new URL("../components/RunElapsedStatus.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../app/api/run-status-phrase/route.ts", import.meta.url), "utf8");
  const search = readFileSync(new URL("./settings-search.ts", import.meta.url), "utf8");
  assert.match(settingsDialog, /data-settings-id="conversation\.runStatusPhrase"/);
  assert.match(settingsDialog, /useRunStatusPhrasePreference/);
  assert.match(settingsDialog, /RUN_STATUS_PHRASE_STYLES/);
  assert.match(status, /claimTurn/);
  assert.match(status, /prefetchNext/);
  assert.match(status, /dispose\(\)/);
  assert.doesNotMatch(route, /systemPrompt: parsed\.prompt/);
  assert.match(route, /systemPrompt: parsed\.systemPrompt/);
  assert.match(route, /content: parsed\.userMessage/);
  assert.match(route, /RUN_STATUS_PHRASE_CUSTOM_MAX_LENGTH/);
  assert.match(status, /resolveDisplayedRunStatusPhrase/);
  assert.match(route, /isApiRequestAllowed/);
  assert.match(route, /hasJsonContentType/);
  assert.match(route, /parseJsonWithinLimit/);
  assert.match(route, /resolveModelRequestCwd/);
  assert.match(route, /createTrustedModelServices/);
  assert.match(route, /completeSimple/);
  assert.match(search, /conversation\.runStatusPhrase/);
});
