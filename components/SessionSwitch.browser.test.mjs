import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import ts from "typescript";

const require=createRequire(import.meta.url),repo=path.resolve(import.meta.dirname,"..");
const {webpack}=require("next/dist/compiled/webpack/webpack.js");
const shell=ts.createSourceFile("AppShell.tsx",await readFile(path.join(repo,"components/AppShell.tsx"),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let selection;
function collect(node){if(ts.isVariableDeclaration(node)&&node.name.getText(shell)==="handleSelectSession")selection=node.initializer.arguments[0].getText(shell);ts.forEachChild(node,collect);}collect(shell);
assert.ok(selection);

test("prepared session switches never paint a blank chat or collapse a running process first",{timeout:180000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),"piora-session-switch-"));let browser;
  const gates=new Map(),waiting=new Set(),requests=[];
  try{
    await writeFile(path.join(root,"loader.cjs"),`const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root,"css.cjs"),'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root,"entry.tsx"),`
import{useRef,useState}from"react";import{createRoot}from"react-dom/client";
import{ChatWindow}from"@/components/ChatWindow";import{I18nProvider,useI18n}from"@/hooks/useI18n";
import{prepareSessionSwitch}from"@/lib/session-prefetch";
const noop=()=>{},sessions=Object.fromEntries(["a","b","c","broken"].map(id=>[id,{id,path:"",cwd:"C:/"+id,created:"",modified:"sidebar-"+id,messageCount:2,firstMessage:id,name:"Chat "+id}]));
window.sources=[];window.EventSource=class{static OPEN=1;static CLOSED=2;readyState=1;constructor(url){this.url=location.origin+url;window.sources.push(this);setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:"connected"})}),0)}close(){this.readyState=2}};
function App(){const{t:translate}=useI18n();const[selectedSession,setSelectedSession]=useState(sessions.a),[sessionKey,setSessionKey]=useState(0),[pendingSessionSwitch,setPendingSessionSwitch]=useState(null),[sessionSwitchError,setSessionSwitchError]=useState(null),[focused,setFocusedEntryId]=useState(null);
  const selectedSessionIdRef=useRef(null);selectedSessionIdRef.current=selectedSession.id;
  const workspaceNavigationVersionRef=useRef(0),suppressCwdBumpRef=useRef(false),chatInputRef=useRef(null);
  const isMobile=false,setSettingsDialogOpen=noop,setHistoryDialogOpen=noop,setHistoryLocation=noop,setSelectedRoom=noop,setActiveTopPanel=noop,setNewSessionCwd=noop,setNewSessionInitialModel=noop,setNewSessionInitialPrompt=noop,setSystemPrompt=noop,setInitialSessionRestored=noop,setSidebarOpen=noop;
  const replaceUrlWithoutNextNavigation=url=>history.replaceState(null,"",url);
  const select=${selection};
  window.select=id=>select(sessions[id]);window.current={id:selectedSession.id,pending:pendingSessionSwitch?.id,error:sessionSwitchError};
  return <><nav>{Object.keys(sessions).map(id=><button key={id} onClick={()=>void select(sessions[id])}>Chat {id}</button>)}</nav>
    <h1>Chat {selectedSession.id}</h1><div id="view" inert={Boolean(pendingSessionSwitch)} aria-busy={Boolean(pendingSessionSwitch)}>
      <ChatWindow key={sessionKey} session={selectedSession} newSessionCwd={null} focusEntryId={focused} chatInputRef={chatInputRef}/>
    </div>{pendingSessionSwitch&&<div role="status" className="session-switch-status is-pending">{translate("chat.loadingSession")}</div>}{sessionSwitchError&&<p role="alert">{sessionSwitchError}</p>}</>;
}createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(root,"entry.tsx"),output:{path:root,filename:"bundle.js",publicPath:"/"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules"),"node_modules"],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(root,"loader.cjs")},{test:/\.css$/,use:path.join(root,"css.cjs")}]}});
    await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
    const css=(await readFile(path.join(repo,"node_modules/tailwindcss/preflight.css"),"utf8"))+(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
    browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
    const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];
    page.on("pageerror",error=>errors.push(error.stack||error.message));
    await page.addInitScript(()=>localStorage.setItem("pi-locale","zh-CN"));
    const runtime=id=>({running:id==="b",state:{runtime:id==="b"?"running":"idle",isStreaming:id==="b",isPromptRunning:id==="b"}});
    await page.route("http://127.0.0.1:38204/**",async route=>{
      const request=route.request(),url=new URL(request.url()),pathname=url.pathname;requests.push(pathname);
      const match=pathname.match(/^\/api\/sessions\/(a|b|c|broken)$/);
      if(match){const id=match[1];if(gates.has(id)){waiting.add(id);await gates.get(id).promise;}if(id==="broken")return route.fulfill({status:503,json:{error:"fixture offline"}});
        const now=Date.now(),messages=[{role:"user",content:"QUESTION_"+id,timestamp:now-5000},{role:"assistant",content:[{type:"thinking",thinking:"THINKING_"+id},{type:"text",text:Array.from({length:24},(_,i)=>"ANSWER_"+id+" · paragraph "+i).join("\n\n")}],timestamp:now-4000}];
        return route.fulfill({json:{sessionId:id,info:{id,cwd:"C:/"+id,modified:"server-"+id},context:{messages,entryIds:[id+"-user",id+"-assistant"],model:{provider:"fixture",modelId:"fixture-model"},thinkingLevel:"auto"},tree:[],leafId:id+"-assistant",persistedPromptIds:[]}});
      }
      const state=pathname.match(/^\/api\/(?:sessions\/([^/]+)\/state|agent\/([^/]+))$/);
      if(state&&request.method()==="GET")return route.fulfill({json:runtime(state[1]??state[2])});
      if(pathname.endsWith("/submissions"))return route.fulfill({json:{items:[],nextOffset:null,taskTimings:[]}});
      if(pathname==="/api/models")return route.fulfill({json:{models:{},modelList:[{id:"fixture-model",provider:"fixture",name:"Fixture model",input:["text","image"]}],defaultModel:{provider:"fixture",modelId:"fixture-model"}}});
      if(pathname==="/api/settings/laboratory")return route.fulfill({json:{planGoalEnabled:false}});
      if(pathname==="/api/system-prompt")return route.fulfill({json:{templates:[],defaultTemplateId:null,selectorVisible:false,maxPromptLength:100000,maxNameLength:80}});
      if(pathname.startsWith("/api/"))return route.fulfill({json:{success:true,data:{commands:[],catalog:{revision:"fixture",commands:[]}},files:[],enabled:false,available:false,items:[],commands:[],records:[],operations:[],taskTimings:[],submissions:[],hasMore:false}});
      if(pathname.endsWith(".js"))return route.fulfill({contentType:"text/javascript",body:await readFile(path.join(root,path.basename(pathname)))});
      return route.fulfill({contentType:"text/html",body:`<!doctype html><meta charset="utf-8"><style>${css}
        body{margin:0;background:var(--bg);color:var(--text)}nav{display:flex;gap:12px;padding:12px}h1{margin:0;padding:8px;font-size:16px}#view{height:calc(100vh - 110px);width:900px;margin:auto}#view>.flex{height:100%}
        .flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.h-full{height:100%}.relative{position:relative}.absolute{position:absolute}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.pt-4{padding-top:16px}
        </style><div id="root"></div><script src="/bundle.js"></script>`});
    });
    const hold=id=>{let resolve;const promise=new Promise(done=>{resolve=done;});gates.set(id,{promise,resolve});};
    const release=id=>{gates.get(id)?.resolve();gates.delete(id);};
    await page.goto("http://127.0.0.1:38204/");
    await page.getByText("ANSWER_a · paragraph 23",{exact:true}).waitFor();
    await page.locator("textarea").fill("DRAFT_A_PRESERVED");
    await page.evaluate(()=>{window.switchFrames=[];window.sampleSwitch=true;const sample=()=>{const view=document.querySelector("#view");window.switchFrames.push({id:window.current.id,pending:window.current.pending,loading:Boolean(view.querySelector(".session-loading-indicator")),rows:view.querySelectorAll("[data-chat-entry-id]").length,expanded:view.querySelector(".compact-process-toggle")?.getAttribute("aria-expanded"),label:view.querySelector(".compact-process-toggle")?.textContent});if(window.sampleSwitch)requestAnimationFrame(sample);};requestAnimationFrame(sample);});
    hold("b");await page.getByRole("button",{name:"Chat b",exact:true}).click();
    await page.waitForFunction(()=>window.current.pending==="b");
    assert.equal(await page.locator("#view").getAttribute("inert"),"");
    assert.equal(await page.locator("textarea").inputValue(),"DRAFT_A_PRESERVED");
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole("heading",{name:"Chat a",exact:true}).count(),1,"the previous chat stays visible while the next projection is held");
    hold("c");await page.getByRole("button",{name:"Chat c",exact:true}).click();
    await page.waitForFunction(()=>window.current.pending==="c");
    release("b");await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.current.pending),"c","an earlier completion cannot dismiss the latest switch");
    release("c");await page.getByRole("heading",{name:"Chat c",exact:true}).waitFor();
    await page.getByText("ANSWER_c · paragraph 23",{exact:true}).waitFor();
    await page.getByRole("button",{name:"Chat b",exact:true}).click();
    await page.getByRole("heading",{name:"Chat b",exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelector(".compact-process-toggle")?.getAttribute("aria-expanded")==="true");
    await page.waitForTimeout(150);
    await page.evaluate(()=>window.sampleSwitch=false);
    const frames=await page.evaluate(()=>window.switchFrames);
    const output=path.join(repo,".verification/session-switch-20261111");await mkdir(output,{recursive:true});await writeFile(path.join(output,"frames.json"),JSON.stringify(frames,null,2));
    assert.ok(frames.length>10);
    assert.ok(frames.every(frame=>!frame.loading&&frame.rows>0),"no switch frame paints the loading shell or an empty history");
    assert.ok(frames.filter(frame=>frame.id==="b").every(frame=>frame.expanded==="true"&&frame.label.includes("正在处理")),"running history opens in its active state on the first frame");
    await page.getByRole("button",{name:"Chat a",exact:true}).click();
    await page.getByRole("heading",{name:"Chat a",exact:true}).waitFor();
    assert.equal(await page.locator("textarea").inputValue(),"DRAFT_A_PRESERVED");
    await page.getByRole("button",{name:"Chat broken",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"会话加载失败"}).waitFor();
    assert.equal(await page.getByRole("heading",{name:"Chat a",exact:true}).count(),1);
    assert.equal(await page.locator("textarea").inputValue(),"DRAFT_A_PRESERVED");
    assert.equal(await page.locator("#view").getAttribute("inert"),null);
    assert.deepEqual(errors,[]);
    await page.screenshot({path:path.join(output,"retained-chat-after-load-error.png")});
  }finally{for(const gate of gates.values())gate.resolve();await browser?.close();assert.equal(path.dirname(root),path.resolve(tmpdir()));assert.ok(path.basename(root).startsWith("piora-session-switch-"));await rm(root,{recursive:true,force:true});}
});
