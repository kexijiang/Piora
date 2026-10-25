import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const { addWorktree, removeWorktree, resolveProject } = await createJiti(import.meta.url).import("./worktree.ts");
const require = createRequire(import.meta.url);
const compiled = ts.transpileModule(readFileSync(new URL("./worktree.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function mockedWorktree(failure, branchExists = false) {
  const calls = [];
  const exports = {};
  runInNewContext(compiled, {
    exports, process,
    require: (id) => {
      if (id === "./allowed-roots") return { allowFileRoot() {} };
      if (id === "node:fs") return { existsSync: () => false, mkdirSync() {} };
      if (id === "node:util") return { promisify: (fn) => fn };
      if (id === "node:child_process") return { execFile: async (_command, args, options) => {
        calls.push({ args: Array.from(args), options });
        if (args.includes("--git-common-dir")) return { stdout: join(tmpdir(), "mock-repo", ".git") };
        if (args.includes("--verify")) {
          if (!branchExists) throw new Error("missing branch");
          return { stdout: "commit" };
        }
        if (failure) throw failure;
        return { stdout: "" };
      } };
      return require(id);
    },
  });
  return { api: exports, calls };
}

test("new and existing branches allow lengthy checkouts while metadata queries stay bounded", async () => {
  for (const existing of [false, true]) {
    const { api, calls } = mockedWorktree(undefined, existing);
    await api.addWorktree(tmpdir(), "codex/member");
    const checkout = calls.find(({ args }) => args.includes("add"));
    assert.equal(checkout.options.timeout, 300_000);
    assert.equal(checkout.options.windowsHide, true);
    assert.ok(checkout.args.includes("--quiet"));
    assert.ok(checkout.args.includes("core.longpaths=true"));
    assert.equal(checkout.args.includes("-b"), !existing);
    assert.ok(calls.filter(({ args }) => args.includes("rev-parse")).every(({ options }) => options.timeout === 10_000));
  }
});

test("checkout errors distinguish timeout from progress and preserve actual Git failures", async () => {
  const progress = "Preparing worktree (new branch 'member')\nUpdating files: 7% (7/100)\r";
  for (const [failure, expected] of [
    [{ killed: true, stderr: progress }, /超时（5 分钟）/u],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, stderr: progress }, /输出超过限制/u],
    [{ stderr: `${progress}fatal: unable to create file: Permission denied\n` }, /^fatal: unable to create file: Permission denied$/u],
    [{ stderr: progress }, /Git 未返回具体错误原因/u],
    [{ stderr: "error: unable to create file nested/file: Filename too long\nfatal: Could not reset index file to revision 'HEAD'." }, /文件路径过长.*共享工作区/u],
  ]) {
    const { api } = mockedWorktree(failure);
    await assert.rejects(api.addWorktree(tmpdir(), "codex/member"), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /Updating files|Preparing worktree/u);
      return true;
    });
  }
});

test("real Git checkout can exceed ten seconds; dirty worktrees remain protected", { timeout: 45_000 }, async (t) => {
  // Keep both the repository and its sibling worktree directory inside one
  // uniquely owned fixture; verify the absolute cleanup boundary first.
  const fixture = mkdtempSync(join(tmpdir(), "piora-worktree-test-"));
  t.after(() => {
    assert.ok(resolve(fixture).startsWith(resolve(tmpdir()) + sep));
    assert.ok(fixture.includes("piora-worktree-test-"));
    rmSync(fixture, { recursive: true, force: true });
  });
  const repo = join(fixture, "repo");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main", repo);
  git("-C", repo, "config", "user.name", "Piora test");
  git("-C", repo, "config", "user.email", "test@example.invalid");
  git("-C", repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  git("-C", repo, "add", "tracked.txt");
  git("-C", repo, "commit", "-m", "fixture");
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nsleep 11\n", { mode: 0o755 });
  chmodSync(hook, 0o755);
  const start = Date.now();
  const created = await addWorktree(repo, "codex/slow-member");
  assert.ok(Date.now() - start >= 10_000, "exercise the former ten-second timeout");
  assert.equal(readFileSync(join(created.path, "tracked.txt"), "utf8").trim(), "original");
  assert.equal(git("-C", created.path, "branch", "--show-current"), "codex/slow-member");
  const project = await resolveProject(created.path);
  assert.equal(project.isWorktree, true);
  // Git can return the same Windows directory through its 8.3 alias.
  assert.equal(realpathSync.native(project.projectRoot).toLowerCase(), realpathSync.native(repo).toLowerCase());
  writeFileSync(join(created.path, "tracked.txt"), "user changes\n");
  await assert.rejects(removeWorktree(repo, created.path), /modified or untracked files/u);
  assert.equal(readFileSync(join(created.path, "tracked.txt"), "utf8"), "user changes\n");
  git("-C", created.path, "restore", "--", "tracked.txt");
  await removeWorktree(repo, created.path);
  assert.equal(existsSync(created.path), false);
});

test("explicit worktrees check out and remove Windows paths exceeding MAX_PATH", { timeout: 60000 }, async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "piora-longpaths-test-"));
  t.after(() => {
    assert.equal(resolve(fixture, ".."), resolve(tmpdir()));
    assert.ok(fixture.includes("piora-longpaths-test-"));
    rmSync(fixture, { recursive: true, force: true });
  });
  const repo = join(fixture, "repo");
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main", repo);
  git("-C", repo, "config", "user.name", "Piora test");
  git("-C", repo, "config", "user.email", "test@example.invalid");
  const relative = join("a".repeat(90), "b".repeat(90), "c".repeat(70));
  mkdirSync(join(repo, relative), { recursive: true });
  writeFileSync(join(repo, relative, "source.txt"), "long path fixture");
  assert.ok(join(repo, relative, "source.txt").length > 260);
  git("-c", "core.longpaths=true", "-C", repo, "add", ".");
  git("-C", repo, "commit", "-m", "long path fixture");
  // Explicitly disable it in the repo: our per-command override must suffice.
  git("-C", repo, "config", "core.longpaths", "false");
  const created = await addWorktree(repo, "codex/long-path-member");
  assert.equal(readFileSync(join(created.path, relative, "source.txt"), "utf8"), "long path fixture");
  assert.equal(git("-C", repo, "config", "core.longpaths"), "false");
  await removeWorktree(repo, created.path);
  assert.equal(existsSync(created.path), false);
});
