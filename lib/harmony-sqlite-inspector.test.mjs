import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { inspectHarmonySqlite, openHarmonySqliteSnapshot, readHarmonySqliteSnapshot, closeHarmonySqliteSnapshot, exportHarmonySqliteSnapshot } = await jiti.import("./harmony/sqlite-inspector.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

test("SQLite inspector lists ordinary tables and bounds rows, cells and blobs without modifying source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-test-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, note TEXT, data BLOB); CREATE INDEX sample_note ON sample(note); CREATE VIEW sample_view AS SELECT id, note FROM sample");
  const insert = db.prepare("INSERT INTO sample VALUES(?,?,?)");
  for (let index = 0; index < 202; index++) insert.run(index, "x".repeat(500), Buffer.alloc(100, 0xab));
  db.close();
  try {
    const list = await inspectHarmonySqlite(path);
    assert.deepEqual(list.tables, ["sample"]);
    assert.deepEqual(list.views, ["sample_view"]);
    const page = await inspectHarmonySqlite(path, "sample");
    assert.deepEqual(page.columns, ["id", "note", "data"]);
    assert.equal(page.rows.length, 200);
    assert.equal(page.hasMore, true);
    assert.equal(page.fields[0].primaryKey, 1);
    assert.equal(page.indexes[0].name, "sample_note");
    assert.equal(page.rows[0][1].length, 401);
    assert.deepEqual(page.rows[0][2], { blobHex: "ab".repeat(64), size: 100, truncated: true });
    assert.equal((await inspectHarmonySqlite(path, "sample", 200)).rows.length, 2);
    assert.deepEqual((await inspectHarmonySqlite(path, "sample_view", 200)).columns, ["id", "note"]);
    await assert.rejects(inspectHarmonySqlite(path, "sample\"; DROP TABLE sample;--"), error => error.code === "INVALID_RESPONSE");
    assert.deepEqual((await inspectHarmonySqlite(path)).tables, ["sample"]);
    await writeFile(`${path}-wal`, "pending");
    await assert.rejects(inspectHarmonySqlite(path), error => error.code === "CAPABILITY_UNAVAILABLE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SQLite snapshot keeps one version across pages and isolates read-only SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-snapshot-test-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY, note TEXT)");
  db.prepare("INSERT INTO sample VALUES (?, ?)").run(1, "original");
  db.close();
  let snapshot;
  try {
    snapshot = await openHarmonySqliteSnapshot(path);
    const db2 = new DatabaseSync(path);
    db2.prepare("UPDATE sample SET note=? WHERE id=1").run("new source content");
    db2.close();
    assert.equal((await readHarmonySqliteSnapshot(snapshot.id, "sample")).rows[0][1], "original");
    const queried = await readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "WITH chosen AS (SELECT note FROM sample) SELECT note FROM chosen");
    assert.equal(queried.rows[0][0], "original");
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "DELETE FROM sample"), error => error.code === "INVALID_ARGUMENT");
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "SELECT * FROM sample; DROP TABLE sample"), error => error.code === "INVALID_ARGUMENT");
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "WITH x AS (SELECT 1) DELETE FROM sample"), error => error.code === "INVALID_RESPONSE");
    await closeHarmonySqliteSnapshot(snapshot.id);
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id), error => error.code === "STALE_SNAPSHOT");
    assert.equal((await inspectHarmonySqlite(path, "sample")).rows[0][1], "new source content");
  } finally {
    if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id);
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite inspector refuses paths outside allowed roots and invalid pagination", async () => {
  await assert.rejects(inspectHarmonySqlite("relative.db"), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(inspectHarmonySqlite("C:\\outside\\no.db"), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(inspectHarmonySqlite("relative.db", undefined, -1), error => error.code === "INVALID_ARGUMENT");
});

test("SQLite export streams complete CSV and JSON from the same snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-export-test-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(id INTEGER, note TEXT, blob BLOB)");
  db.prepare("INSERT INTO sample VALUES (?, ?, ?)").run(9007199254740993n, '=SUM(1,1)\n中文', Buffer.from([0, 1, 255]));
  db.close();
  let snapshot;
  try {
    snapshot = await openHarmonySqliteSnapshot(path);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, "sample", 0, undefined, cancelled.signal), error => error.code === "COMMAND_ABORTED");
    const json = await exportHarmonySqliteSnapshot(snapshot.id, "sample", undefined, "json");
    const jsonChunks = [];
    for await (const chunk of json.stream) jsonChunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
    assert.deepEqual(parsed.columns, ["id", "note", "blob"]);
    assert.deepEqual(parsed.rows[0], ["9007199254740993", '=SUM(1,1)\n中文', { base64: "AAH/", size: 3 }]);
    assert.equal(json.size, Buffer.concat(jsonChunks).length);
    const csv = await exportHarmonySqliteSnapshot(snapshot.id, undefined, "SELECT note FROM sample", "csv");
    await closeHarmonySqliteSnapshot(snapshot.id);
    const csvChunks = [];
    for await (const chunk of csv.stream) csvChunks.push(chunk);
    assert.equal(Buffer.concat(csvChunks).toString("utf8"), '"note"\r\n"\'=SUM(1,1)\n中文"\r\n');
    await assert.rejects(exportHarmonySqliteSnapshot(snapshot.id, "sample", undefined, "json"), error => error.code === "STALE_SNAPSHOT");
  } finally {
    if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id);
    await rm(directory, { recursive: true, force: true });
  }
});
