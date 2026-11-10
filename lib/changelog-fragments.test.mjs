import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { checkPullRequest, parseFragment, prepareRelease, readFragments, renderRelease } from "../scripts/changelog-fragments.mjs";
import { extractVersionNotes } from "../scripts/create-release-notes.mjs";
import { verifyReleaseMetadata } from "../scripts/verify-release-metadata.mjs";

const initial = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-01\n\n- 历史版本保持不变。\n";
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = root => { git(root, "add", "-A"); git(root, "-c", "core.hooksPath=", "commit", "-qm", "fixture"); return git(root, "rev-parse", "HEAD"); };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "piora-changelog-"));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true });
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.autocrlf", "false");
  await mkdir(join(root, "changelog.d"));
  await writeFile(join(root, "changelog.d/README.md"), "Fragment instructions\n");
  await writeFile(join(root, "CHANGELOG.md"), initial);
  return { root, base: commit(root) };
}

test("fragments reject invalid names, blank bullets, headings and unexplained exemptions", () => {
  for (const [name, body] of [["bad.md", "- hello"], ["x.fix.md", ""], ["x.fix.md", "- "], ["x.fix.md", "## [2.0.0]"], ["x.fix.md", "<<<<<<< HEAD"], ["x.skip.md", "- skip"], ["../x.fix.md", "- hello"]]) {
    assert.throws(() => parseFragment(name, body));
  }
  assert.equal(parseFragment("issue-363.fix.md", "- 中文说明。\r\n\r\n- 第二条说明。\r\n").body, "- 中文说明。\n\n- 第二条说明。");
});

test("release output is stable, preserves legacy Unreleased and history, and excludes exemptions", () => {
  const fragments = [parseFragment("z.fix.md", "- 第二条。"), parseFragment("a.fix.md", "- 第一条。"), parseFragment("b.skip.md", "- 仅修正文档中的拼写错误，不影响任何应用行为。")];
  const source = initial.replace("## [Unreleased]\n", "## [Unreleased]\n\n- 遗留内容。\n");
  const output = renderRelease(source, fragments, "1.1.0-beta.1", "2026-11-08");
  assert.equal(output, renderRelease(source.replaceAll("\n", "\r\n"), [...fragments].reverse(), "1.1.0-beta.1", "2026-11-08"));
  const notes = extractVersionNotes(output, "v1.1.0-beta.1");
  assert.match(notes, /遗留内容。/);
  assert.ok(notes.indexOf("第一条") < notes.indexOf("第二条"));
  assert.doesNotMatch(notes, /拼写|历史版本/);
  assert.ok(output.endsWith(initial.slice(initial.indexOf("## [1.0.0]"))));
  for (const [version, date] of [["1.0.0", "2026-11-08"], ["1.1.0-alpha.1", "2026-11-08"], ["1.1.0", "2026-02-30"]]) {
    assert.throws(() => renderRelease(initial, fragments, version, date));
  }
  assert.throws(() => renderRelease(initial, [fragments[2]], "1.1.0", "2026-11-08"), /No publishable/);
});

test("independent PR fragments merge without a shared changelog edit", async t => {
  const { root, base } = await fixture(t);
  git(root, "checkout", "-qb", "first");
  await writeFile(join(root, "changelog.d/first.fix.md"), "- 第一项修复。\n");
  commit(root);
  assert.deepEqual(checkPullRequest(root, base), { kind: "change", added: 1 });
  git(root, "checkout", "-qb", "second", base);
  await writeFile(join(root, "changelog.d/second.feature.md"), "- 第二项新增功能。\n");
  commit(root);
  assert.deepEqual(checkPullRequest(root, "first"), { kind: "change", added: 1 });
  git(root, "merge", "--no-edit", "first");
  assert.equal((await readFragments(root)).length, 2);
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), initial);
});

test("PR check requires new notes, accepts reasoned exemption, rejects shared edits and lost fragments", async t => {
  const { root, base } = await fixture(t);
  await writeFile(join(root, "code.txt"), "changed");
  commit(root);
  assert.throws(() => checkPullRequest(root, base), /Add a changelog/);
  await writeFile(join(root, "changelog.d/docs.skip.md"), "- 仅修正文档中的拼写错误，不影响任何应用行为。\n");
  const merged = commit(root);
  assert.equal(checkPullRequest(root, base).kind, "change");
  await writeFile(join(root, "changelog.d/docs.skip.md"), "- 修改此前已经合入的说明内容，必须拒绝这个操作。\n");
  commit(root);
  assert.throws(() => checkPullRequest(root, merged), /immutable/);
  git(root, "reset", "--hard", merged);
  await writeFile(join(root, "CHANGELOG.md"), initial.replace("## [Unreleased]", "## [Unreleased]\n\n- 直接修改共享位置。"));
  commit(root);
  assert.throws(() => checkPullRequest(root, base), /already exists|aggregation/);
  git(root, "reset", "--hard", merged);
  await rm(join(root, "changelog.d/docs.skip.md"));
  commit(root);
  assert.throws(() => checkPullRequest(root, merged), /already exists|aggregation/);
});

test("preview is read-only; release consumes fixed committed inputs and can be checked as a PR", async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, "changelog.d/one.fix.md"), "- 修复真实问题。\n");
  await assert.rejects(prepareRelease(root, "1.1.0", "2026-11-08", true), /Commit/);
  const base = commit(root);
  const preview = await prepareRelease(root, "1.1.0", "2026-11-08");
  assert.equal(git(root, "status", "--porcelain"), "");
  await prepareRelease(root, "1.1.0", "2026-11-08", true);
  assert.equal(await readFile(join(root, "CHANGELOG.md"), "utf8"), preview.output);
  assert.deepEqual(await readdir(join(root, "changelog.d")), ["README.md"]);
  commit(root);
  assert.deepEqual(checkPullRequest(root, base), { kind: "release", consumed: 1, added: 0 });
  await assert.rejects(prepareRelease(root, "1.1.0", "2026-11-08", true), /already exists/);
  // A later PR's independent input survives merging with the release PR.
  const release = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-qb", "later", base);
  await writeFile(join(root, "changelog.d/later.fix.md"), "- 后来合入的修复。\n");
  commit(root);
  git(root, "merge", "--no-edit", release);
  assert.equal((await readFragments(root))[0].name, "later.fix.md");
  await assert.rejects(verifyReleaseMetadata({ projectRoot: root, tagName: "v1.1.0" }), /Unconsumed/);
});

test("release PR rejects missing or altered aggregated notes", async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, "changelog.d/one.fix.md"), "- 不可丢失的说明。\n");
  const base = commit(root);
  await prepareRelease(root, "1.1.0", "2026-11-08", true);
  const log = await readFile(join(root, "CHANGELOG.md"), "utf8");
  await writeFile(join(root, "CHANGELOG.md"), log.replace("不可丢失的说明", "未经片段记录的其他内容"));
  commit(root);
  assert.throws(() => checkPullRequest(root, base), /aggregation/);
});

test("fragment directory rejects nested files instead of silently ignoring notes", async t => {
  const { root } = await fixture(t);
  await mkdir(join(root, "changelog.d/nested"));
  await assert.rejects(readFragments(root), /regular file/);
});
