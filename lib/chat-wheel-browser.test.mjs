import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("wheel scrolling through deferred history settles without recycling or scrollbar oscillation", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-chat-wheel-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `
import React from "react";
import {createRoot} from "react-dom/client";
import {VirtualList} from ${JSON.stringify(path.join(repo, "components/VirtualList.tsx"))};
const keys=Array.from({length:1000},(_,i)=>String(i));
window.mounts=0;
function Row({id, compact}) {
  const [ready,setReady]=React.useState(false);
  React.useEffect(()=>{window.mounts++;const timer=setTimeout(()=>setReady(true),80);return()=>clearTimeout(timer)},[]);
  return <article style={{height:ready&&!compact?50+(Number(id)%7)*411:32}}>Message {id}</article>;
}
function App(){const scroll=React.useRef(null),[compact,setCompact]=React.useState(false);window.compressHistory=setCompact;return <div id="chat" ref={scroll} style={{height:450,width:640,overflowY:"auto",overflowAnchor:"none"}}>
  <div><VirtualList keys={keys} estimate={160} initialTail scrollContainer={scroll} renderItem={id=><Row id={id} compact={compact}/>}/></div>
</div>}
createRoot(document.getElementById("root")).render(location.search.includes("strict")?<React.StrictMode><App/></React.StrictMode>:<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const bundle = await readFile(path.join(root, "bundle.js"), "utf8");
    for (const {scale, strict} of [{scale:1}, {scale:1.25}, {scale:1.5}, {scale:1, strict:true}]) {
      const page = await browser.newPage({ deviceScaleFactor: scale });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("http://wheel.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><style>body{margin:16px;font:16px system-ui}article{box-sizing:border-box}</style><div id="root"></div>' }));
      await page.goto(`http://wheel.test/${strict ? "?strict" : ""}`);
      await page.addScriptTag({ content: bundle });
      await page.locator("#chat").hover();
      await page.waitForTimeout(250);
      await page.mouse.wheel(0, 1000000);
      await page.waitForTimeout(350);
      // No jump-to-bottom controller is involved: exercise actual wheel input,
      // including direction reversals while recycled rows are still loading.
      for (const delta of [-26000, -6000, 4000, -8000, 6000, -5000, 1000000]) {
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(35);
      }
      const samples = await page.evaluate(async () => {
        const chat = document.getElementById("chat"), samples = [];
        const started = performance.now();
        while (performance.now() - started < 1400) {
          await new Promise(requestAnimationFrame);
          if (performance.now() - started < 700) continue;
          const viewport = chat.getBoundingClientRect();
          const rows = [...chat.querySelectorAll("[data-virtual-key]")];
          const visible = rows.find(row => row.getBoundingClientRect().bottom > viewport.top + 1 && row.getBoundingClientRect().top < viewport.bottom);
          samples.push({ top: chat.scrollTop, height: chat.scrollHeight, mounts: window.mounts, count: rows.length,
            visible: visible?.dataset.virtualKey ?? null,
            y: visible ? visible.getBoundingClientRect().top - viewport.top : null });
        }
        return samples;
      });
      assert.ok(samples.length > 10);
      assert.ok(samples.every(sample => sample.visible !== null && sample.count < 80), `scale ${scale}: history must remain visible and virtualized`);
      assert.equal(new Set(samples.map(sample => JSON.stringify(sample))).size, 1,
        `scale ${scale}: idle history keeps moving or remounting: ${JSON.stringify(samples)}`);
      // Keep scrolling after settling; a cancelled Strict Mode measurement
      // frame must not leave the window frozen at its initial tail.
      const before = samples.at(-1).visible;
      await page.mouse.wheel(0, -12000);
      await page.waitForTimeout(500);
      const visible = await page.evaluate(() => {
        const chat = document.getElementById("chat"), top = chat.getBoundingClientRect().top;
        return [...chat.querySelectorAll("[data-virtual-key]")].find(row => row.getBoundingClientRect().bottom > top + 1)?.dataset.virtualKey;
      });
      assert.ok(visible && visible !== before, "wheel input must continue to reveal older messages");
      let atBottom = false;
      for (let attempt = 0; attempt < 8 && !atBottom; attempt++) {
        await page.mouse.wheel(0, 1000000);
        await page.waitForTimeout(250);
        atBottom = await page.evaluate(() => {
          const chat = document.getElementById("chat");
          return Boolean(chat.querySelector('[data-virtual-key="999"]')) && Math.abs(chat.scrollHeight-chat.clientHeight-chat.scrollTop) < 2;
        });
      }
      const beforeShrink = await page.evaluate(() => { const chat=document.getElementById("chat");return {top:chat.scrollTop,height:chat.scrollHeight,keys:[...chat.querySelectorAll('[data-virtual-key]')].map(row=>row.dataset.virtualKey)}; });
      assert.ok(atBottom, `scale ${scale}, strict ${strict}: wheel must reach the bottom before the content shrinks: ${JSON.stringify(beforeShrink)}`);
      const lostTail = await page.evaluate(async () => {
        const chat = document.getElementById("chat");
        let missing = false;
        const observer = new MutationObserver(() => {
          if (!chat.querySelector('[data-virtual-key="999"]')) missing = true;
        });
        observer.observe(chat, { childList: true, subtree: true });
        // A decoded/updated message can shrink before the next measurement
        // frame, causing the browser to clamp the wheel's scroll position.
        window.compressHistory(true);
        await new Promise(resolve => setTimeout(resolve, 300));
        observer.disconnect();
        return missing;
      });
      assert.equal(lostTail, false, `scale ${scale}, strict ${strict}: a height change must not recycle the visible tail using stale offsets`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
