import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
const { HarmonyRequestError } = await createJiti(import.meta.url).import("../lib/harmony/request-error.ts");

const source = await readFile(new URL("./useHarmonyLiveFrame.ts", import.meta.url), "utf8");

function virtualClock() {
  const timers = new Map();
  let elapsed = 0;
  let nextTimer = 0;
  return {
    timers,
    now: () => elapsed,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms, dueAt: elapsed + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(milliseconds) {
      const target = elapsed + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
        if (!next) break;
        elapsed = next[1].dueAt;
        timers.delete(next[0]);
        next[1].fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      elapsed = target;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

async function mountLiveFrame(videoResponse, decoderClass, geometryResponse, options = {}) {
  const timers = options.clock?.timers ?? new Map();
  const states = [];
  const calls = [];
  const painted = [];
  const canvas = { width: 100, height: 200, getContext: () => ({ clearRect() {}, drawImage(frame) { painted.push(frame); } }) };
  let nextTimer = 0;
  let effect;
  const window = {
    setTimeout(fn, ms) {
      if (options.clock) return options.clock.setTimeout(fn, ms);
      const id = ++nextTimer; timers.set(id, { fn, ms }); return id;
    },
    clearTimeout(id) { if (options.clock) options.clock.clearTimeout(id); else timers.delete(id); },
    ...(decoderClass ? { VideoDecoder: decoderClass } : {}),
  };
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, window, document: { hidden: false }, AbortController,
    performance: options.clock ? { now: options.clock.now } : performance,
    Uint8Array, Uint8ClampedArray, DataView, Blob,
    VideoDecoder: decoderClass,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    require(name) { if(name.includes("request-error")) return { HarmonyRequestError }; return {
      useCallback: (fn) => fn,
      useEffect: (fn) => { effect = fn; },
      useState(initial) { const index = states.length; states.push(initial); return [initial, (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    }; },
    async fetch(url, options) {
      calls.push(url);
      if (url.includes("/video?")) return await videoResponse(options);
      if (url.includes("/geometry?")) return geometryResponse ? geometryResponse(options) : { ok: true, async json() { return { geometry: { geometryId: "geometry", frameWidth: 100, frameHeight: 200 } }; } };
      return { ok: true, headers: new Headers({ "X-Harmony-Generation": "1", "X-Harmony-Revision": "1" }), async blob() { return new Blob(["frame"]); } };
    },
    async createImageBitmap() { return { width: 100, height: 200, close() {} }; },
  });
  exports.useHarmonyLiveFrame({ active: true, enabled: true, serial: "phone", generation: 1, fallbackError: "failed",
    canvasRef: { current: canvas },
  });
  const cleanup = effect();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  return { timers, states, calls, canvas, painted, cleanup, flush };
}

function jpegFrame(width = 100, height = 200) {
  const packet = (type, payload) => {
    const bytes = Buffer.alloc(8 + payload.length);
    bytes.writeUInt32BE(type, 0); bytes.writeUInt32BE(payload.length, 4); payload.copy(bytes, 8);
    return bytes;
  };
  const config = Buffer.alloc(13);
  config[0] = 2; config.writeUInt32BE(width, 1); config.writeUInt32BE(height, 5); config.writeUInt32BE(30, 9);
  return Buffer.concat([packet(2, config), packet(3, Buffer.alloc(10))]);
}

test("late geometry enables a static frame immediately and failed probes revoke it automatically", async () => {
  let resolveGeometry;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(jpegFrame()); },
  })), undefined, () => new Promise(resolve => { resolveGeometry = resolve; }));
  try {
    assert.equal(hook.states[1], "live", "geometry probing must not block display of the first frame");
    assert.equal(hook.states[4].geometryId, undefined);
    assert.equal(hook.states[5], null);
    resolveGeometry({ ok: true, json: async () => ({ geometry: { geometryId: "ready", frameWidth: 100, frameHeight: 200 } }) });
    await hook.flush();
    assert.equal(hook.states[4].geometryId, "ready", "no extra video frame should be needed");
    [...hook.timers.values()].find(timer => timer.ms === 1500).fn();
    resolveGeometry({ ok: false });
    await hook.flush();
    assert.equal(hook.states[4].geometryId, undefined, "failed automatic probes revoke stale coordinates");
    [...hook.timers.values()].filter(timer => timer.ms === 1500).at(-1).fn();
    resolveGeometry({ ok: true, json: async () => ({ geometry: { geometryId: "recovered", frameWidth: 100, frameHeight: 200 } }) });
    await hook.flush();
    assert.equal(hook.states[4].geometryId, "recovered");
  } finally { hook.cleanup(); }
});

test("late geometry cannot revive input after resize or teardown", async () => {
  const pending = [];
  let stream;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { stream = controller; controller.enqueue(jpegFrame()); },
  })), undefined, () => new Promise(resolve => { pending.push(resolve); }));
  try {
    stream.enqueue(jpegFrame(200, 100));
    await hook.flush();
    pending[0]({ ok: true, json: async () => ({ geometry: { geometryId: "old", frameWidth: 100, frameHeight: 200 } }) });
    await hook.flush();
    assert.equal(hook.states[4].width, 200);
    assert.equal(hook.states[4].geometryId, undefined);
    hook.cleanup();
    pending[1]({ ok: true, json: async () => ({ geometry: { geometryId: "late", frameWidth: 200, frameHeight: 100 } }) });
    await hook.flush();
    assert.equal(hook.states[4].geometryId, undefined);
    assert.equal([...hook.timers.values()].some(timer => timer.ms === 1500), false);
  } finally { hook.cleanup(); }
});

test("fallback displays pixels before calibration and ignores a probe finishing after teardown", async () => {
  let resolveGeometry;
  const hook = await mountLiveFrame(async () => ({ ok: false, status: 503, json: async () => ({ error: "video unavailable" }) }),
    undefined, () => new Promise(resolve => { resolveGeometry = resolve; }));
  try {
    assert.equal(hook.states[1], "live");
    assert.equal(hook.states[2], "frames");
    assert.equal(hook.states[5], "video unavailable", "healthy compatible frames must retain the native failure reason");
    assert.equal(hook.states[4].width, 100);
    assert.equal(hook.states[4].geometryId, undefined);
    hook.cleanup();
    resolveGeometry({ ok: true, json: async () => ({ geometry: { geometryId: "old-phone", frameWidth: 100, frameHeight: 200 } }) });
    await hook.flush();
    assert.equal(hook.states[4].geometryId, undefined);
  } finally { hook.cleanup(); }
});

test("a connected but silent stream times out into working frame fallback", async () => {
  let cancelled = false;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  try {
    const watchdog = [...hook.timers.values()].find((timer) => timer.ms === 15_000);
    assert.ok(watchdog);
    watchdog.fn();
    await hook.flush();
    assert.ok(cancelled);
    assert.ok(hook.calls.some((url) => url.includes("/frame?")));
    assert.equal(hook.states[1], "live", hook.states[3]);
    assert.equal(hook.states[2], "frames");
    assert.equal(hook.states[5], "Harmony video stopped producing frames");
  } finally { hook.cleanup(); }
});

test("capture termination revokes a displayed frame and reconnects only to fresh stream data", async () => {
  let currentStream;
  let connections = 0;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) {
      currentStream = controller;
      connections++;
      controller.enqueue(connections === 1 ? jpegFrame() : jpegFrame(200, 100));
    },
  })));
  try {
    assert.equal(hook.states[1], "live");
    assert.equal(hook.states[4].geometryId, "geometry");
    currentStream.close();
    await hook.flush();
    assert.equal(hook.states[1], "error", "a previous displayed frame cannot imply a live capture after EOF");
    assert.equal(hook.states[4].geometryId, undefined);
    assert.equal(hook.states[5], "Harmony video connection closed");
    assert.equal(connections, 1, "recovery must respect the connection backoff");
    const reconnect = [...hook.timers.values()].find(timer => timer.ms === 250);
    assert.ok(reconnect);
    reconnect.fn();
    await hook.flush();
    assert.equal(connections, 2);
    assert.equal(hook.states[1], "live");
    assert.equal(hook.states[4].width, 200);
    assert.equal(hook.states[4].height, 100);
    assert.equal(hook.states[5], null);
    assert.equal(hook.calls.some(url => url.includes("/frame?")), false);
  } finally { hook.cleanup(); }
});

test("a stalled video HTTP request is aborted before falling back", async () => {
  let aborted = false;
  const hook = await mountLiveFrame(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
  }));
  try {
    [...hook.timers.values()].find((timer) => timer.ms === 15_000).fn();
    await hook.flush();
    assert.ok(aborted);
    assert.equal(hook.states[1], "live", hook.states[3]);
    assert.equal(hook.states[2], "frames");
  } finally { hook.cleanup(); }
});

test("slow video connection leaves a full first-frame budget for the next H264 keyframe", async () => {
  const clock = virtualClock();
  const Decoder = watchdogDecoder({ produceFrames: true });
  let resolveResponse;
  let signal;
  let stream;
  const hook = await mountLiveFrame(options => {
    signal = options.signal;
    return new Promise(resolve => { resolveResponse = resolve; });
  }, Decoder, undefined, { clock });
  try {
    await clock.advance(12_000);
    assert.equal(signal.aborted, false, "connection remains inside its own deadline");
    resolveResponse(new Response(new ReadableStream({
      start(controller) { stream = controller; controller.enqueue(capacityPackets(['delta'])); },
    })));
    await hook.flush();
    await clock.advance(8_000);
    assert.equal(signal.aborted, false, "the connection delay must not consume the first-frame deadline");
    assert.equal(hook.states[1], "loading");
    assert.equal(hook.states[2], "video");
    assert.deepEqual(Decoder.instances[0].inputs, [], "deltas cannot stand in for the first keyframe");
    stream.enqueue(capacityPackets(['key', 'delta']).subarray(30));
    await hook.flush();
    assert.equal(hook.states[1], "live");
    assert.equal(hook.states[2], "video");
    assert.deepEqual(Decoder.instances[0].inputs, ['key', 'delta']);
    assert.equal(hook.calls.some(url => url.includes('/frame?')), false);
    assert.equal(hook.painted.length, 2);
  } finally { hook.cleanup(); }
});

test("repeated valid configuration packets cannot extend a silent stream's first-frame deadline", async () => {
  const clock = virtualClock();
  const Decoder = watchdogDecoder();
  let resolveResponse;
  let signal;
  let stream;
  let cancelled = false;
  const hook = await mountLiveFrame(options => {
    signal = options.signal;
    return new Promise(resolve => { resolveResponse = resolve; });
  }, Decoder, undefined, { clock });
  try {
    await clock.advance(12_000);
    resolveResponse(new Response(new ReadableStream({
      start(controller) { stream = controller; controller.enqueue(capacityPackets([])); },
      cancel() { cancelled = true; },
    })));
    await hook.flush();
    for (const elapsed of [5_000, 5_000, 4_000]) {
      await clock.advance(elapsed);
      assert.equal(signal.aborted, false, "first-frame budget starts at response headers");
      stream.enqueue(capacityPackets([]));
      await hook.flush();
    }
    await clock.advance(1_000);
    assert.equal(signal.aborted, true, "configuration-only traffic is not evidence of live video");
    assert.equal(cancelled, true);
    assert.equal(hook.states[1], "live", hook.states[3]);
    assert.equal(hook.states[2], "frames");
    assert.equal(hook.states[5], "Harmony video stopped producing frames");
    assert.equal(Decoder.instances.every(instance => instance.inputs.length === 0), true);
  } finally { hook.cleanup(); }
});

test("a displayed stream still expires after fifteen seconds without fresh pixels", async () => {
  const clock = virtualClock();
  let signal;
  let cancelled = false;
  const hook = await mountLiveFrame(async options => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(jpegFrame()); },
      cancel() { cancelled = true; },
    }));
  }, undefined, undefined, { clock });
  try {
    assert.equal(hook.states[1], "live");
    await clock.advance(14_999);
    assert.equal(signal.aborted, false);
    await clock.advance(1);
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(hook.states[1], "error");
    assert.equal(hook.states[4].geometryId, undefined);
    assert.equal(hook.states[5], "Harmony video stopped producing frames");
    assert.equal(hook.calls.filter(url => url.includes('/video?')).length, 1,
      "established streams retain the existing bounded reconnect backoff");
  } finally { hook.cleanup(); }
});

test("an expired HTTP request cannot revive native video when an ignored abort resolves late", async () => {
  const clock = virtualClock();
  const Decoder = watchdogDecoder({ produceFrames: true });
  let resolveResponse;
  let signal;
  let cancelled = false;
  const hook = await mountLiveFrame(options => {
    signal = options.signal;
    return new Promise(resolve => { resolveResponse = resolve; });
  }, Decoder, undefined, { clock });
  try {
    await clock.advance(15_000);
    assert.equal(signal.aborted, true);
    resolveResponse(new Response(new ReadableStream({
      start(controller) { controller.enqueue(capacityPackets(['key'])); },
      cancel() { cancelled = true; },
    })));
    await hook.flush();
    assert.equal(cancelled, true, "late HTTP bodies must release their own viewer connection");
    assert.equal(Decoder.instances.length, 0);
    assert.equal([...hook.timers.values()].some(timer => timer.ms === 15_000), false,
      "an already aborted attempt cannot gain a new first-frame deadline");
    assert.equal(hook.states[1] === "live" && hook.states[2] === "video", false);
  } finally { hook.cleanup(); }
});

test("HTTP completion after effect teardown cancels its body without restarting timers or painting", async () => {
  const clock = virtualClock();
  const Decoder = watchdogDecoder({ produceFrames: true });
  let resolveResponse;
  let signal;
  let cancelled = false;
  const hook = await mountLiveFrame(options => {
    signal = options.signal;
    return new Promise(resolve => { resolveResponse = resolve; });
  }, Decoder, undefined, { clock });
  try {
    await clock.advance(12_000);
    hook.cleanup();
    const afterCleanup = [...hook.states];
    assert.equal(signal.aborted, true);
    resolveResponse(new Response(new ReadableStream({
      start(controller) { controller.enqueue(capacityPackets(['key'])); },
      cancel() { cancelled = true; },
    })));
    await hook.flush();
    await clock.advance(30_000);
    assert.equal(cancelled, true);
    assert.equal(Decoder.instances.length, 0);
    assert.equal(hook.painted.length, 0);
    assert.equal(hook.timers.size, 0);
    assert.deepEqual(hook.states, afterCleanup);
    assert.equal(hook.calls.length, 1, "a hidden pane cannot revive video, geometry, or frame polling");
  } finally { hook.cleanup(); }
});

test("an automatically closed H264 decoder still recovers to frame fallback", async () => {
  class FailedDecoder {
    state = "unconfigured";
    decodeQueueSize = 0;
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; }
    configure() { this.state = "configured"; }
    decode() { this.state = "closed"; this.callbacks.error(new Error("decoder failed")); }
    close() { assert.notEqual(this.state, "closed", "closed decoders must not be closed again"); this.state = "closed"; }
  }
  const packet = (type, payload) => {
    const data = Buffer.alloc(8 + payload.length);
    data.writeUInt32BE(type, 0); data.writeUInt32BE(payload.length, 4); payload.copy(data, 8);
    return data;
  };
  const config = Buffer.alloc(22);
  config.writeUInt32BE(100, 1); config.writeUInt32BE(200, 5); config.writeUInt32BE(30, 9);
  config.writeUInt16BE(4, 13); config.set([0x67, 0x42, 0xe0, 0x1f], 15);
  config.writeUInt16BE(1, 19); config[21] = 0x68;
  const frame = Buffer.alloc(11); frame[0] = 1; frame[9] = 0x65;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.concat([packet(2, config), packet(3, frame)])); },
  })), FailedDecoder);
  try {
    assert.equal(hook.states[1], "live", hook.states[3]);
    assert.equal(hook.states[2], "frames");
  } finally { hook.cleanup(); }
});

test("turns fatal decoder errors into a stream reconnect", () => {
  const decoderSource = source.slice(
    source.indexOf("    const configureDecoder"),
    source.indexOf("    const drawJpeg"),
  );

  assert.match(decoderSource, /attempt\.failure = failure/);
  assert.match(decoderSource, /attempt\.reader\?\.cancel\(failure\)/);
  assert.doesNotMatch(decoderSource, /setStatus\("error"\)/);
});

test("isolates JPEG work and readers to one connection attempt", () => {
  const connectSource = source.slice(
    source.indexOf("    const connect = async"),
    source.indexOf("    void connect\(\)"),
  );
  const consumeSource = source.slice(
    source.indexOf("    const consume = async"),
    source.indexOf("    const connect = async"),
  );

  assert.match(connectSource, /jpegChain: Promise\.resolve\(\)/);
  assert.match(connectSource, /await attempt\.jpegChain\.catch/);
  assert.match(consumeSource, /finally \{[\s\S]*await reader\.cancel\(\)[\s\S]*reader\.releaseLock\(\)/);
  assert.doesNotMatch(source, /let jpegChain = Promise\.resolve\(\)/);
});

test("backs off flapping streams until a connection is genuinely stable", () => {
  assert.match(source, /STABLE_STREAM_FRAMES = 30/);
  assert.match(source, /STABLE_STREAM_MS = 5_000/);
  assert.match(source, /attempt\.decodedFrames >= STABLE_STREAM_FRAMES/);
  assert.match(source, /failures \+= 1/);
  assert.match(source, /setFrame\(previous => previous \? \{ \.\.\.previous, geometryId: undefined \} : previous\)/);
  assert.match(source, /reconnectDelay\(failures\)/);
});

test("aborts a persistently overloaded H264 stream so connect can request a fresh keyframe", () => {
  const packetSource = source.slice(
    source.indexOf("    const processPacket"),
    source.indexOf("    const consume"),
  );
  assert.match(packetSource, /if \(!available\) \{[\s\S]*attempt\.failure = failure;[\s\S]*attempt\.controller\.abort\(\);[\s\S]*throw failure;/);
  assert.doesNotMatch(packetSource, /firstKeyframe = false/);
});

test("falls back to interruptible screenshot observation when video is unavailable", () => {
  assert.match(source, /const pollFrames = async/);
  assert.match(source, /\/api\/harmony\/frame\?serial=/);
  assert.match(source, /setMode\("frames"\)/);
  assert.match(source, /\(!hasFrame && failures >= 1\) \|\| failures >= 3/);
  assert.match(source, /Keep the last frame visible and retry/);
});


function capacityPackets(types, width = 100, height = 200) {
  const packet = (type, payload) => {
    const bytes = Buffer.alloc(8 + payload.length);
    bytes.writeUInt32BE(type, 0); bytes.writeUInt32BE(payload.length, 4); payload.copy(bytes, 8);
    return bytes;
  };
  const config = Buffer.alloc(22);
  config.writeUInt32BE(width, 1); config.writeUInt32BE(height, 5); config.writeUInt32BE(30, 9);
  config.writeUInt16BE(4, 13); config.set([0x67, 0x42, 0xe0, 0x1f], 15);
  config.writeUInt16BE(1, 19); config[21] = 0x68;
  return Buffer.concat([packet(2, config), ...types.map(type => {
    const frame = Buffer.alloc(11); frame[0] = type === 'key' ? 1 : 0; frame[9] = type === 'key' ? 0x65 : 0x41;
    return packet(3, frame);
  })]);
}

function watchdogDecoder({ produceFrames = false } = {}) {
  return class {
    static instances = [];
    state = 'unconfigured'; decodeQueueSize = 0; inputs = [];
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; this.constructor.instances.push(this); }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) {
      this.inputs.push(chunk.type);
      if (produceFrames) this.callbacks.output({
        displayWidth: this.config.codedWidth,
        displayHeight: this.config.codedHeight,
        close() {},
      });
    }
    close() { this.state = 'closed'; }
  };
}

function capacityDecoder({ produceFrames = false } = {}) {
  return class extends EventTarget {
    static current;
    static instances = [];
    state = 'unconfigured'; decodeQueueSize = 0; inputs = []; listeners = 0;
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) {
      super();
      this.callbacks = callbacks;
      this.constructor.current = this;
      this.constructor.instances.push(this);
    }
    configure(config) { this.config = config; this.state = 'configured'; }
    decode(chunk) {
      this.inputs.push(chunk.type);
      if (this.inputs.length === 1) this.decodeQueueSize = 9;
      if (produceFrames) this.callbacks.output({
        displayWidth: this.config.codedWidth,
        displayHeight: this.config.codedHeight,
        close() {},
      });
    }
    close() { this.state = 'closed'; }
    addEventListener(type, listener, options) { super.addEventListener(type, listener, options); if (type === 'dequeue') this.listeners++; }
    removeEventListener(type, listener, options) { super.removeEventListener(type, listener, options); if (type === 'dequeue') this.listeners--; }
    drain(queue = 0) { this.decodeQueueSize = queue; this.dispatchEvent(new Event('dequeue')); }
  };
}

test('short H264 queue bursts preserve every dependent frame after bounded drainage', async () => {
  const Decoder = capacityDecoder();
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(capacityPackets(['key', 'delta', 'delta'])); },
  })), Decoder);
  try {
    assert.deepEqual(Decoder.current.inputs, ['key']);
    assert.equal(Decoder.current.listeners, 1);
    assert.ok([...hook.timers.values()].some(timer => timer.ms === 1000));
    Decoder.current.drain(); await hook.flush();
    assert.deepEqual(Decoder.current.inputs, ['key', 'delta', 'delta']);
    assert.equal(Decoder.current.listeners, 0);
    assert.equal([...hook.timers.values()].some(timer => timer.ms === 1000), false);
  } finally { hook.cleanup(); }
});

test('persistent H264 queue overload reconnects before the frame watchdog when only deltas follow', async () => {
  const clock = virtualClock();
  const Decoder = capacityDecoder({ produceFrames: true });
  const signals = [];
  let connections = 0;
  let firstStream;
  let firstStreamCancelled = false;
  const hook = await mountLiveFrame(async ({ signal }) => {
    const connection = ++connections;
    signals.push(signal);
    return new Response(new ReadableStream({
      start(controller) {
        if (connection === 1) {
          firstStream = controller;
          controller.enqueue(capacityPackets(['key', 'delta']));
        } else {
          controller.enqueue(capacityPackets(['delta']));
        }
      },
      cancel() { if (connection === 1) firstStreamCancelled = true; },
    }));
  }, Decoder, undefined, { clock });
  try {
    assert.equal(connections, 1);
    assert.equal(hook.states[1], 'live');
    assert.equal(hook.painted.length, 1);
    const displayedFrame = hook.states[4];
    firstStream.enqueue(capacityPackets(['delta', 'delta']).subarray(30));
    await hook.flush();

    await clock.advance(999);
    assert.equal(connections, 1);
    assert.equal(signals[0].aborted, false);
    await clock.advance(1);
    assert.equal(signals[0].aborted, true, 'the one-second capacity bound aborts the overloaded stream');
    assert.equal(firstStreamCancelled, true);
    assert.equal(connections, 1, 'recovery still observes the bounded reconnect delay');
    assert.equal(hook.painted.length, 1, 'the last decoded pixels stay visible while reconnecting');
    assert.equal(hook.states[4].width, displayedFrame.width);
    assert.equal(hook.states[4].height, displayedFrame.height);
    assert.equal(hook.states[4].revision, displayedFrame.revision);

    await clock.advance(249);
    assert.equal(connections, 1);
    await clock.advance(1);
    assert.equal(connections, 2, 'recovery must open a fresh stream instead of waiting fifteen seconds for an IDR');
    assert.equal(hook.calls.filter(url => url.includes('/video?')).length, 2);
    assert.deepEqual(Decoder.instances[1].inputs, [], 'a delta-only reconnect cannot replace the preserved frame');
    assert.equal(hook.painted.length, 1);
  } finally { hook.cleanup(); }
});

test('teardown aborts decoder drainage and cannot decode late packets on an old connection', async () => {
  const Decoder = capacityDecoder();
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(capacityPackets(['key', 'delta'])); },
  })), Decoder);
  const decoder = Decoder.current;
  assert.equal(decoder.listeners, 1);
  hook.cleanup(); await hook.flush(); decoder.drain(); await hook.flush();
  assert.deepEqual(decoder.inputs, ['key']);
  assert.equal(decoder.listeners, 0);
  assert.equal([...hook.timers.values()].some(timer => timer.ms === 1000), false);
});

test('keyframes also respect the decoder queue bound', async () => {
  const Decoder = capacityDecoder();
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(capacityPackets(['key', 'key'])); },
  })), Decoder);
  try {
    assert.deepEqual(Decoder.current.inputs, ['key']);
    [...hook.timers.values()].find(timer => timer.ms === 1000).fn(); await hook.flush();
    assert.deepEqual(Decoder.current.inputs, ['key']);
  } finally { hook.cleanup(); }
});

test('late decoder callbacks cannot repaint or cancel a newer configuration on the same stream', async () => {
  const instances = [];
  const frame = (width, height) => ({ displayWidth: width, displayHeight: height, closed: false, close() { this.closed = true; } });
  class Decoder {
    state = 'unconfigured'; decodeQueueSize = 0;
    static async isConfigSupported(config) { return { supported: true, config }; }
    constructor(callbacks) { this.callbacks = callbacks; instances.push(this); }
    configure() { this.state = 'configured'; }
    decode() {}
    close() {
      this.state = 'closed';
      this.closedFrame = frame(100, 200);
      this.callbacks.output(this.closedFrame);
      this.callbacks.error(new Error('old decoder closed'));
    }
  }
  let stream; let cancelled = false;
  const hook = await mountLiveFrame(async () => new Response(new ReadableStream({
    start(controller) { stream = controller; controller.enqueue(capacityPackets(['key'])); },
    cancel() { cancelled = true; },
  })), Decoder);
  try {
    const portrait = frame(100, 200);
    instances[0].callbacks.output(portrait);
    assert.equal(hook.states[1], 'live');
    assert.equal(portrait.closed, true);
    stream.enqueue(capacityPackets(['key'], 200, 100));
    await hook.flush();
    assert.equal(instances.length, 2);
    assert.equal(instances[0].closedFrame.closed, true);
    assert.equal(cancelled, false, 'close callbacks must be fenced before the old decoder is closed');
    const landscape = frame(200, 100);
    instances[1].callbacks.output(landscape);
    const current = hook.states[4];
    assert.equal(current.width, 200);
    assert.equal(current.height, 100);
    const late = frame(100, 200);
    instances[0].callbacks.output(late);
    instances[0].callbacks.error(new Error('late decoder error'));
    await hook.flush();
    assert.equal(late.closed, true);
    assert.equal(cancelled, false);
    assert.equal(hook.states[4], current);
    assert.equal(hook.canvas.width, 200);
    assert.equal(hook.canvas.height, 100);
    assert.deepEqual(hook.painted, [portrait, landscape]);
    assert.equal(hook.states[1], 'live');
    assert.equal(hook.states[3], null);
    hook.cleanup();
    const afterCleanup = frame(200, 100);
    instances[1].callbacks.output(afterCleanup);
    assert.equal(afterCleanup.closed, true);
    assert.equal(hook.painted.length, 2);
  } finally { hook.cleanup(); }
});
