import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const surface = { version: 2, id: "bill", revision: 1, title: "周末花费", nodes: [
  { id: "people", type: "number", label: "人数", value: 4, min: 1 },
  { id: "total", type: "metric", label: "费用", value: { op: "multiply", args: [{ ref: "people" }, 20] } },
], layout: [{ id: "settings", type: "group", title: "调整人数", columns: 1, nodeIds: ["people", "total"] }] };
const preview = (seq = 1, overrides = {}) => ({ version: 1, kind: "intelligent-ui", sessionId: "session", runId: "run", streamId: "stream", toolCallId: "call", seq, phase: "partial", payload: surface, snapshot: "尚未保存", ...overrides });

async function fixture(directory) {
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `
import React,{useSyncExternalStore,useState}from"react";import{createRoot}from"react-dom/client";
import{AnswerOutput}from ${JSON.stringify(path.join(repo, "components/AnswerOutput.tsx"))};
import{AnswerOutputPreviews}from ${JSON.stringify(path.join(repo, "components/AnswerOutputScope.tsx"))};
import{AnswerOutputPreviewStore}from ${JSON.stringify(path.join(repo, "lib/answer-output-preview-client.ts"))};
import{I18nProvider}from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
import{refreshBetaFeatures}from ${JSON.stringify(path.join(repo, "hooks/useBetaFeatures.ts"))};
import{flushPendingAnswerState}from ${JSON.stringify(path.join(repo, "lib/answer-output-client.ts"))};
const store=new AnswerOutputPreviewStore();let connection=store.connect("session");
window.start=()=>store.started(connection,"session","run");window.preview=value=>store.receive(connection,value);window.stop=()=>store.stop();
window.reconnect=value=>{connection=store.connect("session");store.restore(connection,value)};
window.refreshBeta=refreshBetaFeatures;window.flush=()=>flushPendingAnswerState("session");
localStorage.setItem("pi-locale","zh-CN");window.storageWrites=0;const set=Storage.prototype.setItem;Storage.prototype.setItem=function(...args){window.storageWrites++;return set.apply(this,args)};
function App(){const previews=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);const[result,setResult]=useState();window.result=setResult;
return <I18nProvider><input aria-label="旧回答的草稿" defaultValue="保留我"/><AnswerOutputPreviews.Provider value={previews}><AnswerOutput result={result} toolCallId="call" sessionId="session" generating/></AnswerOutputPreviews.Provider></I18nProvider>}
createRoot(document.getElementById("root")).render(<App/>);`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/", chunkFilename: "[id].js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
}

test("real AnswerOutput incrementally renders read-only previews without writers, preserves focus, and retires cancelled output", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-preview-")); let browser;
  try {
    await fixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    let enabled = false; const api = [], errors = [], chunks = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://preview.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: enabled } });
      if (url.pathname.startsWith("/api/")) { api.push(`${route.request().method()} ${url.pathname}`); return route.fulfill({ status: 500, json: { error: "Unexpected parameter access" } }); }
      if (url.pathname.endsWith(".js")) {
        chunks.push(url.pathname);
        return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(url.pathname))) });
      }
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://preview.test/");
    await page.getByRole("textbox", { name: "旧回答的草稿" }).waitFor();
    await page.evaluate(value => { window.start(); window.preview(value); }, preview());
    await page.evaluate(() => window.refreshBeta());
    assert.equal(await page.locator("[data-answer-output-preview]").count(), 0);
    assert.equal(chunks.length, 1, "disabled Beta never requests either lazy renderer chunk");
    enabled = true; await page.evaluate(() => window.refreshBeta());
    const control = page.getByRole("spinbutton", { name: "人数" }); await control.waitFor();
    assert.equal(await control.isDisabled(), true);
    assert.match(await page.locator("[data-answer-output-preview]").innerText(), /80/);
    await page.getByRole("textbox", { name: "旧回答的草稿" }).fill("继续保留这份修改");
    await page.evaluate(() => { window.originalPreview = document.querySelector('[data-answer-output-preview]'); window.originalControl = document.querySelector('[data-answer-output-preview] input'); });
    const updated = structuredClone(surface);
    updated.nodes.push({ id: "note", type: "text", text: "说明 <script>window.bad=true</script>" });
    updated.layout.push({ id: "notes", type: "group", title: "费用说明", columns: 1, nodeIds: ["note"] });
    await page.evaluate(value => window.preview(value), preview(2, { payload: updated }));
    await page.getByRole("heading", { name: "费用说明" }).waitFor();
    assert.equal(await page.evaluate(() => window.originalPreview === document.querySelector('[data-answer-output-preview]') && window.originalControl === document.querySelector('[data-answer-output-preview] input')), true);
    assert.equal(await page.getByRole("textbox", { name: "旧回答的草稿" }).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await page.evaluate(value => window.preview(value), preview(3, { phase: "complete", payload: updated }));
    await page.getByText("预览已生成 · 尚未发布或保存").waitFor(); assert.equal(await control.isDisabled(), true);
    await page.evaluate(() => window.flush());
    assert.deepEqual(api, []); assert.equal(await page.evaluate(() => window.storageWrites), 0);
    await page.evaluate(() => window.stop());
    await page.locator("[data-answer-output-preview]").waitFor({ state: "detached" });
    await page.evaluate(value => window.preview(value), preview(4));
    await page.evaluate(value => window.reconnect({ sessionId: "session", runId: "run", seq: 4, previews: [value] }), preview(4));
    assert.equal(await page.locator("[data-answer-output-preview]").count(), 0);
    await page.evaluate(value => window.reconnect({ sessionId: "session", runId: "new-run", seq: 1, previews: [value] }), preview(1, { runId: "new-run" }));
    await control.waitFor();
    await page.evaluate(() => window.result({ role: "toolResult", toolCallId: "call", content: [{ type: "text", text: "实际工具失败，旧回答仍保留" }], isError: true }));
    await page.getByText("实际工具失败，旧回答仍保留").waitFor();
    assert.equal(await page.locator("[data-answer-output-preview]").count(), 0, "real tool result wins over an unremoved transient preview");
    assert.equal(await page.getByRole("textbox", { name: "旧回答的草稿" }).inputValue(), "继续保留这份修改");
    assert.deepEqual(api, []); assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
