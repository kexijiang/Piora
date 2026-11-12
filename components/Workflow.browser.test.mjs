import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

for (const locale of ["zh-CN", "en-US"]) {
test(`workflow UI preserves revisions, switches sessions, reviews plans and changes budgets without resuming (${locale})`, { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-workflow-ui-"));
  let browser;
  let page;
  const transport = [], browserMessages = [];
  const held = [];
  const laboratorySaveRecovery = Promise.withResolvers();
  try {
    await writeFile(path.join(directory, "ts.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=function(s){
      const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_')+'_';
      const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));
      const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,name)=>'.'+names[name]);
      const inject=this.resourcePath.includes('Workflow')?'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.appendChild(style);':'';
      return inject+'export default '+JSON.stringify(names);
    }`);
    await writeFile(path.join(directory, "markdown.tsx"), 'import React from "react";export const MarkdownBody=({children})=><div>{children}</div>;');
    await writeFile(path.join(directory, "entry.tsx"), `
import React from 'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from'@/hooks/useI18n';import{useWorkflow}from'@/hooks/useWorkflow';
import{WorkflowPanel}from'@/components/WorkflowPanel';import{WorkflowModePicker}from'@/components/WorkflowModePicker';
import{LaboratorySettings}from'@/components/LaboratorySettings';import{useLaboratorySettings}from'@/hooks/useLaboratorySettings';
function App(){const[sid,setSid]=React.useState('one'),[choice,setChoice]=React.useState({mode:'agent',turnBudget:10});
const lab=useLaboratorySettings();window.lab=lab;
React.useEffect(()=>{(window.laboratoryTrace??=[]).push({ready:lab.ready,error:lab.error,saving:lab.saving})},[lab.ready,lab.error,lab.saving]);
const execute=React.useCallback(async action=>{const res=await fetch('/api/agent/'+sid+'/workflow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});const data=await res.json();if(!res.ok)throw new Error(data.error);return data.snapshot},[sid]);
const state=useWorkflow(sid,true,false,execute);window.state=state;
return <><LaboratorySettings/><output id="lab-state">{String(lab.planGoalEnabled)}</output><button id="switch" onClick={()=>setSid(sid==='one'?'two':'one')}>Switch chat</button><button id="refresh" onClick={()=>state.refresh()}>Refresh</button>
{lab.planGoalEnabled&&<WorkflowModePicker value={choice} onChange={setChoice}/>}<output id="choice">{JSON.stringify(choice)}</output>
<div id="workflow-area" style={{position:'fixed',bottom:60,left:16,right:16}}><WorkflowPanel snapshot={state.snapshot} busy={state.busy} running={false} enabled={lab.planGoalEnabled} error={state.error} onAction={state.act} onRefresh={state.refresh}/><textarea aria-label="Message" id="composer" style={{width:'100%',height:40,boxSizing:'border-box'}}/></div></>}
createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/MarkdownBody$/, path.join(directory, "markdown.tsx"))],
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "ts.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    page = await browser.newPage({ locale, hasTouch: true, viewport: { width: 390, height: 800 } });
    page.on("console", message => { if (message.type() === "warning" || message.type() === "error") browserMessages.push({ type: message.type(), text: message.text() }); });
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith(".js") || pathname === "/api/settings/laboratory") transport.push({ event: "request", path: pathname, method: request.method(), retry: request.headers()["x-piora-fixture-retry"] ?? null });
    });
    page.on("response", response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.endsWith(".js") || pathname === "/api/settings/laboratory") transport.push({ event: "response", path: pathname, status: response.status(), retry: response.request().headers()["x-piora-fixture-retry"] ?? null });
    });
    const clockStart = new Date("2026-11-11T00:00:00Z");
    await page.clock.install({ time: clockStart });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const run = { id: "plan-one", kind: "plan", status: "awaiting_approval", objective: "Review before editing", title: "Plan proposal", markdown: "# Implementation\n1. Inspect\n2. Verify", criteria: [], progress: "", reason: "", turnBudget: 10, turnsUsed: 1, version: 1, createdAt: 1, updatedAt: 1, noProgressTurns: 0 };
    const states = {
      one: { sessionId: "one", revision: 1, mode: "plan", turnBudget: 10, current: run, history: [] },
      two: { sessionId: "two", revision: 1, mode: "goal", turnBudget: 2, current: { ...run, id: "goal-two", kind: "goal", title: "Goal objective", objective: "Complete the checks", status: "budget_exhausted", markdown: "", turnBudget: 2, turnsUsed: 2, criteria: [{ id: "test", text: "Check passes", evidence: "node test: 1 passed", status: "verified" }] }, history: [] },
    };
    const actions = [];
    let holdNext = false;
    let laboratory = { planGoalEnabled: false };
    let holdLaboratoryRead = false;
    let failLaboratoryRead = true;
    let failLaboratoryWrite = true;
    let laboratoryWriteFailed = false;
    let laboratoryReadCount = 0;
    let laboratoryRetryReadCount = 0;
    await page.route("http://127.0.0.1:38201/**", async route => {
      const url = new URL(route.request().url());
      // Locale imports are separate webpack chunks. Replaying the entry bundle
      // for them remounts React and resets the shared laboratory state.
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(url.pathname))) });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#fafafa;--bg-hover:#f1f1f1;--bg-selected:#eee;--border:#dedede;--text:#262626;--text-muted:#666;--text-dim:#a3a3a3;--accent:#2563eb;--text-xs:12px;--text-sm:14px}body{font-family:Arial,sans-serif;color:var(--text);line-height:1.5}</style><div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === "/api/settings/laboratory") {
        if (route.request().method() === "PUT") {
          if (failLaboratoryWrite) { failLaboratoryWrite = false; laboratoryWriteFailed = true; return route.fulfill({ status: 500, json: { error: "fixture save failed" } }); }
          laboratoryWriteFailed = false; laboratorySaveRecovery.resolve();
          laboratory = route.request().postDataJSON(); return route.fulfill({ json: laboratory });
        }
        laboratoryReadCount++;
        if (route.request().headers()["x-piora-fixture-retry"] === "true") {
          laboratoryRetryReadCount++;
          failLaboratoryRead = false;
        }
        if (failLaboratoryRead) return route.fulfill({ status: 503, json: { error: `fixture read failed ${laboratoryReadCount}` } });
        if (laboratoryWriteFailed) await laboratorySaveRecovery.promise;
        const captured = { ...laboratory };
        if (holdLaboratoryRead) { holdLaboratoryRead = false; await new Promise(resolve => held.push(resolve)); }
        return route.fulfill({ json: captured }).catch(() => {});
      }
      const sid = url.pathname.split("/")[3];
      if (!states[sid]) return route.fulfill({ status: 404, json: {} });
      if (route.request().method() === "POST") {
        const action = route.request().postDataJSON(); actions.push(action);
        assert.equal(action.runId, states[sid].current.id);
        assert.equal(action.expectedRevision, states[sid].revision);
        const state = states[sid];
        state.revision++;
        if (action.action === "revise") { state.history.push({ ...state.current }); state.current = { ...state.current, status: "planning", version: 2 }; }
        if (action.action === "set_budget") { state.turnBudget = action.turnBudget; state.current.turnBudget = action.turnBudget; }
        if (action.action === "resume") state.current.status = "running";
        if (action.action === "pause") state.current.status = "paused";
        if (action.action === "cancel") state.current.status = "cancelled";
        return route.fulfill({ json: { snapshot: state } });
      }
      const captured = structuredClone(states[sid]);
      if (holdNext) { holdNext = false; await new Promise(resolve => held.push(resolve)); }
      return route.fulfill({ json: captured }).catch(() => {});
    });
    await page.goto("http://127.0.0.1:38201");
    const expectedLanguage = locale === "en-US" ? "en" : "zh-CN";
    await page.waitForFunction(language => document.documentElement.lang === language, expectedLanguage);
    assert.equal(await page.locator("html").getAttribute("lang"), expectedLanguage);
    if (locale === "en-US") assert.ok(transport.some(event => event.event === "response" && event.path !== "/bundle.js" && /messages_en.*\.js$/.test(event.path) && event.status === 200), "English must load its real locale chunk rather than silently fall back");
    await page.getByTestId("workflow-peek-toggle").waitFor();
    await page.waitForFunction(() => Boolean(window.lab.error));
    assert.equal(await page.evaluate(() => window.lab.ready), false, "a failed first read must not confirm disabled settings");
    // Keep all reads failed until this boundary, including a real background
    // poll. Pausing timers does not suppress focus/online reconciliation.
    const failedPoll = page.waitForResponse(response => response.url().endsWith("/api/settings/laboratory") && response.status() === 503);
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 6_000));
    await (await failedPoll).finished();
    await page.waitForFunction(expected => window.lab.error === expected, `fixture read failed ${laboratoryReadCount}`);
    const retry = page.getByRole("button", { name: /重新加载|Retry loading/ });
    await page.bringToFront();
    await retry.focus();
    // Annotate only a GET synchronously started by the real, trusted Retry
    // click. The production handler and fetch still run normally; ambient
    // focus/visibility/online reads can never unlock this fixture response.
    await retry.evaluate(button => {
      const originalFetch = window.fetch;
      let inRetryClick = false;
      window.fixtureRetryClicks = 0;
      window.fixtureRetryButton = button;
      const beginClick = event => {
        if (!event.isTrusted || !button.contains(event.target)) return;
        inRetryClick = true;
        window.fixtureRetryClicks++;
      };
      const endClick = () => { inRetryClick = false; };
      document.addEventListener("click", beginClick, true);
      window.addEventListener("click", endClick);
      window.fetch = (input, init) => {
        if (inRetryClick && typeof input === "string" && new URL(input, location.href).pathname === "/api/settings/laboratory"
          && (init?.method ?? "GET") === "GET") {
          const headers = new Headers(init?.headers);
          headers.set("x-piora-fixture-retry", "true");
          init = { ...init, headers };
        }
        return originalFetch.call(window, input, init);
      };
      window.cleanupFixtureRetry = () => {
        window.fetch = originalFetch;
        document.removeEventListener("click", beginClick, true);
        window.removeEventListener("click", endClick);
      };
    });
    for (const type of ["focus", "visibilitychange", "online"]) {
      const failedReconcile = page.waitForResponse(response => response.url().endsWith("/api/settings/laboratory") && response.status() === 503);
      await page.evaluate(type => (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type)), type);
      await (await failedReconcile).finished();
      await page.waitForFunction(expected => window.lab.error === expected, `fixture read failed ${laboratoryReadCount}`);
      assert.equal(await page.evaluate(() => window.lab.ready), false, `${type} cannot preempt the explicit Retry`);
      assert.equal(await retry.count(), 1, `the Retry button survives ${type} before its click`);
      assert.equal(laboratoryRetryReadCount, 0);
    }
    const readsBeforeRetry = laboratoryReadCount;
    const retryResponse = page.waitForResponse(response => response.url().endsWith("/api/settings/laboratory")
      && response.request().headers()["x-piora-fixture-retry"] === "true" && response.status() === 200);
    await retry.click();
    await retryResponse;
    assert.equal(await page.evaluate(() => window.fixtureRetryClicks), 1, "one trusted Retry click reached the production handler");
    assert.equal(laboratoryRetryReadCount, 1, "the successful GET originated synchronously from that click");
    assert.equal(laboratoryReadCount, readsBeforeRetry + 1, "the explicit Retry click starts one new settings GET");
    await page.evaluate(() => window.cleanupFixtureRetry());
    await page.clock.resume();
    await page.waitForFunction(() => window.lab.ready);
    const preview = page.getByTestId("workflow-peek-content");
    const toggle = page.getByTestId("workflow-peek-toggle");
    const reveal = async () => { await toggle.hover(); await preview.waitFor({ state: "visible" }); };
    const screenshot = async name => {
      if (!process.env.PIORA_WORKFLOW_SCREENSHOTS) return;
      await mkdir(process.env.PIORA_WORKFLOW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PIORA_WORKFLOW_SCREENSHOTS, `${locale}-${name}.png`), animations: "disabled" });
    };
    assert.equal(await preview.isVisible(), false, "saved plans start as a single summary row");
    const collapsedComposer = await page.locator("#composer").boundingBox();
    assert.ok((await page.getByTestId("workflow-peek").boundingBox()).height <= 40);
    await screenshot("collapsed");
    await reveal();
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.deepEqual(await page.locator("#composer").boundingBox(), collapsedComposer, "preview overlays history without moving the composer");
    const expandedBox = await preview.boundingBox();
    assert.ok(expandedBox.y >= 0 && expandedBox.x >= 0 && expandedBox.x + expandedBox.width <= 390);
    await screenshot("expanded");
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: "hidden" });
    // Keyboard focus reveals the preview; Escape closes it and returns focus.
    await page.locator("#composer").focus();
    await page.keyboard.press("Shift+Tab");
    await preview.waitFor({ state: "visible" });
    await page.keyboard.press("Tab");
    assert.equal(await preview.evaluate(element => element.contains(document.activeElement)), true, "Tab enters the revealed details");
    await page.keyboard.press("Escape");
    await preview.waitFor({ state: "hidden" });
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
    // Clicking pins a preview for touch users or longer reviews.
    await toggle.click();
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: "visible" });
    await toggle.click();
    await preview.waitFor({ state: "hidden" });
    await page.mouse.move(0, 0);
    const touchTarget = await toggle.boundingBox();
    await page.touchscreen.tap(touchTarget.x + touchTarget.width / 2, touchTarget.y + touchTarget.height / 2);
    await preview.waitFor({ state: "visible" });
    await page.touchscreen.tap(touchTarget.x + touchTarget.width / 2, touchTarget.y + touchTarget.height / 2);
    await preview.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1100, height: 800 });
    await reveal();
    await screenshot("desktop-expanded");
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: 390, height: 800 });
    assert.equal(await page.getByTestId("workflow-mode-select").count(), 0);
    assert.equal(await page.getByTestId("workflow-plan-approve").isDisabled(), true);
    assert.equal(await page.getByTestId("workflow-plan-revise").isDisabled(), true);
    assert.equal(await page.getByTestId("workflow-plan-exit").isDisabled(), false);
    await page.getByTestId("laboratory-plan-goal-toggle").click();
    await page.waitForFunction(() => Boolean(window.lab.error));
    assert.equal(await page.getByTestId("laboratory-plan-goal-toggle").isChecked(), false, "failed saves cannot enable workflows locally");
    assert.equal(await page.getByTestId("workflow-mode-select").count(), 0);
    await page.getByTestId("laboratory-plan-goal-toggle").click();
    await page.waitForFunction(() => window.lab.planGoalEnabled);
    assert.equal(await page.locator("#lab-state").textContent(), "true", "separate subscribers update from the same confirmed server setting");
    await page.getByTestId("workflow-mode-goal").click();
    assert.equal(await page.getByTestId("workflow-mode-goal").getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("workflow-mode-agent").getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByTestId("workflow-mode-select").locator("svg").count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mode controls fit a narrow viewport");
    await screenshot("goal-mode");
    await page.getByTestId("workflow-budget-input").fill("7");
    assert.equal(await page.locator("#choice").textContent(), '{"mode":"goal","turnBudget":7}');
    await page.getByTestId("workflow-mode-plan").click();
    assert.equal(await page.getByTestId("workflow-budget-input").count(), 0);
    await page.setViewportSize({ width: 390, height: 480 });
    await page.locator("#composer").evaluate(element => { element.style.height = "220px"; });
    await reveal();
    assert.ok((await preview.boundingBox()).y >= 10, "preview stays within a short window above a tall composer");
    assert.ok(await preview.evaluate(element => element.scrollHeight > element.clientHeight), "long details remain scrollable within the available height");
    await page.mouse.move(0, 0);
    await page.locator("#composer").evaluate(element => { element.style.height = "40px"; });
    await page.setViewportSize({ width: 390, height: 800 });
    holdNext = true;
    await page.locator("#refresh").click();
    await page.waitForFunction(() => window.state.snapshot?.revision === 1);
    await reveal();
    await page.getByTestId("workflow-plan-revise").click();
    await page.waitForFunction(() => window.state.snapshot?.revision === 2);
    held.splice(0).forEach(resolve => resolve());
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "planning");
    await page.getByTestId("workflow-history").locator("summary").first().click();
    assert.equal(await page.getByTestId("workflow-history-entry").count(), 1);
    assert.equal(await page.getByTestId("workflow-history-entry").getAttribute("data-status"), "awaiting_approval");
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: "hidden" });
    holdNext = true;
    await page.locator("#refresh").click();
    await page.locator("#switch").click();
    await page.waitForFunction(() => window.state.snapshot?.sessionId === "two");
    held.splice(0).forEach(resolve => resolve());
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-run-id"), "goal-two");
    assert.equal(await preview.isVisible(), false, "switching chats resets the preview");
    await reveal();
    assert.equal(await page.getByTestId("workflow-goal-resume").isDisabled(), true);
    await page.getByTestId("workflow-run-budget-input").fill("4");
    await page.getByTestId("workflow-goal-set-budget").click();
    await page.waitForFunction(() => window.state.snapshot?.current.turnBudget === 4);
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "budget_exhausted");
    assert.equal(actions.some(action => action.action === "resume"), false);
    await page.getByTestId("workflow-goal-resume").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("workflow-goal-pause").waitFor();
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: "hidden" });
    await reveal();
    await page.getByTestId("workflow-goal-pause").click();
    await page.getByTestId("workflow-goal-resume").waitFor();
    holdLaboratoryRead = true;
    await page.evaluate(() => { void window.lab.refresh(); });
    await page.waitForTimeout(50);
    await page.getByTestId("laboratory-plan-goal-toggle").click();
    await page.waitForFunction(() => !window.lab.planGoalEnabled);
    held.splice(0).forEach(resolve => resolve());
    assert.equal(await page.getByTestId("workflow-mode-select").count(), 0);
    assert.equal(await page.getByTestId("workflow-goal-resume").isDisabled(), true);
    assert.equal(await page.getByTestId("workflow-goal-set-budget").isDisabled(), true);
    assert.equal(await page.getByTestId("workflow-goal-cancel").isDisabled(), false);
    assert.equal(await page.getByTestId("workflow-laboratory-disabled").count(), 1);
    await reveal();
    await page.getByTestId("workflow-goal-cancel").click();
    await page.waitForFunction(() => window.state.snapshot?.current.status === "cancelled");
    assert.deepEqual(actions.map(action => action.action), ["revise", "set_budget", "resume", "pause", "cancel"]);
    await page.reload();
    await page.getByTestId("workflow-peek-toggle").waitFor();
    await page.waitForFunction(() => window.lab.ready);
    assert.equal(await page.getByTestId("workflow-mode-select").count(), 0, "reload reads the disabled server setting");
    laboratory.planGoalEnabled = true;
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "piora-laboratory-settings-changed", newValue: "external-change" })));
    await page.getByTestId("workflow-mode-select").waitFor();
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "planning");
    await reveal();
    states.one.current = { ...states.one.current, id: "next-plan-in-same-chat" };
    states.one.revision++;
    await page.evaluate(() => window.state.refresh());
    await page.waitForFunction(() => window.state.snapshot?.current.id === "next-plan-in-same-chat");
    assert.equal(await preview.isVisible(), true, "a new run arriving under the stationary pointer preserves the hover preview");
    await page.mouse.move(0, 0);
    await preview.waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } catch (error) {
    const state = await page?.evaluate(() => ({
      language: navigator.language, ready: window.lab?.ready, error: window.lab?.error,
      retryClicks: window.fixtureRetryClicks ?? 0,
      retryCaptureButtonConnected: window.fixtureRetryButton?.isConnected ?? null,
      laboratoryTrace: window.laboratoryTrace?.slice(-20) ?? [],
      retryButtons: [...document.querySelectorAll("button")].filter(button => /^(重新加载|Retry loading)$/.test(button.textContent.trim())).length,
    })).catch(failure => ({ error: String(failure) }));
    t.diagnostic(JSON.stringify({ locale, retryRequests: transport.filter(event => event.event === "request" && event.retry === "true").length,
      transport: transport.slice(-60), browserMessages: { first: browserMessages.slice(0, 10), last: browserMessages.slice(-10) }, state }));
    throw error;
  } finally {
    laboratorySaveRecovery.resolve();
    held.splice(0).forEach(resolve => resolve());
    await browser?.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
}
