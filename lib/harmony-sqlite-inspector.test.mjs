import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const { inspectHarmonySqlite } = await jiti.import("./harmony/sqlite-inspector.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

test("SQLite inspector lists ordinary tables and bounds rows, cells and blobs without modifying source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-sqlite-test-"));
  const path = join(directory, "sample.db");
  allowFileRoot(directory);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE sample(id INTEGER, note TEXT, data BLOB)");
  const insert = db.prepare("INSERT INTO sample VALUES(?,?,?)");
  for (let index = 0; index < 52; index++) insert.run(index, "x".repeat(500), Buffer.alloc(100, 0xab));
  db.close();
  try {
    const list = await inspectHarmonySqlite(path);
    assert.deepEqual(list.tables, ["sample"]);
    const page = await inspectHarmonySqlite(path, "sample");
    assert.deepEqual(page.columns, ["id", "note", "data"]);
    assert.equal(page.rows.length, 50);
    assert.equal(page.hasMore, true);
    assert.equal(page.rows[0][1].length, 401);
    assert.deepEqual(page.rows[0][2], { blobHex: "ab".repeat(64), size: 100, truncated: true });
    assert.equal((await inspectHarmonySqlite(path, "sample", 50)).rows.length, 2);
    await assert.rejects(inspectHarmonySqlite(path, "sample\"; DROP TABLE sample;--"), error => error.code === "INVALID_RESPONSE");
    assert.deepEqual((await inspectHarmonySqlite(path)).tables, ["sample"]);
    await writeFile(`${path}-wal`, "pending");
    await assert.rejects(inspectHarmonySqlite(path), error => error.code === "CAPABILITY_UNAVAILABLE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SQLite inspector refuses paths outside allowed roots and invalid pagination", async () => {
  await assert.rejects(inspectHarmonySqlite("relative.db"), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(inspectHarmonySqlite("C:\\outside\\no.db"), error => error.code === "INVALID_ARGUMENT");
  await assert.rejects(inspectHarmonySqlite("relative.db", undefined, -1), error => error.code === "INVALID_ARGUMENT");
});
