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
  await writeFile(path.join(root, "stubs.tsx"), `import {nativeMcpEn} from "@/lib/i18n/messages/native-mcp";export const useI18n=()=>({t:(key,params={})=>{const text=({...nativeMcpEn,"i18n.loading":"Loading","i18n.save":"Save","i18n.reloadSession":"Reload task"})[key];if(!text)throw Error("Missing translation "+key);return text.replace(/\\{([\\w.-]+)\\}/g,(token,name)=>params[name]??token)}});export const sendAgentCommand=async(id,command)=>{window.commands.push({id,command});await window.onFixtureCommand?.(command);};`);
  await writeFile(path.join(root, "entry.tsx"), 'import React,{useState} from "react";import {createRoot} from "react-dom/client";import {NativeMcpConfig} from "@/components/NativeMcpConfig";function Fixture(){const[session,setSession]=useState("fixture-session");const[open,setOpen]=useState(true);window.setFixtureOpen=setOpen;window.setFixtureSession=setSession;window.reloadEvents??=0;return open?<NativeMcpConfig cwd="/fixture-workspace" sessionId={session} onReloaded={()=>window.reloadEvents++}/>:null};createRoot(document.getElementById("root")).render(<Fixture/>);');
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@/hooks/useI18n": path.join(root, "stubs.tsx"), "@/lib/agent-client": path.join(root, "stubs.tsx"), "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true, ...(process.env.PIORA_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.PIORA_TEST_BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [], mutations = [];
  let pendingPut, releasePut;
  t.after(() => releasePut?.());
  page.on("pageerror", error => errors.push(error.message)); await page.addInitScript(() => { window.commands = []; });
  const state = { enabled: false, projectTrusted: false, owner: "native", live: true, reloadRequired: false, diagnostics: [], servers: [{ name: "fixture-http", source: "/fixture-agent/mcp.json", scope: "global", enabled: true, exposure: "codemode", transport: "http", endpoint: "https://fixture.invalid", state: "needs-auth", tools: [], resources: false }] };
  await page.route("http://fixture.local/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: '<meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' }); return; }
    if (url.pathname === "/bundle.js") { await route.fulfill({ contentType: "application/javascript", body: await readFile(path.join(root, "bundle.js"), "utf8") }); return; }
    if (url.pathname === "/fixture-reloaded") { state.reloadRequired = false; state.servers[0].configurationCurrent = true; await route.fulfill({ json: {} }); return; }
    if (url.pathname === "/api/mcp") {
      if (route.request().method() === "PUT") { const body = route.request().postDataJSON(); mutations.push(body); state.reloadRequired = true; if (body.action === "integration") state.enabled = body.enabled; if (body.action === "server" && body.name === "fixture-http") state.servers[0].exposure = body.exposure ?? state.servers[0].exposure; }
      if (route.request().method() === "PUT" && pendingPut) await pendingPut;
      await route.fulfill({ json: state }); return;
    }
    await route.fulfill({ status: 404, body: "fixture" });
  });
  await page.goto("http://fixture.local/");
  await page.evaluate(() => { window.onFixtureCommand = async command => { if (command.type === "reload") await fetch("/fixture-reloaded"); }; }); await page.getByText("Sign-in required", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Sign in", exact: true }).isDisabled(), true);
  await page.getByLabel("Enable native MCP connections", { exact: true }).click();
  await page.waitForFunction(() => document.querySelector("input[type=checkbox]").checked);
  await page.getByRole("button", { name: "Reload task", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  assert.deepEqual((await page.evaluate(() => window.commands)).map(c => c.command), [{ type: "reload" }, { type: "prompt", message: "/mcp login fixture-http" }, { type: "prompt", message: "/mcp reconnect fixture-http" }]);
  await page.getByRole("combobox", { name: "fixture-http Tool exposure" }).selectOption("deferred");
  state.servers[0].configurationCurrent = false;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByText("Saved configuration differs from the live connection. Calls are revoked until reload.", { exact: true }).waitFor();
  await page.evaluate(() => window.setFixtureOpen(false));
  await page.locator("section").waitFor({ state: "detached" });
  await page.evaluate(() => window.setFixtureOpen(true));
  await page.getByRole("button", { name: "Reload task", exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "fixture-http Tool exposure" }).inputValue(), "deferred");
  await page.getByRole("button", { name: "Reload task", exact: true }).click();
  await page.getByRole("button", { name: "Reload task", exact: true }).waitFor({ state: "detached" });
  await page.evaluate(() => window.setFixtureOpen(false));
  await page.locator("section").waitFor({ state: "detached" });
  await page.evaluate(() => window.setFixtureOpen(true));
  await page.getByRole("button", { name: "Refresh status", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reload task", exact: true }).count(), 0);
  assert.equal(await page.getByText("Connecting does not authorize model calls. Enable individual tools and server resources in Settings → Project tools.", { exact: true }).count(), 1);
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
  state.servers[0].configurationCurrent = true; state.servers[0].connectionAuthorized = true;
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  const commandsBefore = (await page.evaluate(() => window.commands)).length;
  const reloadEventsBefore = await page.evaluate(() => window.reloadEvents);
  await page.evaluate(() => {
    window.onFixtureCommand = () => new Promise(resolve => { window.releaseFixtureCommand = resolve; });
    const button = [...document.querySelectorAll("button")].find(button => button.textContent === "Reload task");
    button.click(); button.click();
  });
  await page.waitForFunction(count => window.commands.length === count + 1, commandsBefore);
  assert.equal((await page.evaluate(() => window.commands)).length, commandsBefore + 1);
  await page.evaluate(() => window.setFixtureOpen(false));
  await page.locator("section").waitFor({ state: "detached" });
  await page.evaluate(() => window.setFixtureOpen(true));
  await page.getByRole("button", { name: "Reload task", exact: true }).waitFor();
  await page.evaluate(() => window.releaseFixtureCommand());
  assert.equal(await page.evaluate(() => window.reloadEvents), reloadEventsBefore);
  pendingPut = new Promise(resolve => { releasePut = resolve; });
  const putsBefore = mutations.length;
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === "/api/mcp" && response.request().method() === "PUT");
  await page.getByLabel("Server name", { exact: true }).fill("pending-server");
  await editor.fill('{"command":"node","enabled":false}');
  await page.evaluate(() => { const form = document.querySelector("form"); form.requestSubmit(); form.requestSubmit(); });
  await page.waitForFunction(() => document.querySelector('button[type="submit"]').disabled);
  await page.getByRole("button", { name: "Refresh status", exact: true }).waitFor();
  await page.evaluate(() => window.setFixtureOpen(false));
  await page.locator("section").waitFor({ state: "detached" });
  await page.evaluate(() => window.setFixtureOpen(true));
  await page.getByRole("button", { name: "Refresh status", exact: true }).waitFor();
  await page.getByLabel("Server name", { exact: true }).fill("fresh-name");
  await editor.fill('{"command":"fresh-editor","enabled":false}');
  releasePut(); pendingPut = undefined;
  await (await savedResponse).finished();
  // A subsequent status refresh settles after the delayed response; old saves
  // must not clear the newly mounted editor or enqueue a duplicate operation.
  await page.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('button[type="submit"]').disabled);
  assert.equal(mutations.length, putsBefore + 1);
  assert.equal(await editor.inputValue(), '{"command":"fresh-editor","enabled":false}');
  assert.equal(await page.getByRole("alert").count(), 0);
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
