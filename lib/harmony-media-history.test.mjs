import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listHarmonyMediaHistory } = await jiti.import("./harmony/media-history.ts");
const { nextHarmonyArtifactPath, saveHarmonyScreenshot, safeHarmonyDeviceName } = await jiti.import("./harmony/artifacts.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");

test("media history rediscovers saved screenshots and recordings for one device after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-media-history-"));
  const config = { storage: { screenshotDirectory: join(directory, "screenshots"), recordingDirectory: join(directory, "recordings") } };
  try {
    const older = await saveHarmonyScreenshot(config, "phone", { data: png, width: 1, height: 1 }, new Date("2026-09-30T01:00:00.000Z"));
    await saveHarmonyScreenshot(config, "phone2", { data: png, width: 1, height: 1 }, new Date("2026-09-30T02:00:00.000Z"));
    await mkdir(config.storage.recordingDirectory, { recursive: true });
    const video = nextHarmonyArtifactPath(config, "recording", "phone", new Date("2026-09-30T03:00:00.000Z"));
    await writeFile(video, Buffer.from("000000186674797069736f6d00000000", "hex"));
    await writeFile(join(config.storage.screenshotDirectory, "phone-unrelated.png"), png);
    await writeFile(join(config.storage.screenshotDirectory, "phone-2026-09-30T04-00-00-000Z-deadbeef.png"), "not png");
    const history = await listHarmonyMediaHistory(config, "phone");
    assert.equal(history.truncated, false);
    assert.equal(history.artifacts.length, 2);
    assert.deepEqual(history.artifacts.map(item => item.kind), ["recording", "screenshot"]);
    assert.equal(history.artifacts[0].path, video);
    assert.equal(history.artifacts[1].path, older.path);
    assert.deepEqual([history.artifacts[1].width, history.artifacts[1].height], [1, 1]);
    assert.ok(history.artifacts.every(item => item.serial === "phone"));
    await rm(older.path);
    assert.deepEqual((await listHarmonyMediaHistory(config, "phone")).artifacts.map(item => item.kind), ["recording"], "deleted files do not remain as completed tasks");
    await assert.rejects(listHarmonyMediaHistory(config, "../phone"), error => error.code === "INVALID_ARGUMENT");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("filesystem media names keep normalized device identities distinct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-media-serials-"));
  const config = { storage: { screenshotDirectory: join(directory, "screenshots"), recordingDirectory: join(directory, "recordings") } };
  try {
    assert.notEqual(safeHarmonyDeviceName("phone:1"), safeHarmonyDeviceName("phone-1"));
    await saveHarmonyScreenshot(config, "phone:1", { data: png, width: 1, height: 1 });
    await saveHarmonyScreenshot(config, "phone-1", { data: png, width: 1, height: 1 });
    const wifi = await listHarmonyMediaHistory(config, "phone:1");
    const usb = await listHarmonyMediaHistory(config, "phone-1");
    assert.equal(wifi.artifacts.length, 1);
    assert.equal(usb.artifacts.length, 1);
    assert.notEqual(wifi.artifacts[0].path, usb.artifacts[0].path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
