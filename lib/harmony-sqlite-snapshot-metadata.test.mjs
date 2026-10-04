import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const jiti = createJiti(import.meta.url);
const { openHarmonySqliteTrustedSnapshot, openHarmonySqliteSnapshot, readHarmonySqliteSnapshot,
  closeHarmonySqliteSnapshot, peekHarmonySqliteSnapshotMetadata } = await jiti.import("./harmony/sqlite-inspector.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const actualWorker = fileURLToPath(new URL("./harmony/runtime/sqlite-inspector.cjs", import.meta.url));
const store = globalThis.__pioraHarmonySqliteSnapshots;
const empty = { active: 0, opening: 0, expired: 0, closed: 0 };

async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-metadata-test-"));
  const path = join(directory, "private-source.db");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE private_table(note TEXT); INSERT INTO private_table VALUES ('private-row-content')"); db.close();
  return { directory, path, source: await readFile(path) };
}

async function workerGate(directory, fail = false) {
  const root = join(directory, "runtime"), path = join(root, "lib", "harmony", "runtime", "sqlite-inspector.cjs");
  const gate = join(directory, "release-worker"), started = join(directory, "started-worker");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `const fs = require('node:fs');
    fs.appendFileSync(${JSON.stringify(started)}, 'start\\n');
    const gate = ${JSON.stringify(gate)}, deadline = Date.now() + 3000;
    while (!fs.existsSync(gate) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (!fs.existsSync(gate)) throw new Error('Test worker gate was not released');
    ${fail ? "require('node:worker_threads').parentPort.postMessage({error:'private-path-and-SQL-failure'})" : `require(${JSON.stringify(actualWorker)})`};`);
  const previous = process.env.PIORA_WEB_RUNTIME_ROOT;
  process.env.PIORA_WEB_RUNTIME_ROOT = root;
  return {
    started,
    release: () => writeFile(gate, "ready"),
    restore: () => { if (previous === undefined) delete process.env.PIORA_WEB_RUNTIME_ROOT; else process.env.PIORA_WEB_RUNTIME_ROOT = previous; },
  };
}

async function waitOpening(serial) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (peekHarmonySqliteSnapshotMetadata(serial).opening === 1) return [...store].find(([, item]) => item.ownerSerial === serial);
    await delay(10);
  }
  assert.fail("actual private snapshot did not enter initial worker validation");
}

function assertPrivate(metadata, path, id) {
  assert.deepEqual(Object.keys(metadata).sort(), metadata.latestActive
    ? ["active", "closed", "expired", "latestActive", "opening"] : ["active", "closed", "expired", "opening"]);
  if (metadata.latestActive) assert.deepEqual(Object.keys(metadata.latestActive).sort(), ["createdAt", "expiresAt", "readyAt"]);
  const text = JSON.stringify(metadata);
  assert.ok(!text.includes(path)); if (id) assert.ok(!text.includes(id));
  assert.doesNotMatch(text, /private_table|private-row-content|SELECT|private-path-and-SQL/);
}

test("an actual SQLite snapshot remains opening until its first successful worker read, then exposes only ready metadata", async t => {
  const { directory, path, source } = await database(t), serial = "metadata-success";
  const gate = await workerGate(directory), pending = openHarmonySqliteTrustedSnapshot(path, serial);
  let snapshot;
  try {
    const [id, item] = await waitOpening(serial);
    assert.equal(item.inFlight, 1); assert.equal(item.readyAt, undefined);
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), { ...empty, opening: 1 });
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata("other-device"), empty);
    assertPrivate(peekHarmonySqliteSnapshotMetadata(serial), path, id);
    await gate.release(); snapshot = await pending; gate.restore();
    const metadata = peekHarmonySqliteSnapshotMetadata(serial);
    assert.equal(metadata.active, 1); assert.equal(metadata.opening, 0);
    assert.ok(metadata.latestActive.createdAt <= metadata.latestActive.readyAt);
    assert.ok(metadata.latestActive.readyAt <= Date.now());
    assert.equal(metadata.latestActive.expiresAt - metadata.latestActive.createdAt, 600_000);
    assertPrivate(metadata, path, snapshot.id);
    const starts = await readFile(gate.started, "utf8"), inFlight = item.inFlight;
    for (let index = 0; index < 20; index++) assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), metadata);
    assert.equal(await readFile(gate.started, "utf8"), starts, "metadata peeks must not start more workers");
    assert.equal(item.inFlight, inFlight, "metadata peeks must not query an existing worker");
    assert.deepEqual((await readHarmonySqliteSnapshot(snapshot.id, "private_table")).rows, [["private-row-content"]]);
    assert.deepEqual(await readFile(path), source, "all local observation leaves the source database bytes unchanged");
    await closeHarmonySqliteSnapshot(snapshot.id);
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), empty);
    assert.equal(existsSync(item.directory), false);
  } finally { await gate.release(); gate.restore(); await pending.catch(() => undefined); if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id); }
});

test("failed first verification removes its actual private copy and never becomes active", async t => {
  const { directory, path, source } = await database(t), serial = "metadata-failure";
  const gate = await workerGate(directory, true), pending = openHarmonySqliteTrustedSnapshot(path, serial);
  const rejected = assert.rejects(pending, error => error.code === "INVALID_RESPONSE");
  try {
    const [id, item] = await waitOpening(serial);
    assert.equal(peekHarmonySqliteSnapshotMetadata(serial).active, 0);
    await gate.release(); await rejected;
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), empty);
    assert.equal(store.has(id), false); assert.equal(existsSync(item.directory), false);
    assert.deepEqual(await readFile(path), source);
  } finally { await gate.release(); gate.restore(); await pending.catch(() => undefined); }
});

test("closing during first verification cannot let the late successful worker resurrect readiness", async t => {
  const { directory, path } = await database(t), serial = "metadata-close-opening";
  const gate = await workerGate(directory), pending = openHarmonySqliteTrustedSnapshot(path, serial);
  const rejected = assert.rejects(pending, error => error.code === "STALE_SNAPSHOT");
  try {
    const [id, item] = await waitOpening(serial);
    await closeHarmonySqliteSnapshot(id);
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), empty);
    assert.equal(existsSync(item.directory), true, "in-flight private data stays until its worker completes");
    await gate.release(); await rejected;
    assert.equal(item.readyAt, undefined); assert.equal(store.has(id), false); assert.equal(existsSync(item.directory), false);
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), empty);
  } finally { await gate.release(); gate.restore(); await pending.catch(() => undefined); }
});

test("device ownership and expiry are observed locally without cleaning or touching an expired snapshot", async t => {
  const { directory, path } = await database(t), serial = "metadata-expiry";
  allowFileRoot(directory);
  const owned = await openHarmonySqliteTrustedSnapshot(path, serial), other = await openHarmonySqliteTrustedSnapshot(path, "metadata-other");
  const workspace = await openHarmonySqliteSnapshot(path);
  try {
    const item = store.get(owned.id), metadata = peekHarmonySqliteSnapshotMetadata(serial);
    assert.equal(metadata.active, 1, "workspace and other-device copies do not belong to this device");
    assert.equal(peekHarmonySqliteSnapshotMetadata("metadata-other").active, 1);
    const actualNow = Date.now;
    try {
      Date.now = () => metadata.latestActive.expiresAt + 1;
      const expired = peekHarmonySqliteSnapshotMetadata(serial);
      assert.deepEqual(expired, { ...empty, expired: 1 }); assertPrivate(expired, path, owned.id);
      assert.equal(store.get(owned.id), item); assert.equal(item.closed, false); assert.equal(item.inFlight, 0);
      assert.equal(existsSync(item.path), true, "expiry reporting must not perform cleanup");
    } finally { Date.now = actualNow; }
    assert.equal(peekHarmonySqliteSnapshotMetadata(serial).active, 1);
    await closeHarmonySqliteSnapshot(owned.id);
    assert.deepEqual(peekHarmonySqliteSnapshotMetadata(serial), empty);
    assert.equal(peekHarmonySqliteSnapshotMetadata("metadata-other").active, 1);
  } finally { await Promise.all([owned, other, workspace].map(snapshot => closeHarmonySqliteSnapshot(snapshot.id))); }
});
