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

test("image preview fits small images, zooms, pans, resizes and closes", { timeout: 120000 }, async () => {
 const directory=await mkdtemp(path.join(tmpdir(), "piora-image-viewer-")); let browser;
 try {
  await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,"entry.tsx"), `import {useState} from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from "@/hooks/useI18n";import {MessageImageViewer} from "@/components/MessageImage";function App(){const [open,setOpen]=useState(false);return <I18nProvider><button onClick={()=>setOpen(true)}>Open</button>{open&&<MessageImageViewer src="/small.svg" index={0} onClose={()=>setOpen(false)}/>}</I18nProvider>}createRoot(document.getElementById("root")).render(<App/>);`);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  const css=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
  browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.addInitScript(()=>localStorage.setItem("pi-locale","zh-CN"));
  await page.route("http://image.test/**",async route=>{const url=route.request().url();if(url.endsWith("bundle.js"))return route.fulfill({body:await readFile(path.join(directory,"bundle.js")),contentType:"text/javascript"});if(url.endsWith("small.svg"))return route.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',contentType:"image/svg+xml"});return route.fulfill({body:`<html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`,contentType:"text/html"});});
  await page.goto("http://image.test"); await page.getByText("Open",{exact:true}).click();
  const dialog=page.getByRole("dialog");const img=dialog.locator("img");await img.waitFor();
  await page.waitForFunction(()=>document.querySelector("dialog img")?.naturalWidth===200);
  assert.equal(Math.round((await img.boundingBox()).width),200);assert.ok((await dialog.boundingBox()).width<700);
  const viewport=dialog.locator(".message-image-dialog-viewport");await viewport.hover();await page.mouse.wheel(0,-400);
  await page.waitForFunction(()=>document.querySelector("dialog img").getBoundingClientRect().width>200);
  const box=await viewport.boundingBox();await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+70,box.y+50);await page.mouse.up();assert.match(await img.getAttribute("style"),/translate\(40px, 20px\)/);
  await page.getByRole("button",{name:"1:1",exact:true}).click();assert.equal(Math.round((await img.boundingBox()).width),200);
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).resize),"both");
  await page.keyboard.press("Escape");assert.equal(await dialog.count(),0);assert.equal(await page.getByText("Open",{exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByText("Open",{exact:true}).click();await page.mouse.click(10,10);assert.equal(await dialog.count(),0);
 } finally {await browser?.close();await rm(directory,{recursive:true,force:true});}
});
