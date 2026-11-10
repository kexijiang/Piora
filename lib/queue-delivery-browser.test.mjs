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

test("real session and command hooks keep steering pending until consumption, across recall, failure and reload", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-queue-delivery-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `
import React from "react";import {createRoot} from "react-dom/client";
import {useAgentSession} from "@/hooks/useAgentSession";import {I18nProvider} from "@/hooks/useI18n";
import {ChatCommandQueue} from "@/components/ChatCommandCard";
const session={id:"fixture",cwd:"C:/fixture",name:"Queue",modified:"one"};
window.sources=[];window.EventSource=class{static OPEN=1;static CLOSED=2;readyState=1;constructor(url){this.url=url;window.sources.push(this);setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}),0)}close(){this.readyState=2}};
window.emit=(event,commands=false)=>window.sources.filter(s=>s.readyState===1&&(commands?s.url.includes("scope=commands"):s.url.includes("transport=delta"))).forEach(s=>s.onmessage?.({data:JSON.stringify(event)}));
function App(){const state=useAgentSession({session});window.state=state;
return <><section aria-label="聊天记录">{state.messages.map((m,i)=><p key={i}>{typeof m.content==="string"?m.content:JSON.stringify(m.content)}</p>)}</section>
<ChatCommandQueue records={state.chatCommands.records} pendingMessages={state.queuedMessages} onPendingAction={state.handlePendingInputAction}
actions={{steer:r=>state.chatCommands.queueAction(r,"steer"),resume:r=>state.chatCommands.queueAction(r,"resume"),cancel:r=>state.chatCommands.queueAction(r,"cancel"),edit:state.chatCommands.edit,save:(r,text)=>state.chatCommands.queueAction(r,"edit",text)}}/></>}
localStorage.setItem("pi-locale","zh-CN");createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);
`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let record = { commandId: "queued-one", idempotencyKey: "prompt-one", targetSessionId: "fixture", acceptedAt: 123, revision: 1, status: "queued", preview: "sleep 5s" };
    let queued = { steering: [], followUp: [], pendingInputs: [] };
    let fail = false;
    const history = [{ role: "user", content: "sleep 60s", clientPromptId: "initial" }];
    const publish = async () => {
      await page.evaluate(({ record, queued }) => { window.emit({ type: "command_snapshot", operations: [record] }, true); window.emit({ type: "queue_update", ...queued }); }, { record, queued });
    };
    await page.route("http://127.0.0.1:38201/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, "bundle.js")) });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname.endsWith("/submissions")) return route.fulfill({ json: url.searchParams.has("commandId") ? { value: "sleep 5s", images: [], files: [] } : { items: [record], nextOffset: null } });
      if (url.pathname === "/api/sessions/fixture") return route.fulfill({ json: { context: { messages: history, entryIds: history.map((_,i)=>"entry-"+i) }, info: sessionInfo(), tree: [], persistedPromptIds: history.map(m=>m.clientPromptId) } });
      if (url.pathname === "/api/agent/fixture" && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        if (body.type === "queued_input_action") {
          if (fail) return route.fulfill({ status: 409, json: { error: "steer failed" } });
          record = { ...record, status: "delivered", revision: record.revision + 1 };
          queued = { steering: ["sleep 5s"], followUp: [], pendingInputs: [{ id: "pending-one", commandId: record.commandId, text: "sleep 5s", kind: "steer" }] };
          await publish();
          return route.fulfill({ json: { data: record } });
        }
        if (body.type === "pending_input_action") {
          record = { ...record, status: "queued", revision: record.revision + 1 };
          queued = { steering: [], followUp: [], pendingInputs: [] };
          await publish();
        }
        return route.fulfill({ json: { data: {} } });
      }
      if (url.pathname === "/api/agent/fixture" || url.pathname === "/api/sessions/fixture/state") return route.fulfill({ json: { running: true, state: { runtime: "running", isStreaming: true, isPromptRunning: true, queuedMessages: queued } } });
      if (url.pathname === "/api/models") return route.fulfill({ json: { models: {}, modelList: [], defaultModel: null } });
      return route.fulfill({ json: { items: [], commands: [], records: [], reviews: [], operations: [], templates: [], selectorVisible: false } });
    });
    function sessionInfo() { return { id: "fixture", cwd: "C:/fixture" }; }
    await page.goto("http://127.0.0.1:38201/");
    await page.waitForFunction(() => window.state?.agentRunning && !window.state.loading).catch(async error => {
      throw new Error(error.message + "; " + errors.join("; ") + "; " + await page.evaluate(() => JSON.stringify({ loading: window.state?.loading, error: window.state?.error, text: document.body.innerText })));
    });
    const chat = page.getByRole("region", { name: "聊天记录" });
    const steer = page.getByRole("button", { name: "切换引导", exact: true });
    const restore = page.getByRole("button", { name: "恢复排队", exact: true });
    await steer.click(); await restore.waitFor();
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 0, "queue acceptance must not render a chat bubble");
    await restore.click(); await steer.waitFor();
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 0, "recall must leave no ghost bubble");
    fail = true;
    await steer.click(); await page.getByRole("alert").waitFor();
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 0, "failed steering must not render a chat bubble");
    fail = false;
    await steer.click(); await restore.waitFor();
    await page.reload(); await restore.waitFor();
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 0, "refresh while pending stays pending");
    const delivered = { role: "user", content: "sleep 5s", clientPromptId: record.idempotencyKey, timestamp: 456 };
    history.push(delivered); record = { ...record, status: "completed", revision: record.revision + 1 };
    queued = { steering: [], followUp: [], pendingInputs: [] };
    await page.evaluate(message => window.emit({ type: "message_end", message }), delivered);
    await publish();
    await chat.getByText("sleep 5s", { exact: true }).waitFor();
    await restore.waitFor({ state: "hidden" }); await steer.waitFor({ state: "hidden" });
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 1);
    await page.reload(); await chat.getByText("sleep 5s", { exact: true }).waitFor();
    assert.equal(await chat.getByText("sleep 5s", { exact: true }).count(), 1, "delivered history remains exactly once after reload");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
