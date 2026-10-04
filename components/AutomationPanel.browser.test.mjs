import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("automations reopen after saving in settings and the controlled workspace panel", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-automation-navigation-"));
  let browser;
  let releaseDetail;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `
      import React from 'react';import{createRoot}from'react-dom/client';
      import{I18nProvider}from'@/hooks/useI18n';import{AutomationPanel}from'@/components/AutomationPanel';
      function App(){const [mode,setMode]=React.useState('settings');const[id,setId]=React.useState(null);
      window.showPanel=(mode)=>{setId(null);setMode(mode)};
      return <I18nProvider>{mode!=='closed'&&<AutomationPanel key={mode} embedded={mode==='settings'}
        automationId={mode==='settings'?undefined:id} onSelectAutomation={mode==='settings'?undefined:setId}
        cwd="C:/workspace/project"/>}</I18nProvider>}
      createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const scripts = new Map(await Promise.all((await readdir(directory))
      .filter(file => file.endsWith(".js"))
      .map(async file => [`/${file}`, await readFile(path.join(directory, file))])));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ locale: "en-US" });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let automation;
    let failDetail = false;
    let failSave = false;
    let holdDetail = false;
    let detailRequested;
    await page.route("http://automation.test/**", async route => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (scripts.has(url.pathname)) return route.fulfill({ contentType: "text/javascript", body: scripts.get(url.pathname) });
      if (route.request().resourceType() === "script") return route.fulfill({ status: 404, body: "Unknown test script" });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<html lang="zh-CN"><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>' });
      if (method === "POST" || method === "PATCH") {
        if (failSave) return route.fulfill({ status: 503, json: { error: "保存失败" } });
        automation = { id: "one", running: false, ...automation, ...route.request().postDataJSON() };
        return route.fulfill({ json: { automation } });
      }
      if (url.pathname === "/api/automations") return route.fulfill({ json: { automations: automation ? [automation] : [] } });
      if (holdDetail) await new Promise(resolve => { releaseDetail = resolve; detailRequested?.(); });
      if (failDetail) return route.fulfill({ status: 503, json: { error: "读取失败" } });
      return route.fulfill({ json: { automation, runs: [] } });
    });
    await page.goto("http://automation.test/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(() => document.documentElement.lang === "en");
    for (const mode of ["settings", "workspace"]) {
      await page.evaluate(mode => window.showPanel(mode), mode);
      await page.locator('[data-settings-id="automations.new"]').click();
      await page.locator(".promptField input").fill("测试定时任务");
      await page.locator("textarea").fill("initial prompt");
      await page.locator("footer .primary").click();
      const row = page.locator(".listItem").filter({ hasText: "测试定时任务" });
      await row.waitFor();
      holdDetail = true;
      const pendingDetail = new Promise(resolve => { detailRequested = resolve; });
      await row.click();
      await page.getByRole("status").waitFor();
      assert.equal(await page.locator(".listItem").count(), 0, "click immediately leaves the list while details load");
      assert.equal(await page.locator("textarea").count(), 0, "pending details cannot edit a stale draft");
      assert.equal(await page.locator("h2").textContent(), "测试定时任务");
      await pendingDetail;
      holdDetail = false;
      releaseDetail?.();
      await page.locator("textarea").waitFor();
      assert.equal(await page.locator("textarea").inputValue(), "initial prompt");
      await page.locator("textarea").fill("edited prompt");
      failSave = true;
      await page.locator("footer .primary").click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.locator("textarea").inputValue(), "edited prompt");
      failSave = false;
      await page.locator("footer .primary").click();
      await row.waitFor();
      await row.click();
      await page.locator("textarea").waitFor();
      assert.equal(await page.locator("textarea").inputValue(), "edited prompt");
      await page.evaluate(() => window.showPanel("closed"));
      await page.evaluate(mode => window.showPanel(mode), mode);
      await row.waitFor();
      assert.equal(await page.locator("textarea").count(), 0);
      failDetail = true;
      await row.click();
      await page.getByRole("alert").waitFor();
      failDetail = false;
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page.locator("textarea").waitFor();
      assert.equal(await page.locator("textarea").inputValue(), "edited prompt");
      await page.evaluate(() => window.showPanel("closed"));
    }
    assert.deepEqual(errors, []);
  } finally {
    releaseDetail?.();
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-automation-navigation-"));
    await rm(directory, { recursive: true, force: true });
  }
});
