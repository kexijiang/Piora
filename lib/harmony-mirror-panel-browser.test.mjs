import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
test("minimal mirror auto-connects, isolates late media, and mounts no workbench requests", { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-mirror-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "i18n.ts"), 'export const useI18n=()=>({locale:"en"});');
    await writeFile(path.join(root, "frame.ts"), 'import{useEffect}from"react";export const useHarmonyLiveFrame=o=>{useEffect(()=>{o.canvasRef.current.width=100;o.canvasRef.current.height=200;},[]);return{status:o.enabled?"live":"idle",mode:"video",frame:{serial:o.serial,generation:o.generation,width:100,height:200,geometryId:"g"}}};');
    await writeFile(path.join(root, "control.ts"), 'export const useHarmonyManualControl=o=>({ownerId:"manual:fixture",canControl:o.online,clearControl(){},ensureControl:async()=>"lease"});');
    await writeFile(path.join(root, "entry.tsx"), 'import React from "react";import{createRoot}from"react-dom/client";import{MirrorPanel}from"@/components/workspace/harmony/MirrorPanel";createRoot(document.getElementById("root")).render(<MirrorPanel active/>);');
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@/hooks/useI18n": path.join(root, "i18n.ts"), "@/hooks/useHarmonyLiveFrame": path.join(root, "frame.ts"), "@/hooks/useHarmonyManualControl": path.join(root, "control.ts"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage();
    await page.clock.install();
    const errors = [], reads = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    let devices = [{ serial: "A", name: "Phone A", state: "online", generation: 1 }], screenshotRoute;
    let recording = null, outcome = null, holdStartReply = false, holdInput = false, pendingInputRoute, pendingStopRoute;
    let holdMedia = false, pendingMedia;
    const waitWrites = async count => { for (let i=0;i<100 && writes.length<count;i++) await new Promise(resolve=>setTimeout(resolve,10)); assert.ok(writes.length >= count); };
    await page.route("https://mirror.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "application/javascript", body: await readFile(path.join(root, "bundle.js"), "utf8") });
      reads.push(url.pathname);
      if (url.pathname.endsWith("/devices")) return route.fulfill({ json: { devices, state: {} } });
      if (route.request().method() === "POST") {
        const body = route.request().postDataJSON(); writes.push(body);
        if (body.action === "tap" && holdInput) { pendingInputRoute = route; return; }
        if (body.action === "stop_device" && holdInput) { pendingStopRoute = route; return; }
        if (body.action === "capture_screenshot") { screenshotRoute = route; return; }
        if (body.action === "start_recording") {
          recording = { serial: body.serial, ownerId: body.ownerId, recordingId: "recording-1", startedAt: new Date().toISOString() };
          if (holdStartReply) return;
        }
        if (body.action === "stop_recording") { recording = null; return route.fulfill({ json: { artifact: { path: "saved.mp4", filename: "saved.mp4" } } }); }
        return route.fulfill({ json: { recording } });
      }
      if (url.pathname.endsWith('/media') && holdMedia) {
        pendingMedia = { route, payload: structuredClone({ recording, recordingOutcome: outcome }) };
        return;
      }
      return route.fulfill({ json: { recording, recordingOutcome: outcome } });
    });
    await page.goto("https://mirror.test/");
    await page.getByRole("button", { name: "Screenshot", exact: true }).waitFor();
    await page.getByText("Connected", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button").count(), 2, "only screenshot and recording are visible");
    const delayMediaRead = async () => {
      pendingMedia = undefined; holdMedia = true;
      for (let i=0;i<5 && !pendingMedia;i++) { await page.clock.runFor(2200); await page.waitForTimeout(30); }
      assert.ok(pendingMedia, 'a media read must precede the mutation');
      holdMedia = false;
      return pendingMedia;
    };
    await t.test('a delayed null media GET cannot overwrite a completed recording start', async () => {
      const old = await delayMediaRead();
      await page.getByRole('button', {name:'Record',exact:true}).click();
      await page.getByRole('button', {name:/Stop recording/}).waitFor();
      await old.route.fulfill({json:old.payload}); await page.waitForTimeout(50);
      assert.equal(await page.getByRole('button', {name:/Stop recording/}).isVisible(), true);
    });
    // A fresh read must still reconcile state, including after an ignored reply.
    await page.reload(); await page.getByRole('button',{name:/Stop recording/}).waitFor();
    await t.test('a delayed recording media GET cannot revive a completed recording stop', async () => {
      const old = await delayMediaRead(); assert.ok(old.payload.recording);
      await page.getByRole('button', {name:/Stop recording/}).click();
      await page.getByRole('button', {name:'Record',exact:true}).waitFor();
      await old.route.fulfill({json:old.payload}); await page.waitForTimeout(50);
      assert.equal(await page.getByRole('button', {name:'Record',exact:true}).isVisible(), true);
    });
    writes.length = 0; recording = null;
    await page.reload(); await page.getByText('Connected',{exact:true}).waitFor();
    if (process.env.PIORA_MIRROR_SCREENSHOT) {
      const css = await readFile(path.join(repo, "components/workspace/harmony/MirrorPanel.module.css"), "utf8");
      const style = await page.addStyleTag({ content: css + 'html,body,#root{height:100%;margin:0}body{font-family:system-ui;--bg:#17191d;--bg-panel:#202329;--text:#e8eaee;--text-muted:#a2aab7;--border:#3a404a}' });
      await page.evaluate(() => { const canvas = document.querySelector("canvas"), ctx = canvas.getContext("2d"); ctx.fillStyle="#283a45"; ctx.fillRect(0,0,100,200); ctx.fillStyle="#fff"; ctx.font="10px sans-serif"; ctx.fillText("Synthetic fixture",10,40); });
      await page.screenshot({ path: process.env.PIORA_MIRROR_SCREENSHOT });
      await style.evaluate(element => element.remove());
    }
    const image = page.getByRole("img");
    await image.click({ position: { x: 50, y: 100 } }); await waitWrites(1);
    assert.equal(writes[0].action, "tap"); assert.equal(writes[0].geometryId, "g");
    assert.equal(writes[0].x, 50); assert.equal(writes[0].y, 100);
    await image.press("Escape"); await waitWrites(2); assert.equal(writes[1].key, "back");
    const bounds = await image.boundingBox();
    await page.mouse.move(bounds.x+20,bounds.y+30); await page.mouse.down();
    await page.mouse.move(bounds.x+80,bounds.y+160); await page.mouse.up(); await waitWrites(3);
    assert.equal(writes[2].action, "drag"); assert.equal(writes[2].fromX,20); assert.equal(writes[2].toY,160);
    await page.getByText("Controls",{exact:true}).click();
    await page.getByRole("textbox",{name:"Input text",exact:true}).fill("hello 中文");
    await page.getByRole("button",{name:"Send text",exact:true}).click(); await waitWrites(4);
    assert.equal(writes[3].action,"input_text"); assert.equal(writes[3].text,"hello 中文");
    await page.getByRole("button",{name:"home",exact:true}).click(); await waitWrites(5); assert.equal(writes[4].key,"home");
    await page.getByRole("combobox",{name:"View mode",exact:true}).selectOption("frames");
    await page.getByText("Controls",{exact:true}).click();
    devices.push({ serial: "B", name: "Phone B", state: "online", generation: 1 });
    await page.getByRole("combobox", { name: "Device", exact: true }).waitFor();
    await page.getByRole("button", { name: "Screenshot", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("button").textContent.includes("Capturing"));
    await page.getByRole("combobox", { name: "Device", exact: true }).selectOption("B");
    const oldScreenshot = screenshotRoute, beforeNewScreenshot = writes.length;
    await page.getByRole('button',{name:'Screenshot',exact:true}).click();
    await waitWrites(beforeNewScreenshot+1);
    assert.equal(writes.at(-1).serial,'B','device B must not wait for device A screenshot');
    const newScreenshot = screenshotRoute;
    await oldScreenshot.fulfill({ json: { artifact: { serial: "A", path: "old-device.png", filename: "old-device.png" } } });
    await page.waitForTimeout(50);
    assert.equal(await page.getByRole('button',{name:/Capturing/}).isDisabled(),true,'A completion cannot release B pending guard');
    await newScreenshot.fulfill({json:{artifact:{serial:'B',path:'new-device.png',filename:'new-device.png'}}});
    await page.getByRole("button", { name: "Screenshot", exact: true }).waitFor();
    assert.equal(await page.getByText(/old-device/).count(), 0);
    await t.test('view mode change preserves an in-flight screenshot busy state', async () => {
      await page.getByRole('button',{name:'Screenshot',exact:true}).click();
      await page.getByRole('button',{name:/Capturing/}).waitFor();
      const sameDeviceScreenshot=screenshotRoute;
      await page.getByText('Controls',{exact:true}).click();
      await page.getByRole('combobox',{name:'View mode',exact:true}).selectOption('video');
      assert.equal(await page.getByRole('button',{name:/Capturing/}).isDisabled(),true);
      await sameDeviceScreenshot.fulfill({json:{artifact:{serial:'B',path:'mode-shot.png',filename:'mode-shot.png'}}});
      await page.getByRole('button',{name:'Screenshot',exact:true}).waitFor();
      await page.getByText('Controls',{exact:true}).click();
    });
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.getByRole("button", { name: /Stop recording/ }).waitFor();
    assert.equal(writes.at(-1).serial, "B");
    assert.match(writes.at(-1).ownerId, /^media:/, "recording ownership is independent of manual input leases");
    await page.getByRole("button", { name: /Stop recording/ }).click();
    await page.getByText("Saved: saved.mp4", { exact: true }).waitFor();
    assert.equal(writes.at(-1).recordingId, "recording-1");
    const startsBeforeTimeout = writes.filter(value => value.action === "start_recording").length;
    holdStartReply = true;
    await page.getByRole("button", { name: "Record", exact: true }).click();
    await page.clock.fastForward(31000); await page.clock.runFor(2200);
    await page.getByRole("button", { name: /Stop recording/ }).waitFor();
    assert.equal(writes.filter(value => value.action === "start_recording").length, startsBeforeTimeout + 1, "lost start reply is reconciled without repeating the recorder toggle");
    holdStartReply = false;
    await page.getByRole("button", { name: /Stop recording/ }).click();
    await page.getByRole("button", { name: "Record", exact: true }).waitFor();
    outcome={id:"limit-stop",status:"completed",path:"automatic-limit.mp4"};
    await page.getByText("Saved: automatic-limit.mp4",{exact:true}).waitFor();
    outcome={id:"disk-failed",status:"failed",error:"Disk full"};
    await page.getByRole("alert").filter({hasText:"Disk full"}).waitFor();
    outcome={...outcome,error:"Disk full; recovery retained",recoveryPath:"owned-recovery/capture.mp4",finalized:true};
    await page.getByRole("button",{name:"Copy recovery path",exact:true}).waitFor();
    await page.getByRole("alert").filter({hasText:"Disk full"}).waitFor();
    holdInput=true;
    const beforeHeldInput=writes.length;
    await image.click({position:{x:50,y:100}}); await waitWrites(beforeHeldInput+1);
    await page.getByText("Controls",{exact:true}).click();
    await page.getByRole("button",{name:"Stop device tasks",exact:true}).click(); await waitWrites(beforeHeldInput+2);
    assert.equal(writes.at(-1).action,"stop_device","stop intent bypasses the busy input request");
    await page.getByRole("combobox",{name:"Device",exact:true}).selectOption("A");
    await pendingStopRoute.fulfill({status:409,json:{error:{message:"OLD STOP FAILURE"}}});
    await pendingInputRoute.fulfill({status:409,json:{error:{message:"OLD INPUT FAILURE"}}});
    holdInput=false;
    assert.equal(await page.getByText(/OLD (STOP|INPUT) FAILURE/).count(),0,"old request failures cannot overwrite the newly selected device");
    await page.getByRole("combobox",{name:"Device",exact:true}).selectOption("B");
    devices = [devices[0]];
    await page.getByText("Disconnected. Waiting for the same device", { exact: true }).first().waitFor();
    assert.ok(reads.every(value => ["/api/harmony/devices", "/api/harmony/media", "/api/harmony/action"].includes(value)));
    devices=[{serial:"A",name:"Phone A",state:"unauthorized",generation:2}];
    await page.reload();
    await page.getByText("Allow debugging on the phone",{exact:true}).first().waitFor();
    devices[0].state="online";
    await page.getByText("Connected",{exact:true}).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); if (path.dirname(root) === path.resolve(tmpdir())) await rm(root, { recursive: true, force: true }); }
});
