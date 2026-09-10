import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");

test("model and provider deletion persists immediately without saving unrelated drafts", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-model-settings-"));
  const repo = path.resolve(".");
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {ModelsConfig} from "@/components/ModelsConfig";import {I18nProvider} from "@/hooks/useI18n";import {ConfirmationHost} from "@/components/ConfirmDialog";localStorage.setItem("pi-locale","zh-CN");createRoot(document.getElementById("root")).render(<I18nProvider><ModelsConfig onClose={()=>{}} onModelsChanged={()=>window.changed=(window.changed||0)+1}/><ConfirmationHost/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    const css = await readFile("app/globals.css", "utf8") + await readFile("components/ConfirmDialog.module.css", "utf8") + await readFile("components/ModelsConfig.module.css", "utf8");
    const config = { providers: {
      "自定义渠道": { api: "openai-completions", baseUrl: "https://example.com/v1", models: [{ id: "qwen3.8-max", name: "Qwen 3.8 Max" }, { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }] },
      "备用渠道": { api: "openai-completions", baseUrl: "https://backup.example.com/v1", models: [{ id: "backup-model" }] },
    } };
    const mutations = [];
    let fail = false;
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://models-settings.test/**", async route => {
      const url = new URL(route.request().url()), method = route.request().method();
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      let data = {};
      if (url.pathname === "/api/models-config") {
        if (method === "GET") data = config;
        else {
          const body = route.request().postDataJSON(); mutations.push({ method, body });
          if (fail) return route.fulfill({ status: 500, json: { error: "测试：配置写入失败" } });
          assert.equal(method, "DELETE");
          if (body.id === undefined) delete config.providers[body.provider];
          else config.providers[body.provider].models = config.providers[body.provider].models.filter(model => model.id !== body.id);
          data = { success: true };
        }
      } else if (url.pathname.startsWith("/api/auth/")) data = { providers: [] };
      else if (url.pathname === "/api/models/scope") data = { models: Object.entries(config.providers).flatMap(([provider, value]) => value.models.map(model => ({ ...model, provider, enabled: true }))), enabledPatterns: null, projectOverride: false, warnings: [], enabledCount: 3, totalCount: 3, configuredDefault: null, effectiveDefault: null };
      else if (url.pathname === "/api/models/fallback") data = { enabled: false };
      else if (url.pathname === "/api/models-config/test") data = { ok: true, latencyMs: 125 };
      else if (url.pathname === "/api/models-config/catalog") data = { candidates: [] };
      await route.fulfill({ json: data });
    });
    await page.goto("https://models-settings.test/");
    const modelRow = id => page.locator("span").filter({ hasText: new RegExp(`^${id}$`) }).locator("..").filter({ has: page.getByRole("button", { name: "删除", exact: true }) }).first();
    const confirm = async () => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "删除", exact: true }) }).getByRole("button", { name: "删除", exact: true }).click();
    await modelRow("qwen3.8-max").waitFor();
    assert.equal(await page.getByText("Prefix with", { exact: false }).count(), 0);
    assert.equal(await page.locator(".providerRow[data-selected='true']").evaluate(node => getComputedStyle(node).boxShadow), "none");
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "连接成功" }).waitFor();
    await page.getByRole("button", { name: "模型管理", exact: true }).click();
    assert.equal(await page.locator(".connectionCard").count(), 0);
    await page.getByRole("button", { name: "连接设置", exact: true }).click();
    await page.locator(".connectionCard").waitFor();
    await mkdir(path.resolve(".verification/model-settings"), { recursive: true });
    await page.screenshot({ path: path.resolve(".verification/model-settings/implemented-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.resolve(".verification/model-settings/implemented-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 960 });
    const endpoint = page.locator('input[placeholder="https://api.example.com/v1"]');
    await endpoint.fill("https://unsaved.example.com/v1");
    await modelRow("qwen3.8-max").getByRole("button", { name: "删除", exact: true }).click();
    await confirm();
    await modelRow("qwen3.8-max").waitFor({ state: "hidden" });
    assert.deepEqual(mutations[0], { method: "DELETE", body: { provider: "自定义渠道", id: "qwen3.8-max" } });
    assert.equal(config.providers["自定义渠道"].baseUrl, "https://example.com/v1");
    assert.equal(await endpoint.inputValue(), "https://unsaved.example.com/v1", "deletion preserves unrelated form edits without saving them");
    await page.reload();
    await modelRow("deepseek-v4-pro").waitFor();
    assert.equal(await modelRow("qwen3.8-max").count(), 0);
    fail = true;
    await modelRow("deepseek-v4-pro").getByRole("button", { name: "删除", exact: true }).click();
    await confirm();
    await page.getByRole("alert").filter({ hasText: "配置写入失败" }).waitFor();
    assert.equal(await modelRow("deepseek-v4-pro").count(), 1);
    fail = false;
    await modelRow("deepseek-v4-pro").click();
    await page.locator('input[placeholder="model-id"]').fill("renamed-draft");
    await modelRow("renamed-draft").getByRole("button", { name: "删除", exact: true }).click();
    await confirm();
    await modelRow("renamed-draft").waitFor({ state: "hidden" });
    assert.deepEqual(mutations.at(-1).body, { provider: "自定义渠道", id: "deepseek-v4-pro" }, "unsaved rename still deletes the original disk entry");
    assert.equal(config.providers["自定义渠道"].models.length, 0);
    await modelRow("自定义渠道").getByRole("button", { name: "删除", exact: true }).click();
    await confirm();
    await modelRow("自定义渠道").waitFor({ state: "hidden" });
    await page.reload();
    await modelRow("备用渠道").waitFor();
    assert.equal(await modelRow("自定义渠道").count(), 0);
    assert.equal(config.providers["备用渠道"].models.length, 1);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
