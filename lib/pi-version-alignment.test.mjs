import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("Pi runtime packages stay on one exact version", () => {
  const packageNames = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-mcp",
  ];
  const versions = packageNames.map((name) => packageJson.dependencies[name]);
  assert.ok(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version)), "Pi versions must be exact semver pins");
  assert.equal(new Set(versions).size, 1, `Pi runtime versions differ: ${versions.join(", ")}`);
});

test("all seven locked and installed Pi packages match the reviewed source certificate", async () => {
  const root = new URL("..", import.meta.url);
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  const certificate = JSON.parse(await readFile(new URL("scripts/pi-source-profile-1.4.0.json", root), "utf8"));
  const names = ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-codemode", "pi-mcp", "pi-telemetry", "pi-tui"];
  for (const name of names) {
    const path = `node_modules/@earendil-works/${name}`;
    const installed = JSON.parse(await readFile(new URL(`${path}/package.json`, root), "utf8"));
    assert.equal(lock.packages[path].version, certificate.version, `${name}: lock`);
    assert.equal(installed.version, certificate.version, `${name}: installed`);
    assert.equal(installed.name, `@earendil-works/${name}`);
    assert.equal(lock.packages[path].resolved, `https://registry.npmjs.org/@earendil-works/${name}/-/${name}-${certificate.version}.tgz`);
    if (name === "pi-coding-agent") assert.equal(lock.packages[path].integrity, certificate.integrity);
  }
});

test("Dependabot groups Pi runtime updates so compatibility is reviewed together", async () => {
  const dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*?interval: daily/);
  assert.match(dependabot, /pi-runtime:[\s\S]*?"@earendil-works\/pi-\*"/);
});

test("the headless UI adapter constructs against the installed Pi runtime", () => {
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const m = await import('./lib/rpc-ui-adapter.ts'); const t = m.PLAIN_TEXT_THEME; if (t.fg('text', 'plain') !== 'plain' || t.bg('selectedBg', 'plain') !== 'plain' || t.getThinkingBorderColor('max')('plain') !== 'plain') process.exit(2); process.exit(0);",
  ], { cwd: projectRoot, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
