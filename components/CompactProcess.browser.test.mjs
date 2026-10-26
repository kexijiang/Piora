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

test("chat hides intermediate footers and gaps, opens live logs only on request, and defaults compact display off", { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-compact-process-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatHistory} from "@/components/ChatHistory";
import {useCompactProcessPreference} from "@/hooks/useCompactProcessPreference";
function App(){
  const {enabled,setEnabled}=useCompactProcessPreference();
  const [done,finish]=useState(false), [output,setOutput]=useState("old line\\none\\ntwo\\nthree"), [attention,setAttention]=useState(false), [draft,setDraft]=useState(null);
  const [failed,setFailed]=useState(false), [next,setNext]=useState(false), [mixed,setMixed]=useState(false), [activities,setActivities]=useState(false);
  const [activityCommand,setActivityCommand]=useState("Get-Content Z:/workspace/CreateMyCard/docs/project-overview.md -TotalCount 80");
  const scroll=useRef(null), lastUser=useRef(null), pending=useRef(false), history=useRef(null);
  const user={role:"user",content:"修复 Shell 实时输出的问题",timestamp:Date.now()-15000};
  const assistant={role:"assistant",content:[{type:"thinking",thinking:"检查事件传递与输出更新。"},{type:"toolCall",toolCallId:"shell",toolName:"bash",input:{command:"npm run test"}}],timestamp:user.timestamp+1000};
  const result={role:"toolResult",toolCallId:"shell",isError:failed,isStreaming:!done,content:[{type:"text",text:output}],timestamp:user.timestamp+12000};
  const messages=[user,assistant,result,{role:"assistant",content:[{type:"toolCall",toolCallId:"shell2",toolName:"powershell",input:{command:"echo second"}},
    {type:"toolCall",toolCallId:"shell3",toolName:"bash",input:{command:"echo third"}}],timestamp:user.timestamp+13000},
    {role:"toolResult",toolCallId:"shell2",isStreaming:!done,content:[{type:"text",text:"second command output"}],timestamp:user.timestamp+15000},
    {role:"toolResult",toolCallId:"shell3",isStreaming:!done,content:[{type:"text",text:"third command output"}],timestamp:user.timestamp+18000}];
  if(attention) messages.push({role:"assistant",content:[{type:"toolCall",toolCallId:"wait",toolName:"browser",input:{action:"wait_for_user",reason:"请完成登录"}}]});
  if(done) messages.push({role:"assistant",content:[{type:"text",text:"## 已修复 Shell 实时输出\\n\\n执行日志现在会实时更新。\\n\\n- 运行时显示最新输出\\n- 支持展开查看完整日志"}],timestamp:user.timestamp+19000});
  if(next) messages.push({role:"user",content:"下一轮输入",timestamp:user.timestamp+20000});
  if(mixed) messages.splice(0,messages.length,user,{...assistant,content:[{type:"text",text:"先说明计划"},{type:"toolCall",toolCallId:"shell",toolName:"bash",input:{command:"echo checked"}},{type:"text",text:"中途说明"},{type:"thinking",thinking:"",deferred:true},{type:"text",text:"最后的说明"}]},result,{role:"assistant",content:[{type:"text",text:Array.from({length:80},(_,i)=>"段落 "+i+"：用于验证阅读位置和历史加载。").join("\\n\\n")}],timestamp:user.timestamp+19000});
  window.mix=()=>{setMixed(true);finish(true)};
  if(activities) {
    const tools=[{toolName:"read",input:{path:"README.md",offset:10,limit:20}},{toolName:"ls",input:{path:"src"}},{toolName:"grep",input:{pattern:"test"}},{toolName:"find",input:{pattern:"*.md",path:"docs"}},{toolName:"write",input:{path:"notes.md",content:"updated"}},{toolName:"powershell",input:{command:activityCommand}}];
    const outputs=[Array.from({length:20},(_,i)=>"saved source line "+(i+10)+(i===2?" long code".repeat(80):"")).join("\\n")+"\\n\\n[7 more lines in file. Use offset=30 to continue.]", "components/\\nmain.ts", "src/main.ts-4- before\\nsrc/main.ts:5: test example\\nsrc/other.ts:8: second test", "guide.md\\nintro.md", "ok", "ok"];
    messages.splice(0,messages.length,user,{...assistant,content:[{type:"thinking",thinking:"先查看文件，再验证。"},...tools.map((tool,i)=>({type:"toolCall",toolCallId:"activity"+i,...tool}))]},
      ...tools.map((tool,i)=>({role:"toolResult",toolCallId:"activity"+i,toolName:tool.toolName,content:[{type:"text",text:outputs[i]}]})));
  }
  window.activities=(command)=>{if(command)setActivityCommand(command);setActivities(true);finish(true)};
  window.next=()=>setNext(true);
  window.setLog=setOutput;
  window.advance=()=>setOutput("old line\\r\\none\\r\\ntwo\\r\\nthree\\r\\nfour\\r\\nfive");
  window.advanceAgain=()=>setOutput("old line\\none\\ntwo\\nthree\\nfour\\nfive\\nsix");
  window.think=()=>setDraft({role:"assistant",content:[{type:"thinking",thinking:"正在验证新输出"},{type:"text",text:"正在流式生成的正式回复"}],timestamp:Date.now()});
  window.finish=()=>{setDraft(null);finish(true)}; window.waitForUser=()=>setAttention(true);
  window.fail=()=>{setFailed(true);finish(true)};
  window.setCompact=setEnabled;
  window.revealEntry=(id)=>history.current.revealEntry(id);
  return <I18nProvider><main><header>Piora <button role="switch" aria-label="轻量过程展示" aria-checked={enabled} onClick={()=>setEnabled(!enabled)}>轻量过程展示</button></header>
    <div id="scroll" className="overflow-y-auto" ref={scroll}><div className="chat-column">
      <ChatHistory messages={messages} entryIds={mixed?["u","mixed","r","answer"]:["u","a","r","a2","r2","r3",...(attention?["wait"]:[]),...(done?["answer"]:[]),...(next?["next"]:[])]} compactProcess={enabled}
        streamingMessage={draft} busy={!done} streaming={Boolean(draft)} isNew={false} forkingEntryId={null} highlightedEntryId={null} lastUserMsgRef={lastUser}
        pendingScrollToUserRef={pending} scrollContainer={scroll} handleRef={history} sessionId="fixture" cwd="Z:/workspace/CreateMyCard" onOpenFile={path=>window.openedFile=path} onDeleteMessage={async()=>{}} />
    </div></div><footer>发送消息…</footer></main></I18nProvider>;
}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1200, height: 900 } });
    const errors = [];
    const thinkingRequests = [];
    await context.route("http://compact.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/thinking")) {
        thinkingRequests.push(route.request().url());
        return route.fulfill({json:{thinking:"历史完整思考内容"}});
      }
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { success: true, data: {} } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
        body{height:100vh;overflow:hidden;background:#faf6f3;font-family:var(--ui-font-family)}main{max-width:900px;margin:24px auto;height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:14px}
        header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between}header button{font-size:13px;color:var(--accent)}
        #scroll{overflow:auto;flex:1;min-height:0;padding:24px}.chat-column{max-width:760px;margin:auto}footer{margin:16px;padding:16px;border:1px solid var(--border);border-radius:12px;color:var(--text-muted)}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    const page = await context.newPage();
    const screenshot = async (name) => {
      if (!process.env.PIORA_COMPACT_SCREENSHOTS) return;
      const output = path.join(repo, "test-results", "compact-process");
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: "disabled" });
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://compact.test/");
    const toggle = page.getByRole("switch", { name: "轻量过程展示" });
    await page.locator(".command-execution-card").first().waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.locator(".command-output-section").count(), 0);
    assert.equal(await page.locator(".message-row-assistant .message-response-meta").count(), 0);
    assert.equal(await page.locator(".message-row-assistant .message-delete-button").count(), 0);
    const gaps = await page.locator(".command-execution-card").evaluateAll(cards => cards.slice(1).map((card, index) => card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom));
    assert.equal(gaps.length, 2);
    for (const gap of gaps) assert.ok(Math.abs(gap) < 0.5, `consecutive shell spacing: ${gap}`);
    assert.ok(await page.locator(".chat-process-stack, .chat-process-stack .chat-disclosure--surface").evaluateAll(elements => elements.every(element => {
      const style = getComputedStyle(element);
      return style.borderTopWidth === "0px" && style.borderBottomWidth === "0px" && style.backgroundColor === "rgba(0, 0, 0, 0)";
    })));
    assert.equal(await page.locator(".compact-process-group").count(), 1);
    assert.equal(await page.locator(".chat-process-stack-heading").count(), 0);
    assert.equal(await page.locator(".command-execution-card .chat-disclosure-label").first().innerText(), "运行命令");
    const activityHeading = page.locator('[data-tool-activity="command"] .tool-activity-toggle');
    assert.match(await activityHeading.innerText(), /执行 3 条命令/);
    assert.ok(await page.locator(".command-execution-toggle").first().evaluate(element =>
      element.getBoundingClientRect().left > document.querySelector(".thinking-block-trigger").getBoundingClientRect().left + 16));
    await activityHeading.click();
    assert.equal(await page.locator(".command-execution-card").count(), 0);
    assert.equal(await page.locator(".thinking-block").count(), 1);
    await page.evaluate(() => window.advance());
    assert.equal(await activityHeading.getAttribute("aria-expanded"), "false");
    await page.locator(".compact-process-toggle").click();
    await page.locator(".compact-process-toggle").click();
    assert.equal(await activityHeading.getAttribute("aria-expanded"), "false");
    await page.evaluate(() => window.revealEntry("a2"));
    await page.waitForFunction(() => document.querySelectorAll(".command-execution-card").length === 3);
    await screenshot("grouped");
    const processHeading = page.locator(".compact-process-toggle").first();
    assert.equal(await processHeading.getAttribute("aria-expanded"), "true");
    await processHeading.click();
    assert.equal(await processHeading.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".command-execution-card, .thinking-block").count(), 0);
    assert.equal(await page.locator('[data-process-join-after="true"]').count(), 0);
    await page.evaluate(() => window.advance());
    assert.equal(await processHeading.getAttribute("aria-expanded"), "false");
    await screenshot("group-collapsed");
    await processHeading.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".command-execution-card").length === 3);
    assert.equal(await page.locator(".command-execution-card").count(), 3);
    await processHeading.click();
    await page.evaluate(() => window.revealEntry("a2"));
    await page.waitForFunction(() => document.querySelectorAll(".command-execution-card").length === 3);
    assert.equal(await processHeading.getAttribute("aria-expanded"), "true");
    await page.locator(".command-execution-card .chat-disclosure-trigger").first().click();
    await page.locator(".cm-content").waitFor();
    assert.equal(await page.locator(".cm-content").evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text)";
      element.append(probe);
      const matches = getComputedStyle(element).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    }), true, "expanded process output uses primary text color for readability");
    const card = page.locator(".command-execution-card.is-expanded").first();
    const diagnosticsToggle = card.getByRole("button", {name:"诊断信息", exact:true});
    assert.equal(await diagnosticsToggle.getAttribute("aria-expanded"), "false");
    await diagnosticsToggle.click();
    await card.locator(".command-diagnostics").waitFor();
    assert.equal(await diagnosticsToggle.getAttribute("aria-controls"), await card.locator(".command-diagnostics").getAttribute("id"));
    assert.ok(await card.evaluate(element => {
      const toolbars = [...element.querySelectorAll(".command-section-toolbar")];
      const titles = toolbars.map(toolbar => toolbar.querySelector(".command-section-label"));
      const bodies = [element.querySelector(".command-source-section pre"), element.querySelector(".cm-content"), element.querySelector(".command-diagnostics")];
      const reference = getComputedStyle(bodies[0]);
      return toolbars.length === 3 && toolbars.every(toolbar => toolbar.getBoundingClientRect().height === 36)
        && titles.every(title => Math.abs(title.getBoundingClientRect().left - titles[0].getBoundingClientRect().left) < 1
          && getComputedStyle(title).fontSize === getComputedStyle(titles[0]).fontSize)
        && bodies.every(body => {const style=getComputedStyle(body);return style.fontFamily===reference.fontFamily && style.fontSize===reference.fontSize && style.lineHeight===reference.lineHeight;})
        && reference.fontFamily.includes("Consolas")
        && getComputedStyle(element.querySelector(".command-section-toggle")).borderRadius === "0px";
    }), "all three sections share aligned titles, toolbar heights and code typography without an inner rounded card");
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {configurable:true,value:{writeText:async text => {window.copiedText=text;}}}));
    for (const [section, label, content] of [
      [".command-source-section", "复制完整命令", ".command-source-section pre"],
      [".command-output-section", "复制输出", ".cm-content"],
      [".command-diagnostics-section", "复制诊断信息", ".command-diagnostics"],
    ]) {
      const expected = (await card.locator(content).innerText()).replace(/\r\n/g, "\n");
      await card.locator(section).getByRole("button", {name:label,exact:true}).click();
      assert.equal((await page.evaluate(() => window.copiedText)).replace(/\r\n/g, "\n"), expected);
    }
    for (const dark of [false, true]) {
      await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
      assert.ok(await card.evaluate(element => {
        const style = getComputedStyle(element);
        const source = getComputedStyle(element.querySelector(".command-source-section"));
        const output = getComputedStyle(element.querySelector(".command-output-section"));
        return style.borderTopWidth === "1px" && style.backgroundColor !== "rgba(0, 0, 0, 0)"
          && source.backgroundColor !== output.backgroundColor && source.borderBottomWidth === "1px";
      }), "expanded card separates command and output in either theme");
      await screenshot(dark ? "command-dark" : "command-light");
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await diagnosticsToggle.click();
    await diagnosticsToggle.press("Enter");
    assert.equal(await diagnosticsToggle.getAttribute("aria-expanded"), "true");
    await diagnosticsToggle.press("Enter");
    assert.ok(await card.locator(".cm-scroller").evaluate(element => element.clientHeight < 200), "short logs fit their contents");
    assert.equal(await card.locator(".command-output-expand").count(), 0);
    await page.evaluate(() => window.setLog(Array.from({length:80}, (_,i) => `output line ${i+1}`).join("\n")));
    await card.getByRole("button", {name:"展开当前输出",exact:true}).waitFor();
    assert.equal(await card.locator(".command-output-section > .command-section-toolbar .command-output-expand").count(), 1, "output expansion lives alongside the other toolbar actions");
    assert.ok(await card.locator(".cm-scroller").evaluate(element => element.clientHeight <= 320 && element.scrollHeight > element.clientHeight));
    await card.getByRole("button", {name:"展开当前输出",exact:true}).click();
    await page.waitForFunction(() => document.querySelector(".cm-scroller")?.clientHeight > 1000);
    assert.match(await card.locator(".cm-content").innerText(), /output line 80/);
    await card.getByRole("button", {name:"收起输出",exact:true}).click();
    await page.waitForFunction(() => document.querySelector(".cm-scroller")?.clientHeight <= 320);
    await card.getByRole("button", {name:"搜索输出",exact:true}).click();
    await card.locator(".cm-search input[name=search]").fill("output line 70");
    await card.locator(".cm-search input[name=search]").dispatchEvent("change");
    await card.locator(".cm-search input[name=search]").press("Enter");
    await card.locator(".cm-searchMatch-selected").waitFor();
    await card.locator(".cm-search input[name=search]").press("Escape");
    await card.getByRole("button", {name:"关闭自动换行",exact:true}).click();
    await card.getByRole("button", {name:"开启自动换行",exact:true}).click();
    await card.getByRole("button", {name:"跳到输出末尾",exact:true}).click();
    await page.waitForFunction(() => {const el=document.querySelector(".cm-scroller");return el.scrollHeight-el.scrollTop-el.clientHeight<8;});
    await page.setViewportSize({width:390,height:844});
    await card.locator(".command-source-section").scrollIntoViewIfNeeded();
    assert.ok(await card.locator(".command-cwd").isVisible(), "working directory stays available on narrow screens");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await screenshot("command-mobile");
    await page.setViewportSize({width:1200,height:900});
    await page.evaluate(() => window.advance());
    await page.waitForFunction(() => !document.querySelector(".command-output-expand"));
    await screenshot("running");
    await page.evaluate(() => window.advance());
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("five"));
    assert.match(await page.locator(".cm-content").innerText(), /four\nfive/);
    await page.evaluate(() => window.advanceAgain());
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("six"));
    await page.locator(".command-execution-card .chat-disclosure-trigger").first().click();
    await toggle.click();
    await activityHeading.click();
    await page.locator(".compact-process-toggle").click();
    await page.locator(".compact-process-preview").waitFor();
    assert.equal(await page.locator(".compact-command-tail, .command-output-section").count(), 0);
    await page.locator(".compact-process-preview .compact-command-expand").first().click();
    await page.locator(".cm-content").waitFor();
    assert.match(await page.locator(".cm-content").innerText(), /six/);
    assert.equal(await page.locator(".compact-process-detail .message-response-meta").count(), 0);
    await page.evaluate(() => window.finish());
    await page.locator(".markdown-assistant-message h2").waitFor();
    assert.equal(await page.locator(".markdown-assistant-message h2").evaluate(element => {
      const probe = document.createElement("span");
      probe.style.color = "var(--text-muted)";
      element.append(probe);
      const differs = getComputedStyle(element).color !== getComputedStyle(probe).color;
      probe.remove();
      return differs;
    }), true, "final answer keeps its primary text color");
    assert.equal(await page.locator(".message-row-assistant .message-response-meta").count(), 1);
    assert.equal(await page.locator(".compact-process-toggle").getAttribute("aria-expanded"), "true");
    await screenshot("expanded");
    await page.locator(".compact-process-toggle").click();
    assert.equal(await page.locator(".command-execution-card").count(), 0);
    assert.match(await page.locator(".markdown-assistant-message").innerText(), /已修复 Shell/);
    await screenshot("completed");
    await toggle.click();
    assert.equal(await page.locator(".command-execution-card").count(), 0);
    assert.equal(await page.locator(".compact-process-group").count(), 1);
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
    assert.equal(await page.locator(".compact-process-group").count(), 1);
    await toggle.click();
    await page.locator(".compact-process-group").waitFor();
    // Another same-origin window receives the preference without reload.
    const second = await context.newPage();
    await second.goto("http://compact.test/");
    await second.locator(".compact-process-group").waitFor();
    await toggle.click();
    await second.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
    await toggle.click();
    await second.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await second.evaluate(() => window.think());
    await second.getByText("正在流式生成的正式回复", { exact: true }).waitFor();
    assert.equal(await second.locator(".compact-process-group").count(), 1);
    await second.evaluate(() => window.finish());
    await second.locator(".markdown-assistant-message h2").waitFor();
    assert.equal(await second.locator(".compact-process-toggle").getAttribute("aria-expanded"), "true");
    await second.evaluate(() => window.next());
    await second.getByText("下一轮输入", {exact:true}).waitFor();
    assert.equal(await second.locator(".compact-process-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await second.getByText("正在流式生成的正式回复", { exact: true }).count(), 0);
    await page.evaluate(() => window.waitForUser());
    await page.getByText("请完成登录", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "我已完成，继续" }).count(), 1);
    assert.equal(await page.locator(".compact-process-toggle").getAttribute("aria-expanded"), "true");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await screenshot("mobile-attention");
    // An untouched successful group folds; manual choices and unresolved work remain visible.
    await page.evaluate(() => window.setCompact(false));
    for (const scenario of ["success", "manual-open", "manual-closed", "log-open", "failed", "attention"]) {
      const check = await context.newPage();
      check.on("pageerror", error => errors.push(error.message));
      await check.goto("http://compact.test/");
      const heading = check.locator(".compact-process-toggle").first();
      await heading.waitFor();
      if (scenario.startsWith("manual")) {
        await heading.click();
        if (scenario === "manual-open") await heading.click();
      }
      if (scenario === "log-open") await check.locator(".command-execution-toggle").first().click();
      if (scenario === "failed") await check.locator(".tool-activity-toggle").click();
      await check.evaluate(scenario => {
        if (scenario === "attention") window.waitForUser();
        if (scenario === "failed") window.fail(); else window.finish();
      }, scenario);
      await check.locator(".markdown-assistant-message h2").waitFor();
      const shouldExpand = scenario !== "manual-closed";
      assert.equal(await heading.getAttribute("aria-expanded"), String(shouldExpand), scenario);
      assert.equal(await check.locator(".command-execution-card").count(), shouldExpand ? 3 : 0, scenario);
      if (scenario === "success") {
        assert.match(await heading.innerText(), /处理结束.*思考 1 段.*执行 3 条命令/s);
        if (process.env.PIORA_COMPACT_SCREENSHOTS) await check.screenshot({ path: path.join(repo, "test-results", "compact-process", "auto-completed.png") });
      }
      await check.evaluate(() => window.next());
      await check.getByText("下一轮输入", {exact:true}).waitFor();
      const keepOpen = ["manual-open", "log-open", "failed", "attention"].includes(scenario);
      assert.equal(await heading.getAttribute("aria-expanded"), String(keepOpen), scenario + " after next input");
      assert.equal(await check.locator(".command-execution-card").count(), keepOpen ? 3 : 0);
      await check.close();
    }
    const activitiesPage = await context.newPage();
    activitiesPage.on("pageerror", error => errors.push(error.message));
    await activitiesPage.goto("http://compact.test/");
    await activitiesPage.evaluate(() => window.activities());
    await activitiesPage.locator('[data-tool-activity="read"]').waitFor();
    assert.deepEqual(await activitiesPage.locator('[data-tool-activity]').evaluateAll(rows => rows.map(row => row.dataset.toolActivity)), ["read","directory","search","edit","command"]);
    const icons = await activitiesPage.locator('.tool-activity-heading .chat-disclosure-icon svg').evaluateAll(elements => elements.map(element => element.innerHTML));
    assert.equal(new Set(icons).size,5,"file, folder, search, edit and terminal icons differ");
    assert.equal(await activitiesPage.locator('.command-execution-toggle .chat-disclosure-icon svg').innerHTML(),icons[4]);
    assert.equal(await activitiesPage.locator('.command-execution-toggle .chat-disclosure-label').innerText(),"运行命令","shell file reads remain discoverable as command execution");
    const fileCards=activitiesPage.locator('.tool-call-card');
    await fileCards.nth(0).locator('.tool-call-toggle').click();
    const readCard=activitiesPage.locator('[data-file-result="read"]');
    assert.equal(await readCard.locator('.file-tool-line').count(),8);
    assert.equal(await readCard.locator('.file-tool-line-number').first().innerText(),"10");
    assert.equal(await readCard.locator('.file-tool-line-number').last().innerText(),"29");
    assert.match(await readCard.locator('.file-tool-notice').innerText(),/7 more lines/);
    await readCard.getByRole('button',{name:'显示其余 12 行'}).click();
    assert.equal(await readCard.locator('.file-tool-line').count(),20);
    await readCard.getByRole('button',{name:'README.md',exact:true}).click();
    assert.equal(await activitiesPage.evaluate(()=>window.openedFile),"Z:/workspace/CreateMyCard/README.md");
    await readCard.getByRole('button',{name:'收起内容',exact:true}).click();
    if (process.env.PIORA_COMPACT_SCREENSHOTS) await activitiesPage.screenshot({path:path.join(repo,"test-results","compact-process","file-read.png")});
    await activitiesPage.setViewportSize({width:390,height:844});
    assert.ok(await activitiesPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),"long source lines scroll inside the file card on mobile");
    assert.ok(await readCard.locator('.file-tool-lines').evaluate(element=>element.scrollWidth > element.clientWidth));
    await activitiesPage.setViewportSize({width:1200,height:900});
    await fileCards.nth(1).locator('.tool-call-toggle').click();
    const directoryCard=activitiesPage.locator('[data-file-result="ls"]');
    assert.equal(await directoryCard.getByRole('button').count(),1,"directories are labelled, only files open in the file viewer");
    await directoryCard.getByRole('button',{name:'main.ts',exact:true}).click();
    assert.equal(await activitiesPage.evaluate(()=>window.openedFile),"Z:/workspace/CreateMyCard/src/main.ts");
    await fileCards.nth(2).locator('.tool-call-toggle').click();
    const searchCard=activitiesPage.locator('[data-file-result="grep"]');
    assert.equal(await searchCard.locator('.file-tool-search-group').count(),2);
    assert.equal(await searchCard.locator('.is-match').count(),2);
    await searchCard.getByRole('button',{name:'src/main.ts',exact:true}).click();
    assert.equal(await activitiesPage.evaluate(()=>window.openedFile),"Z:/workspace/CreateMyCard/src/main.ts");
    await fileCards.nth(3).locator('.tool-call-toggle').click();
    await activitiesPage.locator('[data-file-result="find"]').getByRole('button',{name:'guide.md',exact:true}).click();
    assert.equal(await activitiesPage.evaluate(()=>window.openedFile),"Z:/workspace/CreateMyCard/docs/guide.md");
    if (process.env.PIORA_COMPACT_SCREENSHOTS) await activitiesPage.screenshot({path:path.join(repo,"test-results","compact-process","file-results.png")});
    for (let i=0;i<4;i++) await fileCards.nth(i).locator('.tool-call-toggle').click();
    const preview = activitiesPage.locator('.command-summary-preview');
    assert.ok(await preview.evaluate(element => element.scrollWidth <= element.clientWidth + 1), "a command that fits the row is not prematurely clipped");
    if (process.env.PIORA_COMPACT_SCREENSHOTS) await activitiesPage.screenshot({path:path.join(repo,"test-results","compact-process","activity-types.png")});
    const longCommand = "Get-Content Z:/workspace/" + "long-directory/".repeat(25) + "README.md";
    await activitiesPage.evaluate(command => window.activities(command),longCommand);
    await activitiesPage.waitForFunction(command => document.querySelector('.command-summary-preview')?.textContent === command,longCommand);
    const widths=[];
    for (const width of [1200,700]) {
      await activitiesPage.setViewportSize({width,height:900});
      const metrics=await preview.evaluate(element => ({
        width:element.getBoundingClientRect().width,available:element.parentElement.getBoundingClientRect().width,
        clipped:element.scrollWidth > element.clientWidth,ellipsis:getComputedStyle(element).textOverflow,
        statusInside:element.closest('button').querySelector('.chat-disclosure-meta').getBoundingClientRect().right <= element.closest('.command-execution-card').getBoundingClientRect().right,
      }));
      assert.ok(Math.abs(metrics.width-metrics.available)<1,"long commands use all available description space");
      assert.ok(metrics.clipped && metrics.ellipsis === "ellipsis","only overflowing commands get an ellipsis");
      assert.ok(metrics.statusInside,"execution status remains inside the row");
      assert.equal(await preview.getAttribute('title'),longCommand,"the tooltip preserves the complete command");
      widths.push(metrics.width);
      assert.ok(await activitiesPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    assert.ok(widths[0]>widths[1],"preview width follows the available window width");
    await activitiesPage.setViewportSize({width:390,height:844});
    assert.ok(await activitiesPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await activitiesPage.close();
    const mixed = await context.newPage();
    mixed.on("pageerror", error => errors.push(error.message));
    await mixed.goto("http://compact.test/");
    await mixed.evaluate(() => window.mix());
    await mixed.getByText("先说明计划", {exact:true}).waitFor();
    for (const width of [1200, 390]) {
      await mixed.setViewportSize({ width, height: 900 });
      const textBounds = await mixed.getByText("先说明计划", {exact:true}).boundingBox();
      assert.ok(textBounds);
      const alignment = await mixed.evaluate(edge => {
        return [...document.querySelectorAll(".compact-process-detail")].map(element => ({
          left: element.getBoundingClientRect().left, edge, border: getComputedStyle(element).borderLeftWidth,
        }));
      }, textBounds.x);
      assert.ok(alignment.length > 0);
      for (const row of alignment) {
        assert.equal(row.border, "1px");
        assert.ok(Math.abs(row.left - row.edge) <= 1, `process rail aligns with answer at ${width}px: ${JSON.stringify(row)}`);
      }
    }
    await mixed.setViewportSize({ width: 1200, height: 900 });
    const mixedHeading = mixed.locator(".compact-process-toggle");
    await mixed.locator(".thinking-block-trigger").click();
    await mixed.getByText("历史完整思考内容", {exact:true}).waitFor();
    assert.equal(new URL(thinkingRequests.at(-1)).searchParams.get("blockIndex"), "3");
    const toggleAtReadingPosition = async (partiallyClipped) => {
      await mixedHeading.evaluate((element, partiallyClipped) => {
        const scroller = document.querySelector("#scroll");
        scroller.scrollTop = partiallyClipped
          ? scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 8
          : 20;
        window.disclosureAnchor = null;
        // Playwright can scroll a partly clipped button into view before it
        // clicks. Measure at the actual click, before React handles the event.
        element.addEventListener("click", () => {
          const anchor = window.disclosureAnchor = { top: element.getBoundingClientRect().top, samples: [] };
          const sample = () => {
            anchor.samples.push(element.getBoundingClientRect().top);
            if (anchor.samples.length < 6) requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        }, { capture: true, once: true });
      }, partiallyClipped);
      await mixedHeading.click();
      await mixed.waitForFunction(() => window.disclosureAnchor?.samples.length === 6);
      const anchor = await mixed.evaluate(() => window.disclosureAnchor);
      for (const top of anchor.samples) assert.ok(Math.abs(top - anchor.top) < 1,
        `disclosure moved after click: ${JSON.stringify({ partiallyClipped, ...anchor })}`);
    };
    // Exercise normal and auto-scrolled clicks, in both directions. Checking
    // every frame also catches late virtual-row measurements moving the title.
    for (const partiallyClipped of [false, true]) {
      await toggleAtReadingPosition(partiallyClipped);
      assert.equal(await mixedHeading.getAttribute("aria-expanded"), "false");
      await toggleAtReadingPosition(partiallyClipped);
      assert.equal(await mixedHeading.getAttribute("aria-expanded"), "true");
    }
    await toggleAtReadingPosition(false);
    assert.equal(await mixed.locator(".thinking-block-trigger, .command-execution-card").count(), 0);
    for (const text of ["先说明计划", "中途说明", "最后的说明"]) assert.equal(await mixed.getByText(text, {exact:true}).count(), 1);
    await mixed.evaluate(() => window.revealEntry("mixed"));
    await mixed.locator(".thinking-block-trigger").waitFor();
    assert.equal(await mixedHeading.getAttribute("aria-expanded"), "true");
    await mixed.close();
    assert.deepEqual(errors, []);
    t.diagnostic("Verified default-off preferences, contiguous shell steps without intermediate actions, opt-in live output, completion, persistence, cross-window sync and user handoff.");
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-compact-process-"));
    await rm(directory, { recursive: true, force: true });
  }
});
