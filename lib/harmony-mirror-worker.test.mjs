import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { MirrorVideoEngine } = await createJiti(import.meta.url).import("./harmony/mirror/video-engine.ts");
const flush = () => new Promise(resolve => setImmediate(resolve));
const packet = (type, payload) => { const result = Buffer.alloc(8 + payload.length); result.writeUInt32BE(type); result.writeUInt32BE(payload.length, 4); result.set(payload, 8); return result; };
const configuration = (width = 640, height = 480) => {
  const payload = Buffer.from([0, 0, 0, 2, 128, 0, 0, 1, 224, 0, 0, 0, 120, 0, 4, 0x67, 66, 0, 30, 0, 2, 0x68, 1]);
  payload.writeUInt32BE(width, 1); payload.writeUInt32BE(height, 5); return packet(2, payload);
};
const picture = (timestamp, key = false) => { const payload = Buffer.alloc(12); payload[0] = key ? 1 : 0; payload.writeBigUInt64BE(BigInt(timestamp), 1); payload[9] = key ? 0x65 : 0x41; return packet(3, payload); };

async function fixture(t, options = {}) {
  const decoders = [], events = [], calls = [], drawn = [], closed = [];
  let stream, cancels = 0;
  class Decoder {
    static async isConfigSupported(config) { return { supported: true, config }; }
    state = "unconfigured"; decodeQueueSize = 0; inputs = []; resets = 0;
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    configure(config) { this.config = config; this.state = "configured"; }
    decode(chunk) {
      this.inputs.push(chunk);
      if (options.automaticOutput) {
        this.decodeQueueSize++;
        setTimeout(() => { this.decodeQueueSize--; this.output(chunk.timestamp); }, 0);
      }
    }
    reset() { this.resets++; this.state = "unconfigured"; this.decodeQueueSize = 0; }
    close() { this.state = "closed"; }
    output(timestamp, width = 640, height = 480) { this.callbacks.output({ timestamp, displayWidth: width, displayHeight: height, close() { closed.push(timestamp); } }); }
  }
  const previousDecoder = globalThis.VideoDecoder, previousChunk = globalThis.EncodedVideoChunk;
  globalThis.VideoDecoder = Decoder; globalThis.EncodedVideoChunk = class { constructor(value) { Object.assign(this, value); } };
  t.after(() => { globalThis.VideoDecoder = previousDecoder; globalThis.EncodedVideoChunk = previousChunk; });
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST") return new Response("{}");
    return new Response(new ReadableStream({ start(controller) { stream = controller; }, cancel() { cancels++; } }), { headers: { "X-Harmony-Generation": String(options.generation ?? 1) } });
  });
  const engine = new MirrorVideoEngine({ width: 0, height: 0, getContext: () => ({ drawImage(frame) { drawn.push(frame.timestamp); } }) }, "phone", 1, event => events.push(event));
  t.after(() => engine.stop()); engine.start(); await flush();
  return { engine, decoders, events, calls, drawn, closed, send: bytes => stream.enqueue(bytes), get cancels() { return cancels; } };
}

test("worker ignores initial deltas and presents decoded frames without React work", async t => {
  const f = await fixture(t);
  f.send(Buffer.concat([configuration(), picture(1), picture(2, true), picture(3)])); await flush();
  assert.deepEqual(f.decoders[0].inputs.map(value => value.timestamp), [2, 3]);
  f.decoders[0].output(2); f.decoders[0].output(3);
  assert.deepEqual(f.drawn, [2, 3]); assert.deepEqual(f.closed, [2, 3]);
  assert.equal(f.events.filter(value => value.type === "frame").length, 1, "stable dimensions do not emit a UI update for every frame");
});

test("decoder overload drops the entire reference chain and requests an IDR on the same HTTP stream", async t => {
  const f = await fixture(t);
  f.send(Buffer.concat([configuration(), picture(10, true), picture(11)])); await flush();
  const decoder = f.decoders[0]; decoder.decodeQueueSize = 17;
  f.send(picture(12)); await flush();
  assert.equal(decoder.resets, 1); assert.deepEqual(decoder.inputs.map(value => value.timestamp), [10, 11]);
  decoder.output(10); assert.deepEqual(f.drawn, [], "late pre-reset output is closed without repainting");
  f.send(Buffer.concat([picture(13), picture(14, true), picture(15)])); await flush(); decoder.output(14); decoder.output(15);
  assert.deepEqual(f.drawn, [14, 15]);
  assert.equal(f.calls.filter(value => value.init.method === "POST").length, 1);
  assert.equal(f.calls.filter(value => value.init.method !== "POST").length, 1);
});

test("a healthy short network burst is decoded and drawn without a GOP reset or a second presentation queue", async t => {
  const f = await fixture(t);
  f.send(Buffer.concat([configuration(), ...Array.from({length: 8}, (_, index) => picture(index + 1, index === 0))])); await flush();
  const decoder = f.decoders[0]; decoder.decodeQueueSize = 6;
  f.send(picture(9)); await flush();
  assert.equal(decoder.resets, 0);
  for (let timestamp = 1; timestamp <= 9; timestamp++) decoder.output(timestamp);
  assert.deepEqual(f.drawn, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(f.closed, f.drawn);
  assert.equal(f.calls.filter(value => value.init.method === 'POST').length, 0);
});

test("configuration change invalidates old decoder callbacks and publishes the new orientation", async t => {
  const f = await fixture(t);
  f.send(Buffer.concat([configuration(), picture(1, true)])); await flush(); const old = f.decoders[0];
  f.send(Buffer.concat([configuration(480, 640), picture(2, true)])); await flush();
  old.output(1); f.decoders[1].output(2, 480, 640);
  assert.deepEqual(f.drawn, [2]); assert.equal(old.state, "closed");
  assert.equal(f.events.find(value => value.type === "frame").height, 640);
});

test("a coalesced HTTP read yields to decoder output before exceeding the backlog capacity", async t => {
  const f = await fixture(t, { automaticOutput: true });
  const timestamps = Array.from({ length: 24 }, (_, index) => index + 1);
  f.send(Buffer.concat([configuration(), ...timestamps.map(timestamp => picture(timestamp, timestamp === 1))]));
  for (let turn = 0; f.drawn.length < timestamps.length && turn < 100; turn++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(f.drawn, timestamps, "every frame in the healthy coalesced read must reach the canvas");
  assert.equal(f.decoders[0].resets, 0);
  assert.equal(f.calls.filter(value => value.init.method === "POST").length, 0);
});

test("stop cancels the HTTP reader and decoder while closing late output without drawing it", async t => {
  const f = await fixture(t); f.send(Buffer.concat([configuration(), picture(1, true), picture(2)])); await flush();
  f.decoders[0].output(1); f.engine.stop(); f.engine.stop(); f.decoders[0].output(2); await flush();
  assert.equal(f.cancels, 1); assert.equal(f.calls[0].init.signal.aborted, true);
  assert.equal(f.decoders[0].state, "closed"); assert.deepEqual(f.closed, [1, 2]); assert.deepEqual(f.drawn, [1]);
});

test("a stream from another device generation is cancelled before it creates a decoder", async t => {
  const f = await fixture(t, { generation: 2 }); await flush();
  assert.equal(f.cancels, 1); assert.equal(f.decoders.length, 0);
  assert.ok(f.events.some(value => value.type === "state" && /expired/.test(value.error)));
});

test("a fatal decoder error cancels the old reader and retries with software preference", async t => {
  const f = await fixture(t); f.send(Buffer.concat([configuration(), picture(1, true)])); await flush();
  f.decoders[0].callbacks.error(new Error("hardware failed")); await flush();
  assert.equal(f.cancels, 1);
  await new Promise(resolve => setTimeout(resolve, 180));
  f.send(Buffer.concat([configuration(), picture(2, true)])); await flush();
  assert.equal(f.decoders[1].config.hardwareAcceleration, "prefer-software");
});

test("unconfirmed cleanup pauses transport retries and preserves structured recovery guidance", async t => {
  const error = { code: "DEVICE_BUSY", message: "Device dispatch is blocked while stopping or awaiting cleanup confirmation", details: { state: "recovering", serial: "phone" } };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error }, { status: 409 }); });
  const events = [];
  const engine = new MirrorVideoEngine({ getContext: () => ({}) }, "phone", 1, event => events.push(event));
  t.after(() => engine.stop());
  engine.start(); await flush();
  const terminal = events.find(event => event.type === "state" && event.state === "error");
  assert.deepEqual(terminal.requestError, error);
  assert.equal(events.some(event => event.state === "recovering"), false);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(calls, 1, "transport retries cannot resolve unconfirmed physical input");
});

test("temporary stopping retains structured error and reconnects after cleanup settles", async t => {
  const error = { code: "DEVICE_BUSY", message: "Device dispatch is blocked", details: { state: "stopping" } };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return Response.json({ error }, { status: 409 });
    return new Response(new ReadableStream(), { headers: { "X-Harmony-Generation": "1" } });
  });
  const events = [];
  const engine = new MirrorVideoEngine({ getContext: () => ({}) }, "phone", 1, event => events.push(event));
  t.after(() => engine.stop());
  engine.start(); await flush();
  assert.deepEqual(events.find(event => event.state === "recovering").requestError, error);
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(calls, 2);
  assert.equal(events.some(event => event.state === "error"), false);
});
