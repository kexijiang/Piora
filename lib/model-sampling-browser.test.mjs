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

test("sampling drafts survive navigation and save, preserve unknown keys, and display SDK preview", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-sampling-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ModelsConfig}from'@/components/ModelsConfig';createRoot(document.getElementById('root')).render(<I18nProvider><ModelsConfig embedded onClose={()=>{}}/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    const css = (await Promise.all(["app/globals.css", "components/ModelsConfig.module.css", "components/ModelSamplingEditor.module.css"].map(file => readFile(file, "utf8")))).join("\n");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    let saved = { unknownRoot: true, providers: { alpha: { api: "openai-completions", unknownProvider: "keep", baseUrl: "https://fixture.test/v1", models: [
      { id: "model-a", reasoning: true, unknownModel: [1, 2], samplingParams: { vendor_custom: { enabled: true } } },
      { id: "model-b" },
    ] } } };
    const writes = [], probes = [];
    await page.route("http://models.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
      if (url.pathname === "/api/models-config") {
        if (request.method() === "PUT") {
          saved = request.postDataJSON(); writes.push(saved);
          return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: saved });
      }
      if (url.pathname === "/api/models-config/test") {
        const body = request.postDataJSON(); probes.push(body);
        return route.fulfill({ json: body.previewOnly ? { ok: true, samplingPreview: {
          api: body.model.api || body.provider.api, applicable: true, effectiveThinkingLevel: "high",
          params: { ...body.model.samplingParams, ...body.model.samplingParamsByThinkingLevel?.high, ...body.requestSamplingParams },
        } } : { ok: false, error: "400 Unsupported parameter: vendor_custom" } });
      }
      if (url.pathname === "/api/models/scope") return route.fulfill({ json: { models: [], warnings: [], enabledModels: [] } });
      return route.fulfill({ json: { providers: [], imageInput: {} } });
    });
    await page.goto("http://models.test/");
    const openModel = async id => {
      await page.getByText(id, { exact: true }).first().click();
      const advanced = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "高级设置（可选）" }) }).first();
      if (!await advanced.evaluate(node => node.open)) await advanced.locator("summary").first().click();
    };
    await openModel("model-a");
    const editor = page.getByRole("region", { name: "采样参数", exact: true });
    const save = page.getByRole("button", { name: "保存", exact: true });
    await editor.getByLabel("default temperature", { exact: true }).pressSequentially("0.75");
    assert.equal(await editor.getByLabel("default temperature", { exact: true }).inputValue(), "0.75");
    await editor.getByLabel("编辑参数范围", { exact: true }).selectOption("high");
    await editor.getByLabel("high JSON", { exact: true }).fill('{"top_p":0.8,"vendor_level":{"enabled":true}}');
    await editor.getByLabel("编辑参数范围", { exact: true }).selectOption("low");
    await editor.getByLabel("low JSON", { exact: true }).fill("{broken");
    await openModel("model-b");
    await save.click();
    assert.equal(writes.length, 0, "invalid unmounted drafts must block the global save");
    await page.getByRole("alert").filter({ hasText: "samplingParamsByThinkingLevel.low" }).first().waitFor();
    // Saving focuses the invalid model. Recover the draft without losing it.
    await openModel("model-a");
    await editor.getByLabel("编辑参数范围", { exact: true }).selectOption("low");
    assert.equal(await editor.getByLabel("low JSON", { exact: true }).inputValue(), "{broken");
    await editor.getByRole("button", { name: "清除此覆盖 / 恢复继承", exact: true }).click();
    await save.click();
    await page.waitForFunction(() => document.body.textContent.includes("已保存"));
    assert.equal(writes.length, 1);
    assert.equal(saved.unknownRoot, true);
    assert.equal(saved.providers.alpha.unknownProvider, "keep");
    assert.deepEqual(saved.providers.alpha.models[0].unknownModel, [1, 2]);
    assert.deepEqual(saved.providers.alpha.models[0].samplingParams, { vendor_custom: { enabled: true }, temperature: 0.75 });
    assert.deepEqual(saved.providers.alpha.models[0].samplingParamsByThinkingLevel, { high: { top_p: 0.8, vendor_level: { enabled: true } } });
    assert.equal(saved.providers.alpha.models[1].samplingParams, undefined, "opening a model must not add defaults");
    await page.reload();
    await openModel("model-a");
    assert.equal(await editor.getByLabel("default temperature", { exact: true }).inputValue(), "0.75");
    await page.getByPlaceholder("显示名称", { exact: true }).fill("Renamed");
    await save.click();
    await page.waitForFunction(() => document.body.textContent.includes("已保存"));
    assert.equal(saved.providers.alpha.models[0].samplingParams.vendor_custom.enabled, true);
    await editor.locator("summary").filter({ hasText: "预览有效参数" }).click();
    await editor.getByLabel("请求思考等级", { exact: true }).selectOption("max");
    await editor.locator("summary").filter({ hasText: "请求级覆盖" }).click();
    await editor.getByLabel("request JSON", { exact: true }).fill('{"temperature":0.25}');
    await editor.getByRole("button", { name: "预览有效参数", exact: true }).click();
    await editor.locator("[data-sampling-effective]").waitFor();
    assert.match(await editor.innerText(), /max → 有效等级：high/);
    assert.equal(JSON.parse(await editor.locator("[data-sampling-effective]").innerText()).temperature, 0.25);
    assert.equal(probes.at(-1).previewOnly, true);
    await save.click();
    await page.waitForFunction(() => document.body.textContent.includes("已保存"));
    assert.equal(saved.providers.alpha.models[0].samplingParams.temperature, 0.75);
    assert.equal(JSON.stringify(saved).includes("requestSamplingParams"), false);
    await editor.getByRole("button", { name: "测试此采样配置", exact: true }).click();
    await editor.getByRole("alert").filter({ hasText: "Unsupported parameter: vendor_custom" }).waitFor();
    await editor.getByLabel("default temperature", { exact: true }).fill("0.5");
    assert.equal(await editor.locator("[data-sampling-effective]").count(), 0, "edits invalidate old previews");
    const api = page.locator("select").filter({ has: page.locator('option[value="anthropic-messages"]') }).last();
    await api.selectOption("anthropic-messages");
    await editor.getByRole("status").filter({ hasText: "不应用这些采样字段" }).waitFor();
    assert.equal(await editor.getByRole("button", { name: "测试此采样配置", exact: true }).isDisabled(), true);
    await api.selectOption("openai-completions");
    await editor.locator("summary").filter({ hasText: "请求级覆盖" }).click();
    await editor.getByRole("button", { name: "预览有效参数", exact: true }).click();
    await editor.locator("[data-sampling-effective]").waitFor();
    const showEditorTop = () => editor.evaluate(node => {
      const detail = node.closest(".detail");
      detail.scrollTop += node.getBoundingClientRect().top - detail.getBoundingClientRect().top - detail.querySelector("nav").offsetHeight - 16;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(repo, ".verification/sampling"), { recursive: true });
    await showEditorTop();
    await page.screenshot({ path: path.join(repo, ".verification/sampling/mobile.png") });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await showEditorTop();
    await page.screenshot({ path: path.join(repo, ".verification/sampling/desktop.png") });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
