import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { createWebRuntimeArchive } from "../scripts/archive-web-runtime.mjs";
const require = createRequire(import.meta.url);

test("packaged Electron Shell opens its SQLite worker and integration scripts outside ASAR", { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "piora-shell-package-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith("piora-shell-package-")); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const source = join(root, "source"), archive = join(root, "runtime.asar");
  await mkdir(join(source, "lib/shell"), { recursive: true });
  await cp(resolve("lib/shell/runtime"), join(source, "lib/shell/runtime"), { recursive: true });
  const store = await readFile(resolve("lib/shell/store.ts"), "utf8");
  await writeFile(join(source, "lib/shell/store.js"), ts.transpileModule(store, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText);
  const sdk = join(source, "node_modules/@earendil-works/pi-coding-agent");
  await mkdir(sdk, { recursive: true });
  // The test supplies an isolated data directory; no user SDK configuration is read.
  await writeFile(join(sdk, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", main: "index.js" }));
  await writeFile(join(sdk, "index.js"), "exports.getAgentDir=()=>{throw new Error('Unexpected user configuration access')}");
  await writeFile(join(source, "package.json"), '{"name":"piora-shell-packaging-fixture"}');
  const probe = async function () {
    const assert = require("node:assert/strict"), path = require("node:path");
    const { shellAssetPath, ShellStore } = require("./lib/shell/store.js");
    for (const name of ["store-worker.cjs", "history-import.cjs", "integration.ps1", "integration.bash", "integration.zsh"]) assert.ok(shellAssetPath(name).startsWith(process.env.PIORA_WEB_RUNTIME_ROOT + ".unpacked" + path.sep));
    const store = new ShellStore(path.join(process.cwd(), "data"), false);
    await store.recordHistory([{ id: "packaged", sourceId: "packaged", source: "human", command: "echo PACKAGED_SHELL", importedAt: Date.now() }]);
    assert.equal((await store.history({ query: "PACKAGED_SHELL" })).records[0].id, "packaged");
    await store.close();
    const windows = process.platform === "win32";
    const script = shellAssetPath(windows ? "integration.ps1" : "integration.bash");
    const args = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ". '" + script.replaceAll("'", "''") + "'; Write-Output 'PACKAGED_SCRIPT_LOADED'; prompt"]
      : ["--noprofile", "--norc", "-c", '. "$1"; printf "PACKAGED_SCRIPT_LOADED\\n"; __piora_prompt', "packaged-probe", script];
    const result = require("node:child_process").execFileSync(windows ? "powershell.exe" : "/bin/bash", args, { windowsHide: true, encoding: "utf8", timeout: 30000, env: { ...process.env, PIORA_SHELL_TOKEN: "packaging-probe" } });
    assert.ok(result.includes("PACKAGED_SCRIPT_LOADED"));
    assert.ok(result.includes("]633;Piora;packaging-probe;prompt;"));
    console.log("PACKAGED_SHELL_WORKER_AND_SCRIPT_OK");
  };
  await writeFile(join(source, "probe.cjs"), "(" + probe.toString() + ")().catch(error=>{console.error(error);process.exitCode=1})");
  await createWebRuntimeArchive(source, archive);
  assert.ok(resolve(source).startsWith(resolve(root) + sep)); await rm(source, { recursive: true, force: true });
  const output = await new Promise((done, reject) => {
    const child = spawn(require("electron"), [join(archive, "probe.cjs")], { cwd: root, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PIORA_WEB_RUNTIME_ROOT: archive, NODE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Packaged Shell timed out")); }, 60000);
    child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => { clearTimeout(timeout); if (code) reject(new Error(stderr || "Exit " + code)); else done(stdout); });
  });
  assert.match(output, /PACKAGED_SHELL_WORKER_AND_SCRIPT_OK/);
});

test("basic Shell API loading does not eagerly load the Agent model runtime", async () => {
  const source = await readFile(resolve("lib/shell/http.ts"), "utf8");
  assert.doesNotMatch(source, /^import .*from ["']\.\/(?:agent|history-search)["'];?$/m);
  assert.match(source, /await import\(["']\.\/agent["']\)/);
  assert.match(source, /await import\(["']\.\/history-search["']\)/);
});
