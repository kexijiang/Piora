import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("new task selections remain clickable and reach the launch request", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-new-task-selection-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(directory, "icons.tsx"), "export const ModelProviderIcon=()=>null;");
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{NewSessionProjectPicker}from'@/components/NewSessionProjectPicker';window.launches=[];createRoot(document.getElementById('root')).render(<I18nProvider><NewSessionProjectPicker onLaunch={request=>window.launches.push(request)}/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "https://new-task.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./ModelProviderIcon": path.join(directory, "icons.tsx") } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = await readFile(path.join(repo, "app/globals.css"), "utf8");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    const models = [{ provider: "fixture", id: "first", name: "First model" }, { provider: "fixture", id: "chosen", name: "Chosen model" }];
    const workspaceRequested = Promise.withResolvers();
    const releaseWorkspace = Promise.withResolvers();
    await page.route("https://new-task.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(url.pathname))) });
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: {}, modelList: models, defaultModel: { provider: "fixture", modelId: "first" } } });
      if (url.pathname === "/api/chat-workspace") {
        workspaceRequested.resolve();
        await releaseWorkspace.promise;
        return route.fulfill({ json: { cwd: "C:/fixture/chat" } });
      }
      if (url.pathname === "/api/sessions") return route.fulfill({ json: { sessions: [{ id: "fixture", cwd: "C:/fixture/project", projectRoot: "C:/fixture/project", modified: "2026-11-06T00:00:00Z", messages: [] }] } });
      if (url.pathname === "/api/system-prompt") return route.fulfill({ json: { templates: [], selectorVisible: true } });
      if (url.pathname === "/api/tool-permissions") return route.fulfill({ json: { mode: "full" } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { available: false, commands: [] } });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://new-task.test/");
    await workspaceRequested.promise;
    await page.locator(".model-settings-control > .model-settings-trigger").waitFor();
    await page.locator(".model-settings-control > .model-settings-trigger").click();
    await page.locator(".model-settings-row").first().click();
    await page.getByRole("menuitemradio", { name: "Chosen model" }).click();
    assert.match(await page.locator(".model-settings-control > .model-settings-trigger").innerText(), /Chosen model/);
    await page.locator("textarea").fill("Wait for the workspace");
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    await page.locator("textarea").press("Enter");
    assert.equal(await page.evaluate(() => window.launches.length), 0);
    assert.equal(await page.locator("textarea").inputValue(), "Wait for the workspace");
    releaseWorkspace.resolve();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Send"]').disabled);
    const project = page.locator('[class*="projectTrigger"]');
    await project.click();
    await page.getByRole("option", { name: /project/ }).last().click();
    assert.equal(await project.innerText(), "project");
    await page.locator(".model-settings-control > .model-settings-trigger").filter({ hasText: "Chosen model" }).waitFor();
    await page.locator("textarea").fill("Launch with these selections");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.launches.length === 1);
    const launch = await page.evaluate(() => window.launches[0]);
    assert.deepEqual(launch.model, { provider: "fixture", modelId: "chosen" });
    assert.equal(launch.cwd, "C:/fixture/project");
    assert.equal(launch.projectRoot, "C:/fixture/project");
    assert.equal(launch.prompt.message, "Launch with these selections");
    assert.deepEqual(errors, []);
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/new-task-selection.png") });
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
