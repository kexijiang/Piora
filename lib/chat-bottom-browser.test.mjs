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

test("history bottom jump stays aligned before paint as virtual and deferred rows settle", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-chat-bottom-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {VirtualList} from ${JSON.stringify(path.join(repo, "components/VirtualList.tsx"))};import {followChatBottom,isChatBottomFollowing} from ${JSON.stringify(path.join(repo, "lib/chat-bottom-follow.ts"))};
const keys=Array.from({length:400},(_,i)=>"row-"+i);let stop;
function App(){const ref=React.useRef(null),list=React.useRef(null);const [height,setHeight]=React.useState(100);window.changeTail=setHeight;window.followState=()=>isChatBottomFollowing(ref.current);window.reveal=()=>list.current.scrollToKey("row-120");
const jump=()=>{list.current.cancelNavigation();stop?.();stop=followChatBottom(ref.current,()=>ref.current.scrollTo({top:ref.current.scrollHeight-ref.current.clientHeight,behavior:"instant"}));};
return <><button id="jump" onClick={jump}>Bottom</button><div id="chat-scroll-container" ref={ref} style={{width:600,height:500,overflowY:"auto"}}><div><VirtualList handleRef={list} keys={keys} estimate={160} scrollContainer={ref} renderItem={(key,i)=><article style={{height:i===399?height:60+i%11*60}}>{key}</article>}/><footer style={{height:24}}>End of conversation</footer></div></div></>};createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://bottom.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><style>body{margin:16px;font:16px system-ui}article{box-sizing:border-box;border-bottom:1px solid #aaa}footer{background:#ddd;overflow-anchor:none}</style><div id="root"></div>' }));
    await page.goto("http://bottom.test/");
    await page.addScriptTag({ content: await readFile(path.join(root, "bundle.js"), "utf8") });
    await page.locator("#jump").waitFor();
    await page.evaluate(() => window.reveal());
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.jumpGaps = [];
      const chat = document.getElementById("chat-scroll-container");
      window.jumpObserver = new ResizeObserver(() => {
        if (window.followState()) window.jumpGaps.push(chat.scrollHeight - chat.clientHeight - chat.scrollTop);
      });
      window.jumpObserver.observe(chat.firstElementChild);
    });
    await page.locator("#jump").click();
    await page.waitForTimeout(250);
    const jumpGaps = await page.evaluate(() => { window.jumpObserver.disconnect(); return window.jumpGaps; });
    assert.ok(jumpGaps.length > 0 && jumpGaps.every((gap) => Math.abs(gap) <= 2), `initial jump painted intermediate offsets: ${JSON.stringify(jumpGaps)}`);
    // Observe after the production resize observers: this sees the geometry
    // the browser will paint, rather than a later corrected screenshot.
    const gaps = await page.evaluate(async () => {
      const chat = document.getElementById("chat-scroll-container"), footer = chat.querySelector("footer");
      const samples = [];
      const observer = new ResizeObserver(() => {
        samples.push(footer.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom);
      });
      observer.observe(chat.firstElementChild);
      for (const height of [1400, 80, 2400, 160, 950, 100]) {
        window.changeTail(height);
        await new Promise((resolve, reject) => {
          let frames = 0, settled = 0;
          const check = () => {
            const tail = chat.querySelector('[data-virtual-key="row-399"] article');
            settled = tail?.getBoundingClientRect().height === height ? settled + 1 : 0;
            if (settled >= 3) resolve();
            else if (++frames > 120) reject(new Error("tail did not settle"));
            else requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
      }
      observer.disconnect();
      return samples;
    });
    assert.ok(gaps.length >= 6, `expected all deferred height changes: ${JSON.stringify(gaps)}`);
    assert.ok(gaps.every((gap) => Math.abs(gap) <= 2), `bottom flickered before paint: ${JSON.stringify(gaps)}`);
    assert.equal(await page.evaluate(() => window.followState()), true);
    await page.locator("#chat-scroll-container").hover();
    await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => !window.followState());
    const reading = await page.evaluate(() => document.getElementById("chat-scroll-container").scrollTop);
    await page.evaluate(() => window.changeTail(1000));
    await page.waitForTimeout(150);
    assert.ok(Math.abs(await page.evaluate(() => document.getElementById("chat-scroll-container").scrollTop) - reading) <= 2, "manual reading must release bottom following");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
