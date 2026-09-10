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

test("packaged Electron PTY reads and writes through the real native sidecar", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-pty-package-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep) && root.split(sep).at(-1).startsWith("piora-pty-package-")); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); });
  const source = join(root, "source");
  const archive = join(root, "runtime.asar");
  await mkdir(join(source, "node_modules"), { recursive: true });
  const ptySource = resolve("node_modules/node-pty");
  await cp(ptySource, join(source, "node_modules/node-pty"), { recursive: true,
    filter: (entry) => {
      const local = entry.slice(ptySource.length).replaceAll("\\", "/");
      return !local || ["/package.json", "/lib", "/build", "/prebuilds"].some((prefix) => local === prefix)
        || local.startsWith("/lib/") || local.startsWith("/build/") || local.startsWith(`/prebuilds/${process.platform}-${process.arch}`);
    },
  });
  const loader = await readFile(new URL("./terminal-pty.ts", import.meta.url), "utf8");
  await writeFile(join(source, "terminal-pty.cjs"), ts.transpileModule(loader, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText);
  await writeFile(join(source, "package.json"), '{"name":"piora-pty-fixture"}');
  await writeFile(join(source, "probe.cjs"), `
    const pty = require('./terminal-pty.cjs').loadTerminalPty();
    const windows = process.platform === 'win32';
    const child = pty.spawn(windows ? 'cmd.exe' : '/bin/bash', windows ? ['/D', '/Q', '/K'] : ['--noprofile', '--norc'], {cwd: process.cwd(), cols: 90, rows: 24, useConptyDll: true});
    child.onData(data => process.stdout.write(data));
    child.onExit(({exitCode}) => process.exit(exitCode));
    child.write((windows ? 'set PIORA_PTY_VALUE=OK' : 'PIORA_PTY_VALUE=OK') + '\\r');
    child.write((windows ? 'echo PIORA_PACKAGED_PTY_%PIORA_PTY_VALUE%' : 'echo PIORA_PACKAGED_PTY_$PIORA_PTY_VALUE') + '\\r');
    child.write('exit\\r');
    setTimeout(() => {child.kill(); process.exit(2)}, 10000);
  `);
  await createWebRuntimeArchive(source, archive);
  // Remove the staging copy to rule out accidental developer-tree resolution.
  assert.ok(resolve(source).startsWith(resolve(root) + sep));
  await rm(source, { recursive: true, force: true });
  const output = await new Promise((resolveResult, reject) => {
    const child = spawn(require("electron"), [join(archive, "probe.cjs")], {
      cwd: root, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PIORA_WEB_RUNTIME_ROOT: archive, NODE_PATH: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Packaged PTY timed out")); }, 15_000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error(`Packaged PTY exited ${code}: ${stderr}\n${stdout}`));
      else resolveResult(stdout);
    });
  });
  assert.match(output, /PIORA_PACKAGED_PTY_OK/);
});
