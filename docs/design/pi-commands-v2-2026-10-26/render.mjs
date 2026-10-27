import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
const dir=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(dir,'../../../package.json'));
const {chromium}=require('playwright-core');
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1360,height:960},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=pathToFileURL(path.join(dir,'index.html')).href;
const shots=[
 ['idle','普通输入','从输入框进入命令，保留原有对话习惯。'],
 ['menu','发现命令','会话操作与 Skill 分组，直接说明各自的发送方式。'],
 ['ready','执行会话命令','补全命令后再执行，可选添加后续提问。'],
 ['params','填写必需参数','缺少名称时就地提示，参数完整后才可执行。'],
 ['skill','Skill + query','选中 Skill 后继续输入任务，命令、正文和附件一起发送。'],
 ['followup','完成后再提问','会话命令成功后再发送问题；与 Skill 的 query 区分。'],
 ['queued','忙碌时等待','明确等待原因，允许取消排队或停止当前任务再执行。'],
 ['running','执行中','对话内显示实际执行状态，等待真实结果再确认完成。'],
 ['success','成功与详情','轻量回执，展开后查看命令、加载结果与执行时间。'],
 ['failure','失败与恢复','显示失败原因和重试入口，未发送的问题留在输入框。'],
 ['question','扩展交互','扩展请求的选择直接显示在对话内，回复后继续。'],
];
await fs.mkdir(path.join(dir,'screenshots'),{recursive:true});
async function snap(state,name,theme='',width=1360,height=960){
 await page.setViewportSize({width,height});
 await page.goto(`${base}?capture=1&state=${state}&theme=${theme}`);
 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:path.join(dir,'screenshots',name+'.png'),animations:'disabled'});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow)throw new Error('Horizontal overflow: '+name);
 const bounds=await page.locator('.composer').boundingBox();
 if(bounds.y+bounds.height>height)throw new Error('Composer clipped: '+name);
 const toolbars=await page.locator('.composer .toolbar').count();
 if(toolbars!==1)throw new Error('Duplicate toolbar: '+name);
}
for(let i=0;i<shots.length;i++)await snap(shots[i][0],`${String(i+1).padStart(2,'0')}-${shots[i][0]}`);
await snap('menu','12-menu-dark','dark');
await snap('skill','13-skill-dark','dark');
await snap('skill','14-skill-narrow','',540,960);
await page.goto(base+'?state=menu');
await page.getByRole('button',{name:'/skill:code-review'}).click();
if(!(await page.getByLabel('消息输入').inputValue()).includes('异常处理'))throw new Error('Skill query missing');
await page.getByRole('button',{name:'发送',exact:true}).click();
await page.getByText('/skill:code-review 正在审查代码').waitFor();
await page.getByText('/skill:code-review 已完成').waitFor();
await page.selectOption('#stateSelect','params');
if(!(await page.locator('#renameButton').isDisabled()))throw new Error('Missing parameter accepted');
await page.locator('#name').fill('命令交互改版');
if(!(await page.locator('#renameButton').isEnabled()))throw new Error('Valid parameter rejected');
await page.selectOption('#stateSelect','failure');
if(!(await page.getByLabel('消息输入').inputValue()).includes('确认新加载'))throw new Error('Failure draft missing');
await page.selectOption('#stateSelect','queued');
await page.getByRole('button',{name:'取消排队',exact:true}).click();
if(await page.locator('.receipt').count())throw new Error('Queue cancellation failed');
await page.selectOption('#stateSelect','question');
await page.getByRole('radio').nth(1).check();
await page.getByRole('button',{name:'确认并继续'}).click();
await page.getByText('/review 正在审查当前改动').waitFor();
if(errors.length)throw new Error(errors.join('\n'));
const cards=shots.map(([state,title,desc],i)=>`<article><a class="shot" href="index.html?state=${state}" title="打开此状态的可交互原型"><img src="screenshots/${String(i+1).padStart(2,'0')}-${state}.png" alt="${title}"></a><div class="caption"><span>${String(i+1).padStart(2,'0')}</span><div><h2>${title}</h2><p>${desc}</p></div><a href="screenshots/${String(i+1).padStart(2,'0')}-${state}.png" title="查看大图">↗</a></div></article>`).join('');
const gallery=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Piora · 命令交互状态图</title><style>*{box-sizing:border-box}body{margin:0;color:#18181b;background:#fff;font:14px Inter,'Microsoft YaHei UI',sans-serif}header{padding:48px 48px 32px;display:flex;align-items:end;justify-content:space-between}.eyebrow{font-size:12px;letter-spacing:2px;color:#71717a}h1{font-size:34px;font-weight:600;margin:12px 0}header p{font-size:14px;color:#71717a;margin:0}header a{font-size:13px;background:#18181b;color:#fff;border-radius:8px;padding:12px 18px;text-decoration:none}.principles{margin:0 48px 32px;display:flex;gap:24px;font-size:12px;color:#52525b}.principles b{font-weight:600;color:#18181b}.grid{padding:0 48px 40px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:28px 24px}article{min-width:0}.shot{display:block;border:1px solid #e4e4e7;border-radius:0;overflow:hidden;box-shadow:none;background:white}.shot img{display:block;width:100%;height:auto}.caption{display:flex;gap:12px;padding:14px 2px 0}.caption>span{font:12px/22px Consolas,monospace;color:#71717a}.caption h2{font-size:15px;font-weight:600;margin:0 0 6px}.caption p{font-size:12px;color:#71717a;line-height:1.7;margin:0}.caption>a{margin-left:auto;text-decoration:none;color:#71717a;padding:0 6px}.variants{padding:0 48px 48px}.variants h2{font-size:20px;font-weight:600}.variants .row{display:grid;grid-template-columns:1fr 1fr .4fr;gap:24px}.variants img{width:100%;border-radius:0;border:1px solid #e4e4e7}.variants p{font-size:12px;color:#71717a}.note{padding:24px 48px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;line-height:1.8}.note a{color:inherit}.capture .variants,.capture .note{display:none}@media(max-width:800px){header{padding:24px;display:block}header a{display:inline-block;margin-top:20px}.principles{margin:0 24px 24px;display:block;line-height:2}.grid{padding:0 24px;grid-template-columns:1fr}.variants{padding:24px}.variants .row{grid-template-columns:1fr}.variants .row a:last-child{width:60%}h1{font-size:28px}}</style><body><header><div><div class="eyebrow">PIORA / INTERACTION DESIGN / 02</div><h1>命令交互 · 简约版</h1><p>去掉卡片层叠，让内容、输入和执行反馈自然衔接。</p></div><a href="index.html">打开交互原型 ↗</a></header><div class="principles"><span><b>统一入口</b>　输入 / 发现命令</span><span><b>两种提交方式</b>　会话命令直接执行 · Skill 与 query 一起发送</span><span><b>对话内反馈</b>　进度、结果与恢复操作</span></div><main class="grid">${cards}</main><section class="variants"><h2>深色主题与窄窗口</h2><div class="row"><a href="index.html?state=menu&theme=dark"><img src="screenshots/12-menu-dark.png" alt="深色命令选择"><p>深色 · 命令选择</p></a><a href="index.html?state=skill&theme=dark"><img src="screenshots/13-skill-dark.png" alt="深色技能输入"><p>深色 · Skill 输入</p></a><a href="screenshots/14-skill-narrow.png"><img src="screenshots/14-skill-narrow.png" alt="窄窗口技能输入"><p>窄窗口 · 540 px</p></a></div></section><footer class="note">设计稿 · 所有执行结果、数量、技能与扩展名称均为示例。原型不会调用 Pi 或更改工作区。点击任意状态图进入原型，点击 ↗ 查看原尺寸图片。<br>交互参考：<a href="https://code.claude.com/docs/en/interactive-mode">Claude Code</a> · <a href="https://cursor.com/help/customization/skills">Cursor Skills</a> · <a href="https://code.visualstudio.com/docs/chat/chat-overview">VS Code Chat</a></footer><script>if(new URLSearchParams(location.search).has('capture'))document.body.classList.add('capture')</script></body></html>`;
await fs.writeFile(path.join(dir,'overview.html'),gallery);
await page.setViewportSize({width:1800,height:1200});
await page.goto(pathToFileURL(path.join(dir,'overview.html')).href+'?capture=1');
await page.screenshot({path:path.join(dir,'overview.png'),fullPage:true});
await browser.close();
console.log('Rendered 14 screenshots + overview. Prototype checks passed: skill submit, parameter validation, retained draft, queue cancellation, extension reply; no JS errors or horizontal overflow.');
