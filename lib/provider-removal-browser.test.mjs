import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const store = await createJiti(import.meta.url).import("./removed-providers.ts");

test("external Claude channel can be removed, stays removed after reload, and can be restored without deleting credentials", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-provider-removal-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=function(s){const prefix=require('path').basename(this.resourcePath).replace(/[^a-zA-Z]/g,'')+'__';const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+prefix+n);return 'const sheet=document.createElement("style");sheet.textContent='+JSON.stringify(css)+';document.head.appendChild(sheet);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ModelsExperience}from'@/components/ModelsExperience';import{ConfirmationHost}from'@/components/ConfirmDialog';createRoot(document.getElementById('root')).render(<I18nProvider><ModelsExperience embedded onClose={()=>{}}/><ConfirmationHost/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 }, locale: "zh-CN" });
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    const errors = [], mutations = [];
    let fail = false, authType = "environment";
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://provider-removal.test/**", async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(pathname))) });
      if (!pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<html><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
      if (request.method() !== "GET") {
        mutations.push({ path: pathname, method: request.method(), body: request.postDataJSON() });
        assert.equal(pathname, "/api/models/scope", "channel removal must not delete external or stored credentials");
        if (fail) return route.fulfill({ status: 500, json: { error: "测试：无法保存渠道设置" } });
        const body = request.postDataJSON();
        store.setProviderRemoved(body.provider, body.action === "remove-provider", root);
      }
      if (pathname === "/api/models-config") return route.fulfill({ json: { providers: {} } });
      if (pathname === "/api/models/scope") {
        const removedProviders = store.readRemovedProviders(root), enabled = !removedProviders.includes("anthropic");
        return route.fulfill({ json: { removedProviders, models: [{ provider: "anthropic", id: "claude", name: "Claude", enabled }], warnings: [], enabledPatterns: null, projectOverride: false, enabledCount: Number(enabled), totalCount: 1, changed: true } });
      }
      if (pathname === "/api/auth/all-providers") return route.fulfill({ json: { providers: [{ id: "anthropic", displayName: "Anthropic / Claude", configured: authType !== "oauth", source: authType, canRemoveStoredCredential: authType === "stored", modelCount: 1 }] } });
      if (pathname === "/api/auth/providers") return route.fulfill({ json: { providers: [{ id: "anthropic", name: "Anthropic / Claude", loggedIn: authType === "oauth" }] } });
      return route.fulfill({ json: {} });
    });
    await page.goto("http://provider-removal.test/");
    const sidebar = page.getByRole("navigation", { name: "服务商", exact: true });
    const channel = sidebar.getByRole("button", { name: "Anthropic / Claude", exact: true });
    const confirm = () => page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "移除渠道", exact: true }) }).getByRole("button", { name: "移除渠道", exact: true }).click();
    await channel.waitFor();
    fail = true;
    await page.getByRole("button", { name: "移除渠道", exact: true }).click(); await confirm();
    await page.getByRole("alert").filter({ hasText: "无法保存渠道设置" }).waitFor();
    assert.equal(await channel.count(), 1);
    assert.deepEqual(store.readRemovedProviders(root), []);
    fail = false;
    for (const type of ["environment", "stored", "oauth"]) {
      authType = type;
      await page.reload(); await channel.waitFor();
      await page.getByRole("button", { name: "移除渠道", exact: true }).click(); await confirm();
      await channel.waitFor({ state: "hidden" });
      await page.reload();
      const restore = page.getByRole("button", { name: "Anthropic / Claude 恢复渠道", exact: true });
      await restore.waitFor();
      assert.equal(await channel.count(), 0, `${type} cannot recreate the sidebar entry`);
      assert.deepEqual(store.readRemovedProviders(root), ["anthropic"]);
      await restore.click(); await channel.waitFor();
      assert.deepEqual(store.readRemovedProviders(root), []);
    }
    const output = path.join(repo, ".verification/provider-removal"); await mkdir(output, { recursive: true });
    authType = "environment"; await page.reload(); await channel.waitFor();
    await page.getByRole("button", { name: "移除渠道", exact: true }).click();
    await page.getByRole("heading", { name: "移除渠道", exact: true }).waitFor();
    await page.screenshot({ path: path.join(output, "remove-claude.png"), animations: "disabled" });
    await confirm(); await channel.waitFor({ state: "hidden" });
    await page.screenshot({ path: path.join(output, "removed.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
    assert.equal(mutations.filter(m => m.body.action === "restore-removed-provider").length, 3);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("piora-provider-removal-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
