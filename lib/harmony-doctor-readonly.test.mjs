import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { controlledBackend, deferred } from "./harmony/fixtures/controlled-backend.mjs";

const jiti = createJiti(import.meta.url);
const { HarmonyDeviceManager } = await jiti.import("./harmony/device-manager.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const serial = "phone-1";
const check = (report, name) => report.checks.find(item => item.name === name);
const packet = (type, body) => { const header = Buffer.alloc(8); header.writeUInt32BE(type); header.writeUInt32BE(body.length, 4); return Buffer.concat([header, body]); };
const configPacket = (width = 1440, height = 3200) => { const body = Buffer.alloc(13); body.writeUInt32BE(width, 1); body.writeUInt32BE(height, 5); return packet(2, body); };

function fixture(t, { delayedClose = false } = {}) {
  const { backend, state, calls } = controlledBackend();
  let now = Date.parse("2026-10-03T01:00:00Z");
  const listings = [], captures = [], viewers = [];
  const snapshot = backend.snapshot;
  backend.snapshot = async (device, options) => { captures.push({ device, screenshot: options.includeScreenshot, tree: options.includeTree }); return snapshot(device, options); };
  backend.listFiles = async (...args) => { listings.push(args); return { files: [{ name: "private-name.txt", path: "/private-doctor-path", kind: "file", size: 1 }], truncated: false }; };
  backend.openVideoStream = async () => {
    let controller;
    const entry = { closed: 0, stream: new ReadableStream({ start(value) { controller = value; } }),
      send(bytes) { controller.enqueue(bytes); }, async close() { entry.closed++; if (!delayedClose) try { controller.close(); } catch { /* Test reader may already be cancelled. */ } } };
    if (delayedClose) t.after(() => { try { controller.close(); } catch { /* Test reader may already be cancelled. */ } });
    viewers.push(entry); return entry;
  };
  const manager = new HarmonyDeviceManager({ backend, now: () => now });
  t.after(() => manager.dispose());
  const view = async () => {
    const connection = await manager.openVideoStream({ serial });
    const source = viewers.at(-1), reader = connection.stream.getReader();
    t.after(() => reader.cancel().catch(() => undefined));
    return { connection, source, async send(bytes) { source.send(bytes); await reader.read(); } };
  };
  return { manager, backend, state, calls, captures, listings, viewers, view, time: value => { now = value; }, advance: value => { now += value; } };
}

test("doctor reads fixed shared metadata only and never starts frame capture, application discovery, a lease or database inspection", async t => {
  const { manager, captures, listings, viewers, calls } = fixture(t);
  const report = await manager.doctor(serial);
  assert.equal(check(report, "file-access").status, "passed");
  assert.equal(check(report, "frame-freshness").status, "unknown");
  assert.equal(check(report, "database-snapshot").status, "unknown");
  assert.equal(viewers.length, 0);
  assert.deepEqual(captures, [{ device: serial, screenshot: false, tree: true }]);
  assert.equal(listings.length, 1);
  assert.equal(listings[0][0], serial); assert.deepEqual(listings[0][1], { kind: "shared" });
  assert.equal(listings[0][2], "/data/local/tmp"); assert.equal(listings[0][4], 0);
  assert.deepEqual(calls.map(item => item.action), ["snapshot"]);
  assert.equal(manager.getState().leases.length, 0);
  assert.equal(manager.operationTasks.list(serial).length, 0);
  assert.doesNotMatch(JSON.stringify(report), /private-name|private-doctor-path|\/data\/local\/tmp|SELECT/);
});

test("config-only and incomplete video packets never establish frame freshness or usable geometry", async t => {
  const { manager, view, captures } = fixture(t);
  const video = await view();
  await video.send(configPacket());
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
  const encoded = packet(3, Buffer.from("encoded-frame"));
  await video.send(encoded.subarray(0, -1));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await video.send(encoded.subarray(-1));
  const report = await manager.doctor(serial);
  assert.equal(check(report, "frame-freshness").status, "passed");
  assert.match(check(report, "frame-freshness").reason, /encoded video packet.*age 0 ms/);
  assert.match(check(report, "frame-freshness").reason, /does not verify client decoding or drawing/);
  assert.equal((await manager.getFrameGeometry(serial, "video")).frameWidth, 1440);
  assert.ok(captures.every(item => item.screenshot === false), "doctor never requests a screenshot to fill the gap");
});

test("freshness uses the report clock, expires after five seconds and rejects clock rollback", async t => {
  const { manager, view, advance, time } = fixture(t);
  const video = await view(); await video.send(configPacket()); await video.send(packet(3, Buffer.from("frame")));
  advance(5000); assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  advance(1); assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
  time(Date.parse("2026-10-03T00:59:59Z"));
  assert.match(check(await manager.doctor(serial), "frame-freshness").reason, /ahead of the current clock/);
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
});

test("a new video configuration needs a new frame, and closing the viewer clears received-frame evidence", async t => {
  const { manager, view } = fixture(t);
  const video = await view(); await video.send(configPacket()); await video.send(packet(3, Buffer.from("frame")));
  await video.send(configPacket(3200, 1440));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await video.send(packet(3, Buffer.from("rotated")));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  await video.connection.close();
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
  assert.equal(video.source.closed, 1);
});

test("closing one viewer preserves another current viewer's received frame until the last viewer closes", async t => {
  const { manager, view } = fixture(t);
  const first = await view(), second = await view();
  for (const video of [first, second]) { await video.send(configPacket()); await video.send(packet(3, Buffer.from("frame"))); }
  await manager.getFrameGeometry(serial, "video");
  await first.connection.close();
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  assert.equal((await manager.getFrameGeometry(serial, "video")).frameWidth, 1440);
  await second.connection.close();
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
});

test("a config-only remaining viewer cannot inherit the closed viewer's received frame", async t => {
  const { manager, view } = fixture(t);
  const received = await view(), configOnly = await view();
  await received.send(configPacket()); await received.send(packet(3, Buffer.from("received")));
  await configOnly.send(configPacket());
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  await received.connection.close();
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "video"), error => error.code === "STALE_SNAPSHOT");
  await configOnly.send(packet(3, Buffer.from("first-own-frame")));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  assert.equal((await manager.getFrameGeometry(serial, "video")).frameWidth, 1440);
});

test("closing the newest viewer restores only the older remaining viewer's actual observation time", async t => {
  const { manager, view, advance } = fixture(t);
  const older = await view(), newer = await view();
  await older.send(configPacket()); await older.send(packet(3, Buffer.from("older")));
  advance(100); await newer.send(configPacket()); await newer.send(packet(3, Buffer.from("newer")));
  assert.match(check(await manager.doctor(serial), "frame-freshness").reason, /age 0 ms/);
  await newer.connection.close();
  assert.match(check(await manager.doctor(serial), "frame-freshness").reason, /age 100 ms/);
  advance(4901); assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
});

test("closing a prior-epoch viewer cannot clear the new epoch's received frame", async t => {
  const { manager, view, state } = fixture(t);
  const old = await view(); await old.send(configPacket()); await old.send(packet(3, Buffer.from("old")));
  state.devices[0].state = "offline"; await manager.listDevices(); state.devices[0].state = "online"; await manager.listDevices();
  const current = await view(); await current.send(configPacket()); await current.send(packet(3, Buffer.from("current")));
  await old.connection.close();
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  assert.equal((await manager.getFrameGeometry(serial, "video")).frameWidth, 1440);
});

for (const change of ["dimensions", "epoch", "close"]) {
  test(`geometry verification rejects a ${change} change while the native display probe is pending`, async t => {
    const { manager, backend, view, state } = fixture(t);
    const video = await view(); await video.send(configPacket()); await video.send(packet(3, Buffer.from("frame")));
    const entered = deferred(), release = deferred(), probe = backend.displayGeometry;
    backend.displayGeometry = async (...args) => { entered.resolve(); await release.promise; return probe(...args); };
    const pending = manager.getFrameGeometry(serial, "video"), rejected = assert.rejects(pending, error => error.code === "STALE_SNAPSHOT");
    await entered.promise;
    if (change === "dimensions") { await video.send(configPacket(3200, 1440)); await video.send(packet(3, Buffer.from("new-frame"))); }
    else if (change === "epoch") { state.devices[0].state = "offline"; await manager.listDevices(); state.devices[0].state = "online"; await manager.listDevices(); }
    else await video.connection.close();
    release.resolve(); await rejected;
  });
}

test("offline epochs and full stop reject late packets from old viewers without adding another subscription", async t => {
  // Deliberately misbehave after close so old-provider bytes still exercise the epoch fence.
  const { manager, view, state, viewers } = fixture(t, { delayedClose: true });
  const video = await view(); await video.send(configPacket()); await video.send(packet(3, Buffer.from("before")));
  state.devices[0].state = "offline"; await manager.listDevices();
  assert.equal(video.source.closed, 1, "offline discovery must close even a viewer with no input lease");
  state.devices[0].state = "online"; await manager.listDevices();
  await video.send(configPacket()); await video.send(packet(3, Buffer.from("late-old-epoch")));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  const current = await view(); await current.send(configPacket()); await current.send(packet(3, Buffer.from("current")));
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "passed");
  await manager.stopDevice(serial);
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  assert.equal(viewers.length, 2); assert.ok(viewers.every(item => item.closed === 1));
});

test("late video opening after a stop closes its connection rather than registering old epoch evidence", async t => {
  const { manager, backend, viewers } = fixture(t);
  const entered = deferred(), release = deferred(), open = backend.openVideoStream;
  backend.openVideoStream = async (...args) => { entered.resolve(); await release.promise; return open(...args); };
  const pending = manager.openVideoStream({ serial });
  const rejected = assert.rejects(pending, error => error.code === "STALE_SNAPSHOT");
  await entered.promise; await manager.stopDevice(serial); release.resolve(); await rejected;
  assert.equal(viewers.length, 1); assert.equal(viewers[0].closed, 1);
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
});

test("dimensionless screenshots count as received without borrowing previous screenshot geometry", async t => {
  const { manager, state, captures } = fixture(t);
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("image"), width: 1440, height: 3200 };
  await manager.captureLiveFrame({ serial }); await manager.getFrameGeometry(serial, "screenshot");
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("next image") };
  await manager.captureLiveFrame({ serial });
  const report = await manager.doctor(serial);
  assert.equal(check(report, "frame-freshness").status, "passed"); assert.match(check(report, "frame-freshness").reason, /screenshot received/);
  await assert.rejects(manager.getFrameGeometry(serial, "screenshot"), error => error.code === "STALE_SNAPSHOT");
  assert.equal(captures.filter(item => item.screenshot).length, 2);
});

test("a late screenshot from the prior epoch cannot repopulate frame metadata", async t => {
  const { manager, state } = fixture(t);
  const entered = deferred(), release = deferred();
  state.observation.screenshot = { mimeType: "image/png", data: Buffer.from("old"), width: 1440, height: 3200 };
  state.snapshotHook = async (_serial, options) => { if (options.includeScreenshot) { entered.resolve(); await release.promise; } };
  const pending = manager.captureLiveFrame({ serial }); await entered.promise;
  state.devices[0].state = "offline"; await manager.listDevices();
  state.devices[0].state = "online"; await manager.listDevices();
  release.resolve(); await pending;
  assert.equal(check(await manager.doctor(serial), "frame-freshness").status, "unknown");
  await assert.rejects(manager.getFrameGeometry(serial, "screenshot"), error => error.code === "STALE_SNAPSHOT");
});

for (const [label, error, expected] of [["permission", new Error("Permission denied: /private-path-secret"), /access was denied/], ["missing", new HarmonyError("COMMAND_FAILED", "No such file: /private-path-secret"), /was not found/]]) {
  test(`file diagnosis distinguishes ${label} without echoing provider paths`, async t => {
    const { manager, backend } = fixture(t); backend.listFiles = async () => { throw error; };
    const report = await manager.doctor(serial); assert.equal(check(report, "file-access").status, "failed");
    assert.match(check(report, "file-access").reason, expected); assert.doesNotMatch(JSON.stringify(report), /private-path-secret/);
  });
}

test("unavailable or truncated metadata is scoped, and cancellation never yields a passed diagnostic", async t => {
  const { manager, backend } = fixture(t);
  backend.listFiles = undefined;
  assert.equal(check(await manager.doctor(serial), "file-access").status, "unknown");
  backend.listFiles = async () => ({ files: [], truncated: true });
  assert.match(check(await manager.doctor(serial), "file-access").reason, /first page was truncated/);
  const entered = deferred(), release = deferred(), controller = new AbortController();
  backend.listFiles = async () => { entered.resolve(); await release.promise; return { files: [], truncated: false }; };
  const pending = manager.doctor(serial, controller.signal);
  const rejected = assert.rejects(pending, error => error.code === "COMMAND_ABORTED");
  await entered.promise; controller.abort(); release.resolve(); await rejected;
});

test("doctor uses only local verified snapshot metadata and safe history, without returning database identities or contents", async t => {
  const { manager } = fixture(t), map = globalThis.__pioraHarmonySqliteSnapshots;
  const now = Date.now(), key = "private-snapshot-token";
  const item = { directory: "C:/private-db-secret", path: "C:/private-db-secret/data.db", ownerSerial: serial, createdAt: now - 2000, readyAt: now - 1000, expiresAt: now + 60_000, inFlight: 0, closed: false };
  map.set(key, item); t.after(() => map.delete(key));
  const history = manager.operationTasks.begin({ serial, kind: "snapshot", title: "private-db-title", target: "private-db-target" });
  manager.operationTasks.complete(history, { verification: "double-copy-sha256", bytes: 1 });
  const report = await manager.doctor(serial);
  assert.equal(check(report, "database-snapshot").status, "passed"); assert.match(check(report, "database-snapshot").reason, /1 current-device local read-only snapshot/);
  assert.doesNotMatch(JSON.stringify(report), /private-snapshot-token|private-db-secret|private-db-title|private-db-target|SELECT/);
  assert.equal(map.get(key), item); assert.equal(item.inFlight, 0);
  const failed = manager.operationTasks.begin({ serial, kind: "snapshot", title: "other-private-db", target: "private-db-target" });
  manager.operationTasks.failed(failed, new HarmonyError("COMMAND_FAILED", "private SQL and path"));
  assert.match(check(await manager.doctor(serial), "database-snapshot").reason, /COMMAND_FAILED.*does not determine access for every application/);
  item.readyAt = undefined; assert.equal(check(await manager.doctor(serial), "database-snapshot").status, "unknown");
  assert.match(check(await manager.doctor(serial), "database-snapshot").reason, /awaiting its first successful verification/);
  item.readyAt = now - 1000; item.expiresAt = now - 1;
  assert.match(check(await manager.doctor(serial), "database-snapshot").reason, /have expired/); assert.equal(map.has(key), true, "doctor must not clean expired entries");
  map.delete(key);
  assert.match(check(await manager.doctor(serial), "database-snapshot").reason, /No verified local snapshot.*Last capture failed/);
  assert.equal(manager.operationTasks.list(serial).length, 2, "doctor never creates another capture task");
});
