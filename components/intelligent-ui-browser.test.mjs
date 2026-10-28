import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const surface = {
  version: 1, id: "shopping", revision: 1, title: "采购清单",
  nodes: [
    { id: "people", type: "slider", label: "人数", value: 2, min: 1, max: 20, step: 1 },
    { id: "price", type: "number", label: "单价", value: 3, min: 0, max: 100 },
    { id: "fruit", type: "select", label: "水果", value: "苹果", options: ["苹果", "梨"] },
    { id: "vegetarian", type: "checkbox", label: "包含素食", value: false },
    { id: "quantity", type: "metric", label: "数量", value: { op: "multiply", args: [{ ref: "people" }, 2] } },
    { id: "table", type: "table", columns: ["商品", "总价"], rows: [[{ ref: "fruit" }, { op: "multiply", args: [{ ref: "price" }, { ref: "people" }] }]] },
    { id: "chart", type: "barChart", labels: ["人数"], values: [{ ref: "people" }] },
    { id: "literal", type: "text", text: "<script>window.bad=true</script>" },
  ],
};

async function buildFixture(directory) {
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `
import React from "react";import {createRoot} from "react-dom/client";
import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
import Surface from ${JSON.stringify(path.join(repo, "components/intelligent-ui/IntelligentUiSurface.tsx"))};
import {MessageView} from ${JSON.stringify(path.join(repo, "components/MessageView.tsx"))};
import {buildCompactChatHistoryRows} from ${JSON.stringify(path.join(repo, "lib/compact-chat-history.ts"))};
import {flushPendingAnswerState} from ${JSON.stringify(path.join(repo, "lib/answer-output-client.ts"))};
window.flushAnswer=()=>flushPendingAnswerState("session-1");
const root=createRoot(document.getElementById("root"));
window.renderSurface=(show=true,payload=${JSON.stringify(surface)},branchKey="branch-a")=>root.render(<I18nProvider>{show?<Surface payload={payload} snapshot="Readable fallback" sessionId="session-1" toolCallId="tool-1" entryId="entry-1" branchKey={branchKey}/>:null}</I18nProvider>);
window.renderHistory=(hydrated=false)=>{
 const call={type:"toolCall",toolCallId:"tool-1",toolName:"piora_render_ui",input:{}};
 const message={role:"assistant",content:[call]};
 const result={role:"toolResult",toolCallId:"tool-1",content:[{type:"text",text:"Readable fallback"}],details:{answerOutput:{kind:"intelligent-ui",version:1,snapshot:"Readable fallback",payload:${JSON.stringify(surface)}}}};
 const entries=hydrated?["assistant-entry"]:[];
 const rows=buildCompactChatHistoryRows([message,result],entries,!hydrated,new Map(),hydrated?-1:0).rows;
 root.render(<I18nProvider><div>{rows.filter(row=>row.message).map(row=><MessageView key={row.key} message={row.message} toolResults={new Map([["tool-1",result]])} sessionId="session-1" entryId={entries[row.index]} isStreaming={!hydrated}/>)}</div></I18nProvider>);
};
localStorage.setItem("pi-locale",new URLSearchParams(location.search).get("locale")||"zh-CN");window.renderSurface();`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const globals = await readFile(path.join(repo, "app/globals.css"), "utf8");
  const light = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  const dark = globals.match(/html\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(light && dark);
  return { bundle: await readFile(path.join(directory, "bundle.js")), css: `:root{${light}}:root.dark{${dark}}*{box-sizing:border-box}html{font-size:var(--ui-font-size)}body{margin:0;background:var(--bg);font-family:system-ui;font-size:var(--text-base)}` + await readFile(path.join(repo, "components/intelligent-ui/IntelligentUiSurface.module.css"), "utf8") };
}

test("Intelligent UI calculates locally, persists edits, survives remount, and surfaces save conflicts", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-intelligent-ui-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let revision = 0, state = { people: 2, price: 3, fruit: "苹果", vegetarian: false }, leafId = "leaf-1", failSave = false, conflict = false, writes = 0, requests = 0;
    await page.route("https://intelligent-ui.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: true } });
      if (url.pathname.startsWith("/api/")) {
        requests++;
        if (route.request().method() === "PUT") {
          writes++;
          if (failSave) return route.fulfill({ status: 503, json: { error: "unavailable" } });
          if (conflict) { conflict = false; revision++; state = { ...state, people: 9 }; return route.fulfill({ status: 409, json: { error: "conflict" } }); }
          const body = route.request().postDataJSON();
          assert.equal(body.expectedRevision, revision);
          assert.equal(body.toolCallId, "tool-1");
          state = body.state; revision++;
        }
        return route.fulfill({ json: { surface, state, revision, leafId, snapshot: "saved" } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://intelligent-ui.test/");
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    const readyMs = await page.evaluate(() => performance.now());
    const slider = page.getByRole("slider", { name: "人数" });
    await slider.evaluate(input => {
      let started;
      input.addEventListener("input", () => { started = performance.now(); }, { once: true });
      const observer = new MutationObserver(() => { if (started !== undefined) { window.localCalcMs = performance.now() - started; observer.disconnect(); } });
      observer.observe(document.querySelector(".metric output"), { childList: true, characterData: true, subtree: true });
    });
    await slider.focus(); await slider.press("ArrowRight");
    await page.evaluate(() => window.flushAnswer());
    assert.equal(state.people, 3);
    assert.equal(await page.locator(".metric output").textContent(), "6");
    assert.equal(await slider.evaluate(node => document.activeElement === node), true, "saving must preserve focus");
    const localCalcMs = await page.evaluate(() => window.localCalcMs);
    assert.ok(Number.isFinite(localCalcMs));
    t.diagnostic(`Fixture timings (mock API; no model latency): first usable control ${readyMs.toFixed(1)} ms; input to updated metric ${localCalcMs.toFixed(1)} ms`);
    await page.getByRole("combobox", { name: "水果" }).selectOption("梨");
    await page.getByLabel("包含素食").check();
    await page.getByRole("spinbutton", { name: "单价" }).fill("5");
    await page.evaluate(() => window.flushAnswer());
    assert.equal(state.price, 5); assert.equal(state.fruit, "梨"); assert.equal(state.vegetarian, true);
    assert.equal(await page.getByRole("cell", { name: "15", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => window.bad), undefined, "model text must never execute");
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "narrow layout must stay in viewport");
      if (process.env.PIORA_UI_SCREENSHOTS) {
        await mkdir(process.env.PIORA_UI_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PIORA_UI_SCREENSHOTS, `intelligent-ui-${dark ? "dark" : "light"}.png`), fullPage: true });
      }
    }
    const metricSize = await page.locator(".metric output").evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = "22px"; });
    assert.ok(await page.locator(".metric output").evaluate(node => parseFloat(getComputedStyle(node).fontSize)) > metricSize, "metrics follow the user's font scale");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "larger text stays within the narrow viewport");
    await page.evaluate(() => { document.documentElement.style.removeProperty("font-size"); });
    await page.evaluate(() => window.renderSurface(false));
    await page.evaluate(() => window.renderSurface());
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(await slider.inputValue(), "3");
    await page.reload(); await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(await slider.inputValue(), "3");
    failSave = true;
    await slider.focus(); await slider.press("ArrowRight");
    await page.getByText("参数加载或保存失败，本地调整已保留。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => false, () => true)), true, "failed persistence blocks stale followup");
    failSave = false;
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(state.people, 4);
    conflict = true;
    await slider.focus(); await slider.press("ArrowRight");
    await page.getByRole("button", { name: "加载已保存参数" }).waitFor();
    assert.equal(await slider.inputValue(), "5", "conflict keeps local edits until explicit choice");
    await page.getByRole("button", { name: "加载已保存参数" }).click();
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(await slider.inputValue(), "9");
    state = { ...state, people: 11 }; leafId = "branch-b-leaf";
    await page.evaluate(() => window.renderSurface(true, undefined, "branch-b"));
    await page.waitForFunction(() => document.querySelector('input[type="range"]').value === "11");
    assert.equal(await slider.inputValue(), "11", "common ancestor row revalidates when the selected branch changes");
    assert.ok(writes > 4 && requests < 30, "local rendering must not request model data");
    await page.goto("https://intelligent-ui.test/?locale=en");
    await page.getByText("Saved · available to your next message", { exact: true }).waitFor();
    await page.evaluate(() => window.renderHistory(false));
    await page.getByText("Saved · available to your next message", { exact: true }).waitFor();
    const focused = page.getByRole("spinbutton", { name: "单价" });
    await focused.focus();
    await focused.evaluate(node => { window.focusedBeforeHydration = node; });
    await page.evaluate(() => window.renderHistory(true));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await focused.evaluate(node => node === window.focusedBeforeHydration), true, "history row/group/block must retain the exact input DOM node after entry hydration");
    assert.equal(await focused.evaluate(node => document.activeElement === node), true, "late durable entry IDs must not steal focus");
    assert.equal(await focused.inputValue(), String(state.price));
    await page.evaluate(() => window.renderSurface(true, { version: 999 }));
    await page.getByText("Readable fallback", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-intelligent-ui-"));
    await rm(directory, { recursive: true, force: true });
  }
});
