import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("root package exposes the fast desktop command without a production build", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["dev:desktop"], "node scripts/dev-desktop.mjs");
  assert.doesNotMatch(pkg.scripts["dev:desktop"], /next build|build:web|build:app/);
  for (const name of ["dev", "dev:lan"]) assert.match(pkg.scripts[name], /--turbopack/);
  for (const name of ["predev", "predev:desktop", "predev:lan"]) assert.equal(pkg.scripts[name], "node scripts/prepare-development.mjs");
});

test("desktop development orchestrator can load in help mode without starting processes", async () => {
  const script = new URL("../scripts/dev-desktop.mjs", import.meta.url);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(script), "--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /npm run dev:desktop/);
});

test("desktop debugging remains opt-in and rejects invalid ports before starting processes", async () => {
  for (const value of ["1023", "65536", "invalid", "19221.5"]) {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/dev-desktop.mjs", import.meta.url)), "--help"], {
        env: { ...process.env, PIORA_DESKTOP_DEV_DEBUG_PORT: value }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("exit", code => resolve({ code, stderr }));
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /PIORA_DESKTOP_DEV_DEBUG_PORT must be an integer/);
  }
});
