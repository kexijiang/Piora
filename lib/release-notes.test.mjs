import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractVersionNotes, prepareBuildReleaseNotes } from "../scripts/create-release-notes.mjs";
import { verifyUpdateReleaseNotes } from "../scripts/verify-windows-update-artifacts.mjs";
import { dump, load } from "js-yaml";

test("release notes contain only the requested CHANGELOG version plus download guidance", () => {
  const changelog = `# Changelog

## [Unreleased]

## [0.4.20] - 2026-08-27

### Fixed

- Shows update progress.

## [0.4.19] - 2026-08-27

- Older change.
`;
  const notes = extractVersionNotes(changelog, "v0.4.20");
  assert.match(notes, /Shows update progress/);
  assert.match(notes, /### 下载说明/);
  assert.doesNotMatch(notes, /Older change/);
});

test("release-note generation fails closed for a missing or malformed version", () => {
  assert.throws(() => extractVersionNotes("# Changelog", "v0.4.20"), /does not contain release notes/);
  assert.throws(() => extractVersionNotes("# Changelog", "latest"), /Invalid release tag/);
});

test("preview release notes support beta tags and list only preview artifacts", () => {
  const changelog = `# Changelog

## [0.4.41-beta.3] - 2026-09-07

### 修复

- 修复终端联动。
`;
  const notes = extractVersionNotes(changelog, "v0.4.41-beta.3");
  assert.match(notes, /修复终端联动/);
  assert.match(notes, /后续 beta 更新/);
  assert.doesNotMatch(notes, /Windows x64 ZIP/);
  assert.doesNotMatch(notes, /Linux x64 AppImage/);
});

test("build notes preserve Chinese changes through updater YAML and exclude other versions", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-release-notes-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + "/") || resolve(root).startsWith(resolve(tmpdir()) + "\\"));
    await rm(root, { recursive: true, force: true });
  });
  const changelog = "## [Unreleased]\n\n## [1.2.3-beta.4] - 2026-09-10\n\n### 修复\n\n- 终端连接及时返回。\n- 删除模型立即保存。\n\n## [1.2.3-beta.3]\n\n- 旧版本内容。\n";
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3-beta.4" }));
  await writeFile(join(root, "CHANGELOG.md"), changelog);
  const prepared = await prepareBuildReleaseNotes(root);
  const expected = extractVersionNotes(changelog, "v1.2.3-beta.4");
  assert.equal(await readFile(prepared.file, "utf8"), expected);
  const metadata = load(dump({ version: prepared.version, releaseNotes: prepared.notes }));
  verifyUpdateReleaseNotes(metadata, expected);
  assert.match(metadata.releaseNotes, /终端连接及时返回/);
  assert.doesNotMatch(metadata.releaseNotes, /旧版本内容/);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3-beta.5" }));
  await assert.rejects(prepareBuildReleaseNotes(root), /does not contain release notes/);
});
