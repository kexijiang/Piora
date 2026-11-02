import assert from "node:assert/strict";
import sharp from "sharp";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("provider panel detects endpoint models, requests only missing limits and preserves configuration", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-model-experience-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=function(s){const prefix=require('path').basename(this.resourcePath).replace(/[^a-zA-Z]/g,'')+'__';const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+prefix+n);return 'const sheet=document.createElement("style");sheet.textContent='+JSON.stringify(css)+';document.head.appendChild(sheet);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ModelsExperience}from'@/components/ModelsExperience';import{ConfirmationHost}from'@/components/ConfirmDialog';window.changes=Number(sessionStorage.getItem('changes'))||0;createRoot(document.getElementById('root')).render(<I18nProvider><ModelsExperience cwd="/missing-project" embedded onClose={()=>{}} onModelsChanged={()=>{window.changes++;sessionStorage.setItem("changes",String(window.changes))}}/><ConfirmationHost/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => { if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "zh-CN"); });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "") + await readFile(path.join(repo, "app/theme-backgrounds.css"), "utf8");
    let config = { extra: "keep", providers: { legacy: { api: "openai-completions", baseUrl: "https://old.test/v1", models: [{ id: "old", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, compat: { store: false } }] } } };
    const initialLegacy = structuredClone(config.providers.legacy);
    let providerOrder = [], failOrder = false;
    const orderWrites = [];
    let scope = { models: [{ id: "unconfigured", provider: "anthropic", enabled: true }, { id: "old", provider: "legacy", enabled: true }], warnings: [], enabledPatterns: null, projectOverride: false, enabledCount: 0, totalCount: 0, configuredDefault: null, effectiveDefault: null };
    const catalogs = []; let tests = 0; let failSave = false; const savedBodies = []; let failDiscovery = false; let manyModels = false; let failRestore = false; let configured = false;
    await page.route("http://model-experience.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<html><meta charset="utf-8"><style>*{box-sizing:border-box}html,body,#root,.settings-backdrop{height:100%;margin:0}.settings-backdrop{position:fixed;inset:0;z-index:3000}${css}</style><div class="settings-backdrop"><div id="root" class="settings-dialog settings-embedded-section"></div></div><script src="/bundle.js"></script></html>` });
      if (url.pathname === "/api/models-config") {
        if (request.method() === "PUT") { if (failSave) return route.fulfill({ status: 500, json: { error: "Save unavailable" } }); config = request.postDataJSON(); savedBodies.push(structuredClone(config)); return route.fulfill({ json: { success: true } }); }
        return route.fulfill({ json: config });
      }
      if (url.pathname === "/api/models/provider-order") {
        if (request.method() === "PUT") {
          if (failOrder) return route.fulfill({ status: 500, json: { error: "Order unavailable" } });
          providerOrder = request.postDataJSON().providers;
          orderWrites.push([...providerOrder]);
        }
        return route.fulfill({ json: { providers: providerOrder } });
      }
      if (url.pathname === "/api/models/scope") {
        if (request.method() === "GET") { assert.equal(url.searchParams.get("scope"), "global"); assert.equal(url.searchParams.has("cwd"), false); }
        if (request.method() === "PATCH") {
          const body = request.postDataJSON();
          assert.equal(body.scope, "global");
          assert.equal(body.cwd, undefined);
          if (body.action === "restore" && failRestore) return route.fulfill({ status: 409, json: { error: "project scope override" } });
          if (body.action === "set-default") scope.effectiveDefault = { provider: body.provider, modelId: body.id };
          else if (body.action === "remove-provider") scope.removedProviders = [...new Set([...(scope.removedProviders ?? []), body.provider])];
          else if (body.action === "restore-removed-provider") scope.removedProviders = (scope.removedProviders ?? []).filter(id => id !== body.provider);
          else if (body.action === "restore") { const m = config.providers[body.provider].models.find(m => m.id === body.id); scope.models.push({ id: m.id, name: m.name ?? m.id, provider: body.provider, enabled: true }); }
        }
        return route.fulfill({ json: scope });
      }
      if (url.pathname === "/api/models-config/discover") return failDiscovery ? route.fulfill({ status: 401, json: { error: "Unauthorized" } }) : route.fulfill({ json: { models: [{ id: "ready", name: "Ready", contextWindow: 32000, maxTokens: 4096 }, { id: "catalog", contextWindow: 64000 }, { id: "missing" }, ...(manyModels ? Array.from({ length: 120 }, (_, i) => ({ id: `extra-${i}`, name: i === 0 ? `Long model name ${"extended-model-".repeat(12)}` : `Model ${i}`, ...(i % 3 === 0 ? { contextWindow: 128000, maxTokens: 16000 } : {}) })) : [])] } });
      if (url.pathname === "/api/models-config/catalog") { catalogs.push(url.toString()); const q = url.searchParams.get("q"); return route.fulfill({ json: { recommendation: q === "catalog" ? { metadataMethod: "base-url", exactMatches: 1, preset: { contextWindow: 99999, maxTokens: 8000 } } : q === "ready" ? { metadataMethod: "base-url", exactMatches: 1, preset: { reasoning: true, input: ["text", "image"], contextWindow: 99999 } } : { metadataMethod: "none", exactMatches: 0, preset: {} } } }); }
      if (url.pathname === "/api/models-config/test") { tests++; return route.fulfill({ json: { ok: true } }); }
      if (url.pathname === "/api/auth/all-providers") return route.fulfill({ json: { providers: [{ id: "fixture", displayName: "Fixture API", configured, modelCount: 1, canRemoveStoredCredential: configured }] } });
      if (url.pathname === "/api/auth/api-key/fixture") { configured = request.method() === "POST"; return route.fulfill({ json: { success: true } }); }
      return route.fulfill({ json: { providers: [] } });
    });

    await page.goto("http://model-experience.test/");
    await page.getByRole("heading", { name: "模型设置" }).waitFor();
    await page.getByLabel("供应商名称").waitFor();
    const modelRoot = page.locator('[class*="ModelsExperiencemodulecss__root"]');
    const workspace = page.locator('[class*="__workspace"]');
    const originalSurface = await modelRoot.evaluate(el => getComputedStyle(el).backgroundColor);
    const originalPanel = await workspace.evaluate(el => getComputedStyle(el).backgroundColor);
    await page.evaluate(() => {
      document.documentElement.dataset.appBackgroundActive = "true";
      document.documentElement.style.setProperty('--app-background-overlay', '0%');
    });
    assert.equal(await modelRoot.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
    const panelPixel = async color => {
      await page.evaluate(value => document.documentElement.style.setProperty('--app-background-image', `linear-gradient(${value},${value})`), color);
      const box = await workspace.boundingBox();
      return [...(await sharp(await page.screenshot({ clip: { x: Math.floor(box.x + box.width - 20), y: Math.floor(box.y + box.height - 20), width: 1, height: 1 } })).removeAlpha().raw().toBuffer())];
    };
    const pink = await panelPixel('#ff00ff');
    const blue = await panelPixel('#0000ff');
    assert.ok(pink[0] - blue[0] > 80, 'wallpaper is visible through the actual composited provider panel');
    assert.ok(blue[0] > 50, 'provider panel retains its translucent surface');
    const inputColor = await page.getByLabel("Base URL", { exact: true }).evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(inputColor, 'rgba(0, 0, 0, 0)', 'form fields retain readable surfaces');
    await page.evaluate(() => { delete document.documentElement.dataset.appBackgroundActive; });
    assert.equal(await modelRoot.evaluate(el => getComputedStyle(el).backgroundColor), originalSurface);
    assert.equal(await workspace.evaluate(el => getComputedStyle(el).backgroundColor), originalPanel);
    await page.setViewportSize({ width: 1920, height: 1080 });
    const wideCard = await page.locator('[class*="__workspace"]').boundingBox();
    assert.ok(wideCard.width > 1800, "settings card uses the wide available space");
    assert.ok(wideCard.y + wideCard.height >= 1030, "short content fills the available height");
    await page.locator('#root').evaluate(el => { el.style.width = '620px'; });
    assert.equal(await page.locator('nav').evaluate(el => getComputedStyle(el).display), 'flex', "embedded narrow settings respond to their container, not screen width");
    assert.ok(await page.locator('[class*="__root"]').evaluate(el => el.scrollWidth <= el.clientWidth), "narrow embedded view has no horizontal overflow");
    await page.locator('#root').evaluate(el => { el.style.width = ''; });
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.getByRole("navigation", { name: "服务商" }).getByRole("button", { name: "anthropic", exact: true }).count(), 0, "unconfigured built-in models do not create a default provider");
    const addProvider = () => page.getByRole("button", { name: "添加供应商", exact: true }).first();
    await addProvider().click();
    await page.getByRole("button", { name: /创建自定义供应商/ }).click();
    await page.getByLabel("供应商名称").fill("新渠道");
    await page.getByLabel("Base URL", { exact: true }).fill("https://provider.test/v1");
    await page.getByLabel("API Key", { exact: true }).fill("secret-fixture");
    await page.getByRole("button", { name: /一键识别可用模型/ }).click();
    const imports = page.getByRole("dialog", { name: "识别可用模型" });
    await imports.waitFor();
    const bodyBounds = await imports.locator('[class*="__dialogBody"]').evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, scroll: getComputedStyle(el).overflowY }));
    const inputBounds = await imports.getByLabel("上下文窗口").first().boundingBox();
    assert.ok(inputBounds.x >= bodyBounds.left && inputBounds.x + inputBounds.width <= bodyBounds.right, "model fields stay inside the dialog body");
    assert.equal(bodyBounds.scroll, "auto", "long model lists can scroll");
    assert.equal(await imports.locator('[class*="__importRow"]').getByRole("checkbox", { checked: true }).count(), 3);
    assert.equal(await imports.getByLabel("上下文窗口").count(), 2, "complete endpoint models require no manual fields");
    const partial = imports.locator('[class*="__importRow"]').filter({ has: page.getByRole("checkbox", { name: /catalog/ }) });
    assert.equal(await partial.getByLabel("上下文窗口").inputValue(), "64000");
    assert.equal(await partial.getByLabel("最大输出 Token").inputValue(), "65536", "missing output uses the requested default");
    await partial.getByLabel("最大输出 Token").fill("8000");
    const missing = imports.locator('[class*="__importRow"]').filter({ has: page.getByRole("checkbox", { name: /missing/ }) });
    assert.equal(await missing.getByLabel("上下文窗口").inputValue(), "512000");
    assert.equal(await missing.getByLabel("最大输出 Token").inputValue(), "65536");
    await missing.getByLabel("上下文窗口").fill("");
    await imports.getByRole("button", { name: "添加所选模型" }).click();
    await imports.getByRole("alert").waitFor();
    assert.equal(savedBodies.length, 0, "incomplete model limits cannot be saved");
    assert.equal(await missing.getByLabel("上下文窗口").evaluate(el => document.activeElement === el), true, "invalid submission focuses the first incomplete field");
    await missing.getByLabel("上下文窗口").fill("10000");
    await missing.getByLabel("最大输出 Token").fill("2000");
    assert.equal(await missing.getByLabel("最大输出 Token").inputValue(), "2000", "completing parameters keeps the editor mounted");
    failSave = true;
    await imports.getByRole("button", { name: "添加所选模型" }).click();
    await imports.getByRole("alert").filter({ hasText: "Save unavailable" }).waitFor();
    failSave = false;
    await imports.getByRole("button", { name: "添加所选模型" }).click();
    await imports.waitFor({ state: "detached" });
    assert.equal(savedBodies.length, 1);
    assert.deepEqual(config.providers.legacy, initialLegacy, "untouched legacy model, costs and compatibility survive");
    assert.deepEqual(config.providers["新渠道"].models.map(model => [model.id, model.contextWindow, model.maxTokens]), [["ready", 32000, 4096], ["catalog", 64000, 8000], ["missing", 10000, 2000]]);
    assert.equal(catalogs.length, 0, "discovery uses endpoint data and local defaults without external catalog requests");
    assert.equal(tests, 0, "discovery never silently sends paid inference requests");
    const providerRows = page.locator('nav [data-provider-id]');
    const rowIds = () => providerRows.evaluateAll(rows => rows.map(row => row.dataset.providerId));
    assert.deepEqual(await rowIds(), ["legacy", "新渠道"]);
    const dragProvider = async (from, to, cancel = false) => {
      const source = await page.locator(`nav [data-provider-id="${from}"]`).boundingBox();
      const destination = await page.locator(`nav [data-provider-id="${to}"]`).boundingBox();
      await page.mouse.move(source.x + 30, source.y + source.height / 2);
      await page.mouse.down();
      await page.locator(`nav [data-provider-id="${from}"][data-dragging=true]`).waitFor();
      await page.mouse.move(destination.x + 30, destination.y + destination.height / 2, { steps: 6 });
      if (cancel) await page.keyboard.press("Escape");
      await page.mouse.up();
    };
    await page.locator('nav [data-provider-id="新渠道"]').click();
    assert.equal(orderWrites.length, 0, "ordinary clicks do not reorder channels");
    await dragProvider("新渠道", "legacy", true);
    assert.equal(orderWrites.length, 0, "Escape cancels a held drag");
    failOrder = true;
    await dragProvider("新渠道", "legacy");
    await page.getByRole("alert").filter({ hasText: "Order unavailable" }).waitFor();
    assert.deepEqual(await rowIds(), ["legacy", "新渠道"], "failed saves retain the previous order");
    failOrder = false;
    await dragProvider("新渠道", "legacy");
    await page.waitForFunction(() => document.querySelector('nav [data-provider-id]')?.dataset.providerId === "新渠道");
    assert.deepEqual(providerOrder, ["新渠道", "legacy"]);
    assert.equal(await page.getByLabel("供应商名称").inputValue(), "新渠道", "dragging does not change the selected channel");
    await page.reload();
    await page.getByLabel("供应商名称").waitFor();
    assert.deepEqual(await rowIds(), ["新渠道", "legacy"], "saved order survives reload");
    manyModels = true;
    if (process.env.MODEL_DISCOVERY_SCREENSHOT) await page.screenshot({ path: process.env.MODEL_DISCOVERY_SCREENSHOT.replace(/\.png$/, "-page.png") });
    await page.getByRole("button", { name: /一键识别可用模型/ }).click();
    await imports.waitFor();
    const longBody = imports.locator('[class*="__dialogBody"]');
    if (process.env.MODEL_DISCOVERY_SCREENSHOT) await page.screenshot({ path: process.env.MODEL_DISCOVERY_SCREENSHOT });
    assert.ok((await imports.boundingBox()).height <= 601, "many models do not expand the dialog to full screen");
    assert.ok((await imports.boundingBox()).width <= 641, "discovery uses a compact dialog");
    assert.ok(await longBody.evaluate(el => el.scrollHeight > el.clientHeight), "long results overflow a scrollable body");
    const fixedSearch = await imports.getByRole("searchbox").boundingBox();
    const fixedFooter = await imports.getByRole("button", { name: "添加所选模型" }).boundingBox();
    await imports.getByRole("checkbox", { name: /extra-119/ }).scrollIntoViewIfNeeded();
    assert.ok(await longBody.evaluate(el => el.scrollTop > 0), "the last model is reachable by scrolling");
    assert.deepEqual(await imports.getByRole("searchbox").boundingBox(), fixedSearch, "search stays visible while the list scrolls");
    assert.deepEqual(await imports.getByRole("button", { name: "添加所选模型" }).boundingBox(), fixedFooter, "actions stay visible while the list scrolls");
    await imports.getByRole("searchbox").fill("extra-119");
    await imports.getByRole("checkbox", { name: "全选当前结果", exact: true }).uncheck();
    await imports.getByRole("searchbox").fill("extra-1");
    const extraOne = imports.locator('[class*="__importRow"]').filter({ has: page.getByRole("checkbox", { name: "Model 1 extra-1", exact: true }) });
    assert.equal(await extraOne.getByRole("checkbox").isChecked(), true, "selecting filtered results preserves other selections");
    assert.equal(await imports.getByRole("checkbox", { name: /extra-119/ }).isChecked(), false);
    assert.equal(await imports.getByRole("checkbox", { name: "全选当前结果", exact: true }).evaluate(el => el.indeterminate), true);
    await extraOne.getByLabel("上下文窗口").fill("64000");
    await extraOne.getByLabel("最大输出 Token").fill("8000");
    await imports.getByRole("searchbox").fill("not-a-model");
    await imports.getByText("没有匹配的模型", { exact: true }).waitFor();
    assert.equal(await imports.getByRole("checkbox", { name: "全选当前结果", exact: true }).isDisabled(), true);
    await imports.getByRole("searchbox").fill("extra-1");
    assert.equal(await extraOne.getByLabel("最大输出 Token").inputValue(), "8000", "search preserves edited limits");
    await imports.getByRole("searchbox").fill("");
    for (const viewport of [{ width: 390, height: 844 }, { width: 800, height: 420 }]) {
      await page.setViewportSize(viewport);
      await longBody.evaluate(el => { el.scrollTop = 0; });
      assert.ok(await imports.evaluate(dialog => {
        const box = dialog.getBoundingClientRect(), body = dialog.querySelector('[class*="__importBody"]');
        const bounds = body.getBoundingClientRect();
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
          && body.scrollWidth <= body.clientWidth
          && [...body.querySelectorAll('input')].every(input => { const r = input.getBoundingClientRect(); return r.left >= bounds.left && r.right <= bounds.right; });
      }), "dialog and parameter fields fit narrow and short viewports without horizontal overflow");
      await imports.getByRole("checkbox", { name: /extra-119/ }).scrollIntoViewIfNeeded();
      assert.ok(await longBody.evaluate(el => el.scrollTop > 0));
      if (process.env.MODEL_DISCOVERY_SCREENSHOT) {
        await longBody.evaluate(el => { el.scrollTop = 0; });
        await page.screenshot({ path: process.env.MODEL_DISCOVERY_SCREENSHOT.replace(/\.png$/, `-${viewport.width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await imports.getByRole("button", { name: "取消" }).click();
    manyModels = false;
    assert.ok(await page.evaluate(() => window.changes > 0));
    await page.getByRole("navigation", { name: "服务商" }).getByRole("button", { name: "新渠道", exact: true }).waitFor();
    await page.getByRole("button", { name: "测试模型 ready", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "测试通过" }).waitFor();
    assert.equal(tests, 1);
    const readyRow = page.locator('[data-model-id="ready"]');
    assert.equal(await readyRow.getByRole("button", { name: "测试模型 ready", exact: true }).getAttribute("title"), "测试连接");
    assert.equal(await readyRow.locator('[class*="__modelLine"] > :last-child').getAttribute("role"), "switch");
    assert.equal(await readyRow.locator('[class*="__contextBadge"]').innerText(), "32K");
    const dragHandle = readyRow.getByRole("button", { name: /长按拖动/ });
    const dragStart = await dragHandle.boundingBox();
    const dragEnd = await page.locator('[data-model-id="catalog"]').boundingBox();
    await page.mouse.move(dragStart.x + 20, dragStart.y + dragStart.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.move(dragEnd.x + 20, dragEnd.y + dragEnd.height / 2);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-model-id]')?.getAttribute('data-model-id') === 'catalog');
    assert.deepEqual(config.providers["新渠道"].models.map(m => m.id), ["catalog", "ready", "missing"], "long-press order is persisted");
    assert.equal(await page.getByRole("button", { name: /设为默认/ }).count(), 0, "default star buttons are removed; model order determines the default");
    await page.getByRole("button", { name: "编辑模型配置 ready", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "编辑模型配置" });
    await edit.getByLabel("显示名称").waitFor({ state: "hidden" });
    await edit.getByText("高级配置", { exact: true }).click();
    await edit.getByLabel("显示名称").fill("Ready renamed");
    await edit.getByLabel("支持图片输入").check();
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    assert.deepEqual(config.providers["新渠道"].models.find(m => m.id === "ready").input, ["text", "image"]);
    await page.getByRole("navigation", { name: "服务商" }).getByRole("button", { name: "legacy", exact: true }).click();
    await page.getByRole("button", { name: "编辑模型配置 old" }).click();
    await edit.getByLabel("上下文窗口").fill("16000");
    await edit.getByLabel("最大输出 Token").fill("4000");
    await edit.getByRole("button", { name: "保存", exact: true }).click();
    await edit.waitFor({ state: "detached" });
    assert.deepEqual(config.providers.legacy.models[0].compat, initialLegacy.models[0].compat);
    assert.deepEqual(config.providers.legacy.models[0].cost, initialLegacy.models[0].cost);
    await addProvider().click();
    await page.getByRole("button", { name: /Fixture API/ }).click();
    const apiKey = page.getByPlaceholder("sk-…");
    await apiKey.fill("fixture-key");
    const beforeAuth = await page.evaluate(() => window.changes);
    await apiKey.locator("../..").getByRole("button", { name: "保存", exact: true }).click();
    await page.waitForFunction(previous => window.changes > previous, beforeAuth);
    assert.equal(configured, true, "credential changes immediately refresh the chat catalogue");
    await page.getByRole("button", { name: "移除渠道", exact: true }).click();
    await page.getByRole("dialog", { name: "移除渠道" }).getByRole("button", { name: "移除渠道", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('nav button[aria-current="page"]') || !document.querySelector('nav button[aria-current="page"]').textContent.includes('Fixture API'));
    assert.equal(configured, true, "removing a channel preserves its credential");
    assert.deepEqual(scope.removedProviders, ["fixture"]);
    assert.equal(await page.getByRole("navigation", { name: "服务商" }).getByRole("button", { name: "Fixture API", exact: true }).count(), 0);
    await addProvider().click();
    await page.getByRole("button", { name: "Fixture API 恢复渠道", exact: true }).click();
    await page.getByRole("button", { name: "删除配置", exact: true }).click();
    await page.getByRole("dialog", { name: "删除配置" }).getByRole("button", { name: "删除配置", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('nav button[aria-current="page"]') || !document.querySelector('nav button[aria-current="page"]').textContent.includes('Fixture API'));
    assert.equal(configured, false, "explicit credential removal still deletes the stored credential");
    await addProvider().click();
    await page.getByRole("button", { name: /创建自定义供应商/ }).click();
    await page.getByLabel("供应商名称").fill("手动渠道");
    await page.getByLabel("Base URL", { exact: true }).fill("https://manual.test/v1");
    await addProvider().click();
    await page.getByRole("dialog", { name: "放弃未保存的修改？" }).getByRole("button", { name: "取消" }).click();
    assert.equal(await page.getByLabel("供应商名称").inputValue(), "手动渠道", "cancelled navigation retains connection draft");
    failDiscovery = true;
    await page.getByRole("button", { name: /一键识别可用模型/ }).click();
    await page.getByRole("alert").filter({ hasText: "获取模型失败" }).waitFor();
    await page.getByRole("button", { name: "添加模型", exact: true }).click();
    const manual = page.getByRole("dialog", { name: "添加模型", exact: true });
    await manual.getByLabel("模型 ID", { exact: true }).fill("manual-model");
    await manual.getByLabel("上下文窗口").fill("16000");
    await manual.getByLabel("最大输出 Token").fill("2000");
    await manual.getByRole("button", { name: "保存", exact: true }).waitFor();
    failRestore = true;
    await manual.getByRole("button", { name: "保存", exact: true }).click();
    await manual.waitFor({ state: "detached" });
    assert.equal(config.providers["手动渠道"].models[0].id, "manual-model");
    await page.getByRole("status").filter({ hasText: "部分模型无法启用" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => localStorage.setItem("pi-locale", "en"));
    await page.reload();
    await page.getByRole("heading", { name: "Model settings" }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
