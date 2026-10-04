import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { inspectHarmonySqlite, openHarmonySqliteSnapshot, readHarmonySqliteSnapshot, closeHarmonySqliteSnapshot, exportHarmonySqliteSnapshot } = await jiti.import("./harmony/sqlite-inspector.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

test("SQLite structure retains generated fields, expression index keys and automatic constraints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-structure-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE parent(id TEXT PRIMARY KEY); INSERT INTO parent VALUES ('p');
    CREATE TABLE sample(id INTEGER PRIMARY KEY, name TEXT UNIQUE DEFAULT 'untitled', base INTEGER NOT NULL DEFAULT 2,
      vcalc INTEGER GENERATED ALWAYS AS (base * 2) VIRTUAL,
      scalc INTEGER GENERATED ALWAYS AS (base * 3) STORED, parent_id TEXT REFERENCES parent);
    CREATE INDEX expression_idx ON sample(lower(name) COLLATE NOCASE DESC, base ASC) WHERE base > 0;
    INSERT INTO sample(id, name, base, parent_id) VALUES (1, '中文', 3, 'p');`);
  db.close();
  const source = await readFile(path);
  try {
    const page = await inspectHarmonySqlite(path, "sample");
    assert.deepEqual(page.fields.map(field => field.name), page.columns, "generated columns are visible SELECT columns, not hidden virtual-table internals");
    assert.equal(page.fields.find(field => field.name === "vcalc").generated, "virtual");
    assert.equal(page.fields.find(field => field.name === "scalc").generated, "stored");
    assert.equal(page.foreignKeys[0].to, null, "an implicit parent primary key must not be rendered as a column named null");
    assert.match(page.definition, /GENERATED ALWAYS/);
    const expression = page.indexes.find(index => index.name === "expression_idx");
    assert.equal(expression.partial, true);
    assert.equal(expression.origin, "created");
    assert.deepEqual(expression.keyParts, [
      { kind: "expression", descending: true, collation: "NOCASE" },
      { kind: "column", name: "base", descending: false, collation: "BINARY" },
    ], "auxiliary rowid columns must not become declared index keys");
    assert.ok(!expression.columns.includes("null"));
    assert.match(expression.definition, /lower\(name\).*WHERE base > 0/);
    const listed = await inspectHarmonySqlite(path);
    const auto = listed.indexes.find(index => index.table === "sample" && index.origin === "unique");
    assert.ok(auto?.unique, "the object tree must include automatic UNIQUE-constraint indexes");
    assert.ok(listed.indexes.some(index => index.table === "parent" && index.origin === "primary-key"));
    assert.deepEqual(await readFile(path), source, "structure reads must leave the actual database bytes unchanged");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
    assert.deepEqual(list.indexes, [{ name: "sample_note", table: "sample", unique: false, partial: false,
      origin: "created", columns: ["note"], keyParts: [{ kind: "column", name: "note", descending: false, collation: "BINARY" }],
      definition: "CREATE INDEX sample_note ON sample(note)" }]);
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

test("SQLite failures carry parser offsets converted to textarea coordinates without replacing prior data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-error-position-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(note TEXT); INSERT INTO sample VALUES ('original')"); db.close();
  let snapshot;
  try {
    snapshot = await openHarmonySqliteSnapshot(path);
    for (const query of ["SELECT note\nFRM sample", "SELECT '中文😀 sample' FRM sample", "SELECT missing FROM sample"]) {
      const expected = query.includes("missing") ? query.indexOf("missing") : query.lastIndexOf("sample");
      await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, query), error => {
        assert.equal(error.code, "INVALID_RESPONSE"); assert.equal(error.details?.sqlErrorOffset, expected);
        assert.ok(!JSON.stringify(error.toJSON()).includes(directory)); return true;
      });
    }
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "SELECT ("), error => {
      assert.equal(error.details?.sqlErrorOffset, undefined, "incomplete input has no parser-supplied token location"); return true;
    });
    await assert.rejects(readHarmonySqliteSnapshot(snapshot.id, undefined, 0, "WITH x AS (SELECT 1) DELETE FROM sample"), error => {
      assert.equal(error.details?.sqlErrorOffset, undefined, "a runtime read-only rejection must not acquire a syntax position"); return true;
    });
    assert.deepEqual((await readHarmonySqliteSnapshot(snapshot.id, "sample")).rows, [["original"]]);
  } finally { if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id); await rm(directory, { recursive: true, force: true }); }
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

test("SQLite export chooses a bounded page and encodes CSV without changing source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-export-page-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(id INTEGER, note TEXT)");
  const insert = db.prepare("INSERT INTO sample VALUES (?, ?)");
  for (let index = 0; index < 203; index++) insert.run(index, `第 ${index} 行`);
  db.close();
  let snapshot;
  try {
    snapshot = await openHarmonySqliteSnapshot(path);
    const page = await exportHarmonySqliteSnapshot(snapshot.id, "sample", undefined, "csv", { range: "page", offset: 200, encoding: "utf-16le" });
    const chunks = [];
    for await (const chunk of page.stream) chunks.push(chunk);
    const encoded = Buffer.concat(chunks);
    assert.equal(encoded.subarray(0, 2).toString("hex"), "fffe");
    const rows = encoded.subarray(2).toString("utf16le").trim().split("\r\n");
    assert.deepEqual(rows, ['"id","note"', '"200","第 200 行"', '"201","第 201 行"', '"202","第 202 行"']);
    assert.equal(page.rows, 3);
    assert.equal(page.size, encoded.length);
    await assert.rejects(exportHarmonySqliteSnapshot(snapshot.id, "sample", undefined, "json", { range: "all", offset: 0, encoding: "utf-16le" }), error => error.code === "INVALID_ARGUMENT");
    await assert.rejects(exportHarmonySqliteSnapshot(snapshot.id, "sample", undefined, "csv", { range: "page", offset: -1, encoding: "utf-8" }), error => error.code === "INVALID_ARGUMENT");
  } finally {
    if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id);
    await rm(directory, { recursive: true, force: true });
  }
});
