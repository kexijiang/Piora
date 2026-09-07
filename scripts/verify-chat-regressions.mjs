// Run against npm run dev. API fixtures do not create sessions or execute commands.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const projectRoot = process.cwd();
const baseUrl = process.env.PIORA_TEST_URL ?? 'http://127.0.0.1:30141';
import assert from 'node:assert/strict';
const browser=await chromium.launch({...(process.env.PIORA_BROWSER_EXECUTABLE ? {executablePath:process.env.PIORA_BROWSER_EXECUTABLE} : {channel:'msedge'}),headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const id='11111111-1111-4111-8111-111111111111';
 const info={id,name:'界面回归测试',cwd:projectRoot,projectRoot,path:'test.jsonl',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:4,firstMessage:'测试'};
 const messages=[{role:'user',content:'测试命令输出',timestamp:1},{role:'assistant',content:[{type:'toolCall',toolName:'bash',toolCallId:'shell',input:{command:'echo hello'}}],timestamp:2},{role:'toolResult',toolCallId:'shell',content:[{type:'text',text:'hello visible output'}],timestamp:3},{role:'assistant',content:[{type:'text',text:'**重点文字**，*强调*，以及 <mark>高亮文字</mark>。'}],timestamp:4}];
 await page.route('**/api/**',route=>{
 const url=new URL(route.request().url());
 if(url.pathname==='/api/sessions') return route.fulfill({json:{sessions:[info]}});
 if(url.pathname===`/api/sessions/${id}`) return route.fulfill({json:{sessionId:id,info,filePath:'test.jsonl',tree:[],leafId:'a',context:{messages,entryIds:['u','b','r','a'],thinkingLevel:'off',model:null}}});
 if(url.pathname.startsWith(`/api/agent/${id}`)) return route.fulfill({json:{success:true,data:{isStreaming:false,messages,commands:[]}}});
 if(url.pathname==='/api/terminal/events') return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'snapshot',connected:true,output:'terminal sample output',shell:'test'})+'\n\n'});
 return route.continue();
 });
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.goto(baseUrl+'/?session='+id,{waitUntil:'domcontentloaded',timeout:120000});
 const resize=page.getByRole('separator',{name:'从左侧调整主对话宽度',exact:true});
 await resize.waitFor({timeout:60000});
 await page.locator('.chat-column:visible').first().waitFor(); await resize.focus(); await resize.press('Home'); await resize.press('Shift+ArrowLeft');
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); const before=await page.evaluate(()=>localStorage.getItem('pi-chat-column-width'));
 const renderedBefore=await page.locator('.chat-column:visible').first().evaluate(e=>e.getBoundingClientRect().width);
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('dialog').waitFor();
 await page.waitForFunction(()=>(document.querySelector('.chat-column')?.getBoundingClientRect().width ?? 0)===0);
 assert.equal(await page.evaluate(()=>localStorage.getItem('pi-chat-column-width')),before);

 await page.getByRole('button',{name:'返回 Piora',exact:true}).click();
 await resize.waitFor();
 assert.equal(await page.locator('.chat-column:visible').first().evaluate(e=>e.getBoundingClientRect().width),renderedBefore);
 assert.equal(await page.evaluate(()=>localStorage.getItem('pi-chat-column-width')),before);
 assert.equal(await page.getByText('hello visible output',{exact:true}).isVisible(),true);
 console.log('WIDTH PASS',before,renderedBefore);
 await page.getByRole('button',{name:'显示文件面板',exact:true}).click();
  await page.locator('#file-panel').getByRole('button',{name:'终端',exact:true}).click();
 await page.locator('#workspace-commands').waitFor();
 await page.getByRole('tab',{name:'终端',exact:true}).waitFor();
 for (const size of [{width:1440,height:900},{width:800,height:600}]) {
   await page.setViewportSize(size);
   const tab=page.getByRole('tab',{name:'终端',exact:true});
   await tab.waitFor();
   const box=await tab.boundingBox();
   assert.ok(box && box.y>=0 && box.y+box.height<=size.height);
   const close=page.locator('#workspace-commands').getByRole('button',{name:'关闭当前工具',exact:true});
   assert.equal(await close.isVisible(),true);
 }
 await page.locator('#workspace-commands').getByRole('button',{name:'关闭当前工具',exact:true}).click();
 await page.getByRole('tab',{name:'终端',exact:true}).waitFor({state:'detached'});
 console.log('TERMINAL PASS: tab visible at desktop/narrow sizes; independent close works');
 await page.setViewportSize({width:1440,height:900});

 assert.equal(await page.evaluate(()=>localStorage.getItem('pi-chat-column-width')),before);
 console.log('ERRORS',errors);
 mkdirSync(resolve('.verification'),{recursive:true});
 await page.screenshot({path:resolve('.verification/chat-regressions.png')});
 assert.deepEqual(errors, []);
} finally {await browser.close();}
