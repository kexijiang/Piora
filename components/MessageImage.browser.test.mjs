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

test("image preview fits small images, zooms, pans, resizes and closes without aborting the running agent", { timeout: 120000 }, async () => {
 const directory=await mkdtemp(path.join(tmpdir(), "piora-image-viewer-")); let browser;
 try {
  await writeFile(path.join(directory,"loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory,"entry.tsx"), `import {useEffect,useState} from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from "@/hooks/useI18n";import {registerAbortHandler,useGlobalKeyboardShortcuts} from "@/hooks/useKeyboardShortcuts";import {MessageImageViewer} from "@/components/MessageImage";function App(){const [open,setOpen]=useState(false);const [abortCount,setAbortCount]=useState(0);useGlobalKeyboardShortcuts();useEffect(()=>{registerAbortHandler(()=>setAbortCount(count=>count+1));return()=>registerAbortHandler(null);},[]);return <I18nProvider><button onClick={()=>setOpen(true)}>Open</button><output data-testid="abort-count">{abortCount}</output>{open&&<MessageImageViewer src="/small.svg" index={0} onClose={()=>setOpen(false)}/>}</I18nProvider>}createRoot(document.getElementById("root")).render(<App/>);`);
  const compiler=webpack({mode:"development",target:"web",devtool:false,entry:path.join(directory,"entry.tsx"),output:{path:directory,filename:"bundle.js"},resolve:{extensions:[".tsx",".ts",".js"],modules:[path.join(repo,"node_modules")],alias:{"@":repo}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:path.join(directory,"loader.cjs")}]}});
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve())));
  const css=(await readFile(path.join(repo,"app/globals.css"),"utf8")).replace(/^@import.*$/gm,"");
  browser=await chromium.launch({channel:process.platform==="win32"?"msedge":"chromium",headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  await page.addInitScript(()=>{
    localStorage.setItem("pi-locale","zh-CN");window.copiedImages=[];
    window.piDesktop={clipboard:{writeImage:async data=>{if(window.copyFailure)throw Error("denied");window.copiedImages.push(data);}}};
  });
  await page.route("https://image.test/**",async route=>{const url=route.request().url();if(url.endsWith("bundle.js"))return route.fulfill({body:await readFile(path.join(directory,"bundle.js")),contentType:"text/javascript"});if(url.endsWith("small.svg"))return route.fulfill({body:'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="red"/></svg>',contentType:"image/svg+xml"});return route.fulfill({body:`<html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`,contentType:"text/html"});});
  await page.goto("https://image.test"); await page.getByText("Open",{exact:true}).click();
  const dialog=page.getByRole("dialog");const img=dialog.locator("img");await img.waitFor();
  await page.waitForFunction(()=>document.querySelector("dialog img")?.naturalWidth===200);
  assert.equal(Math.round((await img.boundingBox()).width),200);assert.ok((await dialog.boundingBox()).width<700);
  const viewport=dialog.locator(".message-image-dialog-viewport");await viewport.hover();await page.mouse.wheel(0,-400);
  await page.waitForFunction(()=>document.querySelector("dialog img").getBoundingClientRect().width>200);
  const box=await viewport.boundingBox();await page.mouse.move(box.x+30,box.y+30);await page.mouse.down();await page.mouse.move(box.x+70,box.y+50);await page.mouse.up();assert.match(await img.getAttribute("style"),/translate\(40px, 20px\)/);
  await dialog.getByRole("button",{name:"复制图片",exact:true}).click();
  await dialog.getByRole("status").filter({hasText:"已复制"}).waitFor();
  const copied=await page.evaluate(async()=>{
    const blob=await(await fetch(window.copiedImages[0])).blob(),bitmap=await createImageBitmap(blob);
    const canvas=document.createElement("canvas");canvas.width=bitmap.width;canvas.height=bitmap.height;
    const ctx=canvas.getContext("2d");ctx.drawImage(bitmap,0,0);const pixel=[...ctx.getImageData(0,0,1,1).data];
    const result={type:blob.type,width:bitmap.width,height:bitmap.height,pixel};bitmap.close();return result;
  });
  assert.deepEqual(copied,{type:"image/png",width:200,height:100,pixel:[255,0,0,255]},"copy retains original pixels after zooming and panning");
  await viewport.focus();await page.keyboard.press("Control+c");
  await page.waitForFunction(()=>window.copiedImages.length===2);
  await page.evaluate(()=>window.copyFailure=true);
  await dialog.getByRole("button",{name:"复制图片",exact:true}).click();
  await dialog.getByRole("status").filter({hasText:"复制失败"}).waitFor();
  assert.equal(await dialog.isVisible(),true,"copy failure keeps the image open for retry");
  await page.evaluate(()=>{
    delete window.piDesktop;
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{write:async items=>{
      window.browserImage=await items[0].getType("image/png");
    }}});
  });
  await viewport.focus();await page.keyboard.press("Meta+c");
  await page.waitForFunction(()=>Boolean(window.browserImage));
  assert.deepEqual(await page.evaluate(async()=>{const image=await createImageBitmap(window.browserImage);const result={type:window.browserImage.type,width:image.width,height:image.height};image.close();return result;}),
    {type:"image/png",width:200,height:100},"browser clipboard also receives full-resolution PNG pixels");
  await dialog.getByRole("status").filter({hasText:"已复制"}).waitFor();
  await page.getByRole("button",{name:"1:1",exact:true}).click();assert.equal(Math.round((await img.boundingBox()).width),200);
  assert.equal(await dialog.evaluate(el=>getComputedStyle(el).resize),"both");
  await page.keyboard.press("Escape");assert.equal(await dialog.count(),0,"Escape from the image toolbar closes only the preview");assert.equal(await page.getByText("Open",{exact:true}).evaluate(el=>el===document.activeElement),true);
  assert.equal(await page.getByTestId("abort-count").textContent(),"0","closing the preview must not stop the running agent");
  await page.getByText("Open",{exact:true}).click();await dialog.waitFor();await viewport.focus();await page.keyboard.press("Escape");
  assert.equal(await dialog.count(),0,"Escape also closes the preview when its viewport has focus");
  assert.equal(await page.getByTestId("abort-count").textContent(),"0");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("abort-count").textContent(),"1","Escape still stops the running agent after the preview closes");
  await page.getByText("Open",{exact:true}).click();await page.mouse.click(10,10);assert.equal(await dialog.count(),0);
 } finally {await browser?.close();assert.equal(path.dirname(directory),path.resolve(tmpdir()));assert.ok(path.basename(directory).startsWith("piora-image-viewer-"));await rm(directory,{recursive:true,force:true});}
});
