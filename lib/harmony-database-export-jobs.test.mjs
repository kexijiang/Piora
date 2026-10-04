import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HarmonyDatabaseExportJobs } = await jiti.import("./harmony/database-export-jobs.ts");
const { openHarmonySqliteSnapshot, openHarmonySqliteTrustedSnapshot, closeHarmonySqliteSnapshot, assertHarmonySqliteSnapshotOwner } = await jiti.import("./harmony/sqlite-inspector.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");

async function settled(jobs, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = jobs.list("phone").find(item => item.id === id);
    if (job && !["queued", "running"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Database export job did not settle");
}

test("database export task keeps a verified file, local target and restart-safe history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-db-export-jobs-"));
  const databasePath = join(directory, "sample.db"), destinationPath = join(directory, "result.csv"), journal = join(directory, "jobs.json");
  allowFileRoot(directory);
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE sample(id INTEGER, note TEXT)");
  database.prepare("INSERT INTO sample VALUES (?, ?)").run(1, "中文");
  database.close();
  let snapshot;
  try {
    const workspaceSnapshot = await openHarmonySqliteSnapshot(databasePath);
    assertHarmonySqliteSnapshotOwner(workspaceSnapshot.id);
    assert.throws(() => assertHarmonySqliteSnapshotOwner(workspaceSnapshot.id, "phone"), error => error.code === "INVALID_ARGUMENT");
    await closeHarmonySqliteSnapshot(workspaceSnapshot.id);
    snapshot = await openHarmonySqliteTrustedSnapshot(databasePath, "phone");
    assertHarmonySqliteSnapshotOwner(snapshot.id, "phone");
    assert.throws(() => assertHarmonySqliteSnapshotOwner(snapshot.id, "another-phone"), error => error.code === "INVALID_ARGUMENT");
    assert.throws(() => assertHarmonySqliteSnapshotOwner(snapshot.id), error => error.code === "INVALID_ARGUMENT");
    const jobs = new HarmonyDatabaseExportJobs(journal);
    const created = await jobs.create({ serial: "phone", snapshotId: snapshot.id, source: "Notes / sample.db / sample", table: "sample",
      format: "csv", options: { range: "all", offset: 0, encoding: "utf-8-bom" }, destinationPath });
    const completed = await settled(jobs, created.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.rows, 1);
    assert.ok(completed.bytes > 10);
    const bytes = await readFile(destinationPath);
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf");
    assert.equal(bytes.subarray(3).toString("utf8"), '"id","note"\r\n"1","中文"\r\n');
    assert.equal(bytes.length, completed.bytes);
    const privateJournal = await readFile(journal, "utf8");
    assert.ok(!privateJournal.includes(snapshot.id), "snapshot bearer ID must not survive in task history");
    const restored = new HarmonyDatabaseExportJobs(journal);
    assert.equal(restored.list("phone")[0].status, "completed");
    await assert.rejects(restored.openDownload(created.id, "another-phone"), error => error.code === "INVALID_ARGUMENT");
    const download = await restored.openDownload(created.id, "phone");
    await assert.rejects(restored.remove(created.id, "phone"), error => error.code === "DEVICE_BUSY");
    const chunks = [];
    for await (const chunk of download.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    await restored.remove(created.id, "phone");
    assert.equal(restored.list("phone").length, 0);
    await assert.rejects(stat(join(directory, "harmony-database-export-artifacts", `${created.id}.csv`)), { code: "ENOENT" });
    assert.equal((await readFile(destinationPath)).length, bytes.length, "removing history never deletes the user's chosen target");
  } finally {
    if (snapshot) await closeHarmonySqliteSnapshot(snapshot.id);
    await rm(directory, { recursive: true, force: true });
  }
});

test("database export rejects an existing target and settles cancellation without publishing a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-db-export-cancel-"));
  allowFileRoot(directory);
  const journal = join(directory, "jobs.json"), destinationPath = join(directory, "result.csv");
  const jobs = new HarmonyDatabaseExportJobs(journal, async (_input, signal) => {
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    throw new Error("unreachable");
  });
  const databasePath = join(directory, "sample.db");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE sample(id INTEGER)");
  database.close();
  const snapshot = await openHarmonySqliteTrustedSnapshot(databasePath, "phone");
  const snapshotId = snapshot.id;
  try {
    await writeFile(destinationPath, "existing result");
    await assert.rejects(jobs.create({ serial: "phone", snapshotId, source: "Notes / sample.db", table: "sample",
      format: "csv", options: { range: "all", offset: 0, encoding: "utf-8" }, destinationPath }), error => error.code === "INVALID_ARGUMENT");
    await rm(destinationPath);
    const created = await jobs.create({ serial: "phone", snapshotId, source: "Notes / sample.db", table: "sample",
      format: "csv", options: { range: "all", offset: 0, encoding: "utf-8" }, destinationPath });
    jobs.cancel(created.id, "phone");
    assert.equal((await settled(jobs, created.id)).status, "cancelled");
    await assert.rejects(stat(destinationPath), { code: "ENOENT" });
    await assert.rejects(jobs.openDownload(created.id, "phone"), error => error.code === "INVALID_ARGUMENT");
  } finally { await closeHarmonySqliteSnapshot(snapshotId); await rm(directory, { recursive: true, force: true }); }
});

test("database export restart marks unfinished work interrupted and removes partial data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-db-export-restart-"));
  const id = "12345678-1234-1234-1234-123456789abc", artifactDirectory = join(directory, "harmony-database-export-artifacts");
  try {
    await mkdir(artifactDirectory);
    await writeFile(join(artifactDirectory, `${id}.part`), "partial private export");
    await writeFile(join(artifactDirectory, `${id}.csv`), "unverified private export");
    await writeFile(join(directory, "jobs.json"), JSON.stringify([{ id, serial: "phone", source: "Notes / sample.db", format: "csv",
      range: "all", offset: 0, encoding: "utf-8", status: "running", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" }]));
    const jobs = new HarmonyDatabaseExportJobs(join(directory, "jobs.json"));
    const job = jobs.list("phone")[0];
    assert.equal(job.status, "interrupted");
    assert.match(job.error, /restarted/);
    await assert.rejects(stat(join(artifactDirectory, `${id}.part`)), { code: "ENOENT" });
    await assert.rejects(stat(join(artifactDirectory, `${id}.csv`)), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
