import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
const base='http://127.0.0.1:30141';
const browser=await chromium.launch({channel:'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960},locale:'zh-CN',serviceWorkers:'block'});
const page=await context.newPage();page.setDefaultTimeout(60000);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const id='piora-ui-regression',cwd=process.cwd();
const messages=[{role:'user',content:'验证命令执行与视觉识别后界面',timestamp:1},{role:'assistant',content:[{type:'toolCall',toolCallId:'bash-a',toolName:'bash',input:{command:'npm run typecheck'}}],timestamp:2},{role:'toolResult',toolCallId:'bash-a',content:[{type:'text',text:'> tsc --noEmit\nAll checks passed.'}]},{role:'assistant',content:[{type:'text',text:'检查完成。\n\n'+('这一段用于检查少量会话记录在长内容中的定位。\n\n'.repeat(100))}],timestamp:3}];
let terminalInputs='',terminalResizes=0;
await context.addInitScript(()=>{
 const NativeSource=window.EventSource;
 window.EventSource=class {
  static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;
  constructor(url){if(!String(url).includes('/api/terminal/events'))return new NativeSource(url);window.__terminalSource=this;setTimeout(()=>this.emit({type:'snapshot',output:'Piora interactive shell\r\nF:\\Piora> ',connected:true,shell:'cmd.exe'}),30);}
  emit(value){this.onmessage?.({data:JSON.stringify(value)});}close(){this.readyState=2;}
 };
});
await context.route('**/api/**',async route=>{
 const request=route.request(),url=new URL(request.url()),p=url.pathname;
 if(p==='/api/sessions')return route.fulfill({json:{sessions:[{id,path:'fixture',cwd,projectRoot:cwd,name:'终端交互验收',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:messages.length,firstMessage:'终端交互验收'}],runningSessionIds:[]}});
 if(p===`/api/sessions/${id}`)return route.fulfill({json:{sessionId:id,filePath:'fixture',tree:[],leafId:'entry-3',context:{messages,entryIds:messages.map((_,i)=>'entry-'+i),thinkingLevel:'off',model:null}}});
 if(p===`/api/agent/${id}/commands`)return route.fulfill({json:{commands:[]}});
 if(p===`/api/agent/${id}`)return route.fulfill({json:request.method()==='GET'?{running:false}:{success:true,data:{commands:[]}}});
 if(p==='/api/terminal'&&request.method()==='POST'){
  const body=request.postDataJSON();if(body.action==='input'){terminalInputs+=body.data;await page.evaluate(data=>window.__terminalSource?.emit({type:'output',output:data}),body.data);}if(body.action==='resize')terminalResizes++;
  if(body.action==='clear')await page.evaluate(()=>window.__terminalSource?.emit({type:'clear'}));
  return route.fulfill({json:{ok:true}});
 }
 if(request.method()!=='GET')return route.fulfill({status:503,json:{error:'Fixture: mutation blocked'}});
 if(p.includes(id))return route.fulfill({json:{running:false}});
 return route.continue();
});
const button=name=>page.getByRole('button',{name,exact:true});
await mkdir('.verification/workspace-redesign',{recursive:true});
try{
 await page.goto(base+'/?session='+id,{waitUntil:'domcontentloaded',timeout:60000});
 await page.locator('#chat-scroll-container').waitFor({timeout:60000});
 const node=page.locator('[data-minimap-node-index="0"]');await node.waitFor();
 await node.hover();const preview=page.locator('[data-minimap-preview-box]').filter({has:page.locator('[data-minimap-preview-user]')});
 await preview.waitFor();await page.waitForTimeout(200);const nr=await node.boundingBox(),pr=await preview.boundingBox();assert.ok(Math.abs(pr.y-nr.y)<40,JSON.stringify({nr,pr}));
 await page.mouse.move(pr.x+pr.width-8,nr.y+7,{steps:8});await page.locator('[data-minimap-preview-user="0"]').click();
 console.log('PASS sparse timeline anchors to pointer and remains clickable');
 await button('设置').click();
 await button('通用').click();
 const content=page.locator('.settings-content');await content.waitFor();
 await page.screenshot({path:'.verification/workspace-redesign/settings.png'});
 for(const name of ['项目工具','技能','扩展','插件']){
  const buttons=page.getByRole('button',{name,exact:true});
  if(await buttons.count()===0)throw new Error('Missing setting: '+name+'\n'+await page.locator('body').innerText());
  await buttons.first().click();await page.locator('.settings-content').getByText(name,{exact:true}).first().waitFor();
 }
 await page.screenshot({path:'.verification/workspace-redesign/settings-plugins.png'});
 await button('返回 Piora').click();
 await button('显示文件面板').click();

 await button('终端').click();
 await page.locator('[data-terminal-surface="shell"] .xterm-helper-textarea').waitFor({timeout:60000});
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('echo hello');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>window.__terminalSource!=null);await page.waitForTimeout(500);
 assert.equal(terminalInputs,'echo hello\r');assert.ok(terminalResizes>0);
 await page.screenshot({path:'.verification/workspace-redesign/terminal-shell.png'});
 await page.evaluate(()=>{window.piDesktop={clipboard:{writeText:async value=>{window.__copiedText=value;}}};});
 const screen=await page.locator('.xterm-screen').boundingBox();
 await page.mouse.dblclick(screen.x+20,screen.y+8);
 await page.keyboard.press('Control+c');
 await page.waitForFunction(()=>window.__copiedText?.includes('Piora'));
 assert.equal(terminalInputs,'echo hello\r','copy selection must not interrupt the shell');
 await page.mouse.click(screen.x+250,screen.y+60);await page.locator('.xterm-helper-textarea').focus();
 await page.keyboard.press('Control+c');await page.waitForTimeout(300);
 assert.ok(terminalInputs.endsWith('\u0003'),'Ctrl+C without selection reaches the shell');
 await page.getByRole('tab',{name:/Agent 执行/}).click();
 const command=page.getByRole('tabpanel').getByRole('button',{name:/npm run typecheck/});await command.waitFor();
 assert.equal(await command.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('[data-terminal-surface="agent"]').count(),0);
 await command.click();await page.locator('[data-terminal-surface="agent"] .xterm-helper-textarea').waitFor();
 await page.screenshot({path:'.verification/workspace-redesign/terminal-agent.png'});
 await command.click();assert.equal(await page.locator('[data-terminal-surface="agent"]').count(),0);
 assert.deepEqual(errors,[]);console.log('PASS terminal key input, resize, Agent history, default collapse, expand/collapse; restored settings; no page errors');
}catch(e){await page.screenshot({path:'.verification/workspace-redesign/failure.png'});await writeFile('.verification/workspace-redesign/failure.txt',await page.locator('body').innerText());throw e;}finally{await browser.close();}
