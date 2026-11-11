import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("running process disclosures keep their reading anchor through virtual row changes", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-process-disclosure-"));
  let browser, stopped = false;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useRef} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatHistory} from "@/components/ChatHistory";
import {useAgentSession} from "@/hooks/useAgentSession";
const saved=[],ids=[];
for(let i=0;i<30;i++) {
  saved.push({role:"user",content:"历史问题 "+i,timestamp:1000+i*100},
    {role:"assistant",content:[{type:"text",text:("已完成的历史回复 "+i+"\\n\\n").repeat(5)}],timestamp:1050+i*100});
  ids.push("old-user-"+i,"old-answer-"+i);
}
saved.push({role:"user",content:"当前正在运行的任务",timestamp:10000});ids.push("current-user");
for(let i=0;i<45;i++) {
  saved.push({role:"assistant",content:[{type:"thinking",thinking:("处理步骤 "+i+"：检查运行情况。\\n\\n").repeat(12)},
    {type:"toolCall",toolCallId:"read-"+i,toolName:"read",input:{path:"source-"+i+".ts"}}],timestamp:11000+i*100},
    {role:"toolResult",toolCallId:"read-"+i,content:[{type:"text",text:"source line"}],timestamp:11050+i*100});
  ids.push("process-"+i,"result-"+i);
}
window.saved=saved;window.ids=ids;window.sources=[];
window.EventSource=class{static OPEN=1;static CLOSED=2;readyState=1;constructor(url){this.url=location.origin+url;window.sources.push(this);setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}),0)}close(){this.readyState=2}};
let revision=0;
window.advance=()=>{revision++;window.sources.filter(s=>s.readyState===1&&s.url.includes("transport=delta")).forEach(s=>s.onmessage?.({data:JSON.stringify({type:"message_update",message:{role:"assistant",content:[{type:"thinking",thinking:"LIVE_PROCESS_CONTENT "+revision}],timestamp:20000}})}))};
const session={id:"fixture",cwd:"C:/fixture",name:"Fixture",modified:"one"};
function App(){
  const state=useAgentSession({session,newSessionCwd:null}),history=useRef(null);
  window.state=state;
  window.reveal=()=>{state.pauseHistoryFollow();history.current.revealEntry("current-user")};
  window.resume=()=>state.handleScrollToBottom();
  return <main><button style={{position:"fixed",top:8,right:8}} onClick={()=>void state.handleAbort()}>停止任务</button><div id="chat-scroll-container" className="overflow-y-auto" ref={state.scrollContainerRef}><div>{!state.loading&&<ChatHistory
    messages={state.messages} entryIds={state.entryIds} compactProcess streamingMessage={state.streamState.streamingMessage}
    busy={state.agentRunning} streaming={state.streamState.isStreaming} interruptionId={state.interruptedRunId} isNew={false} forkingEntryId={null} highlightedEntryId={null} lastUserMsgRef={state.lastUserMsgRef}
    pendingScrollToUserRef={state.pendingScrollToUserRef} scrollContainer={state.scrollContainerRef} handleRef={history} sessionId="fixture" />}
    {state.agentRunning&&<div data-chat-tail-spacer style={{height:800}}/>}</div></div></main>;
}
createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ locale: "zh-CN", viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://127.0.0.1:38201/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/agent/fixture" && route.request().method() === "POST") {
        assert.ok(["abort", "cancel_prompt_submission"].includes(route.request().postDataJSON().type));
        stopped = true;
        return route.fulfill({ json: { success: true, data: null } });
      }
      if (pathname === "/api/sessions/fixture") {
        const context = await page.evaluate(() => ({ messages: window.saved, entryIds: window.ids }));
        if (stopped) {
          context.messages.push({ role: "assistant", content: [], stopReason: "aborted", errorMessage: "Operation aborted", timestamp: Date.now() });
          context.entryIds.push("interrupted-assistant");
        }
        return route.fulfill({ json: { context, leafId: context.entryIds.at(-1), tree: [], info: { id: "fixture", cwd: "C:/fixture" } } });
      }
      if (pathname === "/api/agent/fixture" || pathname === "/api/sessions/fixture/state") return route.fulfill({ json: {
        running: !stopped, state: { runtime: stopped ? "idle" : "running", isStreaming: !stopped, isPromptRunning: !stopped },
      } });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { items: [], operations: [], commands: [], taskTimings: [], submissions: [], records: [], hasMore: false } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
        body{margin:0;background:var(--bg);color:var(--text)}main{max-width:800px;margin:auto;height:100vh;display:flex;flex-direction:column}
        #chat-scroll-container{overflow:auto;flex:1;min-height:0;padding:24px}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    await page.goto("http://127.0.0.1:38201/");
    await page.waitForFunction(() => window.state?.agentRunning && !window.state.loading && window.sources.some(s => s.url.includes("transport=delta")), null, { timeout: 10000 })
      .catch(async error => { throw new Error(`${error.message}; ${errors.join("; ")}; ${JSON.stringify(await page.evaluate(() => ({ loading: window.state?.loading, error: window.state?.error, running: window.state?.agentRunning, sources: window.sources?.map(s => s.url), text: document.body.innerText.slice(-800) })))}`); });
    await page.evaluate(() => window.advance());
    await page.evaluate(() => window.reveal());
    const heading = page.locator(".compact-process-toggle");
    await heading.waitFor();
    await heading.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const output = path.join(repo, ".verification/process-disclosure-20261111");
    await mkdir(output, { recursive: true });
    const cycles = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const expanded of [false, true]) {
        if (expanded) {
          await page.evaluate(() => window.resume());
          await page.waitForFunction(() => window.state.liveOutputFollowPaused === false);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        }
        await page.evaluate(() => {
          const heading = document.querySelector(".compact-process-toggle");
          const scroller = document.querySelector("#chat-scroll-container");
          window.probe = { top: 0, frames: [], removedHeading: false };
          const observer = new MutationObserver(() => { if (!heading.isConnected) window.probe.removedHeading = true; });
          observer.observe(scroller, { childList: true, subtree: true });
          window.stopProbe = () => observer.disconnect();
          const sample = () => {
            const rect = heading.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
            window.probe.frames.push({ top: rect.top, scrollTop: scroller.scrollTop, connected: heading.isConnected,
              visible: [...scroller.querySelectorAll("[data-virtual-key]")].filter(row => {
                const box = row.getBoundingClientRect(); return box.bottom > viewport.top && box.top < viewport.bottom;
              }).map(row => row.dataset.virtualKey) });
            if (window.probe.frames.length < 24) requestAnimationFrame(sample);
          };
          heading.addEventListener("click", () => {
            window.probe.top = heading.getBoundingClientRect().top;
            requestAnimationFrame(sample);
          }, { capture: true, once: true });
        });
        if (cycle === 1) await heading.press("Enter");
        else if (cycle === 2) await heading.press("Space");
        else await heading.click();
        assert.equal(await heading.getAttribute("aria-expanded"), String(expanded));
        assert.equal(await page.evaluate(() => window.state.liveOutputFollowPaused), true, "manual disclosure pauses live following immediately");
        await page.evaluate(() => window.advance());
        await page.waitForFunction(() => window.probe.frames.length === 24);
        const probe = await page.evaluate(() => { window.stopProbe(); return window.probe; });
        cycles.push({ cycle, expanded, ...probe });
        await writeFile(path.join(output, "frames.json"), JSON.stringify(cycles, null, 2));
        assert.deepEqual(errors, []);
        assert.equal(probe.removedHeading, false, "the clicked process heading stays mounted");
        // Collapsing the final turn can legitimately clamp at the new bottom.
        // Reopening has enough space to preserve that settled reading position.
        if (expanded) assert.ok(probe.frames.every(frame => frame.connected && Math.abs(frame.top - probe.top) <= 2),
          `process heading jumped from ${probe.top} to ${Math.min(...probe.frames.map(frame => frame.top))}…${Math.max(...probe.frames.map(frame => frame.top))}; see frames.json`);
        assert.ok(probe.frames.every(frame => frame.visible.length > 0), "the conversation never paints an empty virtual window");
      }
    }
    assert.equal(await page.evaluate(() => window.state.agentRunning && window.state.streamState.streamingMessage?.content.some(block => block.thinking?.startsWith("LIVE_PROCESS_CONTENT"))), true,
      "streaming continues while details are inspected");
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, "running-expanded.png") });
    await page.evaluate(() => window.resume());
    await page.waitForFunction(() => {
      const scroller = document.querySelector("#chat-scroll-container"), spacer = scroller.querySelector("[data-chat-tail-spacer]");
      return !window.state.liveOutputFollowPaused && Math.abs(scroller.scrollHeight - spacer.offsetHeight - scroller.clientHeight - scroller.scrollTop) <= 2;
    });
    await page.evaluate(() => window.advance());
    await page.waitForFunction(() => {
      const scroller = document.querySelector("#chat-scroll-container"), spacer = scroller.querySelector("[data-chat-tail-spacer]");
      return Math.abs(scroller.scrollHeight - spacer.offsetHeight - scroller.clientHeight - scroller.scrollTop) <= 2;
    });
    await page.evaluate(() => window.reveal());
    await heading.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "停止任务", exact: true }).click();
    await page.waitForFunction(() => !window.state.agentRunning && !window.state.streamState.isStreaming);
    assert.equal(await heading.getAttribute("aria-expanded"), "true", "stopping preserves the expanded process before and after history hydration");
    await page.waitForTimeout(200);
    assert.equal(await heading.getAttribute("aria-expanded"), "true");
    await page.reload();
    await page.waitForFunction(() => window.state && !window.state.loading);
    await page.evaluate(() => window.reveal());
    assert.equal(await heading.getAttribute("aria-expanded"), "true", "saved interrupted history defaults to expanded");
    stopped = false;
    await page.reload();
    await page.waitForFunction(() => window.state?.agentRunning && !window.state.loading);
    await page.evaluate(() => window.reveal());
    await heading.click();
    assert.equal(await heading.getAttribute("aria-expanded"), "false");
    await page.getByRole("button", { name: "停止任务", exact: true }).click();
    await page.waitForFunction(() => !window.state.agentRunning && !window.state.streamState.isStreaming);
    await page.waitForTimeout(200);
    assert.equal(await heading.getAttribute("aria-expanded"), "false", "stopping also preserves an earlier manual collapse");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-process-disclosure-"));
    await rm(directory, { recursive: true, force: true });
  }
});
