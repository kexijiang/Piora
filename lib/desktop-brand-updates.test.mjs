import assert from "node:assert/strict";
import test from "node:test";
import { dump } from "js-yaml";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { preparePreviewUpdateFeed } = await jiti.import("../desktop/src/update-release-selector.ts");
const { validateBrandUpdateInfo } = await jiti.import("../desktop/src/update-brand-validation.ts");
const { DesktopUpdateController } = await jiti.import("../desktop/src/app-updater.ts");
const brand = { id: "example-app", artifactPrefix: "ExampleApp", updateChannels: { stable: "example-latest", preview: "example-beta" } };
const logger = { info() {}, warn() {}, error() {} };
const metadata = version => ({ version, releaseNotes: "品牌更新", files: [{ url: `ExampleApp-${version}-win-x64-setup.exe`, size: 100, sha512: Buffer.alloc(64, 1).toString("base64") }], path: `ExampleApp-${version}-win-x64-setup.exe` });
const response = (status, value = "") => ({ ok: status === 200, status, text: async () => value });
const feed = tags => tags.map(tag => `<entry><link href="https://github.com/kexijiang/Piora/releases/tag/${tag}" /></entry>`).join("");
function updater() {
  const events = {};
  return { events, on(name, listener) { events[name] = listener; }, setFeedURL(value) { this.feed = value; }, downloads: 0,
    async downloadUpdate() { this.downloads++; }, quitAndInstall() { this.installed = true; } };
}

test("ExampleApp skips Piora-only releases and never requests a Piora manifest", async () => {
  const client = updater(), urls = [];
  assert.equal(await preparePreviewUpdateFeed(client, "1.0.0-beta.1", async url => {
    urls.push(url);
    if (url.endsWith(".atom")) return response(200, feed(["v1.0.0-beta.3", "v1.0.0-beta.2"]));
    if (url.includes("beta.3/")) return response(404);
    return response(200, dump(metadata("1.0.0-beta.2")));
  }, logger, { audience: "preview", brand }), true);
  assert.equal(client.channel, "example-beta");
  assert.equal(client.allowDowngrade, false);
  assert.equal(client.feed.url, "https://github.com/kexijiang/Piora/releases/download/v1.0.0-beta.2");
  assert.ok(urls.slice(1).every(url => url.endsWith("/example-beta.yml")));
});

test("ExampleApp stable ignores beta, preview may graduate to its own stable manifest", async () => {
  for (const audience of ["stable", "preview"]) {
    const client = updater();
    const urls = [];
    await preparePreviewUpdateFeed(client, "1.0.0-beta.1", async url => {
      urls.push(url);
      return url.endsWith(".atom") ? response(200, feed(["v1.0.0", "v0.9.0-beta.3"])) : response(200, dump(metadata("1.0.0")));
    }, logger, { audience, brand });
    assert.equal(client.feed.channel, "example-latest");
    assert.equal(client.allowPrerelease, audience === "preview");
    assert.ok(urls.at(-1).endsWith("/example-latest.yml"));
  }
});

test("invalid brand metadata never configures a download feed", async () => {
  const mutations = [
    m => { m.files[0].url = "Piora-1.0.0-win-x64-setup.exe"; },
    m => { m.path = "Piora-1.0.0-win-x64-setup.exe"; },
    m => { m.files[0].url = "https://other.example/ExampleApp-1.0.0-win-x64-setup.exe"; },
    m => { m.files[0].url = "../" + m.files[0].url; },
    m => { m.version = "9.0.0"; },
    m => { m.files[0].sha512 = "bad"; },
    m => { m.files.push({ ...m.files[0] }); },
    m => { m.releaseNotes = ""; },
    m => { m.packages = { x64: { path: "other.7z" } }; },
  ];
  for (const mutate of mutations) {
    const client = updater(), info = metadata("1.0.0"); mutate(info);
    await assert.rejects(preparePreviewUpdateFeed(client, "0.9.0", async url => response(200,
      url.endsWith(".atom") ? feed(["v1.0.0"]) : dump(info)), logger, { audience: "stable", brand }));
    assert.equal(client.feed, undefined);
  }
});

test("metadata is checked again on the updater event, before download or installation", async () => {
  const client = updater();
  const controller = new DesktopUpdateController(client, "0.9.0", logger, { validateUpdateInfo: info => validateBrandUpdateInfo(info, brand) });
  const wrong = metadata("1.0.0"); wrong.files[0].url = "Piora-1.0.0-win-x64-setup.exe";
  client.events["update-available"](wrong);
  assert.equal(controller.getState().status, "error");
  await controller.downloadUpdate(); assert.equal(client.downloads, 0);
  client.events["update-downloaded"](wrong);
  assert.equal(controller.quitAndInstall(), false);
  assert.equal(client.installed, undefined);
});
