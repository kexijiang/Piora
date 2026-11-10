import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url), { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("the mirror hook retains the painted canvas through errors, offline state and worker replacement", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-mirror-retain-")); let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "entry.tsx"), `import {useState} from "react";import {createRoot} from "react-dom/client";import {useHarmonyMirror} from "@/hooks/useHarmonyMirror";import {I18nProvider} from "@/hooks/useI18n";
function App(){const [active,setActive]=useState(true),[generation,setGeneration]=useState(1);window.setActive=setActive;window.setGeneration=setGeneration;const live=useHarmonyMirror({active,serial:"phone",generation,label:"Device screen"});window.reconnect=live.refresh;return <><div ref={live.surfaceRef} id="surface" style={{position:"relative",width:300,height:500}}/><output>{live.state}:{live.frame?.revision??"none"}</output></>;}
createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      window.workers = [];
      HTMLCanvasElement.prototype.transferControlToOffscreen = function () { return { fixtureCanvas: this }; };
      window.Worker = class {
        commands = []; terminated = false;
        constructor() { window.workers.push(this); }
        postMessage(data) { this.commands.push(data.type); if (data.canvas) this.canvas = data.canvas.fixtureCanvas; }
        terminate() { this.terminated = true; }
        emit(data) { if (data.type === "frame") { this.canvas.width=300;this.canvas.height=500;const c=this.canvas.getContext("2d");c.fillStyle="#234567";c.fillRect(0,0,300,500); } this.onmessage?.({ data }); }
      };
    });
    await page.route("http://retained.test/**", async route => route.fulfill(route.request().url().endsWith(".js") ? { contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(new URL(route.request().url()).pathname))) } : { contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' }));
    await page.goto("http://retained.test/"); await page.waitForFunction(() => window.workers.length === 1);
    await page.evaluate(() => { window.workers[0].emit({ type:"frame",width:300,height:500,revision:1 }); window.originalCanvas=document.querySelector("canvas"); });
    await page.getByText("connecting:1", { exact: true }).waitFor();
    await page.evaluate(() => window.workers[0].emit({ type:"state",state:"error",error:"ABI failure" }));
    await page.getByText("error:1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.workers[0].terminated), false, "a reported transport/device error keeps the worker available for reconnect");
    await page.evaluate(() => window.reconnect());
    assert.equal(await page.evaluate(() => window.workers[0].commands.at(-1)), "reconnect");
    await page.evaluate(() => window.setActive(false)); await page.getByText("idle:1", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.querySelector("canvas") === window.originalCanvas), true);
    await page.evaluate(() => window.setActive(true)); await page.waitForFunction(() => window.workers.length === 2);
    assert.equal(await page.locator("canvas").count(), 2, "the replacement starts behind the retained frame");
    assert.equal(await page.locator("canvas").last().evaluate(el => getComputedStyle(el).opacity), "0");
    await page.evaluate(() => window.workers[1].emit({ type:"frame",width:300,height:500,revision:2 }));
    await page.getByText("connecting:2", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 1);
    assert.equal(await page.evaluate(() => window.originalCanvas.isConnected), false);
    await page.evaluate(() => window.setGeneration(2)); await page.waitForFunction(() => window.workers.length === 3);
    await page.getByText("connecting:none", { exact: true }).waitFor();
    assert.equal(await page.locator("canvas").count(), 1, "a new device epoch cannot present a stale old frame");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
