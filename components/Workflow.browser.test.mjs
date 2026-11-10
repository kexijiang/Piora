import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("workflow UI preserves revisions, switches sessions, reviews plans and changes budgets without resuming", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-workflow-ui-"));
  let browser;
  const held = [];
  try {
    await writeFile(path.join(directory, "ts.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "markdown.tsx"), 'import React from "react";export const MarkdownBody=({children})=><div>{children}</div>;');
    await writeFile(path.join(directory, "entry.tsx"), `
import React from 'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from'@/hooks/useI18n';import{useWorkflow}from'@/hooks/useWorkflow';
import{WorkflowPanel}from'@/components/WorkflowPanel';import{WorkflowModePicker}from'@/components/WorkflowModePicker';
import{LaboratorySettings}from'@/components/LaboratorySettings';import{useLaboratorySettings}from'@/hooks/useLaboratorySettings';
function App(){const[sid,setSid]=React.useState('one'),[choice,setChoice]=React.useState({mode:'agent',turnBudget:10});
const lab=useLaboratorySettings();window.lab=lab;
const execute=React.useCallback(async action=>{const res=await fetch('/api/agent/'+sid+'/workflow',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});const data=await res.json();if(!res.ok)throw new Error(data.error);return data.snapshot},[sid]);
const state=useWorkflow(sid,true,false,execute);window.state=state;
return <><LaboratorySettings/><output id="lab-state">{String(lab.planGoalEnabled)}</output><button id="switch" onClick={()=>setSid(sid==='one'?'two':'one')}>Switch chat</button><button id="refresh" onClick={()=>state.refresh()}>Refresh</button>
{lab.planGoalEnabled&&<WorkflowModePicker value={choice} onChange={setChoice}/>}<output id="choice">{JSON.stringify(choice)}</output>
<WorkflowPanel snapshot={state.snapshot} busy={state.busy} running={false} enabled={lab.planGoalEnabled} error={state.error} onAction={state.act} onRefresh={state.refresh}/></>}
createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/MarkdownBody$/, path.join(directory, "markdown.tsx"))],
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "ts.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
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
    await page.route("http://127.0.0.1:38201/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, "bundle.js")) });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === "/api/settings/laboratory") {
        if (route.request().method() === "PUT") {
          if (failLaboratoryWrite) { failLaboratoryWrite = false; return route.fulfill({ status: 500, json: { error: "fixture save failed" } }); }
          laboratory = route.request().postDataJSON(); return route.fulfill({ json: laboratory });
        }
        if (failLaboratoryRead) { failLaboratoryRead = false; return route.fulfill({ status: 503, json: { error: "fixture read failed" } }); }
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
    await page.getByTestId("workflow-panel").waitFor();
    await page.waitForFunction(() => Boolean(window.lab.error));
    assert.equal(await page.evaluate(() => window.lab.ready), false, "a failed first read must not confirm disabled settings");
    await page.getByRole("button", { name: /重新加载|Retry loading/ }).click();
    await page.waitForFunction(() => window.lab.ready);
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
    await page.getByTestId("workflow-mode-select").selectOption("goal");
    await page.getByTestId("workflow-budget-input").fill("7");
    assert.equal(await page.locator("#choice").textContent(), '{"mode":"goal","turnBudget":7}');
    await page.getByTestId("workflow-mode-select").selectOption("plan");
    assert.equal(await page.getByTestId("workflow-budget-input").count(), 0);
    holdNext = true;
    await page.locator("#refresh").click();
    await page.waitForFunction(() => window.state.snapshot?.revision === 1);
    await page.getByTestId("workflow-plan-revise").click();
    await page.waitForFunction(() => window.state.snapshot?.revision === 2);
    held.splice(0).forEach(resolve => resolve());
    await page.waitForTimeout(100);
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "planning");
    await page.getByTestId("workflow-history").locator("summary").first().click();
    assert.equal(await page.getByTestId("workflow-history-entry").count(), 1);
    assert.equal(await page.getByTestId("workflow-history-entry").getAttribute("data-status"), "awaiting_approval");
    holdNext = true;
    await page.locator("#refresh").click();
    await page.locator("#switch").click();
    await page.waitForFunction(() => window.state.snapshot?.sessionId === "two");
    held.splice(0).forEach(resolve => resolve());
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-run-id"), "goal-two");
    assert.equal(await page.getByTestId("workflow-goal-resume").isDisabled(), true);
    await page.getByTestId("workflow-run-budget-input").fill("4");
    await page.getByTestId("workflow-goal-set-budget").click();
    await page.waitForFunction(() => window.state.snapshot?.current.turnBudget === 4);
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "budget_exhausted");
    assert.equal(actions.some(action => action.action === "resume"), false);
    await page.getByTestId("workflow-goal-resume").click();
    await page.getByTestId("workflow-goal-pause").waitFor();
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
    await page.getByTestId("workflow-goal-cancel").click();
    await page.waitForFunction(() => window.state.snapshot?.current.status === "cancelled");
    assert.deepEqual(actions.map(action => action.action), ["revise", "set_budget", "resume", "pause", "cancel"]);
    await page.reload();
    await page.getByTestId("workflow-panel").waitFor();
    await page.waitForFunction(() => window.lab.ready);
    assert.equal(await page.getByTestId("workflow-mode-select").count(), 0, "reload reads the disabled server setting");
    laboratory.planGoalEnabled = true;
    await page.evaluate(() => window.dispatchEvent(new StorageEvent("storage", { key: "piora-laboratory-settings-changed", newValue: "external-change" })));
    await page.getByTestId("workflow-mode-select").waitFor();
    assert.equal(await page.getByTestId("workflow-panel").getAttribute("data-status"), "planning");
    assert.deepEqual(errors, []);
  } finally {
    held.splice(0).forEach(resolve => resolve());
    await browser?.close();
    assert.equal(path.dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
