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

test("composer shrinks within a wide window and keeps menus and actions usable", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-composer-layout-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    // Load production CSS modules with isolated names, including their real styles.
    await writeFile(path.join(directory, "css.cjs"), `const postcss=require(${JSON.stringify(require.resolve("postcss"))});module.exports=function(source){
      const prefix=require("node:path").basename(this.resourcePath).replace(/[^a-zA-Z]/g,"")+"_";
      const names={};const root=postcss.parse(source);root.walkRules(rule=>{rule.selector=rule.selector.replace(/\\.([a-zA-Z_][\\w-]*)/g,(_,name)=>"."+(names[name]=prefix+name))});
      return "const s=document.createElement('style');s.textContent="+JSON.stringify(root.toString())+";document.head.append(s);export default "+JSON.stringify(names);
    }`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatInput} from "@/components/ChatInput";
import {ChatShortcutSettings} from "@/components/ChatShortcutSettings";
import {RoomComposer} from "@/components/RoomComposer";
import {useSendShortcut} from "@/hooks/useSendShortcut";
import {NewSessionProjectPicker} from "@/components/NewSessionProjectPicker";
import {SystemPromptSelector} from "@/components/SystemPromptSelector";
import {ChatCommandCard,ChatCommandQueue} from "@/components/ChatCommandCard";
import {ToolReviewStatus} from "@/components/ToolReviewStatus";
import {createChatCommandCatalog} from "@/lib/chat-command-input";
const catalog=createChatCommandCatalog([{name:"workflow",source:"extension",description:"Start a workflow and continue until complete"}]);
const record={commandId:"sample-command",idempotencyKey:"sample",targetSessionId:"sample",acceptedAt:1792483200000,status:"completed",operation:{version:1,rawText:"/name 项目检查",catalogRevision:catalog.revision,command:catalog.commands.find(c=>c.name==="name"),arguments:"项目检查",phase:"settling",steps:[{id:"command",kind:"command",status:"completed",startedAt:1792483200000,completedAt:1792483200200}],result:{title:"chatCommands.renameCompleted",rename:{before:"新会话",after:"项目检查"}}}};
import { DefaultToolPermissionSetting } from "${path.join(repo, "components/ToolPermissionControl.tsx").replaceAll("\\", "/")}";
function App(){
  const [reviews,setReviews]=useState([]);window.setReviews=setReviews;
  const {shortcut,setShortcut}=useSendShortcut();window.setSendShortcut=setShortcut;
  const [busy,setBusy]=useState(false);window.setBusy=setBusy;
  const [queued,setQueued]=useState([]);window.setQueued=setQueued;
  const [runtimeQueue,setRuntimeQueue]=useState(null);window.setRuntimeQueue=setRuntimeQueue;
  const [permission,setPermission]=useState({mode:"auto",revision:1});
  return <I18nProvider><main>
    <section id="reviews"><ToolReviewStatus reviews={reviews}/></section>
    <section id="command-results"><ChatCommandCard record={record} actions={{retry:async()=>{},restore:async()=>{},cancel:async()=>{},copy:async()=>{}}}/></section>
    <section id="launcher"><NewSessionProjectPicker activeCwd="/workspace/a-very-long-project-name-for-layout-checks" onLaunch={request=>{window.launched=true;window.launchRequest=request}}/></section>
    <section id="conversation"><ChatInput ref={value=>{window.composer=value}} onSend={(text,...args)=>{window.sent=true;window.submission={text,args};return true}} onAbort={()=>{window.stopped=true;setBusy(false)}}
      queueContent={<ChatCommandQueue records={queued} pendingMessages={runtimeQueue} onRecall={()=>{window.recalled=true;setRuntimeQueue(null)}} actions={{recover:async record=>{window.recovered=record.commandId},cancel:async record=>{window.cancelled=record.commandId;if(window.failQueueCancel)throw new Error("Queue cancellation failed");setQueued(current=>current.filter(item=>item.commandId!==record.commandId))},steer:async record=>{window.steered=record.commandId;setQueued(current=>current.filter(item=>item.commandId!==record.commandId))},edit:async record=>{window.editing=record.commandId;return record.preview},save:async(record,text)=>{if(window.failQueueEdit)throw new Error("Queue edit failed");window.edited={id:record.commandId,text};setQueued(current=>current.map(item=>item.commandId===record.commandId?{...item,preview:text}:item))},resume:async record=>{window.resumed=record.commandId;setQueued(current=>current.map(item=>item.commandId===record.commandId?{...item,queuePaused:false}:item))}}}/>}
      commandCatalog={catalog} onLoadSlashCommands={()=>{}} onQueueInput={async(text,images,files,onDurable,options)=>{(window.queuedInputs??=[]).push({text,delivery:options?.delivery});return true}}
      onSteer={()=>true} onFollowUp={()=>true} isStreaming={busy} onModelChange={async()=>true} onThinkingLevelChange={()=>{}}
      model={{provider:"deepseek",modelId:"deepseek-v4.1-flash"}} modelList={[{provider:"deepseek",id:"deepseek-v4.1-flash",name:"DeepSeek V4.1 Flash Very Long Model Name"}]}
      toolPermission={permission} onToolPermissionChange={mode=>{setPermission({mode,revision:permission.revision+1});window.permission=mode}}
      thinkingLevel="high" extensionStatuses={[{key:"fixture",text:"Ready"}]}
      contextControl={<SystemPromptSelector selection={{mode:"default"}} onChange={()=>{}}/>}/></section>
    <section id="room" data-send-shortcut={shortcut}><RoomComposer room={{id:"shortcut-room",members:[],coordination:{mode:"manual"}}} actorSessionId="actor" submissions={[]} onSubmit={async input=>{(window.roomInputs??=[]).push(input);return {...input,status:"delivered"}}/></section>
    <section id="shortcut-settings"><ChatShortcutSettings/></section>
    <section id="permission-settings"><DefaultToolPermissionSetting/></section>
  </main></I18nProvider>;
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
    for (const locale of ["zh-CN", "en"]) {
      const context = await browser.newContext({ locale, viewport: { width: 1440, height: 1100 } });
      const errors = [];
      let defaultMode = "auto", failPermissionSave = false;
      const savedModes = [];
      await context.route("http://localhost:43191/**", async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/api/tool-permissions") {
          if (route.request().method() === "PUT") {
            if (failPermissionSave) return route.fulfill({ status: 500, json: { error: "save failed" } });
            defaultMode = route.request().postDataJSON().mode;
            savedModes.push(defaultMode);
          }
          return route.fulfill({ json: { mode: defaultMode } });
        }
        if (pathname === "/api/models") return route.fulfill({ json: { models: {}, modelList: [{ provider: "deepseek", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash Very Long Model Name" }] } });
        if (pathname === "/api/system-prompt") return route.fulfill({ json: { selectorVisible: true, templates: [{ id: "long", name: "Very long system prompt template name", prompt: "Be helpful" }], defaultTemplateId: "long" } });
        if (pathname === "/api/chat-workspace" || pathname === "/api/cwd/validate") return route.fulfill({ json: { cwd: "/workspace/a-very-long-project-name-for-layout-checks", valid: true } });
        if (pathname.startsWith("/api/")) return route.fulfill({ json: { sessions: [], success: true } });
        if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
          body{background:var(--bg);color:var(--text);font-family:var(--ui-font-family)}#root>main{padding:24px}#launcher,#conversation{width:900px;margin-bottom:32px}
          #launcher{height:650px}#conversation{padding-top:32px}#conversation>[data-composer-variant]{padding:0!important}
          </style><div id="root"></div><script src="/bundle.js"></script></html>` });
      });
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("http://localhost:43191/");
      await page.locator("#launcher .model-settings-trigger:not([data-permission-trigger])").waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[aria-haspopup="listbox"]')].some(el => el.textContent.includes("Very long system")));
      // Select a real project so its production chip must also truncate.
      await page.locator('#launcher button[aria-haspopup="listbox"]').first().click();
      await page.getByRole("option").filter({ hasText: "a-very-long-project-name" }).click();
      for (const width of [900, 590, 480, 420, 320]) {
        await page.locator("#launcher, #conversation").evaluateAll((sections, width) => sections.forEach(section => { section.style.width = width + "px"; }), width);
        // Let container queries and React's resize handling settle.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        for (const id of ["launcher", "conversation"]) {
          const geometry = await page.locator(`#${id} .chat-composer-footer`).evaluate(footer => {
            const rect = footer.getBoundingClientRect();
            const children = [...footer.children].filter(el => el.getBoundingClientRect().width > 0);
            const bounds = children.map(el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, center: box.top + box.height / 2 }; });
            const send = footer.querySelector(".composer-submit-controls > :last-child").getBoundingClientRect();
            const label = footer.querySelector(".model-settings-control .model-settings-trigger-label");
            return { width: rect.width, left: rect.left, right: rect.right, bounds, sendWidth: send.width, labelWidth: label.clientWidth, labelScroll: label.scrollWidth };
          });
          assert.ok(geometry.bounds.every(box => box.left >= geometry.left - 1 && box.right <= geometry.right + 1), `${locale}/${id}/${width}: controls overflow ${JSON.stringify(geometry)}`);
          assert.ok(geometry.sendWidth >= 31, `${locale}/${id}/${width}: action shrank`);
          if (geometry.width > 420) {
            const centers = geometry.bounds.map(box => box.center);
            assert.ok(Math.max(...centers) - Math.min(...centers) < 2, `${locale}/${id}/${width}: toolbar wrapped`);
          }
          if (width === 480) assert.ok(geometry.labelWidth < geometry.labelScroll, "long model name should truncate");
        }
        if (process.env.PIORA_COMPOSER_SCREENSHOTS) {
          const output = path.join(repo, "test-results", "composer-layout");
          await mkdir(output, { recursive: true });
          await page.screenshot({ path: path.join(output, `${locale}-${width}.png`), fullPage: true });
        }
      }
      await page.locator("#launcher, #conversation").evaluateAll(sections => sections.forEach(section => { section.style.width = "590px"; }));
      const conversation = page.locator("#conversation");
      const permission = conversation.locator("[data-permission-trigger]");
      for (const mode of ["full", "ask", "review", "auto"]) {
        await permission.click();
        assert.equal(await page.getByRole("menuitemradio").count(), 4, "three primary modes plus strict compatibility");
        if (process.env.PIORA_COMPOSER_SCREENSHOTS && mode === "full") {
          await page.getByRole("menu").screenshot({ path: path.join(repo, "test-results/composer-layout", `${locale}-permissions.png`) });
        }
        await page.locator(`[role="menuitemradio"][data-mode="${mode}"]`).click();
        assert.equal(await page.evaluate(() => window.permission), mode);
        assert.equal(await permission.getAttribute("aria-expanded"), "false");
      }
      await conversation.locator(".model-settings-trigger:not([data-permission-trigger])").click();
      await page.locator(".model-settings-popover").waitFor();
      await page.keyboard.press("Escape");
      await conversation.locator('button[aria-haspopup="listbox"]').click();
      await page.getByRole("listbox").waitFor();
      await page.keyboard.press("Escape");
      await conversation.locator("textarea").fill("Check layout");
      await conversation.locator(".composer-submit-controls > button:not([data-permission-trigger])").click();
      assert.equal(await page.evaluate(() => window.sent), true);
      // Commands use the same editor; optional controls stay out of the way.
      const editor = conversation.locator("textarea").first();
      await editor.fill("/work");
      await page.getByRole("option").filter({ hasText: "/workflow" }).waitFor();
      const listId = await editor.getAttribute("aria-controls");
      assert.ok(listId);
      await page.keyboard.press("Tab");
      assert.equal(await editor.inputValue(), "/workflow ");
      await page.keyboard.type("Check the workspace");
      assert.equal(await conversation.locator("details[open]").count(), 0);
      await conversation.locator("summary").click();
      await conversation.getByRole("button", { name: locale === "zh-CN" ? "完成后再提问" : "Ask after completion" }).click();
      const query = conversation.getByRole("textbox", { name: locale === "zh-CN" ? "后续提问" : "Follow-up question", exact: true });
      await query.fill("Verify the result");
      await conversation.locator(".composer-submit-controls > button:not([data-permission-trigger])").click();
      const submission = await page.evaluate(() => window.submission);
      assert.equal(submission.text, "/workflow Check the workspace");
      assert.equal(submission.args[4].afterPrompt, "Verify the result");
      await editor.fill("/workflow Keep this as literal text");
      await conversation.locator("summary").click();
      await conversation.getByRole("button", { name: locale === "zh-CN" ? "作为普通消息发送" : "Send as plain message" }).click();
      assert.equal(await editor.inputValue(), "/workflow Keep this as literal text");
      await conversation.locator(".composer-submit-controls > button:not([data-permission-trigger])").click();
      assert.equal((await page.evaluate(() => window.submission)).args[4].inputMode, "text");
      const result = page.locator("#command-results");
      assert.equal(await result.locator("pre").count(), 0);
      await result.getByRole("button", { name: locale === "zh-CN" ? "查看详情" : "View details" }).click();
      assert.equal(await result.locator("pre").innerText(), "/name 项目检查");
      await result.getByRole("button", { name: locale === "zh-CN" ? "收起详情" : "Hide details" }).click();
      // Queue strips tuck behind the input while keeping their controls exposed.
      const chatWindowSource = await readFile(path.join(repo, "components/ChatWindow.tsx"), "utf8");
      assert.match(chatWindowSource, /queueContent=\{composerQueueContent\}/);
      assert.match(chatWindowSource, /const composerQueueContent = useMemo\(\(\) => \(\s*<ChatCommandQueue records=\{chatCommands\.records\} actions=\{queueActions\} pendingMessages=\{queuedMessages\} onRecall=\{handleRecallQueue\} \/>/);
      await page.evaluate(() => window.setRuntimeQueue({steering:['Pending guidance <b>literal</b>'],followUp:['Runtime follow-up']}));
      const runtimeRegion = conversation.getByRole('region', { name: locale === 'zh-CN' ? '接下来执行' : 'Up next' });
      await runtimeRegion.getByRole('status').first().waitFor();
      assert.equal(await runtimeRegion.getByRole('status').count(), 2);
      assert.equal(await runtimeRegion.locator('b').count(), 0);
      assert.equal(await conversation.locator('.composer-queue-tray').count(), 0);
      const runtimeBox = await runtimeRegion.boundingBox();
      const surfaceBox = await conversation.locator('.chat-composer-surface').boundingBox();
      assert.ok(runtimeBox.y < surfaceBox.y && runtimeBox.y + runtimeBox.height > surfaceBox.y, 'guidance shares the attached composer strip');
      await runtimeRegion.getByRole('button', {name: locale === 'zh-CN' ? '移回输入框' : 'Recall to input'}).click();
      assert.equal(await page.evaluate(() => window.recalled), true);
      await runtimeRegion.waitFor({state:'hidden'});
      const longPreview = "Long queued message ".repeat(20);
      await page.evaluate(longPreview => window.setQueued([
        { commandId: "queued-first", status: "queued", preview: "我想参考 chatgpt 的设计" },
        { commandId: "queued-second", status: "accepted", preview: longPreview },
      ]), longPreview);
      const pendingQueue = conversation.getByRole("region", { name: locale === "zh-CN" ? "接下来执行" : "Up next" });
      const cancelQueued = pendingQueue.getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true });
      const queueOptions = () => pendingQueue.getByRole("button", { name: locale === "zh-CN" ? "选项" : "Options", exact: true });
      await pendingQueue.waitFor();
      await conversation.evaluate(section => section.style.setProperty("--chat-column-width", "520px"));
      for (const width of [900, 590, 320]) {
        await conversation.evaluate((section, width) => { section.style.width = width + "px"; }, width);
        const boxes = await conversation.evaluate(section => {
          const queue = section.querySelector('section[aria-label]');
          const rect = element => { const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom }; };
          return { queue: rect(queue), surface: rect(section.querySelector(".chat-composer-surface")), context: rect(section.querySelector(".chat-composer-context")), buttons: [...queue.querySelectorAll('button')].map(rect), overflow: queue.scrollWidth - queue.clientWidth };
        });
        assert.ok(Math.abs(boxes.queue.left - boxes.surface.left - 12) < 1 && Math.abs(boxes.surface.right - boxes.queue.right - 12) < 1, `${locale}/${width}: queue must be inset evenly ${JSON.stringify(boxes)}`);
        assert.ok(boxes.queue.top >= boxes.context.bottom && Math.abs(boxes.queue.bottom - boxes.surface.top - 14) < 1, "queue bottom tucks behind the input");
        assert.ok(boxes.buttons.every(button => button.bottom <= boxes.surface.top && button.left >= boxes.queue.left && button.right <= boxes.queue.right), "input must not cover queue actions");
        assert.ok(boxes.overflow <= 1, "long queued text must truncate without pushing actions out");
        assert.equal(await cancelQueued.count(), 2);
        assert.ok(await pendingQueue.locator('[title]').filter({ hasText: longPreview }).evaluate(element => element.scrollWidth > element.clientWidth), "preview should stay on one line");
      }
      await page.evaluate(()=>window.setQueued(current=>current.map((item,index)=>index===0?{...item,queuePaused:true}:item)));
      const resumeQueue=pendingQueue.getByRole("button",{name:locale==="zh-CN"?"继续排队":"Resume queue",exact:true});
      await resumeQueue.waitFor();
      const resumeBox=await resumeQueue.boundingBox(), pausedBox=await pendingQueue.boundingBox();
      assert.ok(resumeBox.x>=pausedBox.x && resumeBox.x+resumeBox.width<=pausedBox.x+pausedBox.width,"paused recovery controls stay inside the narrow composer");
      await resumeQueue.click();
      await resumeQueue.waitFor({state:"hidden"});
      assert.equal(await page.evaluate(()=>window.resumed),"queued-first");
      await page.evaluate(() => { window.editing = null; window.steered = null; window.cancelled = null; });
      await queueOptions().last().dblclick();
      assert.equal(await page.evaluate(() => window.editing), null, 'double-clicking options must not activate an overlapping menu item');
      assert.equal(await page.evaluate(() => window.steered), null);
      assert.equal(await page.evaluate(() => window.cancelled), null);
      const queueMenu = page.getByRole("menu", { name: locale === "zh-CN" ? "选项" : "Options", exact: true });
      assert.equal(await queueMenu.getByRole("menuitem").count(), 2);
      const menuBox = await queueMenu.boundingBox();
      const triggerBox = await queueOptions().last().boundingBox();
      assert.ok(menuBox.y + menuBox.height < triggerBox.y, "menu must not cover its trigger or adjacent queue actions");
      assert.equal(await queueMenu.innerText(), locale === "zh-CN" ? "编辑消息\n取消排队" : "Edit message\nCancel queued message");
      await page.evaluate(() => {
        document.querySelector('#conversation').dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      });
      assert.equal(await queueMenu.isVisible(), true, 'streaming scroll and resize keep the queue menu open');
      await queueMenu.getByRole("menuitem").first().click();
      const queueEditor = pendingQueue.getByRole("textbox", { name: locale === "zh-CN" ? "编辑消息" : "Edit message" });
      await queueEditor.waitFor();
      assert.equal(await queueEditor.inputValue(), longPreview, "edit restores the entire query");
      await queueEditor.fill("Edited queued query");
      await page.evaluate(() => { window.failQueueEdit = true; });
      const saveQueue = pendingQueue.getByRole("button", { name: locale === "zh-CN" ? "保存并排队" : "Save and queue" });
      await saveQueue.click();
      await pendingQueue.getByRole("alert").waitFor();
      assert.equal(await queueEditor.inputValue(), "Edited queued query", "a failed edit keeps the typed query");
      await page.evaluate(() => { window.failQueueEdit = false; });
      await saveQueue.click();
      await queueEditor.waitFor({ state: "hidden" });
      assert.deepEqual(await page.evaluate(() => window.edited), { id: "queued-second", text: "Edited queued query" });
      await queueOptions().last().click();
      assert.equal(await queueMenu.getByRole('menuitem').count(), 2);
      await queueMenu.getByRole('menuitem').first().press('ArrowDown');
      await queueMenu.getByRole('menuitem').first().press('Escape');
      assert.equal(await cancelQueued.count(), 2, 'closing the menu keeps the queue');
      await queueOptions().first().click();
      await queueMenu.getByRole("menuitem").first().press("Escape");
      await queueMenu.waitFor({ state: "hidden" });
      // A failed cancellation keeps the row and shows the failure locally.
      await page.evaluate(() => { window.failQueueCancel = true; });
      await pendingQueue.getByRole("button", { name: locale === "zh-CN" ? "选项" : "Options", exact: true }).first().click();
      await queueMenu.getByRole("menuitem").nth(1).click();
      await pendingQueue.getByRole("alert").waitFor();
      assert.equal(await pendingQueue.getByRole("alert").innerText(), "Queue cancellation failed");
      assert.equal(await cancelQueued.count(), 2);
      await page.evaluate(() => { window.failQueueCancel = false; });
      await cancelQueued.last().click();
      assert.equal(await page.evaluate(() => window.cancelled), "queued-second");
      assert.equal(await cancelQueued.count(), 1);
      await conversation.evaluate(section => { section.style.width = "590px"; section.style.removeProperty("--chat-column-width"); });
      // Reset the remaining fixture to capture a clean single-row preview.
      await page.evaluate(() => window.setQueued([{ commandId: "queue-preview", status: "queued", preview: "我想参考 chatgpt 的设计" }]));
      if (process.env.PIORA_COMPOSER_SCREENSHOTS) {
        for (const dark of [false, true]) {
          await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
          await conversation.locator(".composer-column").screenshot({ path: path.join(repo, "test-results/composer-layout", `${locale}-queue-${dark ? "dark" : "light"}.png`) });
        }
        await page.evaluate(() => document.documentElement.classList.remove("dark"));
      }
      await pendingQueue.getByRole("button", { name: locale === "zh-CN" ? "引导" : "Steer", exact: true }).click();
      assert.equal(await page.evaluate(() => window.steered), "queue-preview");
      await pendingQueue.waitFor({ state: "hidden" });
      assert.equal(await conversation.locator("textarea").count(), 1);
      // Many waiting messages scroll within the strip instead of taking over the chat.
      await page.evaluate(() => window.setQueued(Array.from({ length: 12 }, (_, index) => ({ commandId: "many-" + index, status: "queued", preview: "Pending message " + index }))));
      const queueList = pendingQueue.locator('[class*="queueList"]');
      assert.ok(await queueList.evaluate(element => element.scrollHeight > element.clientHeight && element.clientHeight <= 180));
      await queueList.evaluate(element => { element.scrollTop = element.scrollHeight; });
      await cancelQueued.last().click();
      assert.equal(await page.evaluate(() => window.cancelled), "many-11");
      await page.evaluate(() => window.setQueued([]));
      await pendingQueue.waitFor({ state: "hidden" });
      await page.evaluate(() => window.setBusy(true));
      await conversation.locator(".streaming-stop-button").click();
      assert.equal(await page.evaluate(() => window.stopped), true);
      await page.evaluate(() => window.setBusy(true));
      const primary = conversation.locator(".streaming-action-primary");
      const streamingMenu = conversation.locator(".streaming-action-menu");
      let queuedCount = 0;
      // Fresh installs and legacy chooser preferences both default to queueing.
      for (const enabled of [true, false]) {
        await page.evaluate(enabled => { const key = "piora-streaming-send-preference:v1"; const newValue = JSON.stringify({ schemaVersion: 1, enabled, behavior: "followup" }); localStorage.setItem(key, newValue); window.dispatchEvent(new StorageEvent("storage", { key, newValue })); }, enabled);
        for (const trigger of ["click", "Enter"]) {
          const text = "Default queue " + trigger;
          await editor.fill(text);
          assert.equal(await primary.getAttribute("aria-label"), locale === "zh-CN" ? "发送" : "Send");
          assert.equal(await primary.innerText(), "");
          if (trigger === "click") await primary.click(); else await editor.press("Enter");
          await page.waitForFunction(count => window.queuedInputs?.length === count, ++queuedCount);
          assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text, delivery: "next_turn" });
          await streamingMenu.waitFor({ state: "hidden" });
        }
      }
      for (const behavior of ["steer", "followup"]) {
        await page.evaluate(behavior => {
          const key = "piora-streaming-send-preference:v1";
          const newValue = JSON.stringify({ schemaVersion: 1, enabled: true, behavior });
          localStorage.setItem(key, newValue);
          window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
        }, behavior);
        const delivery = "next_turn";
        for (const trigger of ["click", "Enter"]) {
          const text = `Default ${behavior} ${trigger}`;
          await editor.fill(text);
          assert.equal(await primary.getAttribute("aria-label"), locale === "zh-CN" ? "发送" : "Send");
          assert.equal(await primary.innerText(), "");
          if (trigger === "click") await primary.click();
          else await editor.press("Enter");
          await page.waitForFunction(count => window.queuedInputs?.length === count, ++queuedCount);
          assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text, delivery });
          await streamingMenu.waitFor({ state: "hidden" });
        }
        assert.equal(await conversation.locator('.streaming-action-toggle').count(), 0);

      }
      await editor.fill('No default guidance binding');
      await editor.press('Control+Enter');
      assert.equal(await page.evaluate(() => window.queuedInputs.length), queuedCount);
      assert.equal(await editor.inputValue(), 'No default guidance binding');
      const shortcutSettings = page.locator('#shortcut-settings');
      const recorder = action => shortcutSettings.locator('[data-settings-id="conversation.' + action + 'Shortcut"] button').first();
      await recorder('steer').click();
      await recorder('steer').press('Control+Enter');
      await editor.fill('Explicit keyboard guidance');
      await editor.press('Control+Enter');
      await page.waitForFunction(count => window.queuedInputs.length === count, ++queuedCount);
      assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text: 'Explicit keyboard guidance', delivery: 'steer' });
      await editor.fill('Queue after guidance');
      await editor.press('Enter');
      await page.waitForFunction(count => window.queuedInputs.length === count, ++queuedCount);
      assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text: 'Queue after guidance', delivery: 'next_turn' });
      await editor.fill('Keep newline');
      await editor.press('Shift+Enter');
      assert.equal(await page.evaluate(() => window.queuedInputs.length), queuedCount);
      assert.ok((await editor.inputValue()).includes('\n'));
      // Record all three actions through the production settings UI.
      await recorder('send').click();
      await recorder('send').press('Control+Enter');
      await shortcutSettings.getByRole('alert').waitFor();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('piora-chat-shortcuts:v2')).bindings.send), 'Enter', 'a conflict must not overwrite the current binding');
      await recorder('send').press('Escape');
      await recorder('steer').click();
      await recorder('steer').press('Control+Shift+Enter');
      await recorder('send').click();
      await recorder('send').press('Control+Enter');
      await recorder('newline').click();
      await recorder('newline').press('Alt+Enter');
      await page.waitForFunction(() => document.querySelector('#room').dataset.sendShortcut !== 'Enter');
      await editor.fill('Custom queued message');
      await editor.press('Control+Enter');
      await page.waitForFunction(count => window.queuedInputs.length === count, ++queuedCount);
      assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text: 'Custom queued message', delivery: 'next_turn' });
      await editor.fill('Custom guidance');
      await editor.press('Control+Shift+Enter');
      await page.waitForFunction(count => window.queuedInputs.length === count, ++queuedCount);
      assert.deepEqual(await page.evaluate(() => window.queuedInputs.at(-1)), { text: 'Custom guidance', delivery: 'steer' });
      // Newlines replace the selection and leave the caret after the inserted break.
      const roomEditor = page.locator('#room textarea');
      for (const input of [editor, roomEditor]) {
        await input.fill('before REPLACE after');
        await input.evaluate(element => element.setSelectionRange(7, 14));
        await input.press('Alt+Enter');
        assert.equal(await input.inputValue(), 'before \n after');
        await page.waitForFunction(selector => document.querySelector(selector).selectionStart === 8, input === editor ? '#conversation textarea' : '#room textarea');
        await input.press('Shift+Enter');
        await input.press('Enter');
        assert.equal(await input.inputValue(), 'before \n after', 'old bindings must not remain active after customization');
      }
      assert.equal(await page.evaluate(() => window.queuedInputs.length), queuedCount);
      await roomEditor.fill('Shared group shortcut');
      await roomEditor.press('Control+Enter');
      await page.waitForFunction(() => window.roomInputs?.at(-1)?.content === 'Shared group shortcut');
      await page.waitForFunction(() => document.querySelector('#room textarea').value === '');
      await page.evaluate(() => window.setBusy(false));
      await editor.fill('Custom idle send');
      await editor.press('Control+Enter');
      await page.waitForFunction(() => window.submission?.text === 'Custom idle send');
      // Completing an exact slash command must not bypass a customized send key.
      await editor.fill('/workflow');
      await editor.press('Enter');
      assert.equal((await page.evaluate(() => window.submission)).text, 'Custom idle send');
      await editor.press('Control+Enter');
      await page.waitForFunction(() => window.submission?.text.trim() === '/workflow');
      // Custom shortcuts stay inert during IME composition, including a non-Enter binding.
      await recorder('send').click();
      await recorder('send').press('Control+Shift+S');
      await editor.fill('Composing message');
      await editor.dispatchEvent('compositionstart');
      await editor.press('Control+Shift+S');
      assert.equal((await page.evaluate(() => window.submission)).text.trim(), '/workflow');
      await editor.dispatchEvent('compositionend');
      await page.waitForTimeout(100);
      await editor.press('Control+Shift+S');
      await page.waitForFunction(() => window.submission?.text === 'Composing message');
      // A second tab loads all preferences and propagates edits back to both composers.
      const otherPage = await context.newPage();
      await otherPage.goto('http://localhost:43191/');
      const otherRecorder = otherPage.locator('#shortcut-settings [data-settings-id="conversation.sendShortcut"] button').first();
      await otherPage.waitForFunction(() => document.querySelector('#room').dataset.sendShortcut === JSON.parse(localStorage.getItem('piora-chat-shortcuts:v2')).bindings.send);
      assert.match(await otherRecorder.innerText(), /Ctrl\+Shift\+S/);
      await otherRecorder.click();
      await otherRecorder.press('Enter');
      await page.waitForFunction(() => document.querySelector('#room').dataset.sendShortcut === 'Enter');
      await otherPage.close();
      // Clearing and resetting are independent; no send change reassigns steering.
      await recorder('steer').click();
      await recorder('steer').press('Delete');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('piora-chat-shortcuts:v2')).bindings.steer), null);
      await shortcutSettings.locator('[data-settings-id="conversation.newlineShortcut"] button').last().click();
      await editor.fill('Restored newline');
      await editor.press('Shift+Enter');
      assert.equal(await editor.inputValue(), 'Restored newline\n');
      if (process.env.PIORA_COMPOSER_SCREENSHOTS) {
        await shortcutSettings.screenshot({ path: path.join(repo, 'test-results/composer-layout', `${locale}-chat-shortcuts.png`) });
      }
      // Recovered ordinary drafts cannot carry a stale steering delivery into idle sends.
      await page.evaluate(() => window.setBusy(false));
      await editor.fill('');
      await page.evaluate(() => window.composer.restoreCommandDraft({value:'Recovered idle message',files:[],images:[],commandInput:{delivery:'steer'}}));
      await page.waitForFunction(() => document.querySelector('#conversation textarea').value === 'Recovered idle message');
      await editor.press('Enter');
      await page.waitForFunction(() => window.submission?.text === 'Recovered idle message');
      assert.equal((await page.evaluate(() => window.submission)).args[4].delivery, 'next_turn');
      for (const width of [480, 420, 320]) {
        await conversation.evaluate((section, width) => { section.style.width = width + "px"; }, width);
        await page.evaluate(() => window.setBusy(true));
        await conversation.locator("textarea").fill("Follow up");
        await conversation.locator(".streaming-action-primary").waitFor();
        const overflow = await conversation.locator(".chat-composer-footer").evaluate(footer => footer.scrollWidth - footer.clientWidth);
        assert.ok(overflow <= 1, `${locale}/${width}: streaming actions overflow by ${overflow}px`);
        await page.evaluate(() => window.setBusy(false));
        await conversation.locator("textarea").fill("/reload");
        await page.keyboard.press("Escape");
        const commandOverflow = await conversation.locator(".chat-composer-footer").evaluate(footer => footer.scrollWidth - footer.clientWidth);
        assert.ok(commandOverflow <= 1, `${locale}/${width}: command action overflows by ${commandOverflow}px`);
      }
      if (process.env.PIORA_COMPOSER_SCREENSHOTS) {
        const output = path.join(repo, "test-results", "composer-layout");
        await page.addStyleTag({ content: "#launcher{display:none}#root>main{padding:28px;max-width:780px;margin:auto}#conversation,#command-results{width:100%!important}#conversation{padding-top:12px}body{min-height:500px}" });
        await conversation.evaluate(section => { section.style.width = "100%"; });
        // Switching away from the literal submission starts a new command draft.
        await editor.fill("Hello");
        await editor.fill("/workflow Check the workspace and verify the changes");
        await page.keyboard.press("Escape");
        await page.locator("#root>main").screenshot({ path: path.join(output, `${locale}-commands.png`) });
        await conversation.locator("summary").click();
        await page.locator("#root>main").screenshot({ path: path.join(output, `${locale}-command-options.png`) });
        await conversation.locator("summary").click();
        await page.evaluate(() => document.documentElement.classList.add("dark"));
        await page.locator("#root>main").screenshot({ path: path.join(output, `${locale}-commands-dark.png`) });
      }
      await page.locator("#launcher").evaluate(el => { el.style.display = "block"; });
      await page.locator("#launcher [data-permission-trigger]").click();
      await page.locator('[role="menuitemradio"][data-mode="full"]').click();
      await page.locator("#launcher textarea").fill("Start with full access");
      await page.locator("#launcher .composer-submit-controls > button:not([data-permission-trigger])").click();
      await page.waitForFunction(() => window.launchRequest);
      assert.equal((await page.evaluate(() => window.launchRequest)).prompt.permissionMode, "full");
      assert.equal(defaultMode, "full");
      assert.deepEqual(savedModes, ["full"]);
      const settingsTrigger = page.locator("#permission-settings [data-permission-trigger]");
      await page.waitForFunction(() => document.querySelector('#permission-settings [data-permission-trigger]').textContent.match(/Full access|完全访问/));
      // A fresh page (new launcher) reads the persisted choice without writing it.
      await page.reload();
      const launcherTrigger = page.locator("#launcher [data-permission-trigger]");
      await page.waitForFunction(() => document.querySelector('#launcher [data-permission-trigger]')?.textContent.match(/Full access|完全访问/));
      assert.deepEqual(savedModes, ["full"]);
      await settingsTrigger.click();
      await page.locator('[role="menuitemradio"][data-mode="ask"]').click();
      await page.waitForFunction(() => document.querySelector('#launcher [data-permission-trigger]').textContent.match(/Ask before actions|操作前询问/));
      assert.equal(defaultMode, "ask");
      // Failure keeps the last confirmed mode and is visible to the user.
      failPermissionSave = true;
      await launcherTrigger.click();
      await page.locator('[role="menuitemradio"][data-mode="full"]').click();
      await page.locator('#launcher [role="alert"]').filter({ hasText: "HTTP 500" }).waitFor();
      assert.match(await launcherTrigger.innerText(), /Ask before actions|操作前询问/);
      assert.equal(defaultMode, "ask");
      failPermissionSave = false;
      await launcherTrigger.click();
      await page.locator('[role="menuitemradio"][data-mode="auto"]').click();
      await page.waitForFunction(() => document.querySelector('#permission-settings [data-permission-trigger]').textContent.match(/Request approval|请求批准/));
      assert.equal(defaultMode, "auto");

      await launcherTrigger.click();
      await page.locator('[role="menuitemradio"][data-mode="review"]').click();
      await page.waitForFunction(() => document.querySelector('#permission-settings [data-permission-trigger]').textContent.match(/Approve for me|帮我批准/));
      assert.equal(defaultMode, "review", "AI review is an explicit saved choice");
      await page.evaluate(() => window.setReviews([{ id:"review-one",toolName:"bash",status:"reviewing",reason:"Checking the requested tests",model:"provider/model",startedAt:1,updatedAt:1 }]));
      const reviewPanel = page.locator('#reviews [data-tool-reviews]');
      await reviewPanel.waitFor();
      assert.equal(await reviewPanel.getAttribute('open'), null, "automatic reviews do not open a dialog");
      await reviewPanel.locator('summary').click();
      await reviewPanel.getByText('Checking the requested tests').waitFor();
      await page.evaluate(() => window.setReviews([{ id:"review-one",toolName:"bash",status:"denied",reason:"Target is outside the authorized deletion scope",model:"provider/model",durationMs:450,tokens:50,startedAt:1,updatedAt:2 }]));
      await reviewPanel.locator('[data-review-status="denied"]').waitFor();
      assert.match(await reviewPanel.innerText(), /run stopped|本轮已停止/);
      assert.match(await reviewPanel.innerText(), /provider\/model/);
      if (process.env.PIORA_COMPOSER_SCREENSHOTS) {
        const output = path.join(repo, "test-results", "composer-layout");
        await reviewPanel.screenshot({ path: path.join(output, `${locale}-tool-review.png`) });
        await launcherTrigger.click();
        await page.locator('[role="menu"]').screenshot({ path: path.join(output, `${locale}-permission-menu.png`) });
        await page.keyboard.press("Escape");
      }

      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), "piora-composer-layout-")));
    await rm(directory, { recursive: true, force: true });
  }
});
