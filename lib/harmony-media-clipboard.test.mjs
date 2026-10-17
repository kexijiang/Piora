import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { copyHarmonyMedia } = await createJiti(import.meta.url).import("../desktop/src/harmony-media-clipboard.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-harmony-copy-"));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const storage = { screenshotDirectory: join(root, "screenshots"), recordingDirectory: join(root, "recordings") };
  await Promise.all(Object.values(storage).map(directory => mkdir(directory)));
  return { root, storage };
}

test("Harmony clipboard copies screenshot bytes and video file references independently of filenames", async t => {
  const { storage } = await fixture(t);
  const screenshot = join(storage.screenshotDirectory, "手机 截图.png");
  const recording = join(storage.recordingDirectory, "手机 录屏.mp4");
  await writeFile(screenshot, png);
  await writeFile(recording, "video fixture");
  const writes = [];
  const write = async value => { await new Promise(resolve => setTimeout(resolve, 5)); writes.push(value); };
  const output = { writeImage: write, writeFile: write };
  await copyHarmonyMedia({ kind: "screenshot", path: screenshot }, storage, output);
  await copyHarmonyMedia({ kind: "recording", path: recording }, storage, output);
  assert.deepEqual(writes, [png, await realpath(recording)]);
});

test("Harmony clipboard rejects files outside configured storage, directories and malformed screenshots", async t => {
  const { root, storage } = await fixture(t);
  const outside = join(root, "outside.png"), invalid = join(storage.screenshotDirectory, "invalid.png");
  await writeFile(outside, png);
  await writeFile(invalid, "not a PNG");
  const output = { writeImage: () => assert.fail("must not write"), writeFile: () => assert.fail("must not write") };
  for (const value of [
    { kind: "screenshot", path: outside },
    { kind: "screenshot", path: invalid },
    { kind: "recording", path: invalid },
    { kind: "screenshot", path: "relative.png" },
    { kind: "text", path: outside },
    null,
  ]) await assert.rejects(copyHarmonyMedia(value, storage, output));
  const directory = join(storage.screenshotDirectory, "directory.png");
  await mkdir(directory);
  await assert.rejects(copyHarmonyMedia({ kind: "screenshot", path: directory }, storage, output));
});

test("native clipboard failure is reported without removing the saved artifact", async t => {
  const { storage } = await fixture(t);
  const path = join(storage.recordingDirectory, "recording.mp4");
  await writeFile(path, "video fixture");
  await assert.rejects(copyHarmonyMedia({ kind: "recording", path }, storage, {
    writeImage: () => assert.fail("video must not be decoded as an image"),
    writeFile: async () => { throw new Error("clipboard busy"); },
  }), /clipboard busy/);
  assert.ok(await realpath(path));
});
