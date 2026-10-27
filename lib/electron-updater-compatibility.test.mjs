import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const desktopRequire = createRequire(new URL("../desktop/package.json", import.meta.url));
const { AppUpdater } = desktopRequire("electron-updater/out/AppUpdater.js");
const { DownloadedUpdateHelper } = desktopRequire("electron-updater/out/DownloadedUpdateHelper.js");
const payload = Buffer.from("reviewed updater test payload");
const sha512 = createHash("sha512").update(payload).digest("base64");
const fileInfo = { url: new URL("https://updates.example.invalid/Piora-1.1.0.exe"), info: { url: "Piora-1.1.0.exe", sha512 } };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function cacheFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-updater-compatibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = new DownloadedUpdateHelper(root);
  await mkdir(helper.cacheDirForPendingUpdate, { recursive: true });
  return { root, helper, pending: helper.cacheDirForPendingUpdate };
}

test("installed updater rejects malformed and escaping cache filenames without touching outside files", async t => {
  assert.equal(desktopRequire("electron-updater/package.json").version, "6.8.11");
  const { root, helper, pending } = await cacheFixture(t);
  const outside = join(root, "outside.exe");
  await writeFile(outside, payload);
  for (const fileName of [undefined, null, 7, "", "../outside.exe", outside]) {
    await writeFile(join(pending, "update-info.json"), JSON.stringify({ fileName, sha512 }));
    assert.equal(await helper.getValidCachedUpdateFile(fileInfo, logger), null);
    assert.deepEqual(await readFile(outside), payload);
  }
});

test("installed updater reuses a valid cached installer and rejects changed bytes", async t => {
  const { helper, pending } = await cacheFixture(t);
  const installer = join(pending, "Piora-1.1.0.exe");
  await writeFile(installer, payload);
  await writeFile(join(pending, "update-info.json"), JSON.stringify({ fileName: "Piora-1.1.0.exe", sha512 }));
  assert.equal(await helper.getValidCachedUpdateFile(fileInfo, logger), installer);
  await writeFile(installer, "corrupted installer");
  assert.equal(await helper.getValidCachedUpdateFile(fileInfo, logger), null);
  await assert.rejects(readFile(installer), { code: "ENOENT" });
});

test("updater public download API shares concurrent work, returns paths and clears stale blockmaps", async t => {
  const { root, helper, pending } = await cacheFixture(t);
  const updater = new AppUpdater(null, { version: "1.0.0" });
  updater.logger = logger;
  updater.downloadedUpdateHelper = helper;
  updater.updateInfoAndProvider = {
    info: { version: "1.1.0", files: [fileInfo.info] },
    provider: { fileExtraDownloadHeaders: null },
  };
  await writeFile(join(root, "current.blockmap"), "stale cached map");
  await writeFile(join(pending, "current.blockmap"), "stale pending map");
  let tasks = 0;
  const completed = [];
  // Exercise installed AppUpdater's real download state machine and filesystem
  // cache logic; only replace the platform-specific network/file transfer.
  updater.doDownloadUpdate = options => updater.executeDownload({
    fileExtension: "exe", fileInfo, downloadUpdateOptions: options,
    task: async destination => { tasks++; await writeFile(destination, payload); },
    done: async event => { completed.push(event); },
  });
  const [first, second] = await Promise.all([updater.downloadUpdate(), updater.downloadUpdate()]);
  assert.equal(tasks, 1);
  assert.deepEqual(first, [join(pending, "Piora-1.1.0.exe")]);
  assert.deepEqual(second, first);
  assert.deepEqual(await readFile(first[0]), payload);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].downloadedFile, first[0]);
  assert.equal(updater.downloadPromise, null);
  for (const directory of [root, pending]) await assert.rejects(readFile(join(directory, "current.blockmap")), { code: "ENOENT" });
});
