import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");

test("native MCP configuration shows live ownership, explicit connection actions and private scoped configuration", { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-native-mcp-ui-")); let browser;
  t.after(async () => { await browser?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
  await writeFile(path.join(root, "stubs.tsx"), `import {nativeMcpEn} from "@/lib/i18n/messages/native-mcp";export const useI18n=()=>({t:(key,params={})=>{const text=({...nativeMcpEn,"i18n.loading":"Loading","i18n.save":"Save","i18n.reloadSession":"Reload task"})[key];if(!text)throw Error("Missing translation "+key);return text.replace(/\\{([\\w.-]+)\\}/g,(token,name)=>params[name]??token)}});export const sendAgentCommand=async(id,command)=>{window.commands.push({id,command});};`);
  await writeFile(path.join(root, "entry.tsx"), 'import React,{useState} from "react";import {createRoot} from "react-dom/client";import {NativeMcpConfig} from "@/components/NativeMcpConfig";function Fixture(){const[session,setSession]=useState("fixture-session");window.setFixtureSession=setSession;return <NativeMcpConfig cwd="/fixture-workspace" sessionId={session}/>};createRoot(document.getElementById("root")).render(<Fixture/>);');
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@/hooks/useI18n": path.join(root, "stubs.tsx"), "@/lib/agent-client": path.join(root, "stubs.tsx"), "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true, ...(process.env.PIORA_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PIORA_TEST_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [], mutations = [];
  page.on("pageerror", error => errors.push(error.message)); await page.addInitScript(() => { window.commands = []; });
  const state = { enabled: false, projectTrusted: false, owner: "native", live: true, diagnostics: [], servers: [{ name: "fixture-http", source: "/fixture-agent/mcp.json", scope: "global", enabled: true, exposure: "codemode", transport: "http", endpoint: "https://fixture.invalid", state: "needs-auth", tools: [], resources: false }] };
  await page.route("http://fixture.local/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' }); return; }
    if (url.pathname === "/bundle.js") { await route.fulfill({ contentType: "application/javascript", body: await readFile(path.join(root, "bundle.js"), "utf8") }); return; }
    if (url.pathname === "/api/mcp") {
      if (route.request().method() === "PUT") { const body = route.request().postDataJSON(); mutations.push(body); if (body.action === "integration") state.enabled = body.enabled; if (body.action === "server" && body.name === "fixture-http") state.servers[0].exposure = body.exposure ?? state.servers[0].exposure; }
      await route.fulfill({ json: state }); return;
    }
    await route.fulfill({ status: 404, body: "fixture" });
  });
  await page.goto("http://fixture.local/"); await page.getByText("Sign-in required", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled(), true);
  await page.getByLabel("Enable native MCP connections", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("input[type=checkbox]").checked);
  await page.getByRole("button", { name: "Reload task", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.commands)).map(c => c.command), [{ type: "reload" }, { type: "prompt", message: "/mcp login fixture-http" }, { type: "prompt", message: "/mcp reconnect fixture-http" }]);
  await page.getByRole("combobox", { name: "fixture-http Tool exposure" }).selectOption("deferred");
  await page.getByLabel("Server name", { exact: true }).fill("fixture-private");
  const editor = page.getByLabel("Server definition (strict JSON)", { exact: true });
  await editor.fill('{"url":"https://fixture.invalid/mcp","headers":{"Authorization":"FIXTURE_PRIVATE_HEADER"},"enabled":false}');
  assert.notEqual(await page.locator('option[value="project"]').getAttribute("disabled"), null);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea").value === "");
  assert.ok(mutations.some(m => m.config?.headers?.Authorization === "FIXTURE_PRIVATE_HEADER" && m.scope === "global"));
  assert.equal(await page.getByText("FIXTURE_PRIVATE_HEADER", { exact: false }).count(), 0);
  for (const revoked of [{ enabled: false }, { state: "approval-required" }, { configurationCurrent: false }, { connectionAuthorized: false }, { approvalRequired: true }]) {
    const previous = { ...state.servers[0] }; Object.assign(state.servers[0], revoked);
    await page.getByRole("button", { name: "Refresh status", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")].filter(button => ["Reconnect", "Sign in"].includes(button.textContent)).every(button => button.disabled));
    assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled(), true);
    state.servers[0] = previous;
  }
  state.owner = "replacement";
  await page.getByRole("button", { name: "Refresh status", exact: true }).click(); await page.getByText("Connection owner: Replacement extension", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reconnect", exact: true }).isDisabled(), true);
  state.live = false; state.owner = "not-started";
  await page.evaluate(() => window.setFixtureSession(null)); await page.getByText("Configuration only. Open a normal task to see actual connection status.", { exact: true }).waitFor();
  await page.setViewportSize({ width: 420, height: 900 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.PIORA_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PIORA_TEST_SCREENSHOT, fullPage: true });
  assert.deepEqual(errors, []);
});
