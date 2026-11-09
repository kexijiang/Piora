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

test("sidebar disclosures preserve project structure, independent session overflow and persisted state", { timeout: 180000 }, async () => {
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
const sessions=[make('pinned',1),make('fork',9,'C:/fixture','older'),make('newest',8),make('third',7),make('fourth',6),make('fifth',5),make('older',2),make('small-a',2,'C:/small'),make('small-b',1,'C:/small'),make('small-fork',3,'C:/small','small-a')];
const groups=buildSessionProjectGroups(sessions,null,[{cwd:'C:/empty'}]);
window.events={newChat:0,newProject:0,newSession:0,reorder:0,restored:0};window.roomRequests=0;window.roomName='Group';
window.fetch=async url=>{if(url==='/api/rooms'){window.roomRequests++;return new Response(JSON.stringify({rooms:[{id:'room',name:window.roomName,updatedAt:1,members:[],summary:{lastMessage:{seq:1,author:'Member',content:'Hello'}}}]}))}return new Response(JSON.stringify({sessions:[],runningSessionIds:[],tasks:[],models:[],modelList:[]}))};
function App(){const state=useSidebarState();const[selected,setSelected]=useState(null);window.setOrder=state.setSessionOrder;const common={selectedSessionId:selected,runningSessionIds:new Set(['older']),unreadSessionIds:new Set(['fifth']),moveTargets:[],sessionFlags:{pinned:{pinned:true}},sessionOrder:state.sessionOrder,onReorderSessions:()=>window.events.reorder++};
return <I18nProvider><main className='session-sidebar-content' style={{width:320,height:'100vh',overflow:'auto'}}>
<div id='rooms'><RoomSidebarSection sessions={[]} selectedSessionId={null} selectedRoomId={null} initialRoomId='room' onSelectRoom={(_r,restore)=>{if(restore)window.events.restored++}}/></div>
<div id='projects'><SidebarProjectArea {...common} loading={false} error={null} projectGroups={groups} selectedProject='C:/fixture' collapsedProjectKeys={state.collapsedProjectKeys} setCollapsedProjectKeys={state.setCollapsedProjectKeys} expandedProjectSessionKeys={state.expandedProjectSessionKeys} setExpandedProjectSessionKeys={state.setExpandedProjectSessionKeys} handleDefaultCwd={()=>{window.events.newProject++;return Promise.resolve()}} handleCustomPathClick={()=>window.events.newProject++} setSelectedCwd={noop} homeDir='' handleSelectSessionFromList={session=>setSelected(session.id)} handleNewSessionInProject={()=>window.events.newSession++} loadSessions={asyncNoop} handleSessionDeletedWithUndo={noop} patchSessionFlag={asyncNoop} duplicateSession={asyncNoop} markSessionUnread={noop} moveSession={asyncNoop} pinnedProjectRoots={empty} projectAliases={{}} mutedProjectRoots={empty} toggleProjectMuted={noop} togglePinnedProject={noop} renameProject={noop} removeProject={noop} onReorderProjects={noop}/></div>
<div id='chats'><SidebarChatArea {...common} sessions={[{...make('Personal chat',1),projectless:true}]} onNewChat={()=>window.events.newChat++} onSelectSession={session=>setSelected(session.id)} onRenamed={noop} onSessionDeleted={noop} onFlagChange={noop} onDuplicate={noop} onMarkUnread={noop} onMoveSession={asyncNoop}/></div>
</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    for (const locale of ["en", "zh-CN"]) {
      const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(locale => {
        localStorage.setItem("pi-locale", locale);
        if (!localStorage.getItem("fixture-initialized")) {
          localStorage.setItem("fixture-initialized", "true");
          localStorage.setItem("piora:sidebar-collapsed-projects:v1", JSON.stringify(["C:/small"]));
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
      await page.waitForFunction(() => document.querySelectorAll('[data-project-drag-root="C:/fixture"] [role="treeitem"]').length === 5);
      assert.deepEqual(await previewIds(), ["pinned", "fork", "newest", "third", "fourth"], "five-session preview keeps pin and recency order without attention extras");
      assert.equal(await page.locator('[data-project-drag-root="C:/small"]').getByRole("treeitem").count(), 0);
      assert.equal(await project.locator('[data-project-drag-handle] .sidebar-running-spinner').count(), 1, "hidden running sessions still surface on the project heading");
      const toggleProject = project.locator('[data-project-drag-handle] button[aria-expanded]').first();
      const showAll = project.getByRole("button", { name: locale === "en" ? "Show all conversations (7)" : "显示所有会话（7）", exact: true });
      const showFewer = project.getByRole("button", { name: locale === "en" ? "Show fewer" : "收起会话", exact: true });
      const drag = async (source, target) => {
        const from = await project.getByRole("treeitem", { name: source, exact: true }).boundingBox();
        const to = await project.getByRole("treeitem", { name: target, exact: true }).boundingBox();
        await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(320);
        await page.mouse.move(to.x + to.width / 2, to.y + 3, { steps: 6 });
        await page.mouse.up();
      };
      await drag("newest", "third");
      assert.equal(await page.evaluate(() => window.events.reorder), 0, "flat preview never reorders across hidden branch ownership");
      await showAll.click();
      const parent = project.getByRole("treeitem", { name: "older", exact: true });
      if (await parent.getAttribute("aria-expanded") === "false") await parent.press("ArrowRight");
      await page.waitForFunction(() => document.querySelector('[data-session-drag-id="fork"]')?.getAttribute('aria-level') === '2');
      assert.equal(await project.getByRole("treeitem").count(), 7, "expanding restores all sessions and their hierarchy");
      await drag("newest", "third");
      assert.equal(await page.evaluate(() => window.events.reorder), 1, "full-tree siblings remain draggable");
      await project.getByRole("treeitem", { name: "fork", exact: true }).click();
      assert.equal(await project.getByRole("treeitem", { name: "fork", exact: true }).getAttribute("aria-selected"), "true");
      await toggleProject.click();
      assert.deepEqual(await previewIds(), [], "clicking the project again fully collapses it");
      await toggleProject.click();
      assert.equal(await showFewer.isVisible(), true, "project visibility keeps its independent all-sessions setting");
      await page.evaluate(() => window.setOrder(["fourth", "fork"]));
      await showFewer.click();
      assert.deepEqual(await previewIds(), ["pinned", "fourth", "fork", "newest", "third"], "restored preview follows manual order");
      await showAll.click();
      assert.equal(await project.getByRole("treeitem", { name: "fork", exact: true }).getAttribute("aria-level"), "2", "showing all restores the branch beneath its original parent");
      const small = page.locator('[data-project-drag-root="C:/small"]');
      assert.equal(await small.getByRole("button", { name: /Show all conversations|显示所有会话/ }).count(), 0);
      const smallToggle = small.locator('[data-project-drag-handle] button[aria-expanded]').first();
      await smallToggle.click();
      const smallParent = small.getByRole("treeitem", { name: "small-a", exact: true });
      await smallParent.press("ArrowRight");
      assert.equal(await small.getByRole("treeitem", { name: "small-fork", exact: true }).getAttribute("aria-level"), "2", "small projects keep their original tree without an overflow toggle");
      await smallToggle.click();
      assert.equal(await page.locator('[data-project-drag-root="C:/empty"]').getByText(locale === "en" ? "No conversations yet" : "还没有会话", { exact: true }).isVisible(), true);

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

      const savedState = () => page.evaluate(() => [
        "piora:sidebar-collapsed-projects:v1",
        "piora:sidebar-expanded-project-sessions:v1",
        "piora:expanded-branches:v1:project:C:/fixture",
        "piora:sidebar-session-order:v1",
      ].map(key => localStorage.getItem(key)));
      const before = await savedState();
      const fullIds = await previewIds();
      await page.evaluate(() => { window.originalProject = document.querySelector('[data-project-drag-root="C:/fixture"]'); });
      await clickBlank(projectsToggle);
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await page.locator("#projects").getByRole("button", { name: "fixture", exact: true }).count(), 0, "section collapse hides project rows as well as sessions");
      assert.equal(await project.isVisible(), false);
      assert.equal(await page.locator(".sidebar-project-scroll").isVisible(), false);
      assert.deepEqual(await savedState(), before, "section collapse never rewrites project, overflow, branch or order preferences");
      const sectionBox = await page.locator("#projects").boundingBox();
      const headerBox = await page.locator(".sidebar-projects-header").boundingBox();
      assert.ok(Math.abs(sectionBox.height - headerBox.height) < 1, "collapsed section leaves only the heading without blank list space");
      await page.locator('.sidebar-projects-header').getByRole("button", { name: locale === "en" ? "New project" : "新建项目", exact: true }).click();
      assert.equal(await page.evaluate(() => window.events.newProject), 1);
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "false", "header actions remain independent");
      await projectsToggle.focus(); await page.keyboard.press("Enter");
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "true");
      assert.deepEqual(await previewIds(), fullIds);
      assert.equal(await showFewer.isVisible(), true);
      assert.equal(await small.getByRole("treeitem").count(), 0, "individually collapsed projects stay collapsed");
      assert.equal(await page.evaluate(() => window.originalProject === document.querySelector('[data-project-drag-root="C:/fixture"]')), true, "section toggle preserves the mounted project subtree");
      assert.deepEqual(await savedState(), before);
      await projectsToggle.focus(); await page.keyboard.press("Space");
      assert.equal(await project.getByRole("treeitem").count(), 0);
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#chats button[aria-expanded]')?.getAttribute('aria-expanded') === 'false');
      assert.equal(await roomToggle.getAttribute("aria-expanded"), "false");
      assert.equal(await projectsToggle.getAttribute("aria-expanded"), "false");
      assert.deepEqual(await previewIds(), [], "collapsed state persists after reload");
      assert.equal(await project.isVisible(), false);
      assert.deepEqual(await savedState(), before, "refresh preserves all inner preferences while the section is hidden");
      await projectsToggle.click();
      assert.equal(await toggleProject.getAttribute("aria-expanded"), "true");
      assert.equal(await small.locator('[data-project-drag-handle] button[aria-expanded]').first().getAttribute("aria-expanded"), "false");
      assert.equal(await showFewer.isVisible(), true);
      assert.equal(await project.getByRole("treeitem", { name: "fork", exact: true }).getAttribute("aria-level"), "2");
      assert.deepEqual(await previewIds(), fullIds, "all sessions, their order and branches survive section collapse and refresh");
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
