import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { dump } from "js-yaml";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { readUpdateSource, writeUpdateSource, configuredUpdateFeed, parseUpdateSource } = await jiti.import("../desktop/src/update-source.ts");
const { DesktopUpdateController } = await jiti.import("../desktop/src/app-updater.ts");
const { preparePreviewUpdateFeed } = await jiti.import("../desktop/src/update-release-selector.ts");
const logger = { info() {}, warn() {}, error() {} };
const brand = { id: "piora", artifactPrefix: "Piora", updateChannels: { stable: "latest", preview: "beta" } };
const mirror = { releasesAtomUrl: "https://mirror.test/releases.atom", releaseDownloadRoot: "https://mirror.test/releases/download" };
const metadata = version => ({ version, releaseNotes: "fixture notes", files: [{ url: `Piora-${version}-win-x64-setup.exe`, size: 100, sha512: Buffer.alloc(64, 1).toString("base64") }] });
class Updater extends EventEmitter {
  checks = 0;
  async checkForUpdates() { this.checks++; }
  setFeedURL(feed) { this.feed = feed; }
  quitAndInstall() { this.installed = true; }
}

test("source selection persists and invalid choices cannot be written", t => {
  const dir = mkdtempSync(join(tmpdir(), "piora-source-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(readUpdateSource(dir), "github");
  writeUpdateSource(dir, "internal"); assert.equal(readUpdateSource(dir), "internal");
  assert.throws(() => writeUpdateSource(dir, "https://untrusted.test"));
  assert.equal(readUpdateSource(dir), "internal");
  writeFileSync(join(dir, "update-source.json"), "invalid"); assert.equal(readUpdateSource(dir), "github");
  assert.throws(() => parseUpdateSource({ source: "github" }));
  assert.throws(() => configuredUpdateFeed("internal"), /未配置/);
  assert.equal(new URL(configuredUpdateFeed("github").releasesAtomUrl).hostname, "github.com");
});

test("source switch invalidates downloaded state while failed persistence preserves it", () => {
  const backend = new Updater();
  const controller = new DesktopUpdateController(backend, "1.0.0", logger, { source: "github", audience: "preview" });
  backend.emit("update-downloaded", { version: "1.1.0", releaseNotes: "old" });
  assert.throws(() => controller.selectSource("internal", () => { throw new Error("disk full"); }), /disk full/);
  assert.equal(controller.getState().source, "github"); assert.equal(controller.getState().status, "downloaded");
  const saved = [];
  controller.selectSource("internal", value => saved.push(value));
  assert.deepEqual(saved, ["internal"]);
  assert.deepEqual(controller.getState(), { source: "internal", audience: "stable", currentVersion: "1.0.0", status: "idle" });
  assert.equal(controller.quitAndInstall(), false); assert.equal(backend.installed, undefined);
});

test("in-flight checks prevent source switching and preserve the selected source on failure", async () => {
  let reject;
  const gate = new Promise((_resolve, fail) => { reject = fail; });
  const controller = new DesktopUpdateController(new Updater(), "1.0.0", logger, { source: "github", prepareCheck: () => gate });
  const checking = controller.checkForUpdates();
  assert.throws(() => controller.selectSource("internal", () => assert.fail("must not persist")), /Wait/);
  reject(new Error("github: fixture network failure")); await checking;
  assert.equal(controller.getState().source, "github"); assert.equal(controller.getState().status, "error");
  controller.selectSource("internal", () => {}); assert.equal(controller.getState().status, "idle");
});

for (const version of ["0.9.0", "1.0.0", "1.1.0"]) test(`internal mirror validates published metadata and never downgrades from 1.0.0 to ${version}`, async () => {
  const client = new Updater(), urls = []; let latest;
  const ready = await preparePreviewUpdateFeed(client, "1.0.0", async url => {
    urls.push(url);
    return { ok: true, status: 200, text: async () => url.endsWith(".atom") ? `<link href="https://mirror.test/releases/tag/v${version}"/>` : dump(metadata(version)) };
  }, logger, { audience: "stable", brand, feed: mirror, onLatestVersion: value => { latest = value; } });
  assert.equal(latest, version);
  assert.ok(urls.every(url => url.startsWith("https://mirror.test/")));
  assert.equal(ready, version === "1.1.0");
  if (ready) { assert.equal(client.allowDowngrade, false); assert.equal(client.feed.url, "https://mirror.test/releases/download/v1.1.0"); }
  else assert.equal(client.feed, undefined);
});

test("internal mirror rejects cross-brand installers using the shared validation", async () => {
  const client = new Updater(), info = metadata("1.1.0"); info.files[0].url = "https://external.test/installer.exe";
  await assert.rejects(preparePreviewUpdateFeed(client, "1.0.0", async url => ({ ok: true, status: 200, text: async () => url.endsWith(".atom") ? '<link href="/releases/tag/v1.1.0"/>' : dump(info) }), logger,
    { audience: "stable", brand, feed: mirror }), /cross-brand|external/);
  assert.equal(client.feed, undefined);
});
