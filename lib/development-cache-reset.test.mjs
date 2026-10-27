import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resetDevelopmentCache } from "../scripts/reset-development-cache.mjs";
import { developmentFilesystemCache } from "../scripts/development-filesystem-cache.mjs";

test("Windows defaults to in-memory dev caching while other platforms and explicit overrides remain supported", () => {
  for (const platform of ["win32", "linux", "darwin"]) {
    assert.equal(developmentFilesystemCache(platform, ""), platform !== "win32");
    assert.equal(developmentFilesystemCache(platform, "1"), true);
    assert.equal(developmentFilesystemCache(platform, "0"), false);
  }
});

test("reset atomically preserves generated output without traversing external dependency links", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-dev-cache-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, ".next/dev");
  const dependency = join(root, "node_modules/test-package");
  await mkdir(join(source, "node_modules"), { recursive: true });
  await mkdir(dependency, { recursive: true });
  await writeFile(join(dependency, "package.json"), '{"name":"test-package"}');
  await writeFile(join(source, "generated.js"), "generated");
  await symlink(dependency, join(source, "node_modules/test-package"), process.platform === "win32" ? "junction" : "dir");
  const backup = await resetDevelopmentCache(root);
  assert.ok(backup.startsWith(join(root, ".next/dev-stale-")));
  assert.equal(await readFile(join(backup, "generated.js"), "utf8"), "generated");
  assert.equal(await readFile(join(dependency, "package.json"), "utf8"), '{"name":"test-package"}');
  assert.equal((await lstat(join(backup, "node_modules/test-package"))).isSymbolicLink(), true);
  await assert.rejects(lstat(source), { code: "ENOENT" });
  assert.equal(await resetDevelopmentCache(root), null);
});

test("reset refuses a linked dev root instead of moving a user-owned target", async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-dev-cache-linked-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".next"));
  await mkdir(join(root, "user-data"));
  await symlink(join(root, "user-data"), join(root, ".next/dev"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(resetDevelopmentCache(root), /Refusing to move linked development directory/);
  assert.equal((await lstat(join(root, "user-data"))).isDirectory(), true);
});
