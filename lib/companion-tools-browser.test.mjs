import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
import { setup } from "./clipboard-test-data.mjs";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { createDefaultCompanionRuntimeState } = await createJiti(import.meta.url).import("./companion-runtime.ts");

test("Pocket prepares clipboard and transfer data on home and preserves them across tool switches", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-pocket-tools-"));
  let browser;
  let libraryReads = 0;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "body.tsx"), "export const MarkdownBody=({children})=><div>{children}</div>;");
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import {CompanionPanel} from ${JSON.stringify(path.join(repo, "components/CompanionPanel.tsx"))};import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};localStorage.setItem('pi-locale','zh-CN');createRoot(document.getElementById('root')).render(<I18nProvider><CompanionPanel/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "https://pocket-tools.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, plugins: [new webpack.DefinePlugin({ "process.env": JSON.stringify({ NODE_ENV: "development" }) }), new webpack.NormalModuleReplacementPlugin(/^\.\/MarkdownBody$/, path.join(root, "body.tsx"))], module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("https://pocket-tools.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname === "/api/companion/library") { libraryReads++; return route.fulfill({ json: { items: [] } }); }
      if (url.pathname === "/api/companion/state") return route.fulfill({ json: createDefaultCompanionRuntimeState() });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { runningSessions: [] } });
      if (url.pathname.startsWith("/icons/")) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>[hidden]{display:none!important}button{min-height:24px}</style><div id="root"></div><script>${setup}</script><script src="/bundle.js"></script>` });
    });
    await page.goto("https://pocket-tools.test/");
    await page.waitForFunction(() => window.queries?.length && document.querySelector('[aria-label="剪贴板记录"] [role="option"]'), undefined, { timeout: 10000 }).catch(async error => {
      throw new Error(`${error.message}\n${JSON.stringify({ errors, body: await page.locator("body").innerText() })}`);
    });
    assert.equal(libraryReads, 1, "transfer data loads before entering the tool");
    assert.equal(await page.getByRole("tab", { name: "工具台", exact: true }).getAttribute("aria-selected"), "true");
    await page.evaluate(() => { window.clipboardNode = document.querySelector('[aria-label="剪贴板记录"]'); });
    await page.getByRole("tab", { name: "剪贴板", exact: true }).click();
    assert.ok(await page.getByRole("listbox", { name: "剪贴板记录" }).getByRole("option").count() > 0);
    await page.getByRole("tab", { name: "中转站", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "新建文档", exact: true }).isEnabled(), true);
    await page.getByRole("tab", { name: "剪贴板", exact: true }).click();
    assert.equal(await page.evaluate(() => window.clipboardNode === document.querySelector('[aria-label="剪贴板记录"]')), true, "returning to clipboard reuses the ready view");
    assert.equal(libraryReads, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith("piora-pocket-tools-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
