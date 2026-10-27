import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, basename } from "node:path";
import { createRequire } from "node:module";
const desktopRequire = createRequire(new URL("../desktop/package.json", import.meta.url));
const { createUpdateInfoTasks } = desktopRequire("app-builder-lib/out/publish/updateInfoBuilder.js");
const { Platform } = desktopRequire("app-builder-lib/out/core.js");
const { Arch } = desktopRequire("builder-util");

test("installed electron-builder generates brand channels directly without renamed manifests", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "piora-builder-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const channel of ["latest", "beta"]) {
    const version = channel.endsWith("beta") ? "1.2.3-beta.4" : "1.2.3";
    const prefix = "Piora";
    const name = `${prefix}-${version}-win-x64-setup.exe`;
    const file = resolve(root, name);
    await writeFile(file, "metadata-generation fixture, not an installer");
    const tasks = await createUpdateInfoTasks({
      file, arch: Arch.x64, target: { outDir: root },
      updateInfo: { size: 45 },
      packager: {
        platform: Platform.WINDOWS,
        platformSpecificBuildOptions: {},
        config: { releaseInfo: { releaseNotes: "目标版本更新说明" } },
        appInfo: { version },
        info: { metadata: { dependencies: { "electron-updater": "6.8.11" } } },
      },
    }, [{ provider: "github", owner: "kexijiang", repo: "Piora", channel }]);
    assert.equal(tasks.length, 1);
    assert.equal(basename(tasks[0].file), `${channel}.yml`);
    assert.equal(tasks[0].info.path, name);
    assert.equal(tasks[0].info.files[0].url, name);
    assert.equal(tasks[0].info.version, version);
    assert.equal(tasks[0].info.releaseNotes, "目标版本更新说明");
  }
});
