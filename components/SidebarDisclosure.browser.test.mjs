import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("sidebar disclosures persist and project collapse hides every session", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-sidebar-disclosure-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useState} from 'react';import{createRoot}from'react-dom/client';
import{I18nProvider}from'@/hooks/useI18n';
import{SidebarProjectArea}from'@/components/sidebar/SidebarProjectArea';
import{SidebarChatArea}from'@/components/sidebar/SidebarChatArea';
import{RoomSidebarSection}from'@/components/RoomSidebarSection';
import{useSidebarState}from'@/components/sidebar/useSidebarState';
import{buildSessionProjectGroups}from'@/lib/session-project-groups';
const noop=()=>{}, asyncNoop=async()=>{}, empty=new Set();
const make=(id,day,cwd='C:/fixture',parentSessionId)=>({id,name:id,firstMessage:id,path:id+'.jsonl',cwd,projectRoot:cwd,modified:'2026-01-'+String(day).padStart(2,'0')+'T00:00:00Z',created:'2026-01-01T00:00:00Z',messageCount:1,parentSessionId});
const sessions=[make('pinned',1),make('fork',9,'C:/fixture','older'),make('newest',8),make('third',7),make('fourth',6),make('fifth',5),make('older',2),make('small-a',2,'C:/small'),make('small-b',1,'C:/small')];
const groups=buildSessionProjectGroups(sessions,null,[{cwd:'C:/empty'}]);
window.events={newChat:0,newProject:0,newSession:0,reorder:0,restored:0};window.roomRequests=0;window.roomName='Group';
window.fetch=async url=>{if(url==='/api/rooms'){window.roomRequests++;return new Response(JSON.stringify({rooms:[{id:'room',name:window.roomName,updatedAt:1,members:[],summary:{lastMessage:{seq:1,author:'Member',content:'Hello'}}}]}))}return new Response(JSON.stringify({sessions:[],runningSessionIds:[],tasks:[],models:[],modelList:[]}))};
function App(){const state=useSidebarState();const[selected,setSelected]=useState(null);window.setOrder=state.setSessionOrder;const common={selectedSessionId:selected,runningSessionIds:new Set(['older']),unreadSessionIds:new Set(['fifth']),moveTargets:[],sessionFlags:{pinned:{pinned:true}},sessionOrder:state.sessionOrder,onReorderSessions:()=>window.events.reorder++};
return <I18nProvider><main className='session-sidebar-content' style={{width:320,height:'100vh',overflow:'auto'}}>
<div id='rooms'><RoomSidebarSection sessions={[]} selectedSessionId={null} selectedRoomId={null} initialRoomId='room' onSelectRoom={(_r,restore)=>{if(restore)window.events.restored++}}/></div>
<div id='projects'><SidebarProjectArea {...common} loading={false} error={null} projectGroups={groups} selectedProject='C:/fixture' collapsedProjectKeys={state.collapsedProjectKeys} setCollapsedProjectKeys={state.setCollapsedProjectKeys} handleDefaultCwd={()=>{window.events.newProject++;return Promise.resolve()}} handleCustomPathClick={()=>window.events.newProject++} setSelectedCwd={noop} homeDir='' handleSelectSessionFromList={session=>setSelected(session.id)} handleNewSessionInProject={()=>window.events.newSession++} loadSessions={asyncNoop} handleSessionDeletedWithUndo={noop} patchSessionFlag={asyncNoop} duplicateSession={asyncNoop} markSessionUnread={noop} moveSession={asyncNoop} pinnedProjectRoots={empty} projectAliases={{}} mutedProjectRoots={empty} toggleProjectMuted={noop} togglePinnedProject={noop} renameProject={noop} removeProject={noop} onReorderProjects={(...args)=>{(window.events.projectReorders??=[]).push(args)}}/></div>
<div id='chats'><SidebarChatArea {...common} sessions={[{...make('Personal chat',1),projectless:true}]} onNewChat={()=>window.events.newChat++} onSelectSession={session=>setSelected(session.id)} onRenamed={noop} onSessionDeleted={noop} onFlagChange={noop} onDuplicate={noop} onMarkUnread={noop} onMoveSession={asyncNoop}/></div>
</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    for (const locale of ["en", "zh-CN"]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
      await page.clock.install();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(locale => {
        localStorage.setItem("pi-locale", locale);
        if (!localStorage.getItem("fixture-initialized")) {
          localStorage.setItem("fixture-initialized", "true");
          localStorage.setItem("piora:sidebar-collapsed-projects:v1", JSON.stringify(["C:/fixture", "C:/small", "C:/empty"]));
        }
      }, locale);
      await page.route("https://sidebar.test/**", async route => {
        const name = path.basename(new URL(route.request().url()).pathname);
        if (name.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, name)) });
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
      });
      await page.goto("https://sidebar.test/");
      const project = page.locator('[data-project-drag-root="C:/fixture"]');
      const previewIds = () => project.getByRole("treeitem").evaluateAll(rows => rows.map(row => row.dataset.sessionDragId));
      await page.waitForFunction(() => document.querySelector('[data-project-drag-root="C:/fixture"] button[aria-expanded]')?.getAttribute('aria-expanded') === 'false');
      const projectTitle = project.locator('button[title="C:/fixture"]');
      await projectTitle.hover();
      assert.equal(await projectTitle.evaluate(el => getComputedStyle(el).cursor), "grab");
      const projectAction = project.locator('[data-project-drag-ignore] button').last();
      await projectAction.hover();
      assert.equal(await projectAction.evaluate(el => getComputedStyle(el).cursor), "pointer", "functional buttons retain the click cursor");
      const sourceBox = await projectTitle.boundingBox();
      const destinationBox = await page.locator('[data-project-drag-root="C:/small"] [data-project-drag-handle]').boundingBox();
      await page.mouse.move(sourceBox.x + 30, sourceBox.y + sourceBox.height / 2);
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.mouse.down(); await page.clock.runFor(499);
      assert.equal(await projectTitle.evaluate(el => getComputedStyle(el).cursor), "grab", "499ms is still a normal press");
      await page.clock.runFor(1);
      assert.equal(await projectTitle.evaluate(el => getComputedStyle(el).cursor), "grabbing", "500ms starts project dragging");
      await page.mouse.move(destinationBox.x + 40, destinationBox.y + destinationBox.height - 3);
      await page.mouse.up();
      assert.deepEqual(await page.evaluate(() => window.events.projectReorders), [["C:/fixture", "C:/small", "after"]]);
      await page.clock.runFor(501); await page.clock.resume();
      assert.deepEqual(await previewIds(), [], "collapsed project hides all sessions");
      assert.equal(await page.locator('[data-project-drag-root="C:/small"]').getByRole("treeitem").count(), 0);
      assert.equal(await project.locator('[data-project-drag-handle] .sidebar-running-spinner').count(), 1, "hidden running sessions still surface on the project heading");
      const toggleProject = project.locator('[data-project-drag-handle] button[aria-expanded]').first();
      await toggleProject.click();
      const parent = project.getByRole("treeitem", { name: "older", exact: true });
      if (await parent.getAttribute("aria-expanded") === "false") await parent.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[data-session-drag-id="fork"]')?.getAttribute('aria-level') === '2');
      assert.equal(await project.getByRole("treeitem").count(), 7, "expanding restores all sessions and their hierarchy");
      await project.getByRole("treeitem", { name: "fork", exact: true }).click();
      assert.equal(await project.getByRole("treeitem", { name: "fork", exact: true }).getAttribute("aria-selected"), "true");
      await toggleProject.click();
      assert.deepEqual(await previewIds(), [], "clicking the project again fully collapses it");
      await page.evaluate(() => window.setOrder(["fourth", "fork"]));

      const chats = page.locator("#chats");
      const chatToggle = chats.locator('button[aria-expanded]').first();
      const roomToggle = page.locator('#rooms button[aria-expanded]').first();
      const projectsToggle = page.locator('.sidebar-projects-header button[aria-expanded]');
      const clickBlank = async toggle => {
        const box = await toggle.boundingBox();
        assert.ok(box.width > 220, "the toggle includes the blank part of the heading");
        assert.equal(await toggle.evaluate(element => getComputedStyle(element).cursor), "pointer");
        await toggle.click({ position: { x: box.width - 4, y: box.height / 2 } });
      };
      await clickBlank(chatToggle);
      assert.equal(await chatToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await chats.getByRole("treeitem").count(), 0);
      await chats.getByRole("button", { name: locale === "en" ? "New projectless chat" : "新建无项目聊天", exact: true }).click();
      assert.equal(await page.evaluate(() => window.events.newChat), 1);
      assert.equal(await chatToggle.getAttribute("aria-expanded"), "false");
      await chatToggle.focus(); await page.keyboard.press("Enter");
      assert.equal(await chats.getByRole("treeitem").count(), 1);
      await page.keyboard.press("Space");
      assert.equal(await chatToggle.getAttribute("aria-expanded"), "false");

      await clickBlank(roomToggle);
      assert.equal(await roomToggle.getAttribute("aria-expanded"), "false");
      await page.waitForFunction(() => window.events.restored === 1);
      const previousRequests = await page.evaluate(() => { window.roomName = "Updated group"; return window.roomRequests; });
      await page.waitForFunction(count => window.roomRequests > count, previousRequests, { timeout: 8000 });
      await page.locator('#rooms [class*="addButton"]').click();
      await page.getByRole("dialog").waitFor();
      assert.equal(await roomToggle.getAttribute("aria-expanded"), "false");
      await page.keyboard.press("Escape");
      await roomToggle.focus(); await page.keyboard.press("Enter");
      await page.getByRole("button", { name: /Updated group/ }).first().waitFor();
      await page.keyboard.press("Space");
      assert.equal(await roomToggle.getAttribute("aria-expanded"), "false");

      await clickBlank(projectsToggle);
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "true");
      await page.locator('.sidebar-projects-header').getByRole("button", { name: locale === "en" ? "New project" : "新建项目", exact: true }).click();
      assert.equal(await page.evaluate(() => window.events.newProject), 1);
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "true");
      await projectsToggle.focus(); await page.keyboard.press("Space");
      assert.equal(await project.getByRole("treeitem").count(), 0);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#chats button[aria-expanded]')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await roomToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "false");
      assert.deepEqual(await previewIds(), [], "collapsed state persists after reload");
      await page.waitForFunction(() => window.events.restored === 1);
      assert.deepEqual(errors, []);
      await mkdir(path.join(repo, ".verification/sidebar-disclosure"), { recursive: true });
      await page.screenshot({ path: path.join(repo, `.verification/sidebar-disclosure/${locale}.png`) });
      await page.close();
    }
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
