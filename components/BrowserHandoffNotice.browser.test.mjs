import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("browser handoff shows waiting, navigation and accurate terminal status", { timeout: 120000 }, async () => {
 const directory=await mkdtemp(path.join(tmpdir(), "piora-handoff-")); let browser;
 try {
  await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,"entry.tsx"), `import {createRoot} from "react-dom/client";import {I18nProvider} from "@/hooks/useI18n";import {BrowserHandoffNotice} from "@/components/BrowserHandoffNotice";window.opened=[];window.addEventListener('piora:open-agent-browser',e=>window.opened.push(e.detail.sessionId));createRoot(document.getElementById("root")).render(<I18nProvider><BrowserHandoffNotice sessionId="fixture" busy={true}/></I18nProvider>);`);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  const css=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
  browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.addInitScript(()=>localStorage.setItem("pi-locale","zh-CN"));
  let status="waiting", purpose="confirmation", toolCallId="one", startedAt=Date.now();const decisions=[];
  await page.route("http://image.test/**",async route=>{const url=route.request().url();if(url.endsWith("browser-wait")&&route.request().method()==="POST"){decisions.push(route.request().postDataJSON());status="continued";return route.fulfill({json:{ok:true}})}if(url.endsWith("browser-wait"))return route.fulfill({json:{wait:status==="waiting"?{sessionId:"fixture",toolCallId,reason:"请登录",backend:"desktop",purpose,startedAt}:null,outcome:status!=="waiting"?{toolCallId,status,purpose,endedAt:Date.now()}:null}});if(url.endsWith("bundle.js"))return route.fulfill({body:await readFile(path.join(directory,"bundle.js")),contentType:"text/javascript"});return route.fulfill({body:`<html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`,contentType:"text/html"});});
  page.on("pageerror", error => console.error(error));
  await page.goto("http://image.test");await page.getByText("等待用户操作",{exact:true}).waitFor();
  await page.getByRole("button",{name:"打开浏览器接手"}).click();assert.deepEqual(await page.evaluate(()=>window.opened),["fixture"]);
  status="continued";await page.getByText("浏览器操作已确认，助手已获准继续。",{exact:true}).waitFor();
  status="timeout";await page.getByText("等待浏览器操作已超时，未确认完成。",{exact:true}).waitFor();
  assert.equal(await page.getByText("浏览器操作已确认，助手已获准继续。",{exact:true}).count(),0);
  purpose="login";toolCallId="two";status="waiting";
  await page.waitForFunction(()=>window.opened.length===2);
  assert.deepEqual(await page.evaluate(()=>window.opened),["fixture","fixture"]);
  assert.equal(await page.locator('.browser-handoff-notice').count(),0,"login reveals the browser without a card");
  await page.waitForTimeout(1700);
  assert.equal(await page.evaluate(()=>window.opened.length),2,"polling never repeatedly opens the browser");
  status="continued";
  await page.waitForTimeout(1700);
  assert.equal(await page.locator('.browser-handoff-notice').count(),0,"automatic completion stays silent");
  toolCallId="three";status="waiting";startedAt=Date.now()-5*60_000-1000;
  await page.getByRole('button',{name:'我已登录，继续',exact:true}).waitFor();
  assert.equal(await page.locator('.browser-handoff-notice,.browser-user-wait').count(),0,"fallback is an inline hint, not a login card");
  await page.getByRole('button',{name:'我已登录，继续',exact:true}).click();
  assert.deepEqual(decisions,[{decision:'continue',toolCallId:'three'}]);
  await page.waitForFunction(()=>document.querySelector('.browser-login-fallback')===null);


 } finally {await browser?.close();await rm(directory,{recursive:true,force:true});}
});
