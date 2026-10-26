import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const sources = {
  normal: "flowchart TD\nA[Start] --> B{Ready?}\nB -->|Yes| C[Continue]\nB -->|No| D[Wait]",
  wide: `flowchart LR\n${Array.from({ length: 24 }, (_, i) => `N${i}[Step ${i}]`).join(" --> ")}`,
  tall: `flowchart TD\n${Array.from({ length: 24 }, (_, i) => `T${i}[Step ${i}]`).join(" --> ")}`,
  small: "flowchart TD\nS[OK]",
  sequence: "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
  pie: 'pie title Tasks\n"Done": 3\n"Waiting": 2',
  error: "this is not a diagram",
};

test("Mermaid retains geometry across remounts and opens a viewport-fitted, stable viewer", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-mermaid-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    // Keep real Mermaid parsing/layout; delay only its completion to exercise races.
    await writeFile(path.join(root, "mermaid.ts"), `import mermaid from ${JSON.stringify(require.resolve("mermaid"))};
      export default {initialize: (...a)=>mermaid.initialize(...a),parse:(...a)=>mermaid.parse(...a),render:async(...a)=>{
        window.renderCalls=(window.renderCalls||0)+1;
        const result=await mermaid.render(...a);
        if(window.delayRender) await new Promise(resolve=>window.releaseRender=resolve);
        return result;
      }};`);
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState,useRef} from "react";import{createRoot}from"react-dom/client";import{flushSync}from"react-dom";
      import {MermaidBlock} from "@/components/MermaidBlock";import{I18nProvider}from"@/hooks/useI18n";import{useTheme,THEME_PRESETS}from"@/hooks/useTheme";
      import{VirtualList}from"@/components/VirtualList";
      const sources=${JSON.stringify(sources)};
      const rows=Array.from({length:100},(_,i)=>String(i));
      function VirtualChat({session}){const scroll=useRef(null);return <div id="virtual-scroll" ref={scroll} style={{height:"100vh",overflow:"auto"}}><VirtualList key={session} keys={rows} estimate={160} scrollContainer={scroll} renderItem={(_,index)=>index===0?<MermaidBlock code={sources.normal}/>:<div style={{height:160}}>Message {index}</div>}/></div>}
      function App(){const[state,setState]=useState({name:"normal",key:0,visible:true,duplicate:false});const[virtual,setVirtual]=useState(null);const{setTheme}=useTheme();
        window.virtualSession=session=>flushSync(()=>setVirtual(session));
        window.selectDiagram=(name,remount=true)=>flushSync(()=>setState(s=>({...s,name,key:s.key+Number(remount),visible:true})));
        window.showDiagram=visible=>flushSync(()=>setState(s=>({...s,visible})));
        window.duplicateDiagram=()=>flushSync(()=>setState(s=>({...s,duplicate:true})));
        window.changeTheme=setTheme;window.themes=THEME_PRESETS.map(p=>p.id);
        return <I18nProvider>{virtual!==null?<VirtualChat session={virtual}/>:<div id="scroll" style={{height:"100vh",overflow:"auto"}}><div style={{height:300}}/><main style={{width:"min(760px,100%)",margin:"auto"}}>
          {state.visible&&<MermaidBlock key={state.key} code={sources[state.name]}/>}<div id="after">Following message</div>
          {state.duplicate&&<MermaidBlock code={sources[state.name]}/>}</main><div style={{height:1000}}/></div>}</I18nProvider>}
      createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "mermaid$": path.join(root, "mermaid.ts"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem("pi-locale", "en"); });
    await page.route("http://mermaid.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}*{box-sizing:border-box}html,body{margin:0}button{font:inherit}</style><div id="root"></div><script src="/bundle.js"></script>` });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://mermaid.test/");
    const preview = page.locator(".mermaid-preview-button").first();
    await preview.waitFor();
    const evidence = process.env.MERMAID_EVIDENCE_DIR;
    if (evidence) await mkdir(evidence, { recursive: true });
    const capture = async name => { if (evidence) {
      await page.screenshot({ path: path.join(evidence, `${name}.png`) });
      await writeFile(path.join(evidence, `${name}.svg`), await page.locator(".mermaid-zoom-canvas svg").evaluate(el=>el.outerHTML));
    } };
    const geometry = () => page.evaluate(() => ({
      block: document.querySelector(".markdown-code-block").getBoundingClientRect().height,
      after: document.querySelector("#after").getBoundingClientRect().top,
      scroll: document.querySelector("#scroll").scrollTop,
    }));
    await page.locator("#scroll").evaluate(el => { el.scrollTop = 250; });
    const before = await geometry();
    await preview.click();
    await page.locator("dialog[open]").waitFor();
    await capture("normal-open");
    const during = await geometry();
    assert.deepEqual(during, before, "opening must preserve the message height and scroll anchor");
    const assertFit = async () => {
      await page.waitForFunction(() => {
        const svg = document.querySelector(".mermaid-zoom-canvas svg"), viewport = document.querySelector(".mermaid-zoom-viewport");
        if (!svg || !viewport) return false;
        const r = svg.getBoundingClientRect(), v = viewport.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.left >= v.left && r.top >= v.top && r.right <= v.right+1 && r.bottom <= v.bottom+1;
      });
      const values = await page.locator(".mermaid-zoom-canvas svg").evaluate(el => { const r=el.getBoundingClientRect(),b=el.viewBox.baseVal;return {ratio:r.width/r.height,natural:b.width/b.height,width:r.width,naturalWidth:b.width}; });
      assert.ok(Math.abs(values.ratio / values.natural - 1) < 0.01, "preserve aspect ratio");
      assert.ok(values.width <= values.naturalWidth + 1, "fit must not upscale small diagrams");
      assert.ok(await page.locator(".mermaid-zoom-canvas svg").evaluate(el=>{
        const box=el.getBBox(), view=el.viewBox.baseVal;
        return box.width>0 && box.height>0 && box.x>=view.x-1 && box.y>=view.y-1 && box.x+box.width<=view.x+view.width+1 && box.y+box.height<=view.y+view.height+1;
      }), "actual graph content must fit inside the SVG viewBox, not just its outer frame");
    };
    await assertFit();
    await page.keyboard.press("Escape");
    assert.deepEqual(await geometry(), before);
    assert.equal(await preview.evaluate(el => document.activeElement === el), true, "restore opener focus");
    const calls = await page.evaluate(() => window.renderCalls);
    const remount = await page.evaluate(() => { window.showDiagram(false); window.showDiagram(true); return {loading:!!document.querySelector(".mermaid-block-loading"),height:document.querySelector(".markdown-code-block").getBoundingClientRect().height}; });
    assert.equal(remount.loading, false);
    assert.equal(remount.height, before.block);
    assert.equal(await page.evaluate(() => window.renderCalls), calls);
    await page.getByRole("button", {name:"Source",exact:true}).click();
    await page.getByRole("button", {name:"Preview",exact:true}).click();
    await preview.waitFor();
    assert.equal(await page.locator(".mermaid-block-loading").count(),0);
    assert.equal(await page.evaluate(() => window.renderCalls),calls);
    for (const name of ["wide", "tall", "small", "normal", "sequence", "pie"]) {
      await page.evaluate(name => window.selectDiagram(name), name);
      await preview.waitFor();
      await preview.click();
      await assertFit();
      await capture(name);
      for (const viewport of [{ width: 360, height: 600 }, { width: 800, height: 360 }, { width: 1100, height: 800 }]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(({width,height})=>{
          const rect=document.querySelector("dialog").getBoundingClientRect();
          return innerWidth===width && innerHeight===height && rect.x>=0 && rect.y>=0 && rect.right<=width+1 && rect.bottom<=height+1;
        },viewport);
        await assertFit();
        const dialog = await page.locator("dialog").boundingBox();
        assert.ok(dialog.x >= 0 && dialog.y >= 0 && dialog.x+dialog.width <= viewport.width+1 && dialog.y+dialog.height <= viewport.height+1, JSON.stringify({ name,dialog,viewport }));
        if (name === "normal" && viewport.width === 360) await capture("narrow");
      }
      const fitWidth = (await page.locator(".mermaid-zoom-canvas").boundingBox()).width;
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await page.waitForFunction(width=>document.querySelector(".mermaid-zoom-canvas").getBoundingClientRect().width>width,fitWidth);
      if (name === "tall") {
        const viewport = await page.locator(".mermaid-zoom-viewport").boundingBox();
        await page.mouse.move(viewport.x+viewport.width/2, viewport.y+viewport.height-50);
        await page.mouse.down();
        await page.mouse.move(viewport.x+viewport.width/2, viewport.y+50, { steps: 5 });
        await page.mouse.up();
        assert.ok(await page.locator(".mermaid-zoom-viewport").evaluate(el=>el.scrollTop) > 50, "zoomed diagrams support dragging");
      }
      await page.getByRole("button", { name: "Fit to view", exact: true }).click();
      await assertFit();
      if (name === "small") {
        const download=page.waitForEvent("download");
        await page.locator("dialog").getByRole("button", {name:"Export PNG",exact:true}).click();
        const result=await download;
        assert.equal(result.suggestedFilename(),"mermaid-diagram.png");
        assert.equal(await result.failure(),null);
        if(evidence) await result.saveAs(path.join(evidence,"export.png"));
      }
      await page.getByRole("button", { name: "Close", exact: true }).click();
      for (let i=0;i<2;i++) { await preview.dblclick(); assert.equal(await page.locator("dialog[open]").count(),1); await page.keyboard.press("Escape"); }
    }
    await page.evaluate(() => { window.delayRender=true;window.selectDiagram("wide");window.changeTheme("dark"); });
    await page.waitForFunction(() => !!window.releaseRender);
    await page.evaluate(() => { window.selectDiagram("small",false);window.delayRender=false;window.releaseRender(); });
    await preview.waitFor();
    assert.match(await preview.textContent(), /OK/);
    assert.doesNotMatch(await preview.textContent(), /Step 23/);
    await page.evaluate(() => window.duplicateDiagram());
    await page.waitForFunction(() => document.querySelectorAll(".mermaid-preview-button svg").length===2);
    await preview.click();
    const ids=await page.locator("svg [id], svg[id]").evaluateAll(nodes=>nodes.map(n=>n.id));
    assert.equal(new Set(ids).size, ids.length, "cached copies and dialog must have unique SVG IDs");
    await page.keyboard.press("Escape");
    for (const theme of await page.evaluate(() => window.themes)) {
      await page.evaluate(theme => window.changeTheme(theme), theme);
      await preview.waitFor();
      await preview.click();
      await assertFit();
      if (["dark", "sakura", "dream"].includes(theme)) await capture(`theme-${theme}`);
      await page.keyboard.press("Escape");
    }
    await page.evaluate(() => { window.piDesktop={};window.selectDiagram("normal"); });
    await preview.waitFor();
    await preview.click();
    assert.ok((await page.locator("dialog").boundingBox()).y>=36, "desktop chrome remains available");
    await assertFit();
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.selectDiagram("error"));
    await page.locator(".mermaid-block-error").first().waitFor();
    assert.equal(await page.locator("dialog[open]").count(),0);
    assert.equal(await page.locator(".markdown-code-block").first().getByRole("button",{name:"Export PNG",exact:true}).isDisabled(),true);
    await page.evaluate(() => { window.changeTheme("light");window.virtualSession("session-a"); });
    await preview.waitFor();
    const rowHeight=await preview.evaluate(el=>el.closest("[data-virtual-key]").getBoundingClientRect().height);
    await page.locator("#virtual-scroll").evaluate(el=>{el.scrollTop=9000;});
    await preview.waitFor({state:"detached"});
    await page.locator("#virtual-scroll").evaluate(el=>{el.scrollTop=0;});
    await preview.waitFor();
    assert.equal(await preview.evaluate(el=>el.closest("[data-virtual-key]").getBoundingClientRect().height),rowHeight);
    for(const session of ["session-b","session-a","session-b","session-a"]) {
      assert.equal(await page.evaluate(session=>{window.virtualSession(session);return !!document.querySelector(".mermaid-block-loading");},session),false);
      assert.equal(await preview.evaluate(el=>el.closest("[data-virtual-key]").getBoundingClientRect().height),rowHeight);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("piora-mermaid-browser-"));
    await rm(root, { recursive: true, force: true });
  }
});
