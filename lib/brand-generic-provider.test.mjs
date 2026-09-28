import test from "node:test";
import assert from "node:assert/strict";
import { GenericProvider } from "electron-updater/out/providers/GenericProvider.js";
import { HttpError } from "builder-util-runtime";
import { dump } from "js-yaml";

for (const channel of ["example-latest", "example-beta"]) {
  test(`installed updater provider requests exactly ${channel}.yml and resolves only its installer`, async () => {
    const requests = [];
    const version = channel.endsWith("beta") ? "1.2.3-beta.4" : "1.2.3";
    const name = `ExampleApp-${version}-win-x64-setup.exe`;
    const base = `https://github.com/kexijiang/Piora/releases/download/v${version}`;
    const provider = new GenericProvider({ provider: "generic", url: base, channel }, { channel, isAddNoCacheQuery: false }, {
      platform: "win32", executor: { request: async options => {
        requests.push(options);
        return dump({ version, files: [{ url: name, sha512: Buffer.alloc(64).toString("base64"), size: 100 }], path: name, releaseNotes: "品牌更新" });
      } },
    });
    const info = await provider.getLatestVersion();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, `/kexijiang/Piora/releases/download/v${version}/${channel}.yml`);
    assert.equal(provider.resolveFiles(info)[0].url.href, `${base}/${name}`);
  });

  test(`missing ${channel} fails without requesting a Piora fallback`, async () => {
    const requests = [];
    const provider = new GenericProvider({ provider: "generic", url: "https://github.com/kexijiang/Piora/releases/download/v1.2.3", channel }, { channel }, {
      platform: "win32", executor: { request: async options => {
        requests.push(options.path);
        throw new HttpError(404);
      } },
    });
    await assert.rejects(provider.getLatestVersion(), { code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" });
    assert.deepEqual(requests, [`/kexijiang/Piora/releases/download/v1.2.3/${channel}.yml`]);
  });
}
