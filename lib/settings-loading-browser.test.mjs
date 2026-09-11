import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("settings show their controls before reads finish, allow retry, and reopen from the last successful data", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-settings-loading-"));
  let browser;
  const held = [];
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{SpeechSettings}from'@/components/SpeechSettings';import{AutomationPanel}from'@/components/AutomationPanel';function App(){const [view,setView]=React.useState('speech');window.showSettings=setView;return <I18nProvider>{view==='speech'?<SpeechSettings/>:view==='automations'?<AutomationPanel/>:<div>closed</div>}</I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    let hold = true, fail = false;
    const speech = { enabled: true, installed: true, available: true, packDirectory: "C:/speech", installedBytes: 123, languages: ["zh", "en"], install: { phase: "idle", downloadedBytes: 0, totalBytes: 0 }, hardware: { supported: true, platform: "win32", arch: "x64", logicalCores: 8, memoryGiB: 16, tier: "balanced", threads: 2 } };
    const automation = { id: "one", name: "保存的任务", status: "ACTIVE", kind: "cron", prompt: "original", timezone: "UTC", rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5", notificationPolicy: "important_updates", target: { type: "project", cwd: "C:/workspace/project" } };
    await page.route("http://settings.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>' });
      if (hold) await new Promise(resolve => held.push(resolve));
      if (fail) return route.fulfill({ status: 503, json: { error: "暂时无法读取配置" } }).catch(() => {});
      const data = url.pathname === "/api/speech/settings" ? speech : url.pathname === "/api/speech/manual" ? { sources: [], complete: false } : url.pathname === "/api/automations" ? { automations: [automation] } : { automation, runs: [] };
      await route.fulfill({ json: data }).catch(() => {});
    });
    await page.goto("http://settings.test/");
    await page.locator('[data-settings-id="speech.toggle"]').waitFor();
    assert.equal(await page.getByRole("switch").isDisabled(), true, "unknown settings cannot be changed");
    assert.ok(await page.locator("h2").count(), "heading renders while the API is pending");
    fail = true; hold = false; held.splice(0).forEach(resolve => resolve());
    await page.getByRole("alert").first().waitFor();
    assert.ok(await page.locator('[data-settings-id="speech.pack"]').count(), "failed reads retain the settings page");
    fail = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await page.evaluate(() => window.showSettings("closed"));
    hold = true;
    await page.evaluate(() => window.showSettings("speech"));
    await page.getByRole("switch").waitFor();
    assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "true", "reopening keeps the last successful value while refreshing");
    await page.evaluate(() => window.showSettings("automations"));
    await page.locator('[data-settings-id="automations.new"]').waitFor();
    assert.ok(await page.locator('[data-settings-id="automations.notifications"]').count(), "task settings descriptions render before the list");
    await page.locator('[data-settings-id="automations.new"]').click();
    assert.ok(await page.locator("textarea").count(), "creating a draft is not blocked by a list request");
    hold = false; held.splice(0).forEach(resolve => resolve());
    await page.evaluate(() => window.showSettings("closed"));
    await page.evaluate(() => window.showSettings("automations"));
    await page.getByRole("button", { name: /保存的任务/ }).waitFor();
    await page.getByRole("button", { name: /保存的任务/ }).click();
    await page.locator("textarea").fill("unsaved draft");
    await page.clock.install();
    await page.clock.runFor(5100);
    assert.equal(await page.locator("textarea").inputValue(), "unsaved draft", "background refresh must preserve edits");
    assert.deepEqual(errors, []);
  } finally {
    held.splice(0).forEach(resolve => resolve());
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-settings-loading-"));
    await rm(directory, { recursive: true, force: true });
  }
});
