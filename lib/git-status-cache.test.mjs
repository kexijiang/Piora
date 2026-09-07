import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getCachedGitStatus, invalidateGitStatusCache } = await jiti.import("./git-status-cache.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const stageRoute = await jiti.import("../app/api/git/stage/route.ts");
const unstageRoute = await jiti.import("../app/api/git/unstage/route.ts");

test("panels share a real Git snapshot and stage/unstage routes invalidate it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "piora-status-cache-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
    writeFileSync(path.join(root, "tracked.txt"), "before\n");
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "sub", "nested.txt"), "nested\n");
    git("add", "."); git("commit", "-m", "initial");
    allowFileRoot(root);
    writeFileSync(path.join(root, "tracked.txt"), "after\n");
    writeFileSync(path.join(root, "sub", "nested.txt"), "nested after\n");
    invalidateGitStatusCache();
    const [first, second] = await Promise.all([getCachedGitStatus(root), getCachedGitStatus(root)]);
    assert.equal(first, second);
    assert.equal(first.files.length, 2);
    const sub = await getCachedGitStatus(path.join(root, "sub"));
    assert.equal(sub.files.length, 1, "subdirectory scopes must not share a repository-wide projection");
    const mutate = (route) => route.POST(new Request("http://local/api/git/stage", { method: "POST", body: JSON.stringify({ cwd: root, paths: ["tracked.txt"] }) }));
    const stagedResponse = await mutate(stageRoute);
    assert.equal(stagedResponse.status, 200, await stagedResponse.text());
    const staged = await getCachedGitStatus(root);
    assert.notEqual(staged, first);
    assert.equal(staged.files.find((file) => file.filePath.endsWith("tracked.txt")).indexStatus, "M");
    const unstagedResponse = await mutate(unstageRoute);
    assert.equal(unstagedResponse.status, 200, await unstagedResponse.text());
    const unstaged = await getCachedGitStatus(root);
    assert.notEqual(unstaged, staged);
    assert.equal(unstaged.files.find((file) => file.filePath.endsWith("tracked.txt")).worktreeStatus, "M");
  } finally { invalidateGitStatusCache(); rmSync(root, { recursive: true, force: true }); }
});
