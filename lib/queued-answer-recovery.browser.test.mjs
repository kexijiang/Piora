import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

test("queued submissions commit independent recovery before answer-state gating and retain originals beside newer drafts across reload", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-queued-answer-recovery-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>'export default '+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(match=>[match[1],match[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatInput} from "@/components/ChatInput";
import {useChatCommandOperations} from "@/hooks/useChatCommandOperations";
import {createChatCommandCatalog} from "@/lib/chat-command-input";
import {readPendingPrompts} from "@/lib/prompt-recovery";
import {readComposerRecord} from "@/lib/reply-storage";
import {flushPendingAnswerState,registerAnswerStateWriter} from "@/lib/answer-output-client";
const sid="queued-answer-session";const catalog=createChatCommandCatalog([]);
window.runVersion=0;window.networkHooks=[];window.guardCalls=0;
window.EventSource=class{addEventListener(){}close(){}};
window.pending=()=>readPendingPrompts(sid);
window.persistedDraft=()=>readComposerRecord("drafts",sid);
window.holdAnswerSave=()=>{window.releaseWriter?.();window.releaseWriter=registerAnswerStateWriter("save",sid,()=>new Promise((resolve,reject)=>{window.finishSave=resolve;window.failSave=()=>reject(new Error("Answer state save failed"));}));};
function App(){
 const commands=useChatCommandOperations({conversationKey:sid,sessionId:sid,scope:sid,catalog,
 captureSubmissionGuard:()=>{const version=window.runVersion;return async()=>{window.guardCalls++;const pending=await readPendingPrompts(sid);window.recoveryAtGate=pending;window.durableAtGate=window.durableId;if(!window.durableId||!pending.some(record=>record.id===window.durableId))throw new Error("Gate ran before durable recovery");await flushPendingAnswerState(sid);return version===window.runVersion;};},
 ensureSession:async()=>{window.networkHooks.push("ensureSession");return sid;},loadCatalog:async()=>{window.networkHooks.push("loadCatalog");return catalog;},uploadFiles:async()=>{window.networkHooks.push("uploadFiles");return [];},connectModelEvents:async()=>{window.networkHooks.push("connectModelEvents");},onAccepted:()=>{},onFinished:()=>{}});
 window.records=commands.records;
 return <ChatInput ref={value=>{window.composer=value;}} draftKey={sid} isStreaming onSend={async()=>false} onAbort={()=>{window.runVersion++;}} onQueueInput={(text,images,files,onDurable,...rest)=>commands.submit(text,images,files,id=>{window.durableId=id;onDurable?.(id);},...rest)} model={{provider:"test",modelId:"fixture"}} modelList={[{provider:"test",id:"fixture",name:"Fixture"}]} onModelChange={async()=>true} commandCatalog={catalog}/>;
}
localStorage.setItem("pi-locale","en");createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    for (const outcome of ["cancel", "failure", "reload"]) {
      const context = await browser.newContext();
      const errors = [], submitted = [];
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.route("https://queued-answer.test/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: url.pathname === "/bundle.js" ? bundle : await readFile(path.join(directory, path.basename(url.pathname))) });
        if (url.pathname.includes("/api/agent/") && route.request().method() === "POST") submitted.push(route.request().postDataJSON());
        if (url.pathname.endsWith("/submissions")) return route.fulfill({ json: { items: [], nextOffset: null } });
        if (url.pathname === "/api/models") return route.fulfill({ json: { models: {}, modelList: [{ provider: "test", id: "fixture", name: "Fixture" }] } });
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { success: true } });
        return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      });
      await page.goto("https://queued-answer.test/");
      await page.waitForFunction(() => !!window.composer);
      await page.evaluate(({ image, outcome }) => {
        window.holdAnswerSave();
        window.composer.restoreCommandDraft({ value: "Original queued input " + outcome, images: [{ data: image, mimeType: "image/png" }], files: [{ name: "notes.txt", size: 7, text: "payload" }] });
      }, { image, outcome });
      const editor = page.locator("textarea").first();
      await page.getByRole("button", { name: "Steer", exact: true }).click();
      await page.waitForFunction(() => !!window.finishSave);
      const before = await page.evaluate(async () => ({ pending: await window.pending(), durable: window.durableAtGate, network: window.networkHooks }));
      assert.equal(before.pending.length, 1);
      assert.equal(before.pending[0].id, before.durable);
      assert.equal(before.pending[0].draft.value, "Original queued input " + outcome);
      assert.equal(before.pending[0].draft.images[0].data, image);
      assert.equal(before.pending[0].draft.files[0].text, "payload");
      assert.deepEqual(before.network, [], "catalog/session/upload/connect wait for durable recovery and the state gate");
      await editor.fill("New independent draft " + outcome);
      await page.waitForFunction(async expected => (await window.persistedDraft())?.value === expected, "New independent draft " + outcome);
      if (outcome === "cancel") {
        await page.evaluate(() => { window.runVersion++; window.finishSave(); });
        await page.waitForFunction(() => window.records.some(record => record.local && record.status === "interrupted"));
      } else if (outcome === "failure") {
        await page.evaluate(() => window.failSave());
        await page.waitForFunction(() => window.records.some(record => record.local && record.status === "failed"));
      }
      await page.reload();
      await page.waitForFunction(async () => !!window.pending && (await window.pending()).length === 1 && window.records.some(record => record.local && record.status === "interrupted"));
      await page.waitForFunction(expected => document.querySelector("textarea")?.value === expected, "New independent draft " + outcome);
      const after = await page.evaluate(async () => ({ pending: await window.pending(), draft: await window.persistedDraft() }));
      assert.equal(after.pending[0].draft.value, "Original queued input " + outcome);
      assert.equal(after.pending[0].draft.files[0].text, "payload");
      assert.equal(after.pending[0].draft.images[0].data, image);
      assert.equal(after.draft.value, "New independent draft " + outcome);
      assert.deepEqual(submitted, [], "a cancelled, failed or abandoned gate never dispatches the prompt");
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-queued-answer-recovery-"));
    await rm(directory, { recursive: true, force: true });
  }
});
