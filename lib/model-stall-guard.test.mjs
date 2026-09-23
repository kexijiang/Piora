import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  guardAssistantStream,
  installModelStallGuard,
  modelStallTimeoutMessage,
  readModelStallConfig,
} from "./model-stall-guard.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeMessage(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function guardOptions(overrides = {}) {
  return {
    model: { api: "anthropic-messages", provider: "anthropic", id: "test-model" },
    controller: new AbortController(),
    userSignal: undefined,
    firstEventTimeoutMs: 40,
    idleTimeoutMs: 40,
    ...overrides,
  };
}

test("readModelStallConfig honors env overrides and keeps defaults", () => {
  assert.deepEqual(readModelStallConfig({}), {
    firstEventTimeoutMs: 180_000,
    idleTimeoutMs: 120_000,
  });
  assert.deepEqual(readModelStallConfig({ PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "5000", PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "0" }), {
    firstEventTimeoutMs: 5_000,
    idleTimeoutMs: 0,
  });
  assert.deepEqual(readModelStallConfig({ PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "nonsense" }), {
    firstEventTimeoutMs: 180_000,
    idleTimeoutMs: 120_000,
  });
});

test("a silent model request fails as a retryable timeout", async () => {
  const source = createAssistantMessageEventStream();
  const options = guardOptions();
  const guarded = guardAssistantStream(source, options);
  const result = await guarded.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /timed out/);
  assert.equal(options.controller.signal.aborted, true);
  source.end();
});

test("the idle watchdog fires after data stops flowing", async () => {
  const source = createAssistantMessageEventStream();
  const options = guardOptions({ firstEventTimeoutMs: 1_000, idleTimeoutMs: 40 });
  const guarded = guardAssistantStream(source, options);
  source.push({ type: "start", partial: fakeMessage() });
  const result = await guarded.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /stream stopped sending data/);
  assert.equal(options.controller.signal.aborted, true);
});

test("streaming events keep resetting the idle watchdog", async () => {
  const source = createAssistantMessageEventStream();
  const options = guardOptions({ firstEventTimeoutMs: 200, idleTimeoutMs: 60 });
  const guarded = guardAssistantStream(source, options);
  const collected = [];
  const consumption = (async () => {
    for await (const event of guarded) collected.push(event.type);
  })();
  source.push({ type: "start", partial: fakeMessage() });
  for (let index = 0; index < 5; index += 1) {
    await sleep(20);
    source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial: fakeMessage() });
  }
  source.push({ type: "done", reason: "stop", message: fakeMessage({ stopReason: "stop" }) });
  await consumption;
  const result = await guarded.result();
  assert.equal(result.stopReason, "stop");
  assert.equal(collected.at(-1), "done");
});

test("a watchdog abort is reported as timeout even when the provider reports abort", async () => {
  const source = createAssistantMessageEventStream();
  const options = guardOptions();
  const guarded = guardAssistantStream(source, options);
  await sleep(60);
  source.push({ type: "error", reason: "aborted", error: fakeMessage({ stopReason: "aborted", errorMessage: "Request aborted" }) });
  const result = await guarded.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /timed out/);
});

test("a user abort is preserved as abort, not rewritten as timeout", async () => {
  const controller = new AbortController();
  const userSignal = controller.signal;
  const source = {
    [Symbol.asyncIterator]: async function* () {
      await sleep(5);
      controller.abort();
      throw new Error("Request aborted");
    },
    result: () => new Promise(() => {}),
  };
  const guarded = guardAssistantStream(source, {
    ...guardOptions({ userSignal, firstEventTimeoutMs: 1_000, idleTimeoutMs: 1_000 }),
  });
  const result = await guarded.result();
  assert.equal(result.stopReason, "aborted");
});

test("installModelStallGuard wraps once and passes a merged signal", async () => {
  const calls = [];
  const runtime = {
    streamSimple(model, context, options) {
      calls.push(options);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: fakeMessage() });
      stream.push({ type: "done", reason: "stop", message: fakeMessage() });
      stream.end();
      return stream;
    },
  };
  const env = { PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "1000", PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "1000" };
  assert.equal(installModelStallGuard(runtime, env), true);
  assert.equal(installModelStallGuard(runtime, env), false);
  const userSignal = AbortSignal.timeout(5_000);
  const guarded = runtime.streamSimple({}, {}, { signal: userSignal });
  const result = await guarded.result();
  assert.equal(result.stopReason, "stop");
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].signal, userSignal);
  assert.equal(calls[0].signal.aborted, false);
});

test("disabled timeouts still forward user cancellation", async () => {
  const calls = [];
  const runtime = {
    streamSimple(model, context, options) {
      calls.push(options);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: fakeMessage() });
      stream.end();
      return stream;
    },
  };
  const userSignal = AbortSignal.timeout(5_000);
  assert.equal(installModelStallGuard(runtime, { PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "0", PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "0" }), true);
  const stream = runtime.streamSimple({}, {}, { signal: userSignal });
  assert.equal(calls[0].signal.aborted, false);
  assert.equal((await stream.result()).stopReason, "stop");
});

test("session settings and per-request overrides take precedence over watchdog defaults", () => {
  const env = { PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "40", PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "40" };
  const settings = { getProviderRetrySettings: () => ({ timeoutMs: 600000 }), getHttpIdleTimeoutMs: () => 900000 };
  assert.deepEqual(readModelStallConfig(env, settings), { firstEventTimeoutMs: 600000, idleTimeoutMs: 900000 });
  assert.deepEqual(readModelStallConfig(env, settings, 1200000), { firstEventTimeoutMs: 1200000, idleTimeoutMs: 900000 });
  settings.getProviderRetrySettings = () => ({});
  settings.getHttpIdleTimeoutMs = () => 0;
  assert.deepEqual(readModelStallConfig(env, settings, 2147483647), { firstEventTimeoutMs: 0, idleTimeoutMs: 0 });
  assert.deepEqual(readModelStallConfig(env, settings, 90000), { firstEventTimeoutMs: 90000, idleTimeoutMs: 0 });
  assert.equal(readModelStallConfig({ PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "9999999999999" }).firstEventTimeoutMs, 2147483647);
});

test("new requests read changed settings while an existing stream keeps its timeout", async () => {
  let timeout = 1000;
  const sources = [];
  const runtime = { streamSimple() { const source = createAssistantMessageEventStream(); sources.push(source); return source; } };
  const settings = { getProviderRetrySettings: () => ({ timeoutMs: timeout }), getHttpIdleTimeoutMs: () => timeout };
  installModelStallGuard(runtime, { PIORA_MODEL_STALL_FIRST_EVENT_TIMEOUT_MS: "1" }, settings);
  const old = runtime.streamSimple({}, {});
  timeout = 20;
  const next = runtime.streamSimple({}, {});
  const keepAlive = sleep(60);
  assert.equal((await next.result()).stopReason, "error");
  sources[0].push({ type: "done", reason: "stop", message: fakeMessage() });
  assert.equal((await old.result()).stopReason, "stop");
  sources.forEach(source => source.end());
  await keepAlive;
});

test("a completely silent provider settles immediately on user abort even with no timeouts", async () => {
  for (const timeout of [0, 10000]) {
    const user = new AbortController();
    const source = createAssistantMessageEventStream();
    const options = guardOptions({ userSignal: user.signal, firstEventTimeoutMs: timeout, idleTimeoutMs: timeout });
    const guarded = guardAssistantStream(source, options);
    user.abort();
    assert.equal(options.controller.signal.aborted, true);
    const result = await guarded.result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.model, "test-model");
    const events = [];
    for await (const event of guarded) events.push(event.type);
    source.push({ type: "done", reason: "stop", message: fakeMessage() });
    assert.deepEqual(events, ["error"], "late provider output cannot revive the request");
    assert.equal((await guarded.result()).stopReason, "aborted");
  }
});

test("an already cancelled request never calls the provider", async () => {
  const runtime = { streamSimple() { assert.fail("must not start a cancelled request"); } };
  installModelStallGuard(runtime);
  const user = new AbortController(); user.abort();
  assert.equal((await runtime.streamSimple({}, {}, { signal: user.signal }).result()).stopReason, "aborted");
});

test("an unlimited idle timeout stays unlimited after the first event", async () => {
  const source = createAssistantMessageEventStream();
  const runtime = { streamSimple() { return source; } };
  installModelStallGuard(runtime, { PIORA_MODEL_STALL_IDLE_TIMEOUT_MS: "1" }, {
    getProviderRetrySettings: () => ({}), getHttpIdleTimeoutMs: () => 0,
  });
  const guarded = runtime.streamSimple({}, {}, { timeoutMs: 2147483647 });
  source.push({ type: "start", partial: fakeMessage() });
  await sleep(30);
  source.push({ type: "done", reason: "stop", message: fakeMessage() });
  assert.equal((await guarded.result()).stopReason, "stop");
});

test("timeout copy stays retryable and never reads as a cancellation", () => {
  for (const kind of ["first-event", "idle"]) {
    const message = modelStallTimeoutMessage(kind, 90_000);
    assert.match(message, /timed out/);
    assert.doesNotMatch(message, /abort|cancel/i);
  }
});
