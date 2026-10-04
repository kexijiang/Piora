import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const { deviceDatabaseCatalog, openDeviceDatabase } = await createJiti(import.meta.url).import("./harmony/device-databases.ts");
const { closeHarmonySqliteSnapshot, readHarmonySqliteSnapshot } = await createJiti(import.meta.url).import("./harmony/sqlite-inspector.ts");
const { HarmonyError } = await createJiti(import.meta.url).import("./harmony/errors.ts");
const { HarmonyOperationTasks } = await createJiti(import.meta.url).import("./harmony/operation-tasks.ts");

test("database discovery keeps application ownership, distinguishes inaccessible apps and opens verified device snapshots", async () => {
  const local = await mkdtemp(join(tmpdir(), "piora-database-catalog-test-"));
  const paths = new Map();
  let captureCount = 0, alterSecondCopy = false;
  let totalPulls = 0;
  let growEmptyWalAfterPull = false;
  let releaseScan;
  const scanGate = new Promise(resolve => { releaseScan = resolve; });
  try {
    for (const name of ["notes.db", "cache.db", "audit.db"]) {
      const path = join(local, name);
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes(body) VALUES ('hello Harmony');");
      db.close();
      paths.set(name, path);
    }
    const files = await Promise.all(["notes.db", "cache.db"].map(async name => ({
      path: `data/storage/el2/database/entry/${name}`, name, kind: "file", size: (await stat(paths.get(name))).size, modifiedAt: 12345,
    })));
    files.push({ path: "data/storage/el2/database/entry/readme.txt", name: "readme.txt", kind: "file", size: 1024, modifiedAt: 12345 });
    files.push({ path: "data/storage/el2/database/entry/secret.db", name: "secret.db", kind: "file", size: 1024, modifiedAt: 12345 });
    files.push({ path: "data/storage/el2/database/entry/secure", name: "secure", kind: "file", size: 1024, modifiedAt: 12345 });
    files.push({ path: "data/storage/el2/database/entry/empty.db", name: "empty.db", kind: "file", size: 0, modifiedAt: 12345 });
    files.push({ path: "data/storage/el2/database/entry/huge.db", name: "huge.db", kind: "file", size: 65 * 1024 * 1024, modifiedAt: 12345 });
    const alternate = { path: "data/storage/el2/base/database/notes.db", name: "notes.db", kind: "file",
      size: (await stat(paths.get("notes.db"))).size, modifiedAt: 12345 };
    globalThis.__pioraHarmonyDeviceManager = {
      operationTasks: new HarmonyOperationTasks(join(local, "operation-tasks.json")),
      async applications() { return [
        { bundleName: "com.example.notes", label: "Notes" },
        { bundleName: "com.example.empty", label: "Empty" },
        { bundleName: "com.example.locked", label: "Locked" },
      ]; },
      async listProcesses() { return ["com.example.notes", "com.example.empty", "com.example.locked"].map((name, index) => ({ name, pid: index + 1 })); },
      async isSqliteFile(_serial, _scope, path) { return !path.endsWith("readme.txt") && !path.endsWith("secret.db") && !path.endsWith("secure"); },
      async listFiles(_serial, scope, path) {
        if (scope.bundleName === "com.example.locked") throw new HarmonyError("COMMAND_FAILED", "HDC rejected the device command");
        if (path === "data/storage/el2/database") await scanGate;
        if (scope.bundleName !== "com.example.notes") throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device directory does not exist", { details: { reason: "missing" } });
        if (path === "data/storage/el2/database") return { files: [{ path: `${path}/entry`, name: "entry", kind: "directory" }], truncated: false };
        if (path === "data/storage/el2/database/entry") return { files, truncated: false };
        if (path === "data/storage/el2/base/database") return { files: [alternate], truncated: false };
        throw new HarmonyError("CAPABILITY_UNAVAILABLE", "The device directory does not exist", { details: { reason: "missing" } });
      },
      async pullFile(_serial, _scope, remote, destination) {
        totalPulls++;
        await copyFile(paths.get(remote.split("/").at(-1)), destination);
        if (growEmptyWalAfterPull) { files.at(-1).size = 4096; growEmptyWalAfterPull = false; }
        if (alterSecondCopy && ++captureCount === 2) await appendFile(destination, "changed");
        return { destinationPath: destination };
      },
    };
    let catalog = deviceDatabaseCatalog("phone", true);
    for (let attempt = 0; catalog.applications.length < 3 && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      catalog = deviceDatabaseCatalog("phone");
    }
    assert.deepEqual(catalog.applications.map(app => app.status), ["scanning", "scanning", "pending"], "only active workers show scanning; queued apps remain pending");
    releaseScan();
    for (let attempt = 0; catalog.scanning && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      catalog = deviceDatabaseCatalog("phone");
    }
    assert.equal(catalog.scanning, false);
    assert.deepEqual(catalog.applications.map(app => [app.bundleName, app.status, app.databases.length]), [
      ["com.example.notes", "ready", 7], ["com.example.empty", "empty", 0], ["com.example.locked", "inaccessible", 0],
    ]);
    const unreadable = catalog.applications[0].databases.find(database => database.name === "secret.db");
    assert.equal(unreadable.status, "unavailable", "an encrypted or unrecognized .db file must not become an empty app result");
    assert.equal(catalog.applications[0].databases.find(database => database.name === "secure")?.status, "unavailable", "an extensionless encrypted database in a standard database folder must be reported");
    assert.equal(catalog.applications[0].databases.find(database => database.name === "empty.db")?.status, "unavailable", "a truncated database file must not be reported as no database");
    assert.match(catalog.applications[0].databases.find(database => database.name === "huge.db")?.reason ?? "", /64 MiB/, "oversized databases remain visible with their read-only limit");
    assert.equal(catalog.applications[0].databases.some(database => database.name === "readme.txt"), false);
    const sameName = catalog.applications[0].databases.filter(database => database.name === "notes.db");
    assert.equal(sameName.length, 2, "same-named databases in separate app directories remain distinct");
    assert.equal(new Set(sameName.map(database => database.identity)).size, 2, "stable opaque identities distinguish the paths without exposing them");
    await assert.rejects(() => openDeviceDatabase("phone", unreadable.id), error => error.code === "CAPABILITY_UNAVAILABLE");
    assert.ok(!JSON.stringify(catalog).includes("data/storage/"), "catalog never exposes raw sandbox paths");
    const databaseId = catalog.applications[0].databases[0].id;
    const snapshot = await openDeviceDatabase("phone", databaseId);
    assert.ok(snapshot.capturedAt);
    assert.equal(snapshot.database.size, catalog.applications[0].databases[0].size);
    assert.equal(snapshot.database.verification, "double-copy-sha256");
    assert.deepEqual(snapshot.result.tables, ["notes"]);
    const captureTasks = globalThis.__pioraHarmonyDeviceManager.operationTasks.list("phone");
    assert.equal(captureTasks[0].status, "completed");
    assert.equal(captureTasks[0].verification, "double-copy-sha256");
    assert.equal(captureTasks[0].capturedAt, snapshot.capturedAt);
    assert.equal(captureTasks[0].bytes, snapshot.database.size);
    assert.ok(!JSON.stringify(captureTasks).includes("data/storage/"), "capture records contain no private device path");
    await closeHarmonySqliteSnapshot(snapshot.id);
    const pullsBeforeJournal = totalPulls;
    files.push({ path: "data/storage/el2/database/entry/notes.db-wal", name: "notes.db-wal", kind: "file", size: 4096, modifiedAt: 12345 });
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "CAPABILITY_UNAVAILABLE"
      && error.toJSON().details?.reason === "database-active-journal");
    assert.equal(totalPulls, pullsBeforeJournal, "an active journal must be refused before copying potentially inconsistent data");
    files.pop();
    const checkpointedWal = { path: "data/storage/el2/database/entry/notes.db-wal", name: "notes.db-wal", kind: "file", size: 0, modifiedAt: 12345 };
    files.push(checkpointedWal);
    const emptyWalSnapshot = await openDeviceDatabase("phone", databaseId);
    assert.equal(emptyWalSnapshot.database.verification, "double-copy-sha256");
    assert.deepEqual((await readHarmonySqliteSnapshot(emptyWalSnapshot.id, "notes")).rows, [["1", "hello Harmony"]], "an empty checkpointed WAL does not hide committed main-file rows");
    await closeHarmonySqliteSnapshot(emptyWalSnapshot.id);
    const pullsBeforeGrowth = totalPulls;
    growEmptyWalAfterPull = true;
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "CAPABILITY_UNAVAILABLE"
      && error.toJSON().details?.reason === "database-active-journal");
    assert.equal(totalPulls, pullsBeforeGrowth + 1, "a WAL that grows after the first copy prevents any snapshot from being published");
    checkpointedWal.size = undefined;
    const pullsBeforeUnknown = totalPulls;
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "CAPABILITY_UNAVAILABLE");
    assert.equal(totalPulls, pullsBeforeUnknown, "unknown WAL sizes remain unsafe before any copy");
    checkpointedWal.size = 0; checkpointedWal.kind = "directory";
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "CAPABILITY_UNAVAILABLE");
    checkpointedWal.kind = "file"; checkpointedWal.name = "notes.db-journal";
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "CAPABILITY_UNAVAILABLE",
      "this change does not relax rollback-journal checks");
    files.pop();
    alterSecondCopy = true; captureCount = 0;
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "STALE_SNAPSHOT"
      && error.toJSON().details?.reason === "database-changed-during-capture");
    assert.equal(globalThis.__pioraHarmonyDeviceManager.operationTasks.list("phone")[0].status, "failed", "inconsistent copies never publish a completed capture");
    let rescanned = deviceDatabaseCatalog("phone", true);
    for (let attempt = 0; rescanned.scanning && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      rescanned = deviceDatabaseCatalog("phone");
    }
    assert.equal(rescanned.scanning, false);
    const afterRefresh = rescanned.applications[0].databases.filter(database => database.name === "notes.db");
    assert.deepEqual(afterRefresh.map(database => database.identity).sort(), sameName.map(database => database.identity).sort(),
      "opaque identities survive rescans so same-named tabs can be restored unambiguously");
    assert.notDeepEqual(afterRefresh.map(database => database.id), sameName.map(database => database.id),
      "short-lived operation IDs must rotate on rescan");
    await assert.rejects(() => openDeviceDatabase("phone", databaseId), error => error.code === "STALE_SNAPSHOT"
      && error.toJSON().details?.reason === "database-id-expired");
  } finally {
    releaseScan();
    globalThis.__pioraHarmonyDeviceManager = undefined;
    await rm(local, { recursive: true, force: true });
  }
});

test("module-owned files directories are discovered within the app scan budget without scanning module caches", async () => {
  const missing = () => { throw new HarmonyError("CAPABILITY_UNAVAILABLE", "Missing directory", { details: { reason: "missing" } }); };
  const calls = [];
  const moduleRoot = "data/storage/el2/base/haps";
  globalThis.__pioraHarmonyDeviceManager = {
    async applications() { return [{ bundleName: "dev.example.modules" }]; },
    async listProcesses() { return [{ name: "dev.example.modules", pid: 5 }]; },
    async isSqliteFile() { return true; },
    async listFiles(_serial, _scope, path) {
      calls.push(path);
      if (path === moduleRoot) return { files: ["entry", "feature"].map(name => ({ name, path: `${path}/${name}`, kind: "directory" })), truncated: false };
      if (path.endsWith("/files") && path.startsWith(moduleRoot)) return { files: [{ name: "backup.db", path: `${path}/backup.db`, kind: "file", size: 16384 }], truncated: false };
      return missing();
    },
  };
  try {
    let catalog = deviceDatabaseCatalog("module-phone", true);
    for (let attempt = 0; catalog.scanning && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10)); catalog = deviceDatabaseCatalog("module-phone");
    }
    assert.equal(catalog.scanning, false);
    assert.equal(catalog.applications[0].status, "ready");
    assert.equal(catalog.applications[0].databases.length, 2);
    assert.equal(new Set(catalog.applications[0].databases.map(db => db.identity)).size, 2);
    assert.ok(calls.includes(`${moduleRoot}/entry/files`) && calls.includes(`${moduleRoot}/feature/files`));
    assert.ok(!calls.some(path => /\/(?:cache|preferences|resources)$/.test(path)));
    assert.ok(calls.length <= 18);
    assert.ok(!JSON.stringify(catalog).includes("data/storage/"));
  } finally { globalThis.__pioraHarmonyDeviceManager = undefined; }
});

test("failed directory reads and exhausted module budgets cannot become no-database results", async () => {
  const calls = new Map();
  const apps = ["dev.example.failed", "dev.example.bounded"];
  globalThis.__pioraHarmonyDeviceManager = {
    async applications() { return apps.map(bundleName => ({ bundleName })); },
    async listProcesses() { return apps.map(name => ({ name, pid: 9 })); },
    async listFiles(_serial, scope, path) {
      calls.set(scope.bundleName, (calls.get(scope.bundleName) ?? 0) + 1);
      if (scope.bundleName.endsWith("failed")) throw new HarmonyError("OBSERVATION_UNAVAILABLE", "Malformed sandbox listing");
      if (path === "data/storage/el2/base/haps") return {
        files: Array.from({ length: 25 }, (_, index) => ({ name: `module${index}`, path: `${path}/module${index}`, kind: "directory" })), truncated: false,
      };
      return { files: [], truncated: false };
    },
  };
  try {
    let catalog = deviceDatabaseCatalog("bounded-phone", true);
    for (let attempt = 0; catalog.scanning && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10)); catalog = deviceDatabaseCatalog("bounded-phone");
    }
    assert.equal(catalog.scanning, false);
    assert.ok(catalog.applications.every(app => app.status === "inaccessible" && app.databases.length === 0));
    assert.match(catalog.applications.find(app => app.bundleName.endsWith("failed")).reason, /Malformed/);
    assert.match(catalog.applications.find(app => app.bundleName.endsWith("bounded")).reason, /上限/);
    assert.ok([...calls.values()].every(count => count <= 18));
  } finally { globalThis.__pioraHarmonyDeviceManager = undefined; }
});
