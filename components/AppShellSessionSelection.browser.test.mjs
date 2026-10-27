import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const source = ts.createSourceFile("AppShell.tsx", await readFile(path.join(repo, "components/AppShell.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks = new Map(), helpers = new Map();
function collect(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
    const callback = node.initializer.arguments[0];
    if (callback && ts.isArrowFunction(callback)) callbacks.set(node.name.text, callback.getText(source));
  }
  if (ts.isFunctionDeclaration(node) && node.name) helpers.set(node.name.text, node.getText(source));
  ts.forEachChild(node, collect);
}
collect(source);
const sessions = [
  { id: "a", cwd: "F:\\Alpha", projectRoot: "F:\\Alpha", name: "Alpha existing chat" },
  { id: "a2", cwd: "F:\\Alpha", projectRoot: "F:\\Alpha", name: "Alpha second chat" },
  { id: "b", cwd: "F:\\Beta", projectRoot: "F:\\Beta", name: "Beta existing chat" },
  { id: "c", cwd: "F:\\Notes", projectRoot: "F:\\Notes", name: "Non-Git chat" },
  { id: "aw", cwd: "F:\\Alpha-worktrees\\feature", projectRoot: "F:\\Alpha", name: "Alpha worktree chat" },
  { id: "p", cwd: "C:\\Users\\user\\pi-cwd-chat", projectless: true, name: "Projectless existing chat" },
].map(item => ({ ...item, path: `${item.cwd}\\${item.id}.jsonl`, created: "2026-10-20T00:00:00Z", modified: "2026-10-20T01:00:00Z", messageCount: 2, firstMessage: item.name }));

test("one project-session click keeps the chosen chat through cwd effects and delayed confirmations", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-sidebar-selection-"));
  let browser;
  t.after(async () => {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-sidebar-selection-"));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `const path=require('node:path');module.exports=function(s){const prefix=path.basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(m,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)};`);
  await writeFile(path.join(directory, "stub.tsx"), "export const DirectoryPicker=()=>null;export const RoomSidebarSection=()=>null;export const ConversationSearchDialog=()=>null;");
  await writeFile(path.join(directory, "entry.tsx"), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SessionSidebar} from '@/components/SessionSidebar'; import {I18nProvider} from '@/hooks/useI18n';
import {parseWorkspaceContinuity,workspaceContinuityStorageKey} from '@/lib/workspace-continuity';
${["getSelectionHistoryState", "replaceUrlWithoutNextNavigation"].map(name => helpers.get(name)).join("\n")}
const sessions=${JSON.stringify(sessions)};
window.states=[]; window.confirmations=[];
function App(){
  const [selectedSession,setSelectedSession]=React.useState(sessions[0]);
  const [selectedRoom,setSelectedRoom]=React.useState(null);
  const [newSessionCwd,setNewSessionCwd]=React.useState(null);
  const [sessionKey,setSessionKey]=React.useState(0);
  const [activeCwd,setActiveCwd]=React.useState(sessions[0].cwd);
  const [activeProjectRoot,setActiveProjectRoot]=React.useState(sessions[0].projectRoot);
  const activeProjectRootRef=React.useRef(sessions[0].projectRoot);
  const selectedSessionIdRef=React.useRef(null); selectedSessionIdRef.current=selectedSession?.id??null;
  const suppressCwdBumpRef=React.useRef(false),chatInputRef=React.useRef({focus(){}});
  const workspaceNavigationVersionRef=React.useRef(0);
  const [fileTabs,setFileTabs]=React.useState([]),[activeFileTabId,setActiveFileTabId]=React.useState(null);
  const [,setRightPanelOpen]=React.useState(false),rightPanelTab='files',isMobile=false;
  const [,setSettingsDialogOpen]=React.useState(false),[,setHistoryDialogOpen]=React.useState(false),[,setHistoryLocation]=React.useState(null);
  const [,setActiveTopPanel]=React.useState(null),[,setNewSessionInitialModel]=React.useState(null),[,setNewSessionInitialPrompt]=React.useState(null);
  const [,setFocusedEntryId]=React.useState(null),[,setSystemPrompt]=React.useState(null),[,setInitialSessionRestored]=React.useState(true),[,setSidebarOpen]=React.useState(true);
  const translate=React.useCallback(key=>key,[]);
  const requestConfirmation=()=>new Promise(resolve=>{window.confirmations.push(resolve)});
  const handleCwdChange=React.useCallback(${callbacks.get("handleCwdChange")},[activeFileTabId,fileTabs,rightPanelTab,selectedRoom,selectedSession,translate]);
  const handleSelectSession=React.useCallback(${callbacks.get("handleSelectSession")},[isMobile]);
  const handleNewSession=React.useCallback(${callbacks.get("handleNewSession")},[isMobile]);
  window.navigation=()=>({id:selectedSession?.id??null,cwd:activeCwd,project:activeProjectRoot,sessionKey,newSessionCwd,tabs:fileTabs.map(tab=>tab.id)});
  window.startCwdChange=(cwd)=>{window.pendingCwdChange=handleCwdChange(cwd,cwd)};
  window.makeDirty=()=>setFileTabs([{id:'dirty',filePath:'F:\\\\Alpha\\\\edited.ts',isDirty:true}]);
  window.makeClean=()=>setFileTabs([]);
  React.useLayoutEffect(()=>{window.states.push(window.navigation())},[selectedSession,sessionKey,newSessionCwd]);
  return <I18nProvider><aside style={{width:320,height:800}}><SessionSidebar selectedSessionId={selectedSession?.id??null}
    selectedCwd={selectedSession?.projectless?null:selectedSession?.cwd??newSessionCwd??null} activeProjectRoot={activeProjectRoot} onSelectSession={handleSelectSession}
    onNewSession={handleNewSession} onCwdChange={handleCwdChange} /></aside>
    <main><output>{selectedSession?selectedSession.name:'New session'}</output><textarea key={sessionKey} aria-label="composer" defaultValue={selectedSession?.id??'new'}/></main></I18nProvider>
}
createRoot(document.getElementById('root')).render(<App/>);`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false,
    entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
    resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
    plugins: [new webpack.NormalModuleReplacementPlugin(/[/\\](DirectoryPicker|RoomSidebarSection|ConversationSearchDialog)$/, path.join(directory, "stub.tsx"))],
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
  });
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve())));
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1100, height: 850 } });
  const errors=[]; page.on("pageerror",error=>errors.push(error.message));
  const worktrees = {
    "F:\\Alpha": [{path:"F:\\Alpha",branch:"main",isMain:true},{path:"F:\\Alpha-worktrees\\feature",branch:"feature",isMain:false}],
    "F:\\Beta": [{path:"F:\\Beta",branch:"main",isMain:true}],
  };
  const mutations = [];
  await page.route("http://selection.test/**",async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/sessions')return route.fulfill({json:{sessions,runningSessionIds:[]}});
    if(url.pathname==='/api/sessions/flags')return route.fulfill({json:{flags:{}}});
    if(url.pathname==='/api/home')return route.fulfill({json:{home:'C:\\Users\\user'}});
    if(url.pathname==='/api/worktrees') {
      if (route.request().method() !== "GET") {
        const body = route.request().postDataJSON();
        mutations.push({method:route.request().method(),...body});
        if (route.request().method() === "POST") {
          const checkout = {path:body.cwd + "-worktrees\\" + body.branch,branch:body.branch,isMain:false};
          worktrees[body.cwd].push(checkout);
          return route.fulfill({json:{path:checkout.path}});
        }
        if (!body.force) return route.fulfill({status:409,json:{dirty:true}});
        worktrees[body.cwd] = worktrees[body.cwd].filter(wt=>wt.path!==body.path);
        return route.fulfill({json:{success:true}});
      }
      const cwd=url.searchParams.get('cwd');
      const projectRoot=cwd?.includes('Alpha')?'F:\\Alpha':cwd?.includes('Beta')?'F:\\Beta':cwd;
      return route.fulfill({json:{projectRoot,isGit:Boolean(worktrees[projectRoot]),isTopLevel:true,worktrees:worktrees[projectRoot]??[]}});
    }
    if(url.pathname.startsWith('/api/'))return route.fulfill({json:{rooms:[],snapshots:[],sessions:[],sessionIds:[]}});
    if(url.pathname.endsWith('.js'))return route.fulfill({contentType:'text/javascript',body:await readFile(path.join(directory,path.basename(url.pathname)))});
    return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="display:flex;margin:0"><div id="root" style="display:flex"></div><script src="/bundle.js"></script></body></html>'});
  });
  await page.goto("http://selection.test/");
  await page.getByRole("treeitem",{name:"Beta existing chat",exact:true}).waitFor();
  for(const id of ['b','p','a2','aw','a']){
    await page.evaluate(()=>{window.states=[]});
    await page.getByRole('treeitem',{name:sessions.find(s=>s.id===id).name,exact:true}).click({timeout:5000}).catch(async cause=>{throw new Error(cause.message+' | '+await page.locator('body').innerText()+' | '+JSON.stringify(await page.evaluate(()=>window.navigation())))});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.navigation().id),id,JSON.stringify(await page.evaluate(()=>window.states)));
    const target=sessions.find(s=>s.id===id);
    await page.waitForFunction(cwd=>window.navigation().cwd===cwd,target.projectless?null:target.cwd);
    assert.ok((await page.evaluate(()=>window.states)).every(state=>state.id===id),JSON.stringify(await page.evaluate(()=>window.states)));
    assert.equal(new URL(page.url()).searchParams.get('session'),id);
  }
  // An older project transition must not overwrite a session chosen while its
  // unsaved-file question is pending.
  await page.evaluate(()=>window.makeDirty());
  await page.evaluate(()=>{void window.startCwdChange('F:\\Beta')});
  await page.waitForFunction(()=>window.confirmations.length>0);
  await page.getByRole('treeitem',{name:'Beta existing chat',exact:true}).click();
  await page.waitForFunction(()=>window.navigation().id==='b');
  await page.evaluate(async()=>{
    window.confirmations[0](false); await window.pendingCwdChange;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
  assert.equal(await page.evaluate(()=>window.navigation().id),'b');
  assert.equal(new URL(page.url()).searchParams.get('session'),'b');
  // The dirty-tab confirmation scenario above deliberately leaves its draft.
  // Finish that scenario before testing ordinary worktree navigation.
  await page.evaluate(()=>window.makeClean());
  // Worktree controls belong to their project, never to global navigation.
  const alpha = page.getByRole('region',{name:'Alpha',exact:true});
  const beta = page.getByRole('region',{name:'Beta',exact:true});
  const openProjectMenu = async (name) => {
    const project = page.getByRole('region',{name,exact:true});
    await project.getByRole('button',{name,exact:true}).hover();
    await project.getByRole('button',{name:`Project menu for ${name}`,exact:true}).click();
  };
  assert.equal(await page.locator('.sidebar-header').count(), 0);
  assert.equal(await page.locator('.project-worktree-section').count(), 0, 'single checkout is hidden');
  await openProjectMenu('Beta');
  await page.getByRole('menuitem',{name:'Worktrees…',exact:true}).click();
  await beta.getByRole('button',{name:'Switch worktree',exact:true}).waitFor();
  await beta.getByText('Main worktree',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelectorAll('.project-worktree-section').length===0);
  assert.equal(await beta.getByRole('button',{name:'Project menu for Beta',exact:true}).evaluate(el=>el===document.activeElement),true);
  // Open an unselected, collapsed project from its menu without using Beta's data.
  await alpha.getByRole('button',{name:'Alpha',exact:true}).click();
  await beta.getByRole('treeitem',{name:'Beta existing chat',exact:true}).click();
  await openProjectMenu('Alpha');
  await page.getByRole('menuitem',{name:'Worktrees…',exact:true}).click();
  await alpha.getByRole('button',{name:'feature',exact:true}).click();
  await page.waitForFunction(()=>window.navigation().cwd==='F:\\Alpha-worktrees\\feature');
  assert.equal(await alpha.locator('.project-worktree-section').count(),1);
  assert.equal(await beta.locator('.project-worktree-section').count(),0);
  const switcher=alpha.getByRole('button',{name:'Switch worktree',exact:true});
  assert.match(await switcher.innerText(),/feature/);
  assert.equal(await switcher.getAttribute('aria-expanded'),'false');
  await switcher.click();
  await alpha.getByRole('button',{name:'main Main worktree',exact:true}).click();
  await page.waitForFunction(()=>window.navigation().cwd==='F:\\Alpha');
  await alpha.getByRole('button',{name:'New worktree…',exact:true}).waitFor({state:'hidden'});
  if(process.env.PIORA_WORKTREE_SCREENSHOTS) {
    await mkdir(path.join(repo,'test-results','worktree-sidebar'),{recursive:true});
    await page.screenshot({path:path.join(repo,'test-results','worktree-sidebar','multiple.png')});
  }
  await openProjectMenu('Beta');
  await page.getByRole('menuitem',{name:'Worktrees…',exact:true}).click();
  await beta.getByRole('button',{name:'New worktree…',exact:true}).click();
  await beta.getByPlaceholder('branch name').fill('layout-check');
  await beta.getByRole('button',{name:'Create',exact:true}).click();
  await page.waitForFunction(()=>window.navigation().cwd==='F:\\Beta-worktrees\\layout-check');
  await beta.getByRole('button',{name:'Switch worktree',exact:true}).click();
  await beta.getByRole('button',{name:'Remove worktree checkout F:\\Beta-worktrees\\layout-check; the branch is kept',exact:true}).click();
  await beta.getByRole('button',{name:'Force',exact:true}).click();
  await page.waitForFunction(()=>window.navigation().cwd==='F:\\Beta');
  assert.deepEqual(mutations,[
    {method:'POST',cwd:'F:\\Beta',branch:'layout-check'},
    {method:'DELETE',cwd:'F:\\Beta',path:'F:\\Beta-worktrees\\layout-check',force:false},
    {method:'DELETE',cwd:'F:\\Beta',path:'F:\\Beta-worktrees\\layout-check',force:true},
  ]);
  await page.keyboard.press('Escape');
  const notesLoaded = page.waitForResponse(response=>{
    const url = new URL(response.url());
    return url.pathname === '/api/worktrees' && url.searchParams.get('cwd') === 'F:\\Notes';
  });
  await openProjectMenu('Notes');
  await notesLoaded;
  assert.equal(await page.getByRole('menuitem',{name:'Worktrees…',exact:true}).count(),0,'non-Git project has no worktree action');
  assert.deepEqual(errors,[]);
});
