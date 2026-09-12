import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));

test("forwarded shard flags partition the entire suite exactly once and preserve test failures", t => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node scripts/run-tests.mjs");
  const root = mkdtempSync(join(tmpdir(), "piora-test-shards-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // This is a standalone CLI probe, not a recursive invocation of this test.
  const testEnvironment = { ...process.env };
  delete testEnvironment.NODE_TEST_CONTEXT;
  const names = [];
  for (const directory of ["components", "hooks", "lib", "lib/i18n"]) {
    mkdirSync(join(root, directory), { recursive: true });
    for (let index = 0; index < 2; index += 1) {
      const name = `fixture-${directory.replaceAll("/", "-")}-${index}`;
      names.push(name);
      writeFileSync(join(root, directory, `${index}.test.mjs`), `import test from 'node:test';test(${JSON.stringify(name)},()=>{});`);
    }
  }
  const run = (...args) => spawnSync(process.execPath, [runner, "--test-reporter=tap", ...args], {
    cwd: root, env: testEnvironment, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
  const seen = [];
  for (let shard = 1; shard <= 3; shard += 1) {
    const result = run(`--test-shard=${shard}/3`);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const selected = [...result.stdout.matchAll(/^# Subtest: (fixture-.*)$/gm)].map(match => match[1].trim());
    assert.ok(selected.length > 0 && selected.length < names.length, `shard ${shard} must execute a proper subset: ${result.stdout}\n${result.stderr}`);
    seen.push(...selected);
  }
  assert.deepEqual(seen.sort(), names.sort(), "all files, including nested i18n tests, run exactly once");
  const full = run();
  assert.equal(full.status, 0, full.stderr || full.stdout);
  assert.equal([...full.stdout.matchAll(/^# Subtest: fixture-/gm)].length, names.length);
  writeFileSync(join(root, "lib", "failure.test.mjs"), "import test from 'node:test';test('fixture-failure',()=>{throw new Error('expected failure')});");
  const failed = run();
  assert.equal(failed.status, 1, "the launcher must propagate failures to CI");
  assert.match(failed.stdout, /expected failure/);
});
