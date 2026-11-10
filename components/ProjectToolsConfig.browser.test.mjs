import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { buildProjectToolsCapabilities } = await createJiti(import.meta.url).import("../lib/project-tools.ts");

test("project tools explain custom exclusions and loader errors before explicit recovery", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-project-tools-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ProjectToolsConfig}from'@/components/ProjectToolsConfig';createRoot(document.getElementById('root')).render(<I18nProvider><ProjectToolsConfig cwd="C:/fixture/project"/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    const css = await readFile(path.join(repo, "app/globals.css"), "utf8") + await readFile(path.join(repo, "components/ProjectToolsConfig.module.css"), "utf8");
    const tools = ["read", "write", "ssh", "piora_room", "send_meme"].map(name => ({ name, description: name, ...(name === "send_meme" ? { sourceInfo: { source: "user" } } : {}) }));
    let record = { projectRoot: "C:/fixture/project", revision: 1, preset: "custom", enabledCapabilityIds: ["tool:read"], updatedAt: new Date().toISOString() };
    const writes = [], errors = [];
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://project-tools.test/**", async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/api/project-tools") {
        if (request.method() === "PATCH") {
          const body = request.postDataJSON(); writes.push(body);
          assert.equal(body.expectedRevision, record.revision);
          record = { ...record, ...body, revision: record.revision + 1 };
        }
        return route.fulfill({ json: { projectRoot: record.projectRoot, managed: true, capabilities: buildProjectToolsCapabilities(tools, "normal", record), runtime: [], definitionTokens: 10, diagnostics: [{ path: "C:/fixture/broken-extension.ts", error: "fixture module failed" }] } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://project-tools.test/");
    const hint = page.getByRole("status").filter({ hasText: "项目自定义选择关闭了" });
    await hint.waitFor();
    assert.match(await hint.innerText(), /4 项.*现有和新会话/);
    assert.match(await hint.innerText(), /send_meme/);
    await page.getByRole("alert").filter({ hasText: "部分扩展加载失败" }).waitFor();
    assert.equal(writes.length, 0, "reading diagnostics must never grant tools");
    const meme = page.getByRole("switch", { name: "Send Meme", exact: true });
    // The switch reflects the saved server policy, so wait for its PATCH receipt.
    await meme.click();
    await page.getByText("项目工具设置已应用到该项目的会话。", { exact: true }).waitFor();
    assert.equal(await meme.isChecked(), true);
    assert.deepEqual(writes[0].enabledCapabilityIds.sort(), ["tool:read", "tool:send_meme"]);
    await page.reload();
    await meme.waitFor(); assert.equal(await meme.isChecked(), true);
    assert.match(await hint.innerText(), /3 项/);
    await hint.getByRole("button").click();
    await hint.waitFor({ state: "hidden" });
    assert.equal(writes.at(-1).preset, "coding");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
