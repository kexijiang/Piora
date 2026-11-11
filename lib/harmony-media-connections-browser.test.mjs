import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
async function until(check, message) {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}

test("media controls preserve HTTP/1 request capacity with four other live streams", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-media-connections-"));
  const streams = new Map(), sockets = new Set();
  let browser, server, recording = null;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
    await writeFile(path.join(directory, "notice.ts"), "export const showPioraMessage=async()=> 'done';");
    await writeFile(path.join(directory, "entry.tsx"), `
import {useEffect,useState} from 'react';import{createRoot}from'react-dom/client';
import{useMirrorMedia}from'@/hooks/useMirrorMedia';import{subscribeHarmonyEvents}from'@/lib/harmony/event-source';
function App(){const[owner,setOwner]=useState(true),[health,setHealth]=useState('idle');
const first=useMirrorMedia('phone','owner-a',true,false),second=useMirrorMedia('phone','owner-b',true,false);
useEffect(()=>owner?subscribeHarmonyEvents(()=>{}):undefined,[owner]);
useEffect(()=>{const sources=Array.from({length:4},(_,i)=>new EventSource('/fixture/live/'+i));return()=>sources.forEach(source=>source.close())},[]);
return <><button aria-pressed={owner} onClick={()=>setOwner(value=>!value)}>Metadata owner</button>
<button onClick={async()=>{setHealth('pending');try{const result=await fetch('/api/health',{signal:AbortSignal.timeout(4000)});setHealth(result.ok?'ready':'failed')}catch{setHealth('timed out')}}}>Check health</button>
<output id='health'>{health}</output><output id='first'>{first.recording?.recordingId??'none'}</output><output id='second'>{second.recording?.recordingId??'none'}</output></>};createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@/components/PioraMessage": path.join(directory, "notice.ts"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, use: path.join(directory, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/harmony/events" || url.pathname.startsWith("/fixture/live/")) {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        response.write('data: {"type":"connected"}\n\n'); streams.set(response, url.pathname);
        request.on("close", () => streams.delete(response)); return;
      }
      if (url.pathname === "/api/harmony/media") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ recording })); return; }
      if (url.pathname === "/api/health") { response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}'); return; }
      if (url.pathname === "/bundle.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(bundle); return; }
      response.writeHead(200, { "Content-Type": "text/html" }); response.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');
    });
    server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Check health" }).waitFor();
    await until(() => streams.size >= 5, "persistent stream fixtures did not connect");
    await page.getByRole("button", { name: "Check health" }).click();
    await page.waitForFunction(() => document.getElementById("health").textContent === "ready", undefined, { timeout: 5000 });
    assert.equal(streams.size, 5, "two media consumers share metadata without claiming their own HTTP slots");
    assert.equal([...streams.values()].filter(url => url === "/api/harmony/events").length, 1);
    await page.getByRole("button", { name: "Metadata owner" }).click();
    await until(() => streams.size === 4, "the last metadata owner must close its stream while media observers remain");
    recording = { recordingId: "poll-fallback", ownerId: "owner-a", startedAt: new Date().toISOString() };
    await page.waitForFunction(() => document.getElementById("first").textContent === "poll-fallback" && document.getElementById("second").textContent === "poll-fallback", undefined, { timeout: 5000 });
    await page.getByRole("button", { name: "Metadata owner" }).click();
    await until(() => streams.size === 5, "metadata owner must reconnect without leaking streams");
    recording = { ...recording, recordingId: "event-refresh" };
    for (const [response, url] of streams) if (url === "/api/harmony/events") response.write('data: {"type":"recording"}\n\n');
    await page.waitForFunction(() => document.getElementById("first").textContent === "event-refresh" && document.getElementById("second").textContent === "event-refresh", undefined, { timeout: 5000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true });
  }
});
