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

test("provider names share the footer save, retain drafts, and reject collisions without losing providers", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-provider-save-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ModelsConfig}from'@/components/ModelsConfig';createRoot(document.getElementById('root')).render(<I18nProvider><ModelsConfig embedded onClose={()=>{}}/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    let saved = { providers: { alpha: { baseUrl: "https://alpha.test/v1", models: [{ id: "model-a" }] }, beta: { baseUrl: "https://beta.test/v1" } } };
    const writes = [];
    let failSave = false;
    await page.route("http://models.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>' });
      if (url.pathname === "/api/models-config") {
        if (request.method() === "PUT") {
          writes.push(request.postDataJSON());
          if (failSave) return route.fulfill({ status: 500, json: { error: "保存失败，请重试" } });
          saved = request.postDataJSON();
          return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: saved });
      }
      if (url.pathname === "/api/models/scope") return route.fulfill({ json: { models: [], warnings: [], enabledModels: [] } });
      return route.fulfill({ json: { providers: [], imageInput: {} } });
    });
    await page.goto("http://models.test/");
    const select = name => page.locator(".providerRow").filter({ has: page.getByText(name, { exact: true }) }).click();
    const nameInput = page.getByPlaceholder("provider-name", { exact: true });
    const save = page.getByRole("button", { name: "保存", exact: true });
    try { await select("alpha"); } catch (error) { throw new Error(`${error.message}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`); }
    await nameInput.fill("renamed");
    assert.equal(await page.getByRole("button", { name: "重命名", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "自动识别可用模型", exact: true }).count(), 1);
    await page.getByPlaceholder("https://api.example.com/v1", { exact: true }).fill("https://changed.test/v1");
    await select("beta");
    await select("alpha");
    assert.equal(await nameInput.inputValue(), "renamed", "switching channels retains the name draft");
    assert.equal(writes.length, 0, "typing and switching must not persist a rename");
    await nameInput.fill("   ");
    await save.click();
    await page.getByText("渠道名称不能为空。", { exact: true }).waitFor();
    await nameInput.fill(" beta ");
    await save.click();
    await page.getByText("渠道名称“beta”已存在，请使用不同的名称。", { exact: true }).waitFor();
    assert.equal(writes.length, 0, "invalid names cannot overwrite either channel");
    await nameInput.fill(" renamed ");
    failSave = true;
    await save.click();
    await page.getByText("保存失败，请重试", { exact: true }).waitFor();
    assert.equal(await nameInput.inputValue(), " renamed ", "failed saves retain the draft for retry");
    assert.ok(saved.providers.alpha);
    failSave = false;
    await save.click();
    await page.getByRole("button", { name: "已保存", exact: true }).waitFor();
    assert.equal(writes.length, 2);
    assert.deepEqual(Object.keys(saved.providers), ["renamed", "beta"]);
    assert.equal(saved.providers.renamed.baseUrl, "https://changed.test/v1");
    assert.equal(saved.providers.renamed.models[0].id, "model-a");
    assert.equal(await nameInput.inputValue(), "renamed");
    await page.reload();
    await select("renamed");
    assert.equal(await nameInput.inputValue(), "renamed", "saved names survive reopening");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-provider-save-"));
    await rm(directory, { recursive: true, force: true });
  }
});
