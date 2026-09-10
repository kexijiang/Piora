import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("idle desktop windows leave HTTP connections available for session and companion reads", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-status-connections-"));
  let browser, server;
  let streams = 0, polls = 0;
  const state = { version: 3, updatedAt: 1 };
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import {useRunningTaskRuntimeState} from ${JSON.stringify(path.join(repo, "hooks/useTaskStatus.ts"))};import {fetchCompanionRuntimeState} from ${JSON.stringify(path.join(repo, "lib/companion-runtime-client.ts"))};function App(){const state=useRunningTaskRuntimeState();React.useEffect(()=>{window.statusReady=state.ready},[state]);window.readData=()=>Promise.all([fetch('/api/sessions/fixture',{signal:AbortSignal.timeout(3000)}).then(r=>r.json()),fetchCompanionRuntimeState({timeoutMs:3000})]);return <p>{state.ready?'Ready':'Loading'}</p>}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(root, "bundle.js"));
    server = createServer((request, response) => {
      if (request.url === "/api/agent/running/events") {
        streams++; response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('data: {"runningSessions":[]}\n\n'); return;
      }
      if (request.url === "/bundle.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(bundle); return; }
      if (request.url.startsWith("/api/")) {
        if (request.url === "/api/agent/running") polls++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(request.url === "/api/agent/running" ? { runningSessions: [] } : request.url === "/api/companion/state" ? state : { sessionId: "fixture" })); return;
      }
      response.writeHead(200, { "Content-Type": "text/html" }); response.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext();
    const pages = await Promise.all(Array.from({ length: 8 }, () => context.newPage()));
    const url = `http://127.0.0.1:${server.address().port}`;
    await Promise.all(pages.map(async page => { await page.goto(url); await page.waitForFunction(() => window.statusReady, undefined, { timeout: 8000 }); }));
    const results = await Promise.all(pages.map(page => page.evaluate(() => window.readData())));
    for (const [session, companion] of results) { assert.equal(session.sessionId, "fixture"); assert.deepEqual(companion, state); }
    assert.ok(polls >= pages.length);
    assert.equal(streams, 0, "idle status tracking does not reserve a permanent connection in each window");
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.ok(path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("piora-status-connections-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
