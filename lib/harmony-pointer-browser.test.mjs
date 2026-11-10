import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");

test("real pointer handlers send DOWN before UP and release on device switch", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-live-pointer-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{useMirrorInput}from'@/hooks/useMirrorInput';function App(){const[serial,setSerial]=useState('phone-1');const input=useMirrorInput({enabled:true,frame:{serial,generation:1,width:100,height:200},chinese:false});return <><div {...input.handlers} tabIndex={0} role="application" aria-busy={input.preparing} style={{width:100,height:200,touchAction:'none'}} onKeyUp={e=>{if(e.key==='F2')setSerial('phone-2')}}>{serial}</div><output>{input.error}</output></>}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage(), inputs = [], errors = [];
    let delayedGeometry, resumeGeometry, delayedLease, resumeLease, geometryRequests = 0, acquisitions = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://pointer.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' });
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "application/javascript", body: await readFile(path.join(root, "bundle.js"), "utf8") });
      if (url.pathname.endsWith("/geometry")) {
        geometryRequests++;
        if (delayedGeometry) await delayedGeometry;
        return route.fulfill({ json: { geometry: { geometryId: "g", frameWidth: 100, frameHeight: 200 } } });
      }
      const body = route.request().postDataJSON();
      if (url.pathname.endsWith("/manual")) {
        if (body.action === "acquire") { acquisitions++; if (delayedLease) await delayedLease; }
        return route.fulfill({ json: { lease: { token: "lease", serial: body.serial, expiresAt: new Date(Date.now() + 120000).toISOString() } } });
      }
      assert.equal(url.pathname, "/api/harmony/pointer", "mouse input must use the streaming control route");
      inputs.push(body); return route.fulfill({ json: { gestureId: "a".repeat(32) } });
    });
    const waitPhase = async (phase, count = 1) => {
      for (let i = 0; i < 100 && inputs.filter(input => input.phase === phase).length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(inputs.filter(input => input.phase === phase).length, count);
    };
    await page.goto("https://pointer.test/");
    await page.getByRole("application").waitFor();
    await page.waitForTimeout(100);
    delayedGeometry = new Promise(resolve => { resumeGeometry = resolve; });
    await page.mouse.move(50, 100);
    await page.waitForTimeout(350);
    await page.mouse.move(55, 105); await page.waitForTimeout(50);
    assert.equal(geometryRequests, 1, "hover and move reuse an unfinished geometry request even after 300 ms");
    await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(50);
    assert.equal(geometryRequests, 1, "pointer DOWN shares the same pending geometry verification");
    assert.equal(inputs.length, 0, "input waits for verified geometry");
    assert.equal(acquisitions, 0, "cold preparation never claims a lease for a click that was not admitted");
    assert.equal(await page.getByRole("application").getAttribute("aria-busy"), "true");
    await page.waitForTimeout(3100);
    assert.equal(await page.locator("output").textContent(), "", "cold preparation is visible without poisoning the gesture controller after three seconds");
    resumeGeometry(); delayedGeometry = undefined;
    await page.waitForFunction(() => document.querySelector('[role="application"]').getAttribute('aria-busy') === 'false');
    assert.equal(inputs.length, 0, "finishing preparation must not replay the released cold-start click");
    await page.mouse.down(); await waitPhase("down");
    assert.equal(inputs.some(input => input.phase === "up"), false, "DOWN must reach the server while the mouse remains held");
    await page.mouse.move(65, 140); await waitPhase("move");
    await page.mouse.up(); await waitPhase("up");
    assert.deepEqual(inputs.slice(0, 3).map(input => input.phase), ["down", "move", "up"]);
    delayedGeometry = new Promise(resolve => { resumeGeometry = resolve; });
    await page.waitForTimeout(350); await page.mouse.move(60, 110); await page.waitForTimeout(50);
    assert.equal(await page.getByRole("application").getAttribute("aria-busy"), "false", "background verification does not disable already prepared controls");
    await page.mouse.down(); await page.waitForTimeout(50);
    resumeGeometry(); delayedGeometry = undefined; await waitPhase("down", 2);
    await page.keyboard.press("F2"); await waitPhase("up", 2);
    assert.equal(inputs.at(-1).serial, "phone-1", "device switch releases the original phone");
    await page.mouse.up(); await page.waitForTimeout(50);
    assert.equal(inputs.filter(input => input.phase === "up").length, 2, "late mouse-up must not replay release or click the new device");
    delayedLease = new Promise(resolve => { resumeLease = resolve; });
    await page.waitForTimeout(350);
    await page.mouse.move(60, 100);
    await page.waitForFunction(() => document.querySelector('[role="application"]').getAttribute('aria-busy') === 'false');
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('output').textContent.length > 0, undefined, { timeout: 5000 });
    resumeLease(); await page.waitForTimeout(100);
    assert.equal(inputs.filter(input => input.phase === "down").length, 2, "setup timeout must never inject the old click after a late lease response");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
