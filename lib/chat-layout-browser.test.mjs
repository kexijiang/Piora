import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url); const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const hookSource = await readFile(path.join(repo, "hooks/useAgentSession.ts"), "utf8");
const scrollIntentCallback = hookSource.slice(hookSource.indexOf("const markUserScrollIntent ="), hookSource.indexOf("const handleScrollPositionChange ="));
test("opening, closing and resizing the side panel preserves the visible chat row", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-chat-layout-")); let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {VirtualList} from ${JSON.stringify(path.join(repo, "components/VirtualList.tsx"))};
import {followChatBottom,isChatBottomFollowing} from ${JSON.stringify(path.join(repo, "lib/chat-bottom-follow.ts"))};
const useCallback=React.useCallback,SCROLL_KEYS=new Set(["ArrowUp","ArrowDown","PageUp","PageDown","Home","End"," "]),USER_SCROLL_INTENT_MS=1000;
const userScrollIntentUntilRef={current:0},agentRunningRef={current:true},bashRunningRef={current:false},completionScrollAllowedRef={current:true},liveOutputFollowRef={current:true},liveOutputAutoScrollEnabled=true;
let cleanup;const stopInitialBottomPin=()=>cleanup?.(),setLiveOutputFollowPaused=value=>window.followPaused=value;
const keys=Array.from({length:120},(_,i)=>"message-"+i);function App(){const ref=React.useRef(null),history=React.useRef(null);const [width,setWidth]=React.useState(1000);window.resizeChat=setWidth;window.revealKey=key=>history.current?.scrollToKey(key);
${scrollIntentCallback}
React.useEffect(()=>{window.addEventListener("pointerdown",markUserScrollIntent,true);window.addEventListener("wheel",markUserScrollIntent,true);window.addEventListener("keydown",markUserScrollIntent);return()=>{window.removeEventListener("pointerdown",markUserScrollIntent,true);window.removeEventListener("wheel",markUserScrollIntent,true);window.removeEventListener("keydown",markUserScrollIntent);};},[markUserScrollIntent]);
window.followBottom=()=>{userScrollIntentUntilRef.current=0;liveOutputFollowRef.current=true;window.followPaused=false;cleanup=followChatBottom(ref.current,()=>{ref.current.scrollTop=ref.current.scrollHeight-ref.current.clientHeight;});};window.followState=()=>({following:isChatBottomFollowing(ref.current),intent:userScrollIntentUntilRef.current,paused:window.followPaused});
return <><button id="panel" onClick={()=>setWidth(w=>w===1000?600:1000)}>Toggle files</button><div className="chat-column-scroll-rail" style={{height:10}}>Rail</div><div id="chat-scroll-container" ref={ref} style={{width,height:560,overflowY:"auto",transition:"width 200ms ease"}}><div style={{paddingTop:16}}><VirtualList handleRef={history} keys={keys} estimate={160} scrollContainer={ref} renderItem={(key,i)=><article><strong>{key}</strong><p>{("This is a readable conversation with variable lines and references. ").repeat(3+i%7)}</p></article>}/></div></div></>};createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true }); const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://layout.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><style>body{font:16px/24px system-ui;margin:24px}article{padding:16px 24px}p{margin:8px 0 20px}#chat{border:1px solid #ccc}</style><div id="root"></div>' }));
    await page.goto("http://layout.test"); await page.addScriptTag({ content: await readFile(path.join(root, "bundle.js"), "utf8") }); await page.locator("[data-virtual-key]").first().waitFor();
    await page.evaluate(() => { document.getElementById("chat-scroll-container").scrollTop = 6000; });
    async function settle() { await page.evaluate(() => new Promise((resolve) => { let last = "", stable = 0; const frame = () => { const chat = document.getElementById("chat-scroll-container"); const signature = [chat.scrollTop,chat.scrollHeight,chat.clientWidth].join(":"); stable = signature === last ? stable + 1 : 0; last = signature; if (stable >= 20) resolve(); else requestAnimationFrame(frame); }; requestAnimationFrame(frame); })); }
    await settle();
    const anchor = await page.evaluate(() => { const chat = document.getElementById("chat-scroll-container"); const top = chat.getBoundingClientRect().top; const row = [...chat.querySelectorAll("[data-virtual-key]")].find((row) => row.getBoundingClientRect().bottom > top+1); return { key: row.dataset.virtualKey, y: row.getBoundingClientRect().top-top }; });
    for (const width of [600,1000,720,1000]) {
      await page.evaluate((width) => window.resizeChat(width), width); await settle();
      const delta = await page.evaluate((anchor) => { const chat = document.getElementById("chat-scroll-container"); const row = [...chat.querySelectorAll("[data-virtual-key]")].find((row) => row.dataset.virtualKey===anchor.key); return row ? row.getBoundingClientRect().top-chat.getBoundingClientRect().top-anchor.y : null; }, anchor);
      assert.notEqual(delta, null, "visible row must remain mounted"); assert.ok(Math.abs(delta) <= 2, `width ${width} moved the reading anchor by ${delta}px`);
    }
    await page.evaluate(() => { const chat = document.getElementById("chat-scroll-container"); chat.scrollTop = chat.scrollHeight; }); await settle();
    for (let attempt = 0; attempt < 3; attempt++) { await page.evaluate(() => { const chat = document.getElementById("chat-scroll-container"); chat.scrollTop = chat.scrollHeight; }); await settle(); }
    assert.ok(Math.abs(await page.evaluate(() => { const chat = document.getElementById("chat-scroll-container"); return chat.scrollHeight-chat.clientHeight-chat.scrollTop; })) <= 2, "manual bottom must settle before resizing");
    for (let index = 0; index < 4; index++) {
      await page.locator("#panel").click(); await settle();
      const idleBottomGap = await page.evaluate(() => { const chat = document.getElementById("chat-scroll-container"); return chat.scrollHeight-chat.clientHeight-chat.scrollTop; });
      assert.ok(Math.abs(idleBottomGap) <= 2, `manual bottom toggle ${index} moved by ${idleBottomGap}px`);
    }
    await page.evaluate(() => { window.resizeChat(600); requestAnimationFrame(() => window.revealKey("message-40")); }); await settle();
    const navigationGap = await page.locator('[data-virtual-key="message-40"]').evaluate((row) => { const chat = document.getElementById("chat-scroll-container"); return row.getBoundingClientRect().top-chat.getBoundingClientRect().top-chat.clientHeight*.3; });
    assert.ok(Math.abs(navigationGap) <= 2, "explicit history navigation must win over the resize anchor");
    await page.evaluate(() => window.followBottom()); await settle();
    for (let index = 0; index < 4; index++) {
      await page.locator("#panel").click(); await settle();
      const state = await page.evaluate(() => ({ ...window.followState(), gap: (() => { const chat = document.getElementById("chat-scroll-container"); return chat.scrollHeight - chat.clientHeight - chat.scrollTop; })() }));
      assert.equal(state.following, true, "file-panel clicks must retain bottom following");
      assert.equal(state.intent, 0, "layout changes must not open a user-scroll intent window");
      assert.ok(Math.abs(state.gap) <= 2, `bottom moved by ${state.gap}px`);
    }
    await page.locator("#panel").press("Space"); await settle();
    assert.equal((await page.evaluate(() => window.followState())).following, true, "keyboard activation of the panel must not pause chat following");
    await page.locator(".chat-column-scroll-rail").click();
    assert.equal((await page.evaluate(() => window.followState())).following, false, "dragging the chat rail must still release bottom following");
    assert.equal((await page.evaluate(() => window.followState())).paused, true);
    await page.evaluate(() => window.followBottom()); await settle();
    await page.locator("#chat-scroll-container").hover(); await page.mouse.wheel(0, -300);
    await page.waitForFunction(() => !window.followState().following);
    assert.equal((await page.evaluate(() => window.followState())).following, false, "reading history must still release bottom following");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
