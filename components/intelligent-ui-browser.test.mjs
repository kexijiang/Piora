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

async function buildFixture(directory, initialSurface = surface, initialEnvelopeVersion = 1) {
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
window.renderSurface=(show=true,payload=${JSON.stringify(initialSurface)},branchKey="branch-a",envelopeVersion=${initialEnvelopeVersion})=>root.render(<I18nProvider>{show?<Surface payload={payload} snapshot="Readable fallback" sessionId="session-1" toolCallId="tool-1" entryId="entry-1" branchKey={branchKey} envelopeVersion={envelopeVersion}/>:null}</I18nProvider>);
window.renderHistory=(hydrated=false,envelopeVersion=1)=>{
 const call={type:"toolCall",toolCallId:"tool-1",toolName:"piora_render_ui",input:{}};
 const message={role:"assistant",content:[call]};
 const result={role:"toolResult",toolCallId:"tool-1",content:[{type:"text",text:"Readable fallback"}],details:{answerOutput:{kind:"intelligent-ui",version:envelopeVersion,snapshot:"Readable fallback",payload:${JSON.stringify(surface)}}}};
 const entries=hydrated?["assistant-entry"]:[];
 const rows=buildCompactChatHistoryRows([message,result],entries,!hydrated,new Map(),hydrated?-1:0).rows;
 root.render(<I18nProvider><div>{rows.filter(row=>row.message).map(row=><MessageView key={row.key} message={row.message} toolResults={new Map([["tool-1",result]])} sessionId="session-1" entryId={entries[row.index]} isStreaming={!hydrated}/>)}</div></I18nProvider>);
};
const query=new URLSearchParams(location.search);
localStorage.setItem("pi-locale",query.get("locale")||"zh-CN");
if(query.get("mode")==="publication")window.renderHistory(true,2);else window.renderSurface();`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const globals = await readFile(path.join(repo, "app/globals.css"), "utf8");
  const light = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  const dark = globals.match(/html\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(light && dark);
  return { bundle: await readFile(path.join(directory, "bundle.js")), css: `:root{${light}}:root.dark{${dark}}*{box-sizing:border-box}html{font-size:var(--ui-font-size)}body{margin:0;background:var(--bg);font-family:system-ui;font-size:var(--text-base)}` + await readFile(path.join(repo, "components/intelligent-ui/IntelligentUiSurface.module.css"), "utf8") + await readFile(path.join(repo, "components/intelligent-ui/RichSurfaceLayout.module.css"), "utf8") };
}

test("Intelligent UI calculates locally, persists edits, survives remount, and surfaces save conflicts", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-intelligent-ui-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
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
    assert.equal(await page.getByRole("status", { name: "数量", exact: true }).textContent(), "6", "metric values retain their accessible labels after editing");
    assert.equal(await page.getByRole("status", { name: "人数", exact: true }).textContent(), "3", "chart outputs expose the corresponding row label");
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

test("v2 previews await publication and superseded local drafts remain recoverable without repeated writes or blocked followups", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-intelligent-ui-publication-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let publication = { status: "candidate", operationId: "generation-1" };
    let featureEnabled = true, rejectSave = false, reads = 0, writes = 0, revision = 0;
    let state = { people: 2, price: 3, fruit: "苹果", vegetarian: false };
    await page.route("https://intelligent-ui.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: featureEnabled } });
      if (url.pathname.endsWith("/answer-output")) return route.fulfill({ json: { snapshot: "Server-saved parameters" } });
      if (url.pathname.endsWith("/intelligent-ui")) {
        if (route.request().method() === "PUT") {
          writes++;
          if (rejectSave) {
            publication = { status: "superseded", operationId: "generation-1", currentToolCallId: "tool-2" };
            return route.fulfill({ status: 409, json: { error: "A newer committed output is active" } });
          }
          assert.equal(publication.status, "committed", "candidate or replaced outputs must never submit changes");
          const body = route.request().postDataJSON();
          assert.equal(body.toolCallId, "tool-1");
          assert.equal(body.expectedRevision, revision);
          state = body.state; revision++;
        } else { reads++; }
        return route.fulfill({ json: { surface, state, revision, leafId: "published-leaf", publication, snapshot: "Saved original parameters" } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });

    // Enter through the durable history envelope so v2 gating is covered as
    // well as the feature renderer; the payload is still a v1 Surface.
    await page.goto("https://intelligent-ui.test/?mode=publication");
    await page.getByText("预览 · 正在等待发布确认", { exact: true }).waitFor();
    const slider = page.getByRole("slider", { name: "人数" });
    assert.equal(await slider.isDisabled(), true);
    assert.equal(await page.getByRole("spinbutton", { name: "单价" }).isDisabled(), true);
    assert.equal(await page.getByRole("combobox", { name: "水果" }).isDisabled(), true);
    assert.equal(await page.getByLabel("包含素食").isDisabled(), true);
    assert.equal(writes, 0);
    const candidateReads = reads;
    publication = { status: "committed", operationId: "generation-1" };
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor({ timeout: 15000 });
    assert.ok(reads > candidateReads && reads < 12, "publication is refreshed without requiring a remount or excessive polling");
    assert.equal(await slider.isEnabled(), true);

    rejectSave = true;
    await slider.focus(); await slider.press("ArrowRight");
    const retain = page.getByRole("button", { name: "保留旧稿并使用已保存参数", exact: true });
    await retain.waitFor();
    await page.getByText(/已有新版本/).waitFor();
    assert.equal(await slider.inputValue(), "3", "publication conflict must retain the unacknowledged local edit");
    assert.equal(await slider.isDisabled(), true, "the superseded structure cannot accept further edits");
    assert.equal(state.people, 2, "the rejected edit never reached the server");
    assert.equal(writes, 1);
    const draft = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("piora-ui-pending:")));
    assert.ok(draft, "a rejected change must remain in the local recovery journal");
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => false, () => true)), true);
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => false, () => true)), true);
    assert.equal(writes, 1, "dependent sends must not repeatedly PUT the replaced tool call");

    // Archiving is an explicit durability boundary. A failed local write must
    // keep both the original draft and its dependent-send registration.
    await page.evaluate(() => {
      window.originalStorageWrite = Storage.prototype.setItem;
      window.retentionWriteAttempts = 0;
      Storage.prototype.setItem = function() { window.retentionWriteAttempts++; throw new DOMException("Storage full", "QuotaExceededError"); };
    });
    await retain.click();
    await page.waitForFunction(() => window.retentionWriteAttempts > 0);
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => false, () => true)), true);
    assert.equal(await page.evaluate(key => localStorage.getItem(key), draft[0]), draft[1]);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalStorageWrite; });

    await retain.click();
    const retainedSummary = page.locator("summary", { hasText: "查看保留的旧稿" });
    await retainedSummary.waitFor();
    await page.waitForFunction(key => localStorage.getItem(key) === null, draft[0]);
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => true, () => false)), true, "confirmed retention unblocks followups using server-saved values");
    assert.equal(writes, 1);
    await retainedSummary.click();
    assert.match(await page.locator(".surface details").textContent(), /人数:\s*3/, "the retained record exposes the original values for recovery");
    await page.reload();
    await retainedSummary.waitFor();
    await retainedSummary.click();
    assert.match(await page.locator(".surface details").textContent(), /人数:\s*3/, "retention survives a fresh client runtime");
    assert.equal(await slider.isDisabled(), true);
    assert.equal(await page.evaluate(() => window.flushAnswer().then(() => true, () => false)), true);
    assert.equal(writes, 1, "reloading an archived superseded draft cannot auto-save it");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const readsBeforeDisabled = reads;
    featureEnabled = false;
    await page.reload();
    await page.getByText("Server-saved parameters", { exact: true }).waitFor();
    assert.equal(await page.getByRole("slider").count(), 0);
    assert.equal(await page.locator(".surface").count(), 0);
    assert.equal(reads, readsBeforeDisabled, "the disabled feature must not activate its state reader");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-intelligent-ui-publication-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("two windows retain independent drafts through supersession and offline reload, and recovery requires an explicit choice", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-intelligent-ui-windows-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const pageA = await context.newPage(), pageB = await context.newPage();
    const errors = [];
    let publication = { status: "committed", operationId: "generation-windows" };
    let failReadB = false, writes = 0;
    const state = { people: 2, price: 3, fruit: "苹果", vegetarian: false };
    const attach = async page => {
      page.on("pageerror", error => errors.push(error.message));
      await page.route("https://intelligent-ui.test/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
        if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: true } });
        if (url.pathname.endsWith("/intelligent-ui")) {
          if (route.request().method() === "PUT") {
            writes++;
            return route.fulfill({ status: 503, json: { error: "Unacknowledged draft" } });
          }
          if (page === pageB && failReadB) return route.fulfill({ status: 503, json: { error: "Offline state reader" } });
          return route.fulfill({ json: { surface, state, revision: 0, leafId: "shared-leaf", publication, snapshot: "Original saved values" } });
        }
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      });
    };
    const ready = page => page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    const failed = page => page.getByText("参数加载或保存失败，本地调整已保留。", { exact: true }).waitFor();
    const field = page => page.getByRole("spinbutton", { name: "单价" });
    const flushFails = page => page.evaluate(() => window.flushAnswer().then(() => false, () => true));
    const pending = page => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("piora-ui-pending:"))
      .map(([key, raw]) => ({ key, raw, value: JSON.parse(raw) })));
    await Promise.all([attach(pageA), attach(pageB)]);
    await pageA.goto("https://intelligent-ui.test/?mode=publication&window=a"); await ready(pageA);
    await pageB.goto("https://intelligent-ui.test/?mode=publication&window=b"); await ready(pageB);

    await pageA.bringToFront(); await field(pageA).fill("7"); await failed(pageA);
    await pageB.bringToFront(); await field(pageB).fill("8"); await failed(pageB);
    assert.equal(await field(pageA).inputValue(), "7");
    assert.equal(await field(pageB).inputValue(), "8");
    const drafts = await pending(pageA);
    const draftA = drafts.find(item => item.value.state.price === 7), draftB = drafts.find(item => item.value.state.price === 8);
    assert.ok(draftA && draftB, "shared localStorage must contain both unacknowledged values");
    assert.notEqual(draftA.key, draftB.key, "different windows must never overwrite a shared pending record");
    assert.deepEqual(await pending(pageB), drafts, "both pages use the same origin storage");

    // Browser-created popups inherit their opener's sessionStorage. A clone
    // must first make its own recovery copy, even if the user never edits it
    // before choosing to discard or load the server's values.
    const [windowKey, sourceId] = await pageA.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("piora-ui-window:")));
    for (const action of ["放弃未保存调整", "加载已保存参数"]) {
      await pageA.bringToFront();
      const opening = pageA.waitForEvent("popup");
      await pageA.evaluate(() => { window.open("about:blank", "_blank"); });
      const clone = await opening;
      try {
        assert.equal(await clone.evaluate(key => sessionStorage.getItem(key), windowKey), sourceId, "the real popup inherits the opener's draft reference");
        await attach(clone);
        await clone.goto("https://intelligent-ui.test/?mode=publication&window=clone");
        await failed(clone);
        assert.equal(await field(clone).inputValue(), "7");
        const cloneId = await clone.evaluate(key => sessionStorage.getItem(key), windowKey);
        assert.ok(cloneId && cloneId !== sourceId, "recovery allocates a distinct writer before the clone is edited");
        const cloneDraft = (await pending(clone)).find(item => item.value.id === cloneId);
        assert.ok(cloneDraft); assert.notEqual(cloneDraft.key, draftA.key);
        assert.equal(cloneDraft.value.state.price, 7);
        assert.equal(await clone.evaluate(key => localStorage.getItem(key), draftA.key), draftA.raw);
        await clone.getByRole("button", { name: action, exact: true }).click();
        await ready(clone);
        assert.equal(await field(clone).inputValue(), "3");
        assert.equal(await clone.evaluate(key => localStorage.getItem(key), cloneDraft.key), null, `${action} settles only the clone's own record`);
        assert.equal(await clone.evaluate(key => sessionStorage.getItem(key), windowKey), null);
        assert.equal(await clone.evaluate(key => localStorage.getItem(key), draftA.key), draftA.raw, `${action} cannot settle the opener's unconfirmed values`);
        assert.equal(await clone.evaluate(key => localStorage.getItem(key), draftB.key), draftB.raw);
      } finally { await clone.close(); }
    }

    // A fresh window has neither page's sessionStorage reference. Multiple
    // recoverable records must be offered without choosing one as its draft.
    const pageC = await context.newPage(); await attach(pageC);
    await pageC.goto("https://intelligent-ui.test/?mode=publication&window=c"); await ready(pageC);
    assert.equal(await field(pageC).inputValue(), "3", "a fresh window starts from server-saved parameters, not another window's draft");
    const otherDrafts = pageC.locator("details").filter({ has: pageC.locator("summary", { hasText: "其他可恢复草稿" }) });
    await otherDrafts.locator("summary").click();
    const recoveryA = otherDrafts.locator(`[data-recovery-draft="${draftA.value.id}"]`);
    const recoveryB = otherDrafts.locator(`[data-recovery-draft="${draftB.value.id}"]`);
    assert.equal(await recoveryA.count(), 1);
    assert.equal(await recoveryB.count(), 1);
    assert.match(await recoveryA.textContent(), /单价:\s*7/);
    assert.match(await recoveryB.textContent(), /单价:\s*8/);
    assert.equal(await flushFails(pageC), false, "unselected recoverable drafts do not become this window's pending writer");

    publication = { status: "superseded", operationId: "generation-windows", currentToolCallId: "tool-latest" };
    await pageA.bringToFront();
    await pageA.evaluate(() => window.dispatchEvent(new Event("online")));
    const retain = pageA.getByRole("button", { name: "保留旧稿并使用已保存参数", exact: true });
    await retain.waitFor();
    assert.equal(await field(pageA).inputValue(), "7");
    await retain.click();
    const retainedA = pageA.locator("details").filter({ has: pageA.locator("summary", { hasText: "查看保留的旧稿" }) });
    await retainedA.locator("summary").click();
    assert.match(await retainedA.textContent(), /单价:\s*7/);
    assert.equal(await pageA.evaluate(key => localStorage.getItem(key), draftA.key), null);
    assert.equal(await pageA.evaluate(key => localStorage.getItem(key), draftB.key), draftB.raw, "archiving A cannot delete or change B's pending bytes");
    assert.equal(await flushFails(pageA), false);

    // Reload B while authoritative reads fail. Its own reference and local
    // bytes must restore 8 before the failed GET, with sending still blocked.
    failReadB = true;
    await pageB.bringToFront(); await pageB.reload(); await failed(pageB);
    assert.equal(await field(pageB).inputValue(), "8", "offline reload restores this window's unconfirmed values");
    assert.equal(await flushFails(pageB), true);
    assert.equal(await pageB.evaluate(key => localStorage.getItem(key), draftB.key), draftB.raw);
    await pageA.bringToFront(); await pageA.reload();
    await retainedA.locator("summary").waitFor(); await retainedA.locator("summary").click();
    assert.match(await retainedA.textContent(), /单价:\s*7/, "A's independent archive survives reload alongside B's pending draft");
    assert.equal(await flushFails(pageA), false);

    // Explicitly recover B's record in the third window. Recovery copies the
    // selected values without taking over or removing B's still-needed record.
    await pageC.bringToFront();
    await recoveryB.getByRole("button", { name: "恢复这份草稿", exact: true }).click();
    await pageC.waitForFunction(() => document.querySelector('input[type="number"]').value === "8");
    assert.equal(await field(pageC).inputValue(), "8");
    assert.equal(await flushFails(pageC), true);
    assert.equal(await pageC.evaluate(key => localStorage.getItem(key), draftB.key), draftB.raw);
    assert.equal(state.price, 3, "no unacknowledged draft silently replaces the server's state");
    assert.ok(writes >= 2, "both independent edits reached the deliberately failing save path");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-intelligent-ui-windows-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration reviews explicit field mapping in the browser and keeps the original after save", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-ui-migration-browser-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const targetSurface = { ...surface, version: 2, revision: 2, title: "新版采购清单", layout: [{ id: "parameters", type: "group", title: "采购参数", columns: 2, nodeIds: ["attendees", "price"] }], nodes: [
      { id: "attendees", type: "number", label: "参加人数", value: 4, min: 1, max: 20 },
      { id: "price", type: "number", label: "单价", value: 10, min: 0, max: 100 },
    ] };
    let updated = false, targetRevision = 0, targetState = { attendees: 4, price: 10 }, writes = 0, ancestorReads = 0;
    await page.route("https://migration-ui.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: true } });
      if (url.pathname.startsWith("/api/")) {
        if (url.searchParams.has("requiredAncestorLeafId")) { ancestorReads++; assert.equal(url.searchParams.get("requiredAncestorLeafId"), "before-update"); }
        if (request.method() === "PUT") {
          const data = request.postDataJSON();
          if (data.toolCallId === "tool-1") return route.fulfill({ status: 503, json: { error: "offline" } });
          assert.equal(data.toolCallId, "tool-2"); assert.equal(data.leafId, "after-update"); assert.equal(data.expectedRevision, targetRevision);
          targetState = data.state; targetRevision++; writes++;
        }
        if (url.searchParams.get("toolCallId") === "tool-2" || request.method() === "PUT") return route.fulfill({ json: { surface: targetSurface, state: targetState, revision: targetRevision, leafId: "after-update", publication: { status: "committed", operationId: "new-op" } } });
        return route.fulfill({ json: { surface, state: { people: 2, price: 3, fruit: "苹果", vegetarian: false }, revision: 0, leafId: updated ? "after-update" : "before-update", publication: updated ? { status: "superseded", operationId: "old-op", currentToolCallId: "tool-2" } : { status: "committed", operationId: "old-op" } } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://migration-ui.test/");
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    const slider = page.getByRole("slider", { name: "人数" }); await slider.focus(); await slider.press("ArrowRight");
    await page.getByText("参数加载或保存失败，本地调整已保留。", { exact: true }).waitFor();
    updated = true; await page.reload();
    await page.getByRole("button", { name: "核对并迁移到新版本", exact: true }).click();
    const panel = page.getByRole("region", { name: "核对字段后迁移" }); await panel.waitFor();
    const confirm = panel.getByRole("button", { name: "确认字段对应并保存", exact: true });
    assert.equal(await confirm.isDisabled(), true, "same names never choose mappings automatically");
    await panel.getByRole("combobox", { name: "使用哪个旧字段: 参加人数", exact: true }).selectOption("people");
    assert.equal(await panel.getByRole("combobox", { name: "使用哪个旧字段: 单价", exact: true }).inputValue(), "", "same ID still requires explicit choice");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "migration review remains within a narrow viewport");
    await confirm.click();
    await page.getByText("所选参数已保存到新版本，原稿仍在本机保留。", { exact: true }).waitFor();
    assert.deepEqual(targetState, { attendees: 3, price: 10 }); assert.equal(writes, 1); assert.ok(ancestorReads >= 5);
    const records = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("piora-ui-transfer:")).map(([, value]) => JSON.parse(value)));
    assert.equal(records.length, 1); assert.equal(records[0].status, "saved");
    assert.equal(records[0].target.surface.version, 2); assert.deepEqual(records[0].target.surface.layout, targetSurface.layout);
    await page.getByText("查看保留的旧稿", { exact: true }).click();
    assert.ok((await page.locator("details .snapshot").allTextContents()).some(text => text.includes("人数: 3")));
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("structure changes show meanings, wait for completion and require an explicit idempotent confirmation", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-ui-structure-review-"));
  let browser;
  const changed = { version: 1, id: "bill", revision: 2, title: "费用计算", nodes: [
    { id: "people", type: "number", label: "人数", value: 4, min: 1, max: 20 },
    { id: "price", type: "number", label: "费用", value: 2000, min: 0 },
  ] };
  let review = { proposalId: "proposal", digest: "digest", toolCallId: "tool-1", leafId: "ready-leaf", status: "provisional",
    suggestedState: { people: 6, price: 2000 }, fields: [
      { id: "people", change: "compatible", before: changed.nodes[0], after: changed.nodes[0], savedValue: 6, suggestedValue: 6 },
      { id: "price", change: "changed", before: { ...changed.nodes[1], value: 20 }, after: changed.nodes[1], beforeMeaning: { id: "price", valueType: "number", unit: "元" }, afterMeaning: { id: "price", valueType: "number", unit: "分" }, savedValue: 30, suggestedValue: 2000 },
    ] };
  let publication = { status: "awaiting_confirmation", operationId: "operation" }, state = { people: 4, price: 2000 };
  const posts = [], errors = []; let disconnect = true, conflict = false;
  try {
    const { bundle, css } = await buildFixture(directory, changed, 2);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://structure-review.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname.endsWith("/migration")) {
        if (route.request().method() === "POST") {
          const input = route.request().postDataJSON(); posts.push(input);
          if (conflict) { review = { ...review, status: "stale" }; return route.fulfill({ status: 409, json: { error: "Source changed" } }); }
          if (disconnect) {
            disconnect = false; review = { ...review, pendingConfirmation: { requestId: input.requestId, state: input.state } };
            return route.abort("failed");
          }
          review = { ...review, status: input.decision === "confirm" ? "committed" : "cancelled" };
          publication = { ...publication, status: input.decision === "confirm" ? "committed" : "aborted" };
          if (input.decision === "confirm") state = input.state;
          return route.fulfill({ json: { status: review.status } });
        }
        return route.fulfill({ json: { review } });
      }
      if (url.pathname.startsWith("/api/")) {
        assert.notEqual(route.request().method(), "PUT", "proposal review never borrows normal parameter PUT");
        return route.fulfill({ json: { surface: changed, state, revision: publication.status === "committed" ? 3 : 0, leafId: review.leafId, publication } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://structure-review.test/");
    const panel = page.getByRole("region", { name: "核对变更后使用新版" });
    const confirm = panel.getByRole("button", { name: "确认并使用新版", exact: true });
    await panel.getByText("正在等待当前任务完成，完成后可以确认。", { exact: true }).waitFor();
    assert.equal(await confirm.isDisabled(), true); assert.equal(posts.length, 0);
    assert.equal(await page.getByRole("spinbutton", { name: "人数", exact: true }).isDisabled(), true);
    review.status = "ready"; await panel.getByRole("button", { name: "刷新核对内容" }).click();
    await confirm.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent === '确认并使用新版' && !button.disabled));
    assert.match(await panel.textContent(), /单位: 元/); assert.match(await panel.textContent(), /单位: 分/);
    assert.equal(await panel.getByRole("spinbutton", { name: "新版使用的值: 人数" }).count(), 0, "compatible values cannot be silently changed");
    const price = panel.getByRole("spinbutton", { name: "新版使用的值: 费用" });
    await price.fill(""); assert.equal(await confirm.isDisabled(), true, "empty numeric input is not coerced to zero");
    await price.fill("3000");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => localStorage.setItem("piora-ui-retained:sentinel", "old local draft"));
    if (process.env.PIORA_UI_SCREENSHOTS) {
      await mkdir(process.env.PIORA_UI_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PIORA_UI_SCREENSHOTS, 'intelligent-ui-structure-review.png'), fullPage: true });
    }
    await confirm.click();
    const retry = panel.getByRole("button", { name: "重试原确认", exact: true }); await retry.waitFor();
    assert.equal(posts.length, 1, "unknown result is queried, never automatically posted again");
    assert.deepEqual(posts[0].state, { people: 6, price: 3000 });
    assert.equal(await price.inputValue(), "3000"); assert.equal(await price.isDisabled(), true);
    await retry.click(); await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(posts.length, 2); assert.deepEqual(posts[1], posts[0]);
    assert.equal(await page.getByRole("spinbutton", { name: "费用", exact: true }).inputValue(), "3000");
    assert.equal(await page.evaluate(() => localStorage.getItem("piora-ui-retained:sentinel")), "old local draft");
    // A source change detected at POST keeps the proposal read-only and requires regeneration.
    review = { ...review, status: "ready", pendingConfirmation: undefined }; publication.status = "awaiting_confirmation"; conflict = true;
    await page.reload(); await confirm.waitFor(); await confirm.click();
    await panel.getByText("对话或已保存参数已变化，请让模型根据最新参数重新生成。", { exact: true }).waitFor();
    assert.equal(await confirm.count(), 0); assert.equal(posts.length, 3);
    assert.equal(await page.getByRole("spinbutton", { name: "人数", exact: true }).isDisabled(), true);
    // Explicit cancellation has its own choice and does not delete local drafts.
    conflict = false; review.status = "ready"; await page.reload();
    await panel.getByRole("button", { name: "取消这次变更" }).click();
    await page.getByText("此预览未发布，已保存的回答仍可查看。", { exact: true }).waitFor();
    assert.equal(posts.at(-1).decision, "cancel");
    assert.equal(await page.evaluate(() => localStorage.getItem("piora-ui-retained:sentinel")), "old local draft");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Surface2 production renderer persists controlled layout and filters, preserves focus, and keeps candidates read-only", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-ui-rich-integration-"));
  let browser;
  const rich = { version: 2, id: "journey", revision: 1, title: "出行比较", nodes: [
    { id: "people", type: "number", label: "人数", value: 2, min: 1, max: 20 },
    { id: "transport", type: "select", label: "交通方式", value: "全部", options: ["全部", "火车", "飞机"] },
    { id: "basic", type: "metric", label: "经济费用", value: { op: "multiply", args: [{ ref: "people" }, 10] } },
    { id: "premium", type: "metric", label: "舒适费用", value: { op: "multiply", args: [{ ref: "people" }, 20] } },
    { id: "options", type: "table", columns: ["方式", "费用"], rows: [["火车", 20], ["飞机", 200]] },
  ], layout: [
    { id: "inputs", type: "group", title: "出行条件", columns: 2, nodeIds: ["people", "transport"] },
    { id: "plans", type: "comparison", title: "两种方案", cards: [{ id: "cheap", title: "经济方案", nodeIds: ["basic"] }, { id: "comfortable", title: "舒适方案", nodeIds: ["premium"] }] },
    { id: "results", type: "filteredTable", title: "可选交通", tableId: "options", filters: [{ column: 0, controlId: "transport", operator: "equals", inactiveValue: "全部" }] },
  ] };
  try {
    const { bundle, css } = await buildFixture(directory, rich, 2);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 950 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let revision = 0, state = { people: 2, transport: "全部" }, writes = 0, publication = { status: "committed", operationId: "rich-op" };
    await page.route("https://rich-integration.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/beta-features") return route.fulfill({ json: { intelligentUi: true } });
      if (url.pathname.endsWith("/intelligent-ui/actions")) return route.fulfill({ json: { source: null, operations: [] } });
      if (url.pathname.startsWith("/api/")) {
        if (request.method() === "PUT") {
          assert.equal(publication.status, "committed");
          const body = request.postDataJSON(); assert.equal(body.expectedRevision, revision); assert.equal(body.leafId, "rich-leaf");
          state = body.state; revision++; writes++;
        }
        return route.fulfill({ json: { surface: rich, state, revision, leafId: "rich-leaf", publication } });
      }
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://rich-integration.test/");
    await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "出行条件", exact: true }).waitFor();
    assert.equal(await page.getByRole("article", { name: "经济方案" }).locator("output").textContent(), "20");
    assert.equal(await page.getByRole("article", { name: "舒适方案" }).locator("output").textContent(), "40");
    const people = page.getByRole("spinbutton", { name: "人数" }); await people.fill("5");
    await page.evaluate(() => window.flushAnswer());
    assert.equal(state.people, 5); assert.equal(await people.evaluate(node => document.activeElement === node), true, "save must keep the controlled input mounted and focused");
    assert.equal(await page.getByRole("article", { name: "经济方案" }).locator("output").textContent(), "50");
    await page.getByRole("combobox", { name: "交通方式" }).selectOption("火车"); await page.evaluate(() => window.flushAnswer());
    assert.deepEqual(state, { people: 5, transport: "火车" });
    await page.getByText("显示 1 条，共 2 条", { exact: true }).waitFor();
    assert.equal(await page.getByRole("cell", { name: "飞机", exact: true }).count(), 0);
    assert.equal(await page.getByRole("cell", { name: "火车", exact: true }).count(), 1);
    await page.reload(); await page.getByText("已保存 · 后续追问可读取当前参数", { exact: true }).waitFor();
    assert.equal(await people.inputValue(), "5"); assert.equal(await page.getByRole("combobox", { name: "交通方式" }).inputValue(), "火车");
    assert.equal(await page.getByRole("cell", { name: "飞机", exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.evaluate(() => window.flushAnswer()); assert.equal(writes, 2, "reload and follow-up do not create extra writes");
    publication = { status: "candidate", operationId: "rich-op" };
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByText("预览 · 正在等待发布确认", { exact: true }).waitFor();
    assert.equal(await people.isDisabled(), true); assert.equal(await page.getByRole("combobox", { name: "交通方式" }).isDisabled(), true);
    await page.evaluate(() => window.flushAnswer()); assert.equal(writes, 2);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
