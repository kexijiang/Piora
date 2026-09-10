import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPackage } from "@electron/asar";
import {
  normalizeAsarEntry,
  verifyUpdateReleaseNotes,
  verifyWindowsUpdateArtifacts,
} from "../scripts/verify-windows-update-artifacts.mjs";

test("ASAR entries normalize identically on Windows and POSIX", () => {
  assert.equal(
    normalizeAsarEntry("\\node_modules\\electron-updater\\out\\main.js"),
    "/node_modules/electron-updater/out/main.js",
  );
  assert.equal(
    normalizeAsarEntry("/node_modules/electron-updater/out/main.js"),
    "/node_modules/electron-updater/out/main.js",
  );
});

async function createFixture(t, version = "0.4.12") {
  const root = await mkdtemp(join(tmpdir(), "piora-update-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installerName = `Piora-${version}-win-x64-setup.exe`;
  const installerPath = join(root, installerName);
  await writeFile(installerPath, "", "utf8");
  await truncate(installerPath, 11 * 1024 * 1024);
  const installer = await readFile(installerPath);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  await writeFile(`${installerPath}.blockmap`, "blockmap".repeat(20), "utf8");
  await mkdir(join(root, "win-unpacked", "resources"), { recursive: true });
  const asarSource = join(root, "asar-source");
  await mkdir(join(asarSource, "node_modules", "electron-updater", "out"), { recursive: true });
  await mkdir(join(asarSource, "node_modules", "builder-util-runtime", "out"), { recursive: true });
  await writeFile(join(asarSource, "node_modules", "electron-updater", "out", "main.js"), "module.exports = {};\n", "utf8");
  await writeFile(join(asarSource, "node_modules", "builder-util-runtime", "out", "index.js"), "module.exports = {};\n", "utf8");
  await createPackage(asarSource, join(root, "win-unpacked", "resources", "app.asar"));
  await writeFile(
    join(root, "win-unpacked", "resources", "app-update.yml"),
    `provider: github\nowner: kexijiang\nrepo: Piora\n${version.includes("-beta.") ? "channel: beta\n" : ""}`,
    "utf8",
  );
  const metadataName = version.includes("-beta.") ? "beta.yml" : "latest.yml";
  await writeFile(
    join(root, metadataName),
    [
      `version: ${version}`,
      "releaseNotes: |",
      "  - 修复终端启动等待，模型删除立即保存。",
      "files:",
      `  - url: ${installerName}`,
      `    sha512: ${sha512}`,
      `    size: ${11 * 1024 * 1024}`,
      "releaseDate: '2026-08-26T00:00:00.000Z'",
      "",
    ].join("\n"),
    "utf8",
  );
  return { root, installerName };
}

test("Windows update artifacts bind the installer to GitHub metadata", async (t) => {
  const fixture = await createFixture(t);
  const result = await verifyWindowsUpdateArtifacts(fixture.root, "v0.4.12");
  assert.equal(result.version, "0.4.12");
  assert.equal(result.installerName, fixture.installerName);
  assert.equal(result.metadataName, "latest.yml");
});

test("updater metadata requires the exact version notes instead of empty or stale copy", () => {
  const notes = "### 修复\n\n- 修复终端连接。\n";
  assert.doesNotThrow(() => verifyUpdateReleaseNotes({ releaseNotes: notes }, notes));
  assert.throws(() => verifyUpdateReleaseNotes({}, notes), /missing releaseNotes/);
  assert.throws(() => verifyUpdateReleaseNotes({ releaseNotes: " " }, notes), /missing releaseNotes/);
  assert.throws(() => verifyUpdateReleaseNotes({ releaseNotes: "旧版本说明" }, notes), /do not match/);
});

test("Windows update verification rejects a substituted installer", async (t) => {
  const fixture = await createFixture(t);
  await writeFile(join(fixture.root, fixture.installerName), "substituted", "utf8");
  await assert.rejects(
    verifyWindowsUpdateArtifacts(fixture.root, "0.4.12"),
    /unexpectedly small|SHA-512 does not match/,
  );
});

test("preview Windows update artifacts require beta metadata and updater channel", async (t) => {
  const fixture = await createFixture(t, "0.4.13-beta.2");
  const result = await verifyWindowsUpdateArtifacts(fixture.root, "v0.4.13-beta.2");
  assert.equal(result.version, "0.4.13-beta.2");
  assert.equal(result.metadataName, "beta.yml");
});
