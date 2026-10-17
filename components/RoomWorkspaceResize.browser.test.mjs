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

test("room details share space with chat during dragging and restore preferred widths", { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-room-resize-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {RoomWorkspace} from "@/components/RoomWorkspace";
const room={id:"11111111-1111-4111-8111-111111111111",name:"调整布局",projectRoot:"F:/fixture",coordination:{mode:"manual",coordinatorMemberId:"m",maxConcurrency:1},members:[{memberId:"m",profile:{name:"执行者",role:"worker",modelPolicy:{mode:"session"}},binding:{sessionId:"live",status:"ready"}}]};
const messages=Array.from({length:6},(_,i)=>({id:"msg"+i,seq:i+1,createdAt:Date.now(),author:{id:"user",kind:"user",name:"我"},content:"群聊消息 "+i,payload:{truncated:false,lineCount:1,byteLength:30}}));
const snapshot={type:"snapshot",room,messages,tasks:[],artifacts:[],runs:[],submissions:[]};
window.EventSource=class{constructor(){setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify(snapshot)});},0)}addEventListener(){}close(){}};
window.fetch=async()=>new Response(JSON.stringify(snapshot),{headers:{"Content-Type":"application/json"}});
function App(){const [width,setWidth]=useState(1200);window.setFixtureWidth=setWidth;return <I18nProvider><div id="fixture" style={{width,maxWidth:"100%",height:"100vh"}}><RoomWorkspace initialRoom={room} onRoomDeleted={()=>{}} onOpenBrowser={()=>{}}/></div></I18nProvider>}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "")
      + (await readFile(path.join(repo, "components/RoomWorkspace.module.css"), "utf8")).replace(/:global\(([^)]+)\)/gu, "$1");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN" });
    const errors = [];
    page.on("pageerror", (error) => { errors.push(error.message); t.diagnostic(error.stack); });
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://room-resize.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}body{margin:0;height:100vh;overflow:hidden;font-family:var(--ui-font-family)}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    const details = page.locator(".room-workspace-details");
    const separator = page.getByRole("separator", { name: "调整群聊正文与详情面板宽度", exact: true });
    const width = async (locator) => (await locator.boundingBox()).width;
    const waitWidth = async (expected) => page.waitForFunction((value) => Math.abs(document.querySelector(".room-workspace-details").getBoundingClientRect().width - value) < 1, expected);
    const openResults = async () => { await page.getByRole("button", { name: "成果", exact: true }).click(); await separator.waitFor(); };
    const drag = async (delta, beforeRelease) => {
      const box = await separator.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + delta, box.y + 100, { steps: 8 });
      if (beforeRelease) await beforeRelease();
      await page.mouse.up();
    };
    await page.goto("http://room-resize.test/");
    await openResults();
    await waitWidth(324);
    const chatWidth = await width(page.locator(".conversation"));
    await drag(-180, async () => {
      await waitWidth(504);
      assert.ok(Math.abs(await width(page.locator(".conversation")) - (chatWidth - 180)) < 1);
      assert.equal(await page.evaluate(() => localStorage.getItem("pi-room-details-width")), null);
    });
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-room-details-width")), "504");
    await page.getByRole("button", { name: "成员", exact: true }).click();
    await waitWidth(504);
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await waitWidth(504);
    await separator.dblclick(); await waitWidth(324);
    await separator.focus(); await page.keyboard.press("ArrowLeft"); await waitWidth(336);
    await page.keyboard.press("Home"); await waitWidth(260);
    await page.keyboard.press("End"); await waitWidth(800);
    await drag(240); await waitWidth(560);
    await page.reload(); await openResults(); await waitWidth(560);
    await page.evaluate(() => window.setFixtureWidth(760)); await waitWidth(360);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-room-details-width")), "560");
    await page.evaluate(() => window.setFixtureWidth(640));
    await details.getByRole("heading", { name: "成果", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".room-workspace-details")?.getAttribute("role") === "dialog");
    assert.equal(await separator.count(), 0);
    assert.ok(await width(page.locator(".conversation")) > 560);
    await page.evaluate(() => window.setFixtureWidth(1200)); await separator.waitFor(); await waitWidth(560);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector(".room-workspace-details")?.getAttribute("role") === "dialog");
    assert.equal(await separator.count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 }); await separator.waitFor(); await waitWidth(560);
    await separator.focus(); await page.keyboard.press("Enter"); await waitWidth(324);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-room-resize-"));
    await rm(directory, { recursive: true, force: true });
  }
});
