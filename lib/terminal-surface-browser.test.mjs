import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { TerminalSession } = await createJiti(import.meta.url).import("./terminal-session.ts");

test("real PTY reattachment, clipboard shortcuts, native paste and transparent terminal rendering", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-terminal-surface-"));
  const session = new TerminalSession(root);
  let browser;
  let unsubscribe = () => {};
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {TerminalSurface} from ${JSON.stringify(path.join(repo, "components/workspace/TerminalSurface.tsx"))};function App(){const [key,setKey]=React.useState(0);window.reopen=()=>setKey(k=>k+1);return <section className="root"><header className="header">交互终端 · cmd.exe</header><TerminalSurface key={key} cwd=${JSON.stringify(root)} onStatus={ready=>window.ready=ready} onError={error=>window.terminalError=error}/></section>};createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://terminal-surface.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 650 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    let captureInputOnly = false;
    await page.exposeFunction("snapshot", () => ({ type: "snapshot", ...session.snapshot() }));
    await page.addInitScript(() => {
      window.streams = new Set();
      window.EventSource = class {
        constructor() { window.streams.add(this); window.snapshot().then((snapshot) => this.onmessage?.({ data: JSON.stringify(snapshot) })); }
        close() { window.streams.delete(this); }
      };
      window.emitTerminal = (event) => { for (const stream of window.streams) stream.onmessage?.({ data: JSON.stringify(event) }); };
    });
    const css = (await readFile(path.join(repo, "components/workspace/TerminalPanel.module.css"), "utf8")).replace(/:global\(([^)]+)\)/g, "$1");
    const xtermCss = await readFile(path.join(repo, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
    await page.route("http://terminal-surface.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/terminal") {
        const body = route.request().postDataJSON();
        requests.push(body);
        if (body.action === "start") session.start();
        else if (body.action === "input" && !captureInputOnly) session.input(body.data, body.replay === true);
        else if (body.action === "resize") session.resize(body.cols, body.rows);
        await route.fulfill({ json: session.snapshot() });
      } else if (url.pathname.endsWith(".js")) await route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      else await route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-app-background-active="true"><style>:root{--ui-font-size:14px;--radius-panel:18px}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#226657,#353661 45%,#813c56);font:14px system-ui}#root{width:640px;height:530px;margin:40px auto}${xtermCss}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    unsubscribe = session.subscribe((event) => { void page.evaluate((event) => window.emitTerminal?.(event), event).catch(() => {}); });
    await page.goto("http://terminal-surface.test/");
    await page.waitForFunction(() => window.ready && document.querySelector(".xterm-helper-textarea"));
    const waitForOutput = async (text) => {
      const deadline = Date.now() + 10000;
      while (!session.snapshot().output.includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing terminal output: ${text}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const waitForInput = async (offset) => {
      const deadline = Date.now() + 2000;
      while (!requests.slice(offset).some((request) => request.action === "input")) {
        if (Date.now() > deadline) throw new Error("Paste did not reach terminal input");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return requests.slice(offset).filter((request) => request.action === "input").map((request) => request.data).join("");
    };
    session.run("echo PIORA_FIRST_OK"); await waitForOutput("PIORA_FIRST_OK");
    await page.evaluate(() => window.reopen());
    await page.waitForFunction(() => window.ready && document.querySelector(".xterm-helper-textarea"));
    // Also replay a historical cursor query; it must not reach the shell.
    await page.evaluate((output) => window.emitTerminal({ type: "snapshot", output: output + "\x1b[6n", connected: true, shell: "cmd.exe" }), session.snapshot().output);
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("PIORA_FIRST_OK"));
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("echo PIORA_TYPED_OK"); await page.keyboard.press("Enter");
    await waitForOutput("PIORA_TYPED_OK");
    unsubscribe();
    await page.evaluate(() => window.emitTerminal({ type: "output", output: "\x1b[?2004l\r\nPLAIN_PASTE_READY\r\n" }));
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("PLAIN_PASTE_READY"));
    // Desktop clipboard shortcuts must paste text, never the Ctrl+V control
    // character. Keep clipboard contents inside the page, not the host OS.
    await page.evaluate(() => {
      window.clipboardText = "echo PIORA_PASTED_OK";
      window.clipboardReads = 0;
      window.piDesktop = { clipboard: { readText: async () => { window.clipboardReads++; return window.clipboardText; } } };
    });
    const pasteStart = requests.length;
    await page.keyboard.press("Control+v");
    await page.waitForFunction(() => window.clipboardReads === 1, undefined, { timeout: 2000 });
    await waitForOutput("PIORA_PASTED_OK");
    const pasted = requests.slice(pasteStart).filter((request) => request.action === "input");
    assert.equal(pasted.map((request) => request.data).join(""), "echo PIORA_PASTED_OK", "paste happens exactly once without submitting");
    const submitStart = requests.length;
    await page.keyboard.press("Enter");
    assert.equal(await waitForInput(submitStart), "\r");
    // The remaining cases inspect transport bytes without executing pasted
    // multiline text in the real shell.
    captureInputOnly = true;
    for (const shortcut of ["Control+Shift+v", "Shift+Insert", "Meta+v"]) {
      await page.evaluate((text) => { window.clipboardText = text; }, `paste:${shortcut}`);
      const offset = requests.length;
      await page.keyboard.press(shortcut);
      assert.equal(await waitForInput(offset), `paste:${shortcut}`);
    }
    // xterm owns newline normalization and bracketed-paste negotiation.
    await page.evaluate(() => window.emitTerminal({ type: "output", output: "\x1b[?2004h\r\nBRACKET_READY\r\n" }));
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("BRACKET_READY"));
    await page.evaluate(() => { window.clipboardText = "中文第一行\nsecond line"; });
    const bracketOffset = requests.length;
    await page.keyboard.press("Control+v");
    assert.equal(await waitForInput(bracketOffset), "\x1b[200~中文第一行\rsecond line\x1b[201~");
    await page.evaluate(() => { delete window.piDesktop; });
    const nativeOffset = requests.length;
    assert.equal(await page.locator(".xterm-helper-textarea").evaluate((element) => {
      const event = new KeyboardEvent("keydown", { key: "v", keyCode: 86, ctrlKey: true, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }), false, "browser Ctrl+V keeps the native paste action");
    await page.locator(".xterm-helper-textarea").evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "native paste");
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await waitForInput(nativeOffset), "\x1b[200~native paste\x1b[201~", "native/menu paste is sent once, without Ctrl+V bytes");
    const interruptOffset = requests.length;
    await page.keyboard.press("Control+c");
    assert.equal(await waitForInput(interruptOffset), "\x03", "Ctrl+C without a selection still interrupts the shell");
    assert.ok(requests.some((request) => request.replay === true), "replayed query replies are explicitly identified");
    assert.ok(!session.snapshot().output.includes("^[[?1;2c"), "old device-attribute replies never become command text");
    assert.ok(!session.snapshot().output.includes("^[[1;"), "old cursor reports never become command text");
    const style = await page.evaluate(() => ({ radius: getComputedStyle(document.querySelector(".root")).borderTopLeftRadius, background: getComputedStyle(document.querySelector(".root")).backgroundColor, viewport: getComputedStyle(document.querySelector(".xterm-viewport")).backgroundColor }));
    assert.equal(style.radius, "18px");
    assert.match(style.background, /rgba\(.+, 0\.4\)/);
    assert.match(style.viewport, /rgba\(.+, 0\)/);
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/terminal-transparency.png") });
    assert.equal(await page.evaluate(() => window.terminalError), undefined);
    assert.deepEqual(errors, []);
  } finally { unsubscribe(); await session.dispose(); await browser?.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
