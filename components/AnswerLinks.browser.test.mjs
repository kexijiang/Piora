import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const storageKey = "piora-answer-link-target:v1";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("answer links open new built-in tabs, preserve browser state, and honor persistent destination settings", { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-answer-links-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(root, "entry.tsx"), `
import {useState,useCallback} from 'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from'@/hooks/useI18n';import{useAnswerLinkNavigation}from'@/hooks/useAnswerLinkNavigation';
import{AnswerLinkProvider}from'@/components/AnswerLinkProvider';import{AnswerLinkSettings}from'@/components/AnswerLinkSettings';
import{MarkdownBody}from'@/components/MarkdownBody';import{BrowserPanel}from'@/components/workspace/BrowserPanel';
function Harness(){const[open,setOpen]=useState(false);const[session,setSession]=useState('first');
const show=useCallback(()=>{setTimeout(()=>setOpen(true),250)},[]);const navigation=useAnswerLinkNavigation(session,show);
return <I18nProvider><AnswerLinkProvider openLink={navigation.openLink}><main><AnswerLinkSettings/>
<button onClick={()=>setSession(s=>s==='first'?'second':'first')}>Switch session</button><output>{session}</output>
<button onClick={()=>setOpen(v=>!v)}>Toggle browser</button>
<div id="answer"><MarkdownBody className="markdown-assistant-message" cwd="C:/fixture" onOpenFile={p=>window.openedFiles.push(p)}>{'[Docs A](https://docs.example.test/a) · [Docs B](https://docs.example.test/b) · [Local file](./README.md) · [Email](mailto:team@example.test)'}</MarkdownBody></div>
<div id="other"><MarkdownBody>{'[Other link](https://docs.example.test/other)'}</MarkdownBody></div>
{open?<section id="browser"><BrowserPanel active maximized={false} sessionId={session} navigationRequest={navigation.request} onNavigationConsumed={navigation.consume}/></section>:null}
</main></AnswerLinkProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<Harness/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://answer-links.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const html = `<!doctype html><style>:root{--bg:#fff;--bg-panel:#fafafa;--bg-hover:#eee;--border:#ddd;--text:#222;--text-dim:#555;--text-muted:#666;--accent:#2864dc;--text-xs:11px;--text-sm:13px;--text-base:14px;--radius-control:6px}*{box-sizing:border-box}body{margin:0;font:14px system-ui}main{padding:16px;max-width:1000px}#browser{height:440px;border:1px solid #ccc;margin-top:12px}a{margin-right:16px}button{cursor:pointer}</style><div id="root"></div><script src="/bundle.js"></script>`;
    browser = await chromium.launch({ channel: "msedge", headless: true });

    for (const mode of ["desktop", "desktop-playwright", "web"]) for (const locale of ["en", "zh-CN"]) {
      t.diagnostic(`${mode}/${locale}`);
      const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => { errors.push(error.message); t.diagnostic(error.message); });
      const requests = [];
      const webState = { ready: true, revision: 1, title: "Keep original", url: "https://keep.example.test/original", viewport: { width: 1280, height: 800 }, cursor: "default", activeTabIndex: 0, tabs: [{ index: 0, title: "Keep original", url: "https://keep.example.test/original" }] };
      await context.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== "answer-links.test") return route.fulfill({ contentType: "text/html", body: "External destination fixture" });
        if (url.pathname === "/api/browser") {
          const input = route.request().postDataJSON(); requests.push({ method: route.request().method(), url: url.href, input });
          if (input?.action === "new_tab") {
            const index = webState.tabs.length; webState.tabs.push({ index, title: input.url, url: input.url });
            Object.assign(webState, { activeTabIndex: index, url: input.url, title: input.url, revision: webState.revision + 1 });
          }
          return route.fulfill({ json: webState });
        }
        if (url.pathname === "/api/browser/screenshot") return route.fulfill({ contentType: "image/png", body: png });
        if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
      });
      await page.addInitScript(({ mode, locale }) => {
        localStorage.setItem("pi-locale", locale);
        localStorage.setItem("piora-browser-follow-agent-v1", "true");
        localStorage.setItem("piora-desktop-browser-onboarding-v1", "done");
        window.openedFiles = []; window.nativeActions = [];
        if (mode === "web") return;
        let currentSession = "first";
        const makeState = sessionId => ({ sessionId, activeTabId: "original", url: "https://keep.example.test/original", title: "Keep original", tabs: [{ id: "original", title: "Keep original", url: "https://keep.example.test/original" }], canGoBack: false, canGoForward: false, loading: false });
        window.nativeStates = { first: makeState("first"), second: makeState("second") };
        window.piDesktop = { browser: {
          getAgentBackend: async () => mode === "desktop" ? "desktop" : "playwright",
          onAgentBackend: () => () => {},
          setViewport: async () => {},
          action: async input => {
            window.nativeActions.push({ ...input, displayedSession: currentSession });
            if (input.action === "set_session") { await new Promise(resolve => setTimeout(resolve, 180)); currentSession = input.sessionId; }
            const state = window.nativeStates[currentSession];
            if (input.action === "new_tab") {
              if (window.failNextTab) { window.failNextTab = false; throw new Error("Tab limit reached (fixture)"); }
              const tab = { id: String(state.tabs.length), title: input.url, url: input.url }; state.tabs.push(tab);
              Object.assign(state, { activeTabId: tab.id, url: tab.url, title: tab.title });
            }
            return structuredClone(state);
          },
          getState: async () => structuredClone(window.nativeStates[currentSession]),
          onState: listener => { window.nativeStateListener = listener; return () => {}; }, onDownload: () => () => {},
          onAgentActivity: listener => { window.agentActivityListener = listener; return () => {}; },
          importChromeBookmarks: async () => ({ bookmarkCount: 0, profiles: [] }), showBookmarkMenu: async () => null,
        } };
      }, { mode, locale });
      await page.goto("http://answer-links.test/");
      const builtin = page.getByRole("button", { name: locale === "en" ? "Built-in browser" : "内置浏览器", exact: true });
      const system = page.getByRole("button", { name: locale === "en" ? "System browser" : "系统浏览器", exact: true });
      const linkA = page.getByRole("link", { name: "Docs A", exact: true });
      const linkB = page.getByRole("link", { name: "Docs B", exact: true });
      const opens = async () => mode === "web" ? requests.filter(r => r.input?.action === "new_tab").map(r => r.input) : page.evaluate(() => window.nativeActions.filter(a => a.action === "new_tab"));
      const waitCount = async count => {
        if (mode === "web") { for (let n = 0; n < 100 && (await opens()).length < count; n++) await page.waitForTimeout(30); }
        else await page.waitForFunction(count => window.nativeActions.filter(a => a.action === "new_tab").length >= count, count);
        assert.equal((await opens()).length, count);
      };
      const external = async (link, options = {}) => { const popup = page.waitForEvent("popup"); await link.click(options); const opened = await popup; await opened.waitForLoadState(); assert.equal(new URL(opened.url()).hostname, "docs.example.test"); await opened.close(); };
      assert.equal(await builtin.getAttribute("aria-pressed"), "true");
      // Queue two real clicks before either lazy panel or native session is ready.
      await linkA.click(); await linkB.click(); await waitCount(2);
      assert.deepEqual((await opens()).map(a => a.url), ["https://docs.example.test/a", "https://docs.example.test/b"]);
      if (mode === "web") {
        assert.equal(webState.tabs[0].url, "https://keep.example.test/original");
        assert.equal(requests.filter(r => r.input).some(r => r.input.action === "navigate"), false);
        assert.equal(requests.some(r => r.method === "POST" && new URL(r.url).searchParams.has("sessionId")), false);
      } else {
        assert.equal(await page.evaluate(() => window.nativeStates.first.tabs[0].url), "https://keep.example.test/original");
        assert.ok((await opens()).every(a => a.displayedSession === "first"));
        assert.equal(requests.filter(r => r.input).length, 0);
      }
      // Returning from follow mode must remain on the explicit new manual tab.
      if (mode !== "desktop") assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "false");
      await linkA.focus(); await page.keyboard.press("Enter"); await waitCount(3);
      await linkB.click({ button: "middle" }); await waitCount(4);
      for (const modifier of ["Control", "Meta", "Shift"]) { t.diagnostic(`external ${modifier}`); await external(linkA, { modifiers: [modifier] }); }
      assert.equal((await opens()).length, 4);
      await page.getByRole("link", { name: "Local file" }).click();
      assert.deepEqual(await page.evaluate(() => window.openedFiles), ["C:/fixture/README.md"]);
      assert.equal(await page.getByRole("link", { name: "Email" }).getAttribute("href"), "mailto:team@example.test");
      await external(page.getByRole("link", { name: "Other link" }));
      await system.click(); await external(linkA);
      assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), "system");
      await linkB.click({ modifiers: ["Control"] }); await waitCount(5);
      await page.reload();
      assert.equal(await system.getAttribute("aria-pressed"), "true");
      await external(linkA);
      await builtin.click();
      // Switching tasks cancels clicks that have not reached a browser yet.
      await linkA.click(); await page.getByRole("button", { name: "Switch session" }).click();
      await page.waitForTimeout(600);
      const afterSwitch = (await opens()).length;
      if (mode !== "web") assert.equal(afterSwitch, 0, "a pending old-session link must not open in the new session");
      else assert.equal(afterSwitch, 5, "a pending old-session link must not open after navigation");
      await linkB.click(); await waitCount(afterSwitch + 1);
      if (mode !== "web") {
        assert.equal((await opens()).at(-1).displayedSession, "second");
        await page.evaluate(() => { window.failNextTab = true; }); await linkA.click();
        await page.getByRole("alert").filter({ hasText: "Tab limit reached" }).waitFor();
        const failedCount = (await opens()).length;
        await page.getByRole("button", { name: "Toggle browser" }).click(); await page.getByRole("button", { name: "Toggle browser" }).click();
        await page.waitForTimeout(400); assert.equal((await opens()).length, failedCount, "failed requests are not replayed on remount");
      }
      if (mode === "desktop" && locale === "zh-CN") {
        const out = path.join(repo, ".verification", "answer-links"); await mkdir(out, { recursive: true }); await page.screenshot({ path: path.join(out, "zh-CN.png"), fullPage: true });
      }
      // Blocked storage still allows changing this renderer's preference.
      await page.evaluate(key => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(k,v) { if(k===key) throw new Error("Storage denied"); return original.call(this,k,v); }; }, storageKey);
      await system.click(); assert.equal(await system.getAttribute("aria-pressed"), "true"); await external(linkA);
      await page.setViewportSize({ width: 390, height: 800 });
      assert.equal(await page.locator('[data-settings-id="conversation.answerLinks"]').evaluate(element => element.scrollWidth <= element.clientWidth), true, "destination settings fit narrow screens");
      assert.deepEqual(errors, [], `${mode}/${locale}`);
      await context.close();
    }
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
