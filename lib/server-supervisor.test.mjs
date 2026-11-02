import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/src/server-supervisor.ts", import.meta.url), "utf8");

test("uses Next readiness output to avoid a sequential cold health-route wait", () => {
  assert.match(source, /export function isNextServerReadyLine/);
  assert.match(source, /runtimeReady\.then\(\(\) => "next-ready" as const\)/);
  assert.match(source, /readinessSource/);
  assert.match(source, /if \(runtimeReady \|\| !isNextServerReadyLine\(line\)\) return;/);
});

test("passes the staged runtime root to the web process for core extension discovery", () => {
  assert.match(source, /runtimeRoot: string/);
  assert.match(source, /PIORA_WEB_RUNTIME_ROOT: this\.options\.runtimeRoot/);
});

test("supervisor stops a real local service, releases its port and starts a new process", async () => {
  const { StandaloneServer } = await createJiti(import.meta.url).import("../desktop/src/server-supervisor.ts");
  const root = await mkdtemp(join(tmpdir(), "piora-restart-service-"));
  let server;
  try {
    const host = readFileSync(new URL("../desktop/src/server-host.ts", import.meta.url), "utf8");
    const serverHostEntry = join(root, "host.cjs"), serverEntry = join(root, "server.cjs");
    await writeFile(serverHostEntry, ts.transpileModule(host, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
    await writeFile(serverEntry, `const server=require('node:http').createServer((req,res)=>res.end(String(process.pid)));server.listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
    const options = { serverHostEntry, serverEntry, runtimeRoot: root, homeDirectory: root, agentDirectory: root, token: "fixture", logger: { info() {}, warn() {} } };
    server = new StandaloneServer(options);
    const first = await server.start();
    const firstPid = Number(await (await fetch(first)).text());
    await server.stop();
    assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" }, "old process has exited");
    server = new StandaloneServer({ ...options, preferredPort: Number(first.port) });
    const second = await server.start();
    assert.equal(second.port, first.port, "the old port can be reused immediately");
    assert.notEqual(Number(await (await fetch(second)).text()), firstPid, "restart uses a fresh service process");
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("failed forced termination is reported instead of allowing a second server", async () => {
  const ast = ts.createSourceFile("supervisor.ts", source, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["isRunning", "waitForExit", "stopChild"].includes(node.name?.text)).map(node => node.getText(ast)).join("\n");
  const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, connected: true, send() {}, kill: () => false });
  const env = { delay: async () => {}, child, logger: { warn() {} } };
  const result = runInNewContext(`${compiled}\nstopChild(child, logger, 1);`, env);
  await assert.rejects(result, /did not exit after termination/);
});

test("stopping during startup prevents a late spawn or startup retry", async () => {
  const { StandaloneServer } = await createJiti(import.meta.url).import("../desktop/src/server-supervisor.ts");
  const root = await mkdtemp(join(tmpdir(), "piora-cancel-start-"));
  let server;
  try {
    const entry = join(root, "waiting.cjs");
    await writeFile(entry, `process.on('message',()=>process.exit(0));setInterval(()=>{},1000);`);
    for (const phase of ["reserve", "health"]) {
      let started;
      const childStarted = new Promise(resolve => { started = resolve; });
      let spawns = 0;
      server = new StandaloneServer({ serverEntry: entry, serverHostEntry: entry, runtimeRoot: root, homeDirectory: root, agentDirectory: root, token: "fixture",
        logger: { info(message) { if (message === "Starting web server") { spawns++; started(); } }, warn() {} } });
      const starting = server.start();
      const rejected = assert.rejects(starting, /startup was cancelled/);
      if (phase === "health") await childStarted;
      await server.stop(); await rejected;
      assert.equal(spawns, phase === "reserve" ? 0 : 1);
      assert.equal(server.url, undefined);
    }
  } finally {
    await server?.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
