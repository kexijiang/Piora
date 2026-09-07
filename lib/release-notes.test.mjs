import assert from "node:assert/strict";
import test from "node:test";
import { extractVersionNotes } from "../scripts/create-release-notes.mjs";

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
