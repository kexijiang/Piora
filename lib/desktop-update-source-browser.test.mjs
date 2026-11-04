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

test("update source UI saves selection, restores after reload and switches after a failed check", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-update-source-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default {}"');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{DesktopUpdateSourceSetting}from'@/components/DesktopUpdateSourceSetting';createRoot(document.getElementById('root')).render(<I18nProvider><DesktopUpdateSourceSetting/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    // The IPC bridge is a fixture. All selections and checks below use UI controls.
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      let state = { status: "idle", currentVersion: "1.0.0", audience: "preview", source: localStorage.getItem("fixture-source") || "github" };
      let listener;
      window.fixtureFailSave = false;
      window.piDesktop = {
        getUpdateState: async () => state,
        onUpdateState: next => { listener = next; return () => { listener = undefined; }; },
        setUpdateSource: async source => {
          if (window.fixtureFailSave) throw new Error("fixture persistence failed");
          state = { ...state, source, status: "idle", error: undefined, latestVersion: undefined };
          localStorage.setItem("fixture-source", source); listener?.(state); return state;
        },
        checkForUpdates: async () => {
          state = { ...state, status: "checking" }; listener?.(state);
          state = state.source === "internal" ? { ...state, status: "error", error: "内源更新地址未配置" } : { ...state, status: "up-to-date", latestVersion: "0.9.0", error: undefined };
          listener?.(state); return state;
        },
      };
    });
    await page.route("http://source.test/**", route => route.fulfill(route.request().url().endsWith("bundle.js") ? { contentType: "text/javascript", body: bundle } : { contentType: "text/html", body: '<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>' }));
    await page.goto("http://source.test/");
    const select = page.getByLabel("更新来源", { exact: true });
    await select.selectOption("internal");
    await page.waitForFunction(() => localStorage.getItem("fixture-source") === "internal");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('select')?.value === "internal" && !document.querySelector('select')?.disabled);
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("内源渠道 检查失败。 内源更新地址未配置").waitFor();
    await page.getByRole("button", { name: "切换到另一来源并重试" }).click();
    await page.getByText("此渠道没有更高版本，不会降级。").waitFor();
    assert.equal(await select.inputValue(), "github");
    assert.match(await page.locator('body').innerText(), /渠道最新版本：0.9.0/);
    await page.evaluate(() => { window.fixtureFailSave = true; });
    await select.selectOption("internal");
    await page.getByRole("alert").waitFor();
    assert.equal(await select.inputValue(), "github");
    assert.equal(await page.evaluate(() => localStorage.getItem("fixture-source")), "github");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
