import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": repo } });

test("browser command hook, HTTP handlers, router and real SDK retain results and recovery across reload", { timeout: 180000 }, async context => {
  const fixture = await createSdkTestFixture(context, { extension: pi => pi.registerCommand("flow-fail", { handler: async () => { throw new Error("FLOW_COMMAND_FAILED"); } }) });
  const environment = Object.fromEntries(["PI_CODING_AGENT_DIR", "PIORA_SESSION_CONTROL_ROOT", "PIORA_RUNTIME_PROFILE"].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  process.env.PIORA_SESSION_CONTROL_ROOT = join(fixture.agentDir, "control");
  process.env.PIORA_RUNTIME_PROFILE = "normal";
  const previousSessions = globalThis.__piSessions, previousRouter = globalThis.__pioraSessionMessageRouter;
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { SessionMessageRouter } = await jiti.import("./session-message-router.ts");
  const { SessionControlStore } = await jiti.import("./session-control-store.ts");
  const { SessionCommandEventHub } = await jiti.import("./session-command-events.ts");
  const { createChatCommandEventResponse } = await jiti.import("./chat-command-events.ts");
  const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
  const { GET } = await jiti.import("../app/api/sessions/[id]/submissions/route.ts");
  const { GET: GETSession } = await jiti.import("../app/api/sessions/[id]/route.ts");
  const { cacheSessionPath } = await jiti.import("./session-reader.ts");
  const session = await fixture.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  cacheSessionPath(session.sessionId, wrapper.sessionFile);
  globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  const store = new SessionControlStore();
  globalThis.__pioraSessionMessageRouter = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => ({ session: wrapper, realSessionId: session.sessionId }) });
  const catalog = (await wrapper.send({ type: "get_commands" })).catalog;
  const directory = fixture.cwd;
  let browser, server;
  const errors = [];
  try {
    await writeFile(join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(join(directory, "css.cjs"), `module.exports=s=>'export default '+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(match=>[match[1],match[1]])))`);
    await writeFile(join(directory, "entry.tsx"), `
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {useChatCommandOperations} from "@/hooks/useChatCommandOperations";
import {ChatCommandCard,ChatCommandQueue} from "@/components/ChatCommandCard";
import {readPendingPrompts,confirmPendingPrompts} from "@/lib/prompt-recovery";
import {sendAgentCommand} from "@/lib/agent-client";
const sid=${JSON.stringify(session.sessionId)};
function App(){
 const [catalog,setCatalog]=useState(${JSON.stringify(catalog)});
 const [activeSid,setActiveSid]=useState(()=>new URLSearchParams(location.search).has("session")?sid:null);
 const load=async()=>{const data=await sendAgentCommand(sid,{type:"get_commands"});setCatalog(data.catalog);return data.catalog};
 const sync=async()=>{const response=await fetch('/api/sessions/'+sid);const data=await response.json();await confirmPendingPrompts(data.persistedPromptIds??[])};
 const commands=useChatCommandOperations({conversationKey:"fixture-chat",sessionId:activeSid,scope:activeSid??${JSON.stringify(`new:${fixture.cwd}`)},catalog,ensureSession:async()=>sid,loadCatalog:load,connectModelEvents:async()=>{if(window.holdConnection)await new Promise(resolve=>{window.releaseConnection=resolve})},uploadFiles:async()=>[],onAccepted:()=>{setActiveSid(sid);history.replaceState(null,"","?session="+sid)},onFinished:record=>{if(record.operation?.command.name==="reload")void load();void sync()}});
 window.promote=()=>{setActiveSid(sid);history.replaceState(null,"","?session="+sid)};
 window.submit=(text,options={},files=[])=>commands.submit(text,[],files,undefined,options);
 window.editQueue=record=>commands.edit(record);window.records=commands.records;window.taskTiming=commands.taskTiming;window.taskTimings=commands.taskTimings;window.pending=()=>readPendingPrompts(sid);window.restore=record=>commands.restore(record);window.queueAction=(record,action,text)=>commands.queueAction(record,action,text);
 return <main>{commands.records.map(record=><ChatCommandCard key={record.commandId} record={record} actions={{retry:async()=>{},restore:async()=>{},cancel:commands.cancel,copy:commands.copy}}/>) }<footer><ChatCommandQueue records={commands.records} actions={{cancel:r=>commands.queueAction(r,"cancel"),steer:r=>commands.queueAction(r,"steer"),edit:commands.edit,save:(r,text)=>commands.queueAction(r,"edit",text),resume:r=>commands.queueAction(r,"resume")}}/></footer></main>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(directory, "loader.cjs") }, { test: /\.css$/, use: join(directory, "css.cjs") }] } });
    await new Promise((resolvePromise, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolvePromise())));
    server = createServer(async (incoming, outgoing) => {
      const controller = new AbortController();
      outgoing.on("close", () => controller.abort());
      try {
        const url = `http://127.0.0.1:${server.address().port}${incoming.url}`;
        const pathname = new URL(url).pathname;
        let response;
        if (pathname.endsWith("/events")) response = createChatCommandEventResponse(new Request(url, { signal: controller.signal }), session.sessionId);
        else if (pathname.endsWith("/submissions")) response = await GET(new Request(url), { params: Promise.resolve({ id: session.sessionId }) });
        else if (pathname === `/api/sessions/${session.sessionId}`) response = await GETSession(new Request(url), { params: Promise.resolve({ id: session.sessionId }) });
        else if (incoming.method === "POST") {
          const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
          response = await POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: Buffer.concat(chunks).toString("utf8") }), { params: Promise.resolve({ id: session.sessionId }) });
        } else if (pathname.endsWith(".js")) response = new Response(await readFile(join(directory, pathname.slice(1))), { headers: { "Content-Type": "text/javascript" } });
        else response = new Response('<!doctype html><html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>', { headers: { "Content-Type": "text/html" } });
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) for await (const chunk of response.body) { if (outgoing.destroyed) break; outgoing.write(chunk); }
        outgoing.end();
      } catch (error) {
        if (!controller.signal.aborted) { errors.push(String(error)); outgoing.writeHead(500); outgoing.end(String(error)); }
      }
    });
    await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ locale: "zh-CN" });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.submit === "function");
    const oversized = await POST(new Request("http://localhost/api/agent/oversized", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "submit_input", message: "/name test", afterPrompt: "x".repeat(256 * 1024), idempotencyKey: "oversized-query" }) }), { params: Promise.resolve({ id: session.sessionId }) });
    assert.equal(oversized.status, 413);
    assert.equal(store.loadCommands(session.sessionId).length, 0);
    assert.equal(await page.evaluate(() => window.submit("/reload", { submissionId: "landing-command-id" })), true);
    await page.waitForFunction(() => window.records.some(record => record.operation?.command.name === "reload" && record.status === "completed"));
    assert.equal(fixture.requests.length, 0);
    assert.equal(store.loadCommands(session.sessionId)[0].idempotencyKey, "landing-command-id");
    await page.waitForFunction(() => window.taskTiming?.outcome === "completed");
    const savedTiming = store.loadCommands(session.sessionId)[0].taskTiming;
    assert.deepEqual(await page.evaluate(() => window.taskTiming), savedTiming);
    await page.waitForFunction(() => window.taskTimings?.some(record => record.idempotencyKey === "landing-command-id" && record.taskTiming.outcome === "completed"));
    assert.deepEqual(await page.evaluate(() => window.taskTimings.find(record => record.idempotencyKey === "landing-command-id").taskTiming), savedTiming);
    await page.reload();
    await page.waitForFunction(() => window.records?.some(record => record.operation?.command.name === "reload" && record.status === "completed"));
    assert.equal(await page.evaluate(() => window.records.filter(record => record.operation?.command.name === "reload").length), 1);
    await page.waitForFunction(() => window.taskTiming?.outcome === "completed");
    assert.deepEqual(await page.evaluate(() => window.taskTiming), savedTiming);
    await page.waitForFunction(() => window.taskTimings?.some(record => record.idempotencyKey === "landing-command-id" && record.taskTiming.outcome === "completed"));
    assert.deepEqual(await page.evaluate(() => window.taskTimings.find(record => record.idempotencyKey === "landing-command-id").taskTiming), savedTiming);
    assert.equal(await page.evaluate(() => window.submit("/name 流程验证", { afterPrompt: "FOLLOW_UP_AFTER_NAME" })), true);
    await page.waitForFunction(() => window.records.some(record => record.operation?.command.name === "name" && record.status === "completed"));
    assert.equal(session.sessionManager.getSessionName(), "流程验证");
    assert.equal(fixture.requests.length, 1);
    assert.match(JSON.stringify(fixture.requests[0].messages), /FOLLOW_UP_AFTER_NAME/);
    await page.waitForFunction(async () => (await window.pending()).length === 0);
    assert.equal(await page.evaluate(() => window.submit("/flow-fail", { inputMode: "text" })), true);
    await page.waitForFunction(async () => (await window.pending()).length === 0);
    await page.waitForFunction(() => window.records.some(record => !record.operation && record.preview === "/flow-fail" && record.status === "completed"));
    assert.equal(fixture.requests.length, 2);
    assert.match(JSON.stringify(fixture.requests[1].messages), /flow-fail/);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    assert.equal(await page.evaluate(() => window.submit("/copy")), true);
    await page.getByRole("button", { name: /^点击复制/ }).click();
    await page.waitForFunction(() => window.records.some(record => record.operation?.command.name === "copy" && record.status === "completed"));
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "completed");
    assert.equal(await page.evaluate(() => window.submit("/flow-fail", { afterPrompt: "DO_NOT_SEND" }, [{ name: "附件.pdf", path: "F:\\fixture\\附件.pdf", size: 123, text: null }])), true);
    await page.waitForFunction(() => window.records.some(record => record.operation?.command.name === "flow-fail" && record.status === "failed"));
    assert.equal(fixture.requests.length, 2);
    await page.reload();
    await page.waitForFunction(() => window.records?.some(record => record.operation?.command.name === "flow-fail" && record.status === "failed"));
    const recovered = await page.evaluate(async () => { const record = window.records.find(item => item.operation?.command.name === "flow-fail"); return { draft: await window.restore(record), count: window.records.filter(item => item.idempotencyKey === record.idempotencyKey).length, pending: (await window.pending()).length }; });
    assert.equal(recovered.count, 1);
    assert.equal(recovered.pending, 1);
    assert.equal(recovered.draft.commandInput.afterPrompt, "DO_NOT_SEND");
    assert.equal(recovered.draft.files[0].name, "附件.pdf");
    assert.equal(store.loadCommands(session.sessionId).find(record => record.operation?.command.name === "flow-fail").operation.steps[1].status, "blocked");
    const failed = store.loadCommands(session.sessionId).find(record => record.operation?.command.name === "flow-fail");
    const repeated = await POST(new Request("http://localhost/api/agent/repeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "submit_input", message: "/flow-fail", idempotencyKey: failed.idempotencyKey, catalogRevision: "outdated-catalog" }) }), { params: Promise.resolve({ id: session.sessionId }) });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).data.commandId, failed.commandId);
    const outdated = await POST(new Request("http://localhost/api/agent/outdated", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "submit_input", message: "/flow-fail", idempotencyKey: "new-outdated-submission", catalogRevision: "outdated-catalog" }) }), { params: Promise.resolve({ id: session.sessionId }) });
    assert.equal(outdated.status, 409);
    assert.equal(fixture.requests.length, 2);
    // Exercise the production hook -> HTTP -> durable router path while a task is busy.
    const originalIsRunning = wrapper.isRunning.bind(wrapper);
    wrapper.isRunning = () => true;
    try {
      // A new chat can acquire its session while a slow event connection is pending.
      // Recovery hydration must not label this live submission as interrupted.
      await page.goto('http://127.0.0.1:' + server.address().port + '/');
      await page.waitForFunction(() => typeof window.submit === 'function');
      await page.evaluate(() => { window.holdConnection = true; window.slowSend = window.submit('SLOW_QUEUE_QUERY', { delivery: 'next_turn' }); });
      await page.waitForFunction(() => typeof window.releaseConnection === 'function');
      await page.evaluate(()=>window.promote());
      await page.waitForTimeout(500); // The initial prompt promotes the same chat while its queued submission is still preparing.
      const preparing = await page.evaluate(() => window.records.find(record => record.preview === 'SLOW_QUEUE_QUERY'));
      assert.equal(preparing.status, 'accepted', 'a live submission is not an interrupted recovery');
      assert.equal(preparing.local, true);
      assert.equal(await page.locator('footer section').getByText(/SLOW_QUEUE_QUERY/).count(), 1);
      assert.equal(await page.locator('footer section button:enabled').count(), 0, 'unacknowledged submissions cannot issue queue mutations');
      assert.equal(await page.locator('main > section').filter({ hasText: 'SLOW_QUEUE_QUERY' }).count(), 0);
      assert.equal(store.loadCommands(session.sessionId).filter(record => record.content === 'SLOW_QUEUE_QUERY').length, 0);
      await page.evaluate(() => { window.holdConnection = false; window.releaseConnection(); });
      assert.equal(await page.evaluate(() => window.slowSend), true);
      await page.waitForFunction(() => window.records.some(record => record.preview === 'SLOW_QUEUE_QUERY' && !record.local && record.status === 'queued'));
      assert.equal(store.loadCommands(session.sessionId).filter(record => record.content === 'SLOW_QUEUE_QUERY').length, 1);
      await page.evaluate(() => window.queueAction(window.records.find(record => record.preview === 'SLOW_QUEUE_QUERY'), 'cancel'));
      // A real page interruption must still leave an editable recovery, without replaying.
      await page.evaluate(() => { window.releaseConnection = undefined; window.holdConnection = true; void window.submit('ABANDONED_QUEUE_QUERY', { delivery: 'next_turn' }); });
      await page.waitForFunction(() => typeof window.releaseConnection === 'function');
      await page.reload();
      await page.waitForFunction(() => window.records?.some(record => record.preview === 'ABANDONED_QUEUE_QUERY' && record.local && record.status === 'interrupted'));
      assert.equal(await page.locator('footer section').filter({ hasText: 'ABANDONED_QUEUE_QUERY' }).count(), 0, "interrupted sends must not accumulate in the queue");
      assert.equal(await page.locator('main > section').filter({ hasText: 'ABANDONED_QUEUE_QUERY' }).count(), 0);
      const abandonedDraft = await page.evaluate(() => window.restore(window.records.find(record => record.preview === 'ABANDONED_QUEUE_QUERY')));
      assert.equal(abandonedDraft.value, 'ABANDONED_QUEUE_QUERY', "removing the queue duplicate must retain the complete recovery draft");
      assert.deepEqual(abandonedDraft.images, []);
      assert.deepEqual(abandonedDraft.files, []);
      assert.equal(await page.evaluate(async () => (await window.pending()).filter(record => record.draft.value === 'ABANDONED_QUEUE_QUERY').length), 1);
      assert.equal(store.loadCommands(session.sessionId).filter(record => record.content === 'ABANDONED_QUEUE_QUERY').length, 0);
      assert.equal(await page.evaluate(() => window.submit("QUEUED_LONG_" + "query ".repeat(60), { delivery: "next_turn" }, [{ name: "notes.txt", path: "D:/fixture/notes.txt", size: 25, text: null }])), true);
      await page.waitForFunction(() => window.records.some(record => record.preview?.startsWith("QUEUED_LONG_") && !record.local && record.status === "queued"));
      await page.route("**/submissions?commandId=*", route=>route.fulfill({status:500,json:{error:"read failed"}}));
      const failedEdit=await page.evaluate(async()=>{try{await window.editQueue(window.records.find(item=>item.preview?.startsWith("QUEUED_LONG_")&&!item.local));return false;}catch{return true;}});
      assert.equal(failedEdit,true);
      await page.waitForFunction(()=>window.records.some(record=>record.preview?.startsWith("QUEUED_LONG_")&&!record.local&&!record.queuePaused));
      assert.equal(store.loadCommands(session.sessionId).find(record=>record.content.startsWith("QUEUED_LONG_")).queuePaused,false,"failed read rolls back its own pause with the new revision");
      await page.route("**/api/agent/*",route=>{
        const body=route.request().postDataJSON();
        return body?.type==="queued_input_action"&&body.action==="resume"?route.fulfill({status:409,json:{error:"resume failed",code:"SESSION_BUSY"}}):route.continue();
      });
      const failedRollback=await page.evaluate(async()=>{try{await window.editQueue(window.records.find(item=>item.preview?.startsWith("QUEUED_LONG_")&&!item.local));return "";}catch(error){return error.message;}});
      assert.match(failedRollback,/恢复排队也失败/);
      await page.waitForFunction(()=>window.records.some(record=>record.preview?.startsWith("QUEUED_LONG_")&&!record.local&&record.queuePaused));
      await page.getByRole("button",{name:"继续排队",exact:true}).waitFor();
      // An existing pause must not be undone by a later failed edit attempt.
      await page.unroute("**/api/agent/*");
      await page.evaluate(async()=>{try{await window.editQueue(window.records.find(item=>item.preview?.startsWith("QUEUED_LONG_")&&!item.local));}catch{}});
      assert.equal(store.loadCommands(session.sessionId).find(record=>record.content.startsWith("QUEUED_LONG_")).queuePaused,true);
      await page.getByRole("button",{name:"继续排队",exact:true}).click();
      await page.waitForFunction(()=>window.records.some(record=>record.preview?.startsWith("QUEUED_LONG_")&&!record.local&&!record.queuePaused));
      await page.unroute("**/submissions?commandId=*");
      await page.evaluate(async () => { const record = window.records.find(item => item.preview?.startsWith("QUEUED_LONG_") && !item.local); window.queueId = record.commandId; await window.queueAction(record, "pause"); });
      await page.waitForFunction(() => window.records.some(record => record.commandId === window.queueId && record.queuePaused));
      await page.reload();
      await page.getByRole("button",{name:"继续排队",exact:true}).waitFor();
      await page.getByRole("button",{name:"继续排队",exact:true}).click();
      await page.waitForFunction(()=>window.records.some(record=>record.preview?.startsWith("QUEUED_LONG_")&&!record.local&&!record.queuePaused));
      await page.evaluate(async()=>{const record=window.records.find(record=>record.preview?.startsWith("QUEUED_LONG_")&&!record.local);window.queueId=record.commandId;await window.queueAction(record,"pause");});
      await page.waitForFunction(()=>window.records.some(record=>record.commandId===window.queueId&&record.queuePaused));
      const originalDraft = await page.evaluate(() => window.restore(window.records.find(record => record.commandId === window.queueId)));
      assert.ok(originalDraft.value.length > 180, "the editable query is not truncated to the strip preview");
      assert.equal(originalDraft.files[0].path, "D:/fixture/notes.txt");
      await page.evaluate(() => window.queueAction(window.records.find(record => record.commandId === window.queueId), "edit", "EDITED_QUEUE_QUERY"));
      await page.reload();
      await page.waitForFunction(() => window.records?.some(record => record.preview === "EDITED_QUEUE_QUERY" && record.status === "queued"));
      const editedDraft = await page.evaluate(() => window.restore(window.records.find(record => record.preview === "EDITED_QUEUE_QUERY")));
      assert.equal(editedDraft.value, "EDITED_QUEUE_QUERY", "server edits supersede the original local recovery copy");
      assert.equal(editedDraft.files[0].path, "D:/fixture/notes.txt");
      await page.evaluate(() => window.queueAction(window.records.find(record => record.preview === "EDITED_QUEUE_QUERY"), "cancel"));
      await page.waitForFunction(() => window.records.some(record => record.preview === "EDITED_QUEUE_QUERY" && record.status === "cancelled"));
      assert.equal(fixture.requests.length, 2, "editing and cancelling never sends to the model");
      const cancelledKey = await page.evaluate(() => window.records.find(record => record.preview === 'EDITED_QUEUE_QUERY').idempotencyKey);
      assert.equal(await page.locator('main > section').filter({hasText:'EDITED_QUEUE_QUERY'}).count(), 0);
      assert.equal(await page.evaluate(async key => (await window.pending()).some(record => record.id === key), cancelledKey), false);
      const archived = await page.evaluate(key => new Promise((resolve,reject) => {
        const request=indexedDB.open('piora-prompt-recovery',1);
        request.onsuccess=()=>{const db=request.result;const read=db.transaction('prompts').objectStore('prompts').get(key);read.onsuccess=()=>{resolve(read.result);db.close()};read.onerror=()=>reject(read.error)};
      }), cancelledKey);
      assert.equal(archived.dismissed, true, 'explicit deletion hides recovery without erasing original bytes');
      assert.ok(archived.draft.value.startsWith('QUEUED_LONG_'));
      // Simulate an older app's cancelled recovery copy, which had no dismissal marker.
      await page.evaluate(record => new Promise((resolve,reject)=>{
        const request=indexedDB.open('piora-prompt-recovery',1);
        request.onsuccess=()=>{const db=request.result;const tx=db.transaction('prompts','readwrite');tx.objectStore('prompts').put({...record,dismissed:false});tx.oncomplete=()=>{db.close();resolve()};tx.onabort=()=>reject(tx.error)};
      }),archived);
      await page.reload();
      await page.waitForFunction(() => window.records?.some(record => record.preview === 'ABANDONED_QUEUE_QUERY'));
      assert.equal(await page.locator('main').getByText('EDITED_QUEUE_QUERY', {exact:true}).count(),0);
      await page.waitForFunction(async key => !(await window.pending()).some(record=>record.id===key), cancelledKey);
      // IndexedDB completion and React's state commit are separate boundaries.
      await page.waitForFunction(key => !window.records.some(record=>record.idempotencyKey===key && record.local), cancelledKey);
      assert.equal(await page.evaluate(key => window.records.some(record=>record.idempotencyKey===key && record.local), cancelledKey),false);
      assert.equal(await page.locator('main > section').filter({hasText:'EDITED_QUEUE_QUERY'}).count(),0);
      const cancelledQueue = store.loadCommands(session.sessionId).find(record => record.content === "EDITED_QUEUE_QUERY");
      const untracked = await (await GET(new Request("http://localhost/api/sessions/" + session.sessionId + "/submissions?view=operations"), { params: Promise.resolve({ id: session.sessionId }) })).json();
      assert.equal(untracked.items.some(record => !record.operation), false, "historical ordinary completions must not trigger repeated history hydration");
      const tracked = await (await GET(new Request("http://localhost/api/sessions/" + session.sessionId + "/submissions?view=operations&trackedCommandId=" + cancelledQueue.commandId), { params: Promise.resolve({ id: session.sessionId }) })).json();
      assert.equal(tracked.items.find(record => record.commandId === cancelledQueue.commandId).status, "cancelled", "polling recovers terminal state when a queue event was missed");
    } finally { wrapper.isRunning = originalIsRunning; }
    assert.deepEqual(errors, []);
    await browser.close(); browser = undefined;
    cacheSessionPath(session.sessionId, wrapper.sessionFile);
    wrapper.destroy(); await wrapper.shutdownForFileMutation();
    let startups = 0;
    globalThis.__piSessions = new Map();
    globalThis.__pioraSessionMessageRouter = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => { startups++; throw new Error("Read-only commands must not start a runtime"); } });
    const offline = await POST(new Request("http://localhost/api/agent/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "submit_input", message: "/session", idempotencyKey: "offline-statistics" }) }), { params: Promise.resolve({ id: session.sessionId }) });
    assert.equal(offline.status, 200);
    const deadline = Date.now() + 5000;
    while (!store.loadCommands(session.sessionId).some(record => record.idempotencyKey === "offline-statistics" && record.status === "completed")) {
      assert.ok(Date.now() < deadline, "offline statistics did not finish");
      await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    }
    assert.equal(startups, 0);
    assert.equal(globalThis.__piSessions.size, 0);
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server) await new Promise(resolvePromise => server.close(resolvePromise));
    wrapper.destroy(); await wrapper.shutdownForFileMutation();
    globalThis.__piSessions = previousSessions; globalThis.__pioraSessionMessageRouter = previousRouter;
    for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
