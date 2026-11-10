import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url), { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("write progress reveals long waits and diagnostics, then settles missing results on cancellation", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-write-progress-")); let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import {useState} from "react";import {createRoot} from "react-dom/client";import {MessageView} from "@/components/MessageView";import {I18nProvider} from "@/hooks/useI18n";
function App(){const [active,setActive]=useState(true),[preparing,setPreparing]=useState(true),[input,setInput]=useState({});window.execute=()=>{setPreparing(false);setInput({path:"src/example.ts",content:"export const answer = 42;"})};window.stop=()=>setActive(false);return <I18nProvider><MessageView message={{role:"assistant",content:[{type:"toolCall",toolCallId:"write-pending",toolName:"write",input}]}} isStreaming={preparing} toolRunActive={active}/></I18nProvider>;}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-01-01T00:00:01Z'));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://write-progress.test/**", async route => route.fulfill(route.request().url().endsWith(".js") ? { contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(new URL(route.request().url()).pathname))) } : { contentType: "text/html", body: '<meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' }));
    await page.goto("http://write-progress.test/");
    const card = page.locator(".tool-call-card"); await card.waitFor();
    assert.match(await card.innerText(), /准备参数/); assert.doesNotMatch(await card.innerText(), /\{path\}|0 字符/);
    await page.evaluate(() => window.execute()); await card.getByText("运行中", { exact: true }).waitFor();
    await page.clock.runFor(61_000);
    assert.match(await card.innerText(), /61s.*等待较久/s);
    await card.locator(".tool-call-toggle").click();
    await card.getByText("工具已等待超过 60 秒仍未返回结果；可以停止本轮后重试。", { exact: true }).waitFor();
    await card.getByRole("button", { name: "诊断信息", exact: true }).click();
    assert.match(await card.locator("pre").innerText(), /"state": "running"/);
    assert.match(await card.locator("pre").innerText(), /"waitingSeconds": 61/);
    await page.evaluate(() => window.stop()); await card.getByText("未返回结果", { exact: true }).waitFor();
    assert.equal(await card.locator(".is-running").count(), 0);
    assert.match(await card.innerText(), /本轮已结束，工具没有返回结果/);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
