import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { GestureChannel } = await jiti.import("./harmony/input/gesture-channel.ts");
const { LiveTouch } = await jiti.import("./harmony/input/live-touch.ts");

async function fixture(t, onRequest, timeout = 200) {
  const requests = [], sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("error", () => {});
    socket.on("data", bytes => { const request = JSON.parse(bytes.toString()); requests.push(request); onRequest(socket, request, requests.length); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const channel = new GestureChannel(server.address().port, timeout);
  t.after(async () => { channel.close(); for (const socket of sockets) socket.destroy(); server.close(); await once(server, "close"); });
  await channel.connect(); return { channel, requests };
}

test("persistent channel sequences down/move/up and waits for fragmented UTF-8 JSON", async t => {
  const { channel, requests } = await fixture(t, socket => {
    const reply = Buffer.from('{"result":"好\\\"{}"}');
    socket.write(reply.subarray(0, 12)); setTimeout(() => socket.write(reply.subarray(12)), 10);
  });
  const replies = await Promise.all([channel.touch("down", 10, 20), channel.touch("move", 11, 21), channel.touch("up", 11, 21)]);
  assert.deepEqual(requests.map(r => r.params.api), ["touchDown", "touchMove", "touchUp"]);
  assert.equal(replies[0].result, '好"{}');
});

test("ambiguous timeout closes channel and never replays or sends queued input", async t => {
  const { channel, requests } = await fixture(t, () => {}, 30);
  const results = await Promise.allSettled([channel.touch("down", 1, 2), channel.touch("move", 3, 4)]);
  assert.ok(results.every(r => r.status === "rejected")); assert.equal(requests.length, 1);
});

test("device rejection and unexpected extra replies fail closed", async t => {
  for (const reply of ['{"exception":"unsupported"}', '{}{}', 'bad', '{"result":' + ' '.repeat(65536)]) {
    const { channel } = await fixture(t, socket => socket.write(reply));
    await assert.rejects(channel.touch("down", 1, 2));
    await assert.rejects(channel.touch("up", 1, 2), /unavailable/);
  }
});

test("disconnect rejects pending gesture without replay", async t => {
  const { channel, requests } = await fixture(t, socket => socket.destroy());
  await assert.rejects(channel.touch("down", 1, 2), /closed/); assert.equal(requests.length, 1);
});

test("live touch coalesces pending moves and releases after cancellation", async () => {
  const events = []; let finishMove;
  const touch = new LiveTouch({ async touch(phase, x, y) {
    events.push([phase, x, y]); if (phase === "move") await new Promise(resolve => { finishMove = resolve; });
  } }, { validate() {}, recoverRelease() { throw new Error("unexpected recovery"); }, onError: assert.fail });
  await touch.down({ x: 1, y: 2 });
  const move = touch.move({ x: 3, y: 4 }); await new Promise(resolve => setImmediate(resolve));
  void touch.move({ x: 5, y: 6 }); void touch.move({ x: 7, y: 8 });
  const release = touch.up(); finishMove(); await move; await release;
  assert.deepEqual(events, [["down", 1, 2], ["move", 3, 4], ["up", 3, 4]]);
  await touch.up(); assert.equal(events.length, 3);
});

test("hold watchdog releases and transport failure uses explicit recovery", async () => {
  const events = []; let recovered = 0;
  const touch = new LiveTouch({ async touch(phase) { events.push(phase); if (phase === "up") throw new Error("lost socket"); } }, {
    validate() {}, async recoverRelease() { recovered++; }, onError: assert.fail, maxHoldMs: 20,
  });
  await touch.down({ x: 1, y: 2 }); await new Promise(resolve => setTimeout(resolve, 50)); await touch.up();
  assert.deepEqual(events, ["down", "up"]); assert.equal(recovered, 1);
  await assert.rejects(touch.move({ x: 3, y: 4 }), /not active/);
});

test("revoked geometry prevents pending move but still releases previous point", async () => {
  let valid = true; const events = [];
  const touch = new LiveTouch({ async touch(phase) { events.push(phase); } }, {
    validate() { if (!valid) throw new Error("stale epoch"); }, async recoverRelease() {}, onError: assert.fail,
  });
  await touch.down({ x: 1, y: 2 }); valid = false;
  await assert.rejects(touch.move({ x: 3, y: 4 }), /stale epoch/); await touch.up();
  assert.deepEqual(events, ["down", "up"]);
});

test("latest move replaces intermediate backlog without dropping final release", async () => {
  const events = []; let finish;
  const touch = new LiveTouch({ async touch(phase, x) {
    events.push([phase, x]); if (phase === "move" && x === 2) await new Promise(resolve => { finish = resolve; });
  } }, { validate() {}, async recoverRelease() {}, onError: assert.fail });
  await touch.down({ x: 1, y: 1 }); const moving = touch.move({ x: 2, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  void touch.move({ x: 3, y: 3 }); void touch.move({ x: 4, y: 4 }); finish();
  await moving; await touch.up();
  assert.deepEqual(events, [["down", 1], ["move", 2], ["move", 4], ["up", 4]]);
});

test("ambiguous DOWN still releases, and failed recovery is reported", async () => {
  const events = [], errors = [];
  const touch = new LiveTouch({ async touch(phase) { events.push(phase); throw new Error("socket lost"); } }, {
    validate() {}, async recoverRelease() { throw new Error("release uncertain"); }, onError: error => errors.push(error.message),
  });
  await assert.rejects(touch.down({ x: 1, y: 1 }), /socket lost/);
  assert.deepEqual(events, ["down", "up"]); assert.deepEqual(errors, ["release uncertain"]);
});
