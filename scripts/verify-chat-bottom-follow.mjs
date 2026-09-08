import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const webpack = require("next/dist/compiled/webpack/webpack").webpack;
const output = path.resolve(".verification/chat-bottom-follow");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "fixture.tsx"), `
import React,{useRef,useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {VirtualList} from '@/components/VirtualList';
import {followChatBottom} from '@/lib/chat-bottom-follow';
const keys=Array.from({length:1000},(_,i)=>String(i));
function Row({id}) {
 const [ready,setReady]=useState(false);
 useEffect(()=>{const timer=setTimeout(()=>setReady(true),80);return ()=>clearTimeout(timer)},[]);
 return <div style={{height:ready?50+(Number(id)%7)*411:32,padding:12}}>Message {id}</div>;
}
function App(){const scroll=useRef(null),list=useRef(null),stop=useRef(()=>{});
 useEffect(()=>()=>stop.current(),[]);
 return <><button id="jump" onClick={()=>{stop.current();list.current.scrollToKey('400')}}>History</button>
 <button id="bottom" onClick={()=>{list.current.cancelNavigation();stop.current();stop.current=followChatBottom(scroll.current,()=>{const s=scroll.current;s.scrollTop=Math.max(0,s.scrollHeight-s.clientHeight-180)})}}>Latest</button>
 <div id="scroll" ref={scroll} style={{height:450,overflow:'auto',overflowAnchor:'none'}}>
 <div><VirtualList keys={keys} estimate={160} initialTail handleRef={list} scrollContainer={scroll} renderItem={key=><Row id={key}/>}/><div style={{height:180}}/></div></div></>;
}createRoot(document.getElementById('root')).render(<App/>);
`);
writeFileSync(path.join(output, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=source=>ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;`);
await new Promise((resolve, reject) => {
  const compiler = webpack({ mode: "production", target: "web", entry: path.join(output, "fixture.tsx"),
    output: { path: output, filename: "fixture.js" }, optimization: { minimize: false },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": process.cwd() } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(output, "loader.cjs") }] },
  });
  compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
    ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
});
writeFileSync(path.join(output, "index.html"), '<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;font:15px sans-serif}</style><div id="root"></div><script src="fixture.js"></script>');
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const reports = [];
  for (const scale of [1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: scale });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(pathToFileURL(path.join(output, "index.html")).href);
    await page.locator("#jump").click();
    await page.waitForTimeout(300);
    await page.locator("#bottom").click();
    const samples = await page.evaluate(async () => {
      const scroller = document.querySelector("#scroll");
      const samples = [];
      const start = performance.now();
      while (performance.now() - start < 2000) {
        await new Promise(requestAnimationFrame);
        samples.push({ time: performance.now() - start, top: scroller.scrollTop,
          gap: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop - 180,
          lastMounted: Boolean(document.querySelector('[data-virtual-key="999"]')) });
      }
      return samples;
    });
    const settled = samples.filter((sample) => sample.time > 1000);
    const report = { scale, errors, samples, unstableFrames: settled.filter((sample) => Math.abs(sample.gap) > 2 || !sample.lastMounted).length };
    reports.push(report);
    console.log(JSON.stringify({ scale, unstableFrames: report.unstableFrames, last: samples.at(-1), errors }));
    if (!process.argv.includes("--record")) {
      const atBottom = () => {
        const s = document.querySelector("#scroll");
        return Boolean(document.querySelector('[data-virtual-key="999"]')) && Math.abs(s.scrollHeight - s.clientHeight - s.scrollTop - 180) < 2;
      };
      await page.locator('[data-virtual-key="999"]').evaluate((row) => { row.style.paddingBottom = "300px"; });
      await page.waitForFunction(atBottom);
      await page.setViewportSize({ width: 480, height: 600 });
      await page.waitForFunction(atBottom);
      await page.evaluate(() => {
        const s = document.querySelector("#scroll");
        s.dispatchEvent(new WheelEvent("wheel", { deltaY: -300 }));
        s.scrollTop -= 300;
        window.manualTop = s.scrollTop;
      });
      await page.locator('[data-virtual-key="999"]').evaluate((row) => { row.style.paddingBottom = "500px"; });
      await page.waitForTimeout(250);
      assert.ok(await page.evaluate(() => Math.abs(document.querySelector("#scroll").scrollTop - window.manualTop) < 2), "wheel input must stop bottom follow");
      await page.locator("#jump").click();
      await page.waitForFunction(() => {
        const row = document.querySelector('[data-virtual-key="400"]');
        const s = document.querySelector("#scroll");
        return row && Math.abs(row.getBoundingClientRect().top - s.getBoundingClientRect().top - s.clientHeight * 0.3) < 2;
      });
      assert.ok(await page.locator("[data-virtual-key]").count() < 80, "history must remain virtualized");
    }
    await page.close();
  }
  writeFileSync(path.join(output, "report.json"), JSON.stringify(reports, null, 2));
  if (!process.argv.includes("--record")) {
    assert.ok(reports.every((report) => report.unstableFrames === 0 && report.errors.length === 0), "bottom follow must settle without flickering at every display scale");
  }
} finally { await browser.close(); }
