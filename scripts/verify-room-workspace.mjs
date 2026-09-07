import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const webpack = require("next/dist/compiled/webpack/webpack").webpack;
const output = path.resolve(".verification/room-workspace");
mkdirSync(output, { recursive: true });
const results = [];
const check = (name, condition) => { assert.ok(condition, name); results.push(name); console.log(`PASS ${name}`); };
writeFileSync(path.join(output, "stubs.tsx"), `
import React from 'react';
const t = (key)=>key;
export const useI18n=()=>({t});
export const AliIcon=()=> <span aria-hidden="true"/>;
export const MarkdownBody=({children})=><div>{children}</div>;
export const CollapsibleUserContent=({message})=><div>{message.content}</div>;
export const RoomSettingsDialog=()=>null;
`);
writeFileSync(path.join(output, "fixture.tsx"), `
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RoomWorkspace} from '@/components/RoomWorkspace';
import {VirtualList} from '@/components/VirtualList';
import {useSendShortcut} from '@/hooks/useSendShortcut';
import {followChatBottom} from '@/lib/chat-bottom-follow';
window.submissions=[]; window.browserMember=null;
window.fetch=async(url,init)=>{
 if(init?.method==='POST'){window.submissions.push(JSON.parse(init.body));return {ok:true,json:async()=>({dispatch:{dispatched:[]}})}}
 return {ok:true,json:async()=>({runs:[]})};
};
window.EventSource=class {
 constructor(url){this.url=url; if(url.includes('/rooms/room/events'))window.roomEvents=this;
  setTimeout(()=>{this.onopen?.(); if(url.includes('/rooms/room/events'))this.onmessage?.({data:JSON.stringify({type:'snapshot',messages:[]})});},20);}
 addEventListener(){} close(){} };
const members=['协调者','研究员'].map((name,i)=>({memberId:'m'+i,sessionId:'s'+i,name,role:i?'worker':'coordinator',profile:{name},binding:{sessionId:'s'+i,status:'ready'}}));
const room={id:'room',name:'个人智能体团队',members,projectRoot:'F:/fixture',workspace:{path:'F:/fixture',label:'共享文件',mode:'managed'},coordination:{mode:'manual',coordinatorMemberId:'m0',maxConcurrency:2}};
const keys=Array.from({length:1000},(_,i)=>String(i));
function App(){const {shortcut,setShortcut}=useSendShortcut();const list=useRef(null),scroll=useRef(null),stop=useRef(()=>{});const [tab,setTab]=useState('room');
 return <><nav><button id="setting" onClick={()=>setShortcut(shortcut==='enter'?'ctrl-enter':'enter')}>{shortcut}</button>
 <button id="navigation" onClick={()=>setTab('navigation')}>Navigation test</button></nav>
 {tab==='room'?<div style={{height:'calc(100vh - 50px)'}}><RoomWorkspace initialRoom={room} onRoomDeleted={()=>{}} onOpenBrowser={(id)=>window.browserMember=id}/></div>:
 <><button id="bottom" onClick={()=>{list.current.cancelNavigation();stop.current();stop.current=followChatBottom(scroll.current,()=>{const s=scroll.current;s.scrollTop=s.scrollHeight-s.clientHeight-180;});}}>Latest</button><button id="jump" onClick={()=>{stop.current();list.current.scrollToKey('640');}}>Jump once</button><button id="grow" onClick={()=>{
 const target=document.querySelector('[data-virtual-key="639"]');if(target)target.style.paddingTop='350px';}}>Delayed layout</button>
 <div id="scroll" ref={scroll} style={{height:450,overflow:'auto'}}><div style={{padding:18}}><VirtualList keys={keys} initialTail estimate={160} handleRef={list} scrollContainer={scroll}
 renderItem={(key)=><div style={{height:50+(Number(key)%7)*41,padding:12}}>User {key}</div>}/><div id="tail" style={{height:180}}/></div></div></>}
 </>;
}createRoot(document.getElementById('root')).render(<App/>);
`);
writeFileSync(path.join(output, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){return ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText}`);
writeFileSync(path.join(output, "css-loader.cjs"), `module.exports=function(source){const names=[...source.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>m[1]);return 'const css='+JSON.stringify(source)+';const s=document.createElement("style");s.textContent=css;document.head.append(s);export default '+JSON.stringify(Object.fromEntries(names.map(n=>[n,n])))}`);
const aliases = {};
for(const name of ["@/hooks/useI18n", "./MarkdownBody", "./CollapsibleUserContent", "./RoomSettingsDialog"]) aliases[name+'$']=path.join(output,"stubs.tsx");
aliases["@"] = process.cwd();
await new Promise((resolve,reject)=>{
const compiler=webpack({mode:'production',target:'web',entry:path.join(output,'fixture.tsx'),output:{path:output,filename:'fixture.js'},optimization:{minimize:false},
resolve:{extensions:['.tsx','.ts','.js'],alias:aliases},module:{rules:[{test:/\.tsx?$/,use:path.join(output,'loader.cjs')},{test:/\.css$/,use:path.join(output,'css-loader.cjs')}]}});
compiler.run((error,stats)=>compiler.close(()=>error||stats?.hasErrors()?reject(error||new Error(stats.toString({all:false,errors:true}))):resolve()));});
writeFileSync(path.join(output,'index.html'),`<!doctype html><html><meta charset="utf-8"><title>Room workspace verification</title><style>
:root{--bg:#fafafa;--bg-panel:#fff;--bg-hover:#eee;--bg-selected:#e9f2ef;--border:#dedede;--text:#202828;--text-muted:#657575;--text-dim:#789;--accent:#23856e;--text-xs:12px;--text-sm:13px;--text-base:15px;--tool-bg:#eef2ef;--font-mono:monospace}*{box-sizing:border-box}body{margin:0;font:14px system-ui}nav{padding:6px}button,textarea{font:inherit}</style><div id="root"></div><script src="fixture.js"></script></html>`);
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
const evaluate=(code)=>page.evaluate(code);
const wait=(code)=>page.waitForFunction(code,{},{timeout:20000});
try {
 await page.goto(pathToFileURL(path.join(output,'index.html')).href);
 await wait('Boolean(window.roomEvents && document.querySelector("textarea"))');
 if(await page.locator('#setting').textContent()!=='ctrl-enter') await page.locator('#setting').click();
 await page.locator('textarea').fill('测试快捷键');await page.locator('textarea').press('Enter');
 check('Ctrl+Enter preference: Enter adds a newline without submitting',await evaluate('window.submissions.length===0 && document.querySelector("textarea").value.endsWith("\\n")'));
 await page.locator('textarea').press('Control+Enter');await wait('window.submissions.length===1');
 check('Ctrl+Enter sends exactly once',await evaluate('window.submissions[0].content==="测试快捷键"'));
 await page.locator('#setting').click();await page.locator('textarea').fill('普通 Enter');await page.locator('textarea').press('Enter');await wait('window.submissions.length===2');
 check('changing the setting takes effect in the mounted composer',true);
 await evaluate(`(()=>{const el=document.querySelector('textarea');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));})()`);
 check('IME confirmation does not submit',await evaluate('window.submissions.length===2'));
 const activity={sessionId:'s1',runId:'r1',status:'working',phase:'正在思考',text:'正在检查资料。',thinking:'先检查来源，再进行比较。',tools:[{id:'t',name:'piora_browser',status:'running',input:'navigate',output:''}],browser:true,updatedAt:Date.now()};
 await page.evaluate(activity=>window.roomEvents.onmessage({data:JSON.stringify({type:'activity',activities:[activity]})}),activity);
 await wait('document.body.textContent.includes("先检查来源")');
 check('live thinking and browser activity render inside the room',await evaluate('document.body.textContent.includes("piora_browser") && window.browserMember==="s1"'));
 check('execution steps render in the conversation scroll area, with no top execution deck',await page.evaluate(()=>Boolean(document.querySelector('[data-room-message-list] [data-room-activity]')) && !document.querySelector('[aria-label="团队执行现场"]')));
 check('tool output is collapsed by default',await page.locator('[data-room-activity] details.liveTool').evaluate(element=>!element.open));
 await page.locator('[data-room-activity] details.liveTool > summary').click();
 check('tool output expands in place',await page.locator('[data-room-activity] details.liveTool').evaluate(element=>element.open));
 await page.screenshot({path:path.join(output,'inline-steps.png')});
 await page.locator('[data-room-activity] details.liveTool > summary').click();
 await page.getByRole('button',{name:'补充指令',exact:true}).click();
 check('follow-up addresses the selected member in the room',await evaluate('document.querySelector("textarea").value.includes("@研究员")'));
 const widthBefore = await page.locator('.composerWrap').evaluate(element=>element.getBoundingClientRect().width);
 const handle = page.locator('[data-resize-handle="room-column"]');
 const handleBox = await handle.boundingBox();
 await page.mouse.move(handleBox.x + 5, handleBox.y + 80); await page.mouse.down();
 await page.mouse.move(handleBox.x - 95, handleBox.y + 80, { steps: 10 }); await page.mouse.up();
 check('dragging the group column widens both composer and conversation',await page.locator('.composerWrap').evaluate((element,before)=>element.getBoundingClientRect().width > before + 150,widthBefore));
 check('room width persists',Number(await page.evaluate(()=>localStorage.getItem('pi-room-column-width'))) > widthBefore);
 await handle.press('Enter');
 check('Enter restores the default room width',Math.abs(await page.locator('.composerWrap').evaluate(element=>element.getBoundingClientRect().width)-840)<2);
 const stamp=Date.now();
 const roomMessages=[{id:'u1',roomId:'room',seq:1,author:{id:'user',kind:'user',name:'我'},content:'定位第一条群聊消息',createdAt:stamp-5000,payload:{}},{id:'a1',roomId:'room',seq:2,author:{id:'s0',kind:'agent',name:'协调者'},content:('长正文\n').repeat(1500),createdAt:stamp-4000,payload:{}}];
 await page.evaluate(messages=>window.roomEvents.onmessage({data:JSON.stringify({type:'snapshot',messages})}),roomMessages);
 await page.locator('[data-testid="room-message-timeline"]').waitFor();
 const rail=await page.locator('[data-testid="room-message-timeline"]').boundingBox();
 await page.mouse.move(rail.x+18,rail.y+rail.height*.65);
 const preview=page.locator('[data-testid="room-message-timeline"] [data-minimap-preview-box]'); await preview.waitFor();
 const previewBox=await preview.boundingBox();
 check('sparse room history opens beside the pointer',Math.abs(previewBox.y-(rail.y+rail.height*.65))<40);
 await page.mouse.move(previewBox.x+previewBox.width-6,rail.y+rail.height*.65,{steps:8});
 await preview.locator('button.previewItem').click();
 check('the pointer can cross into the history preview and jump',await page.locator('[data-room-message-list]').evaluate(element=>element.scrollTop<100));
 await page.evaluate(activity=>window.roomEvents.onmessage({data:JSON.stringify({type:'activity',activities:[{...activity,status:'ended',tools:[{...activity.tools[0],status:'completed'}]}]})}),activity);
 await page.evaluate(activity=>window.roomEvents.onmessage({data:JSON.stringify({type:'activity',activities:[{...activity,runId:'r2',startedAt:Date.now(),thinking:'下一轮执行'}]})}),activity);
 check('a new run preserves the previous run steps in the conversation',await page.locator('[data-room-message-list] [data-room-activity]').count()===2);
 await page.screenshot({path:path.join(output,'desktop.png')});
 await page.setViewportSize({width:390,height:844});
 check('room supports a narrow viewport',await evaluate('document.documentElement.scrollWidth<=innerWidth'));
 await page.screenshot({path:path.join(output,'mobile.png')});
 await page.locator('#navigation').click();await page.locator('#jump').click();
 const aligned=`(()=>{const el=document.querySelector('[data-virtual-key="640"]'),s=document.querySelector('#scroll');return el && Math.abs(el.getBoundingClientRect().top-s.getBoundingClientRect().top-s.clientHeight*.3)<2})()`;
 await wait(aligned);
 check('first click aligns an unmeasured historical row within 2px',true);
 await evaluate(`document.querySelector('[data-virtual-key="639"]').style.paddingTop='350px'`);
 await wait(aligned);
 check('late content growth preserves the navigation target',true);
 await page.locator('#bottom').click();
 const bottom=`(()=>{const el=document.querySelector('[data-virtual-key="999"]'),s=document.querySelector('#scroll');return el && Math.abs(s.scrollHeight-s.clientHeight-s.scrollTop-180)<2})()`;
 await wait(bottom);
 check('one bottom click reaches the actual last message, excluding tail spacer',true);
 await evaluate(`document.querySelector('[data-virtual-key="999"]').style.paddingBottom='300px'`);
 await wait(bottom);
 check('bottom jump follows delayed last-message layout',true);
 await evaluate(`(()=>{const s=document.querySelector('#scroll');s.dispatchEvent(new WheelEvent('wheel',{deltaY:-100}));s.scrollTop-=300;window.manualTop=s.scrollTop;})()`);
 await evaluate(`document.querySelector('[data-virtual-key="999"]').style.paddingBottom='500px'`);
 await page.waitForTimeout(200);
 check('manual scrolling cancels bottom following',await evaluate('Math.abs(document.querySelector("#scroll").scrollTop-window.manualTop)<2'));
 check('navigation keeps the history window bounded',await evaluate('document.querySelectorAll("[data-virtual-key]").length<80'));
 check('no uncaught browser errors',errors.length===0);
 writeFileSync(path.join(output,'report.json'),JSON.stringify({results,errors},null,2));
} catch(error) {await page.screenshot({path:path.join(output,'failure.png')});console.error(errors);throw error;}
finally{await browser.close();}
