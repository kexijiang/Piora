import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyStagedPortableExtractor } from "../scripts/stage-portable-extractor.mjs";
const require = createRequire(import.meta.url);
const { createPayloadManifest, verifyPayload, preparePublication } = require("../scripts/portable-payload.cjs");
const run = promisify(execFile);
const version = "0.0.0-test.1";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-payload-test-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = join(root, "source");
  await mkdir(join(source, "resources"), { recursive: true });
  await writeFile(join(source, "Piora.exe"), "executable before final resource editing");
  await writeFile(join(source, "resources", "media.mp4"), "startup video bytes");
  return { root, source };
}
test("NSIS artifact hook hashes finalized executable and late elevate helper once", async t => {
  const { root, source } = await fixture(t);
  const hook = require("../scripts/electron-portable-payload.cjs");
  await mkdir(join(root, "build"));
  let copies = 0;
  hook.registerPayloadContext({ electronPlatformName: "win32", arch: 1, appOutDir: source,
    packager: { projectDir: root, appInfo: { version, productFilename: "Piora" } },
    targets: [{ name: "portable", packageHelper: { elevateHelper: { copy: async () => { copies++; await writeFile(join(source, "resources/elevate.exe"), "signed helper"); } } } }],
  });
  await writeFile(join(source, "Piora.exe"), "FINAL resource editing and signing bytes");
  await Promise.all([hook({ targetPresentableName: "nsis" }), hook({ targetPresentableName: "portable" })]);
  assert.equal(copies, 1);
  const manifest = join(root, "build/portable-payload-x64.json");
  assert.equal((await verifyPayload(source, manifest, version)).files.length, 3);
  await writeFile(join(source, "Piora.exe"), "changed after manifest");
  await assert.rejects(verifyPayload(source, manifest, version), /missing, altered/);
});
test("cold verification rejects missing, altered and extra files before publishing ready", async t => {
  const { root, source } = await fixture(t);
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, await createPayloadManifest(source, { version, executable: "Piora.exe" }));
  const destination = join(root, "cache");
  const staging = `${destination}.pending-123`;
  await rename(source, staging);
  await mkdir(destination);
  await writeFile(join(destination, "old.txt"), "not removed before validation");
  const payloadFile = join(staging, "resources/media.mp4");
  for (const mode of ["missing", "altered", "extra"]) {
    if (mode === "missing") await rm(payloadFile);
    if (mode === "altered") await writeFile(payloadFile, "altered");
    if (mode === "extra") { await writeFile(payloadFile, "startup video bytes"); await writeFile(join(staging, "unexpected"), "extra"); }
    await assert.rejects(preparePublication(staging, destination, manifest, version), /missing, altered/);
    await assert.rejects(stat(join(staging, ".piora-runtime-ready")), { code: "ENOENT" });
    assert.equal(await readFile(join(destination, "old.txt"), "utf8"), "not removed before validation");
  }
  await rm(join(staging, "unexpected"));
  await preparePublication(staging, destination, manifest, version);
  await assert.rejects(stat(destination), { code: "ENOENT" });
  await rename(staging, destination);
  assert.equal(await readFile(join(destination, ".piora-runtime-ready"), "utf8"), version);
  await verifyPayload(destination, manifest, version, { allowReady: true });
});
test("publication refuses unrelated destination paths", async t => {
  const { root, source } = await fixture(t);
  await assert.rejects(preparePublication(source, dirname(root), "unused", version), /Unsafe portable/);
});
test("real pinned 7za preserves Unicode, spaces and paths longer than MAX_PATH", { skip: !process.env.PIORA_TEST_7ZA }, async t => {
  const executable = resolve(process.env.PIORA_TEST_7ZA);
  await verifyStagedPortableExtractor(dirname(executable));
  const { root, source } = await fixture(t);
  const relative = join("resources", "中文 空格 " + "a".repeat(55), "b".repeat(70), "c".repeat(70), "数据库.sqlite");
  const longFile = join(source, relative);
  assert.ok(longFile.length > 260);
  await mkdir(dirname(longFile), { recursive: true });
  await writeFile(longFile, Buffer.from("SQLite format 3\0long path bytes"));
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, await createPayloadManifest(source, { version, executable: "Piora.exe" }));
  const archive = join(root, "fixture.7z");
  await run(executable, ["a", archive, ".", "-mx=1"], { cwd: source, windowsHide: true });
  const destination = join(root, "中文 cache with spaces");
  const staging = `${destination}.pending-789`;
  await run(executable, ["x", archive, `-o${staging}`, "-y", "-aoa"], { windowsHide: true });
  assert.deepEqual(await readFile(join(staging, relative)), await readFile(longFile));
  await verifyPayload(staging, manifest, version);
  await writeFile(join(staging, relative), "tamper");
  await assert.rejects(preparePublication(staging, destination, manifest, version), /missing, altered/);
  await rm(join(staging, relative));
  await assert.rejects(preparePublication(staging, destination, manifest, version), /missing, altered/);
  await copyFile(longFile, join(staging, relative));
  await run(process.execPath, [resolve("scripts/portable-payload.cjs"), "prepare", staging, destination, manifest, version], { windowsHide: true });
  await rename(staging, destination);
  assert.equal(await readFile(join(destination, ".piora-runtime-ready"), "utf8"), version);
});
