import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("render failure screen exposes and copies real diagnostics without application providers", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-render-error-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import AppError from '@/app/error';
window.piDesktop={clipboard:{writeText:async text=>{if(window.failCopy)throw Error('clipboard unavailable');window.copiedReport=text}}};window.retries=0;
const error=new TypeError("Cannot read properties of undefined (reading 'replace')");
createRoot(document.getElementById('root')).render(<AppError error={error} reset={()=>window.retries++}/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      plugins: [new webpack.DefinePlugin({ "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("test-build") })],
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 420, height: 700 } });
    const errors = [], logs = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") logs.push(message.text()); });
    await page.route("http://render-error.test/**", async route => route.request().url().endsWith(".js")
      ? route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, "bundle.js")) })
      : route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;overflow:hidden}</style><div id="root"></div><script src="/bundle.js"></script>' }));
    await page.goto("http://render-error.test/");
    await page.getByRole("heading", { name: "Piora 页面遇到问题" }).waitFor();
    assert.match(await page.locator("main").innerText(), /Cannot read properties of undefined/);
    assert.doesNotMatch(await page.locator("main").innerText(), /残留的页面缓存/);
    await page.getByRole("button", { name: "复制诊断信息" }).click();
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor();
    const report = await page.evaluate(() => window.copiedReport);
    assert.match(report, /Version: test-build/);
    assert.match(report, /client-render-[a-f0-9]{8}/);
    assert.match(report, /TypeError: Cannot read properties/);
    assert.ok(logs.some(log => log.includes(report)), "the copied report also reaches Electron console diagnostics");
    await page.getByRole("button", { name: "重试", exact: true }).click();
    assert.equal(await page.evaluate(() => window.retries), 1);
    await page.evaluate(() => { window.failCopy = true; });
    await page.getByRole("button", { name: "已复制", exact: true }).click();
    await page.getByRole("status").waitFor();
    await page.locator("summary").click();
    await page.locator("pre").waitFor();
    assert.equal(await page.locator("pre").textContent(), report);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-render-error-"));
    await rm(root, { recursive: true, force: true });
  }
});
