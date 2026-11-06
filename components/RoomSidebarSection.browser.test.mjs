import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
let directory, browser, css;

test.before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "piora-room-sidebar-"));
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `
import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider} from '@/hooks/useI18n';import {RoomSidebarSection} from '@/components/RoomSidebarSection';
window.events={restored:0,done:0,selected:0};
function App(){const[key,setKey]=useState(0);const[mounted,setMounted]=useState(true);return <I18nProvider>
<button onClick={()=>setKey(k=>k+1)}>Refresh fixture</button><button onClick={()=>setMounted(v=>!v)}>Toggle fixture</button>
<input aria-label="Chat draft"/><aside style={{width:260}}>{mounted&&<RoomSidebarSection sessions={[]} selectedSessionId={null} selectedRoomId={null} activeProjectRoot="F:/fixture" initialRoomId="room" refreshKey={key} onSelectRoom={(_room,restore)=>{window.events[restore?'restored':'selected']++}} onInitialRestoreDone={()=>window.events.done++}/>}</aside></I18nProvider>};
createRoot(document.getElementById('root')).render(<App/>);`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false,
    entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "")
    + await readFile(path.join(repo, "components/RoomSidebarSection.module.css"), "utf8");
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
});
test.after(async () => { await browser?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function fixture(locale = "en", initialMode = "network") {
  const page = await browser.newPage({ viewport: { width: 600, height: 850 } });
  await page.addInitScript(locale => localStorage.setItem("pi-locale", locale), locale);
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const state = { mode: initialMode, name: "Existing group", requests: 0, held: [], errors: [], logs: [], aborted: 0 };
  page.on("pageerror", error => state.errors.push(error.message));
  page.on("console", message => { if (message.type() === "warning") state.logs.push(message.text()); });
  page.on("requestfailed", request => { if (request.url().endsWith("/api/rooms") && request.failure()?.errorText.includes("ABORTED")) state.aborted++; });
  await page.route("https://room-sidebar.test/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/rooms") {
      if (route.request().method() === "POST") return route.fulfill({ status: 409, json: { error: "Creation fixture rejected" } });
      state.requests++;
      if (state.mode === "network") return route.abort("failed");
      if (state.mode === "http") return route.fulfill({ status: 503, json: { error: "Internal fixture diagnostic" } });
      if (state.mode === "json") return route.fulfill({ contentType: "application/json", body: "not-json" });
      if (state.mode === "shape") return route.fulfill({ json: { rooms: {} } });
      if (state.mode === "hold") { state.held.push(route); return; }
      return route.fulfill({ json: { rooms: [{ id: "room", name: state.name, updatedAt: 1, members: [] }] } });
    }
    if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
  });
  await page.goto("https://room-sidebar.test/");
  await page.waitForFunction(locale => document.documentElement.lang === locale, locale);
  const section = page.getByRole("region", { name: locale === "en" ? "Groups" : "群聊", exact: true });
  const alert = section.getByRole("alert");
  const retry = () => section.getByRole("button", { name: locale === "en" ? "Retry" : "重试", exact: true });
  const refresh = () => page.getByRole("button", { name: "Refresh fixture", exact: true }).click();
  return { page, state, section, alert, retry, refresh };
}

for (const locale of ["en", "zh-CN"]) {
  test(`group sidebar recovers from failures and isolates creation errors (${locale})`, { timeout: 90000 }, async () => {
    const { page, state, section, alert, retry, refresh } = await fixture(locale);
    try {
      await alert.waitFor();
      assert.match(await alert.innerText(), locale === "en" ? /Couldn’t refresh groups/ : /群聊加载失败/);
      assert.doesNotMatch(await section.innerText(), /TypeError|Failed to fetch|Internal fixture/);
      assert.equal(await section.getByRole("button", { name: locale === "en" ? "Build a team and get work done" : "组建团队，一起完成工作" }).count(), 0);
      assert.ok(state.logs.some(message => message.includes("GET /api/rooms")));
      assert.deepEqual(await page.evaluate(() => window.events), { restored: 0, done: 0, selected: 0 });
      await page.getByLabel("Chat draft").fill("Keep my draft");
      state.mode = "hold";
      await retry().click();
      const retrying = section.getByRole("button", { name: locale === "en" ? "Retrying…" : "正在重试…", exact: true });
      await retrying.waitFor();
      assert.equal(await retrying.isDisabled(), true);
      await page.clock.runFor(5000);
      assert.equal(state.requests, 2, "polling does not overlap a manual retry");
      state.mode = "ok";
      await state.held.shift().fulfill({ json: { rooms: [{ id: "room", name: state.name, updatedAt: 1, members: [] }] } });
      await alert.waitFor({ state: "detached" });
      await section.getByRole("button", { name: /Existing group/ }).first().click();
      assert.deepEqual(await page.evaluate(() => window.events), { restored: 1, done: 1, selected: 1 });
      assert.equal(await page.getByLabel("Chat draft").inputValue(), "Keep my draft");

      for (const mode of ["http", "json", "shape"]) {
        state.mode = mode; await refresh(); await alert.waitFor();
        assert.equal(await section.getByRole("button", { name: /Existing group/ }).first().isVisible(), true, "failures retain cached groups");
        assert.doesNotMatch(await alert.innerText(), /Internal fixture|JSON|TypeError/);
        state.mode = "ok"; await retry().click(); await alert.waitFor({ state: "detached" });
      }

      state.mode = "network"; await refresh(); await alert.waitFor();
      const toggle = section.locator("button[aria-expanded]");
      await toggle.click(); assert.equal(await alert.count(), 0, "collapsed groups hide the failure too");
      await toggle.click(); await alert.waitFor();
      if (process.env.PIORA_BROWSER_EVIDENCE_DIR) {
        await mkdir(process.env.PIORA_BROWSER_EVIDENCE_DIR, { recursive: true });
        await section.screenshot({ path: path.join(process.env.PIORA_BROWSER_EVIDENCE_DIR, `room-sidebar-${locale}.png`) });
      }
      await section.getByRole("button", { name: locale === "en" ? "Dismiss group loading notice" : "关闭群聊加载提示", exact: true }).click();
      await page.clock.runFor(5000);
      assert.equal(await alert.count(), 0, "repeated failure does not reopen a dismissed notice");
      state.mode = "ok"; state.name = "Recovered automatically";
      await page.clock.runFor(5000);
      await section.getByRole("button", { name: /Recovered automatically/ }).first().waitFor();
      state.mode = "network"; await refresh(); await alert.waitFor();
      state.mode = "ok";
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await alert.waitFor({ state: "detached" });

      state.mode = "network"; await refresh(); await alert.waitFor();
      await section.getByRole("button", { name: locale === "en" ? "New group" : "新建群聊", exact: true }).click();
      const dialog = page.getByRole("dialog");
      assert.equal(await dialog.getByRole("alert").count(), 0, "list failures must not become creation errors");
      await dialog.getByRole("button", { name: locale === "en" ? "Create group" : "创建群聊", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "Creation fixture rejected" }).waitFor();
      state.mode = "ok";
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.clock.runFor(5000);
      assert.equal(await dialog.getByRole("alert").innerText(), "Creation fixture rejected", "successful polling does not clear creation errors");
      await dialog.getByRole("button", { name: locale === "en" ? "Cancel" : "取消", exact: true }).click();
      assert.equal(await alert.count(), 0, "creation errors stay inside their dialog");
      assert.deepEqual(state.errors, []);
    } finally { await page.close(); }
  });
}

test("group refresh cancels superseded requests and releases a timed-out retry", { timeout: 90000 }, async () => {
  const { page, state, section, alert, retry, refresh } = await fixture("en", "hold");
  try {
    await section.getByRole("status").waitFor();
    await page.clock.runFor(15000);
    await alert.waitFor();
    assert.ok(state.logs.some(message => message.includes("GET /api/rooms")));
    state.mode = "ok"; await retry().click(); await alert.waitFor({ state: "detached" });
    await section.getByRole("button", { name: /Existing group/ }).first().waitFor();
    state.mode = "hold"; await refresh();
    state.mode = "ok"; state.name = "Newest group"; await refresh();
    await section.getByRole("button", { name: /Newest group/ }).first().waitFor();
    for (const route of state.held.splice(0)) await route.fulfill({ json: { rooms: [{ id: "old", name: "Stale group", updatedAt: 0 }] } }).catch(() => {});
    await page.clock.runFor(1);
    assert.equal(await section.getByRole("button", { name: /Stale group/ }).count(), 0);
    state.mode = "hold"; await refresh();
    await page.getByRole("button", { name: "Toggle fixture" }).click();
    const before = state.requests;
    await page.clock.runFor(20000);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    assert.equal(state.requests, before, "unmount removes polling and recovery listeners");
    assert.ok(state.aborted >= 3, "timeouts, replacement and unmount abort their network request");
    assert.deepEqual(state.errors, []);
  } finally { await page.close(); }
});
