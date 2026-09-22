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

test("SSH tabs close independently, retain failed sessions, and return to the connection form", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-ssh-tabs-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    // Keep the real panel, requests, selection logic and CSS; isolate terminal transport.
    await writeFile(path.join(directory, "session.ts"), "export const useSSHSession=()=>({snapshot:null,restoring:false,restoreError:null});");
    await writeFile(path.join(directory, "entry.tsx"), "import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{SSHPanel}from'@/components/workspace/SSHPanel';createRoot(document.getElementById('root')).render(<I18nProvider><SSHPanel/></I18nProvider>);");
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@/hooks/useSSHSession": path.join(directory, "session.ts"), "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/SSHPanel.module.css"), "utf8");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 380, height: 780 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      window.EventSource = class { close() {} };
    });
    let sessions = ["alpha", "beta", "gamma"].map(id => ({ id, host: id, port: 22, username: "test", connected: true }));
    const deletes = [];
    let status = 200;
    let release;
    await page.route("http://ssh-tabs.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}${css}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
      if (request.method() === "DELETE") {
        const id = url.pathname.split("/").at(-1);
        deletes.push(id);
        if (id === "beta") await new Promise(resolve => { release = resolve; });
        if (status === 200 || status === 404) sessions = sessions.filter(item => item.id !== id);
        return route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "close failed" } });
      }
      if (url.pathname === "/api/ssh/sessions") return route.fulfill({ json: { sessions } });
      if (url.pathname === "/api/ssh/hosts") return route.fulfill({ json: { hosts: [] } });
      return route.fulfill({ json: { configured: false, unlocked: false } });
    });
    await page.goto("http://ssh-tabs.test/");
    const tab = id => page.getByRole("button", { name: `${id}:22`, exact: true });
    const close = id => page.getByRole("button", { name: `关闭标签并断开连接 · ${id}:22`, exact: true });
    await tab("alpha").waitFor();
    await close("beta").click();
    await page.waitForFunction(() => document.querySelectorAll(".hostTabClose:disabled").length === 1);
    await close("beta").evaluate(button => button.click());
    assert.deepEqual(deletes, ["beta"], "a pending close cannot submit twice");
    release();
    await tab("beta").waitFor({ state: "detached" });
    assert.equal(await tab("alpha").getAttribute("aria-current"), "page", "closing a background tab preserves selection");
    status = 409;
    await close("alpha").click();
    await page.getByRole("alert").waitFor();
    assert.equal(await tab("alpha").getAttribute("aria-current"), "page", "failed close retains the selected tab");
    status = 200;
    await close("alpha").focus();
    await page.keyboard.press("Enter");
    await tab("alpha").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.querySelector('.hostTabSelect[aria-current="page"]')?.textContent.includes("gamma"));
    status = 404;
    await close("gamma").click();
    await tab("gamma").waitFor({ state: "detached" });
    await page.locator(".connectPage").waitFor();
    assert.equal(await page.locator(".hostTab").count(), 0);
    assert.equal(await page.getByRole("alert").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
