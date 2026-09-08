import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./useHarmonyLiveFrame.ts", import.meta.url), "utf8");

async function mountLiveFrame(videoResponse, decoderClass) {
  const timers = new Map();
  const states = [];
  const calls = [];
  let nextTimer = 0;
  let effect;
  const window = {
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ...(decoderClass ? { VideoDecoder: decoderClass } : {}),
  };
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, window, document: { hidden: false }, AbortController, performance, Uint8Array, Uint8ClampedArray, DataView, Blob,
    VideoDecoder: decoderClass,
    EncodedVideoChunk: class { constructor(value) { Object.assign(this, value); } },
    require() { return {
      useCallback: (fn) => fn,
      useEffect: (fn) => { effect = fn; },
      useState(initial) { const index = states.length; states.push(initial); return [initial, (value) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    }; },
    async fetch(url, options) {
      calls.push(url);
      if (url.includes("/video?")) return await videoResponse(options);
      return { ok: true, headers: new Headers({ "X-Harmony-Generation": "1", "X-Harmony-Revision": "1" }), async blob() { return new Blob(["frame"]); } };
    },
    async createImageBitmap() { return { width: 100, height: 200, close() {} }; },
  });
  exports.useHarmonyLiveFrame({ active: true, enabled: true, serial: "phone", generation: 1, fallbackError: "failed",
    canvasRef: { current: { width: 100, height: 200, getContext: () => ({ clearRect() {}, drawImage() {} }) } },
  });
  const cleanup = effect();
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await flush();
  return { timers, states, calls, cleanup, flush };
}

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
  assert.match(source, /failures > 1/);
  assert.match(source, /reconnectDelay\(failures\)/);
});

test("drops an overloaded H264 GOP until the next keyframe", () => {
  assert.match(source, /decoder\.decodeQueueSize > 8[\s\S]*firstKeyframe = false/);
});

test("falls back to interruptible screenshot observation when video is unavailable", () => {
  assert.match(source, /const pollFrames = async/);
  assert.match(source, /\/api\/harmony\/frame\?serial=/);
  assert.match(source, /setMode\("frames"\)/);
  assert.match(source, /\(!hasFrame && failures >= 1\) \|\| failures >= 3/);
  assert.match(source, /Keep the last frame visible and retry/);
});
