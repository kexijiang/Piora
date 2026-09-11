import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url, { alias: { "@": repo } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { createShell } = await jiti.import("./shell/registry.ts");
const { discoverShellProfiles } = await jiti.import("./shell/profiles.ts");
const { handleShellRequest } = await jiti.import("./shell/http.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
async function until(read, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timed out: " + JSON.stringify(await read()));
}

test("managed xterm handles real interactive input, reconnects, cancellation and stale generations", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-surface-"));
  const store = new ShellStore(root, false); globalThis.__pioraShellStore = store;
  allowFileRoot(root);
  const profile = (await discoverShellProfiles()).find(item => item.integrated);
  assert.ok(profile);
  const session = await createShell(root, profile.executable);
  let browser, releaseInput, unsubscribe = () => {};
  let forwarding = Promise.resolve(), holdInput = false, inputPending = false;
  const requests = [];
  const wireSnapshot = () => { const snapshot = session.snapshot(); return { type: "snapshot", terminalId: session.state.id, generation: session.state.generation, sequence: snapshot.sequence, snapshot }; };
  const api = (body) => handleShellRequest(new Request("http://localhost/api/shell/sessions/" + session.state.id + "/actions", { method: "POST", headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify(body) }), ["sessions", session.state.id, "actions"]);
  try {
    await writeFile(path.join(root, "loader.cjs"), "const ts=require(" + JSON.stringify(require.resolve("typescript")) + ");module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText");
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      "import {TerminalSurface} from " + JSON.stringify(path.join(repo, "components/workspace/TerminalSurface.tsx")) + ";",
      "import {useSmartShell} from " + JSON.stringify(path.join(repo, "hooks/useSmartShell.ts")) + ";",
      "function App(){const shell=useSmartShell(" + JSON.stringify(root) + ");const [key,setKey]=React.useState(0);const [native,setNative]=React.useState(false);window.reopen=()=>setKey(k=>k+1);window.showNative=setNative;return <div className='body'><div className='native' hidden={!native}>{shell.snapshot&&<TerminalSurface key={key} cwd=" + JSON.stringify(root) + " terminalId=" + JSON.stringify(session.state.id) + " subscribeToShell={shell.subscribe} onStatus={ready=>window.ready=ready} onError={error=>window.terminalError=error}/>}</div></div>}",
      'createRoot(document.getElementById("root")).render(<App/>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "https://shell-surface.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 700, height: 600 } });
    page.setDefaultTimeout(60000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("snapshot", wireSnapshot);
    await page.addInitScript(() => {
      window.streams = new Set();
      window.EventSource = class {
        constructor() { window.streams.add(this); window.snapshot().then(snapshot => this.onmessage?.({ data: JSON.stringify(snapshot) })); }
        close() { window.streams.delete(this); window.closedStream = this; }
      };
      window.emitTerminal = event => { window.lastEvent = event; for (const stream of window.streams) stream.onmessage?.({ data: JSON.stringify(event) }); };
    });
    const css = await readFile(path.join(repo, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
    const terminalCss = (await readFile(path.join(repo, "components/workspace/TerminalPanel.module.css"), "utf8")).replace(/:global\(([^)]+)\)/g, "$1");
    const shellCss = await readFile(path.join(repo, "components/workspace/SmartShell.module.css"), "utf8");
    await page.route("https://shell-surface.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/actions")) {
        const body = route.request().postDataJSON(); requests.push(body);
        if (holdInput && body.action === "input") { inputPending = true; await new Promise(resolve => { releaseInput = resolve; }); holdInput = false; }
        const response = await api(body);
        const text = await response.text();
        if (response.ok && ["input", "resize"].includes(body.action)) assert.deepEqual(JSON.parse(text), { success: true }, "keystrokes and resize must not return the terminal's output/history");
        return route.fulfill({ status: response.status, contentType: "application/json", body: text });
      }
      if (url.pathname.startsWith("/api/shell/")) {
        const parts = url.pathname.slice("/api/shell/".length).split("/");
        const response = await handleShellRequest(new Request("http://localhost" + url.pathname + url.search, { headers: { Host: "localhost", Origin: "http://localhost" } }), parts);
        return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
      }
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><style>*{box-sizing:border-box}body{margin:0;background:#101419}#root{height:580px;width:680px;display:flex;flex-direction:column}' + css + terminalCss + shellCss + '</style><div id="root"></div><script src="/bundle.js"></script>' });
    });
    unsubscribe = session.subscribe(event => { forwarding = forwarding.then(() => page.evaluate(event => window.emitTerminal?.(event), event)).catch(() => {}); });
    await page.goto("https://shell-surface.test/");
    // Reproduce an already-mounted terminal inside a hidden workspace tab.
    await page.evaluate(() => { document.getElementById("root").style.display = "none"; });
    await page.waitForFunction(() => window.ready && document.querySelector(".xterm-helper-textarea"));
    const hiddenSizes = requests.filter(body => body.action === "resize");
    assert.ok(hiddenSizes.every(body => body.cols > 20), "hidden mounts must never send a tiny fallback width to the PTY");
    await page.evaluate(() => { document.getElementById("root").style.display = "flex"; });
    assert.equal(await page.evaluate(() => window.streams.size), 1, "command cards and native terminal share one event connection");
    // The default command-card view keeps the native surface hidden. It still
    // needs the panel's real dimensions before the shared shell prints output.
    const initialSize = await until(() => requests.filter(body => body.action === "resize").at(-1), size => size?.cols > 70, 3000);
    await page.evaluate(() => { document.getElementById("root").style.width = "500px"; });
    const narrowSize = await until(() => requests.filter(body => body.action === "resize").at(-1), size => size?.cols > 2 && size.cols < initialSize.cols, 3000);
    await page.evaluate(() => { document.getElementById("root").style.width = "680px"; });
    await until(() => requests.filter(body => body.action === "resize").at(-1), size => size?.cols === initialSize.cols, 3000);
    assert.ok(narrowSize.cols < initialSize.cols);
    const directoryLine = "DIRECTORY:C:/" + "folder/".repeat(Math.floor((initialSize.cols - 15) / 7));
    const listing = await session.execute(profile.kind === "powershell" ? `Write-Output '${directoryLine}'` : `printf '%s\\n' '${directoryLine}'`, randomUUID());
    await until(() => session.command(listing.id), block => block.status === "completed");
    await page.evaluate(() => window.showNative(true));
    await page.waitForFunction(line => document.querySelector(".xterm-rows")?.textContent.includes(line), directoryLine);
    const geometry = await page.locator(".surface").evaluate(element => {
      const surface = element.getBoundingClientRect();
      const screen = element.querySelector(".xterm-screen").getBoundingClientRect();
      return { right: screen.right, bottom: screen.bottom, surfaceRight: surface.right, surfaceBottom: surface.bottom };
    });
    assert.ok(geometry.right <= geometry.surfaceRight && geometry.bottom <= geometry.surfaceBottom, "terminal cells fit inside the padded surface");
    const input = page.locator(".xterm-helper-textarea");
    const completed = id => until(() => session.command(id), block => !["accepted", "running"].includes(block.status));
    const command = profile.kind === "powershell" ? "Write-Output 'NATIVE_TYPED_PROOF'" : "echo NATIVE_TYPED_PROOF";
    await input.focus(); await page.keyboard.type(command); await page.keyboard.press("Enter");
    await until(() => session.snapshot().commands, blocks => blocks.some(block => block.command.includes("NATIVE_TYPED_PROOF") && block.status === "completed"));
    await page.reload();
    await page.waitForFunction(() => typeof window.showNative === "function");
    await page.evaluate(() => window.showNative(true));
    await page.waitForFunction(() => window.ready && document.querySelector(".xterm-rows")?.textContent.includes("NATIVE_TYPED_PROOF"));
    const interactive = await session.execute(profile.kind === "powershell" ? "$answer = Read-Host 'TYPE_PROOF'; Write-Output ('ANSWER:' + $answer)" : "read -r -p 'TYPE_PROOF:' answer; printf 'ANSWER:%s\\n' \"$answer\"", randomUUID());
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("TYPE_PROOF"));
    await input.focus(); await page.keyboard.type("hello"); await page.keyboard.press("Enter");
    assert.match((await completed(interactive.id)).output, /ANSWER:hello/);
    const tuiFile = path.join(root, "tui.cjs");
    await writeFile(tuiFile, 'process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[HINTERACTIVE_TUI");process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on("data",data=>{if(data.includes(113)){process.stdin.setRawMode(false);process.stdout.write("\\x1b[?1049lTUI_EXIT_OK\\n");process.exit(0)}})');
    const tui = await session.execute("node '" + tuiFile.replaceAll("'", profile.kind === "powershell" ? "''" : "'\\''") + "'", randomUUID());
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("INTERACTIVE_TUI"));
    await input.focus(); await page.keyboard.press("q");
    assert.match((await completed(tui.id)).output, /TUI_EXIT_OK/);
    const long = await session.execute(profile.kind === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30", randomUUID());
    await until(() => session.command(long.id), block => block.status === "running");
    await page.keyboard.press("Control+c"); await completed(long.id);
    assert.equal(session.state.activeCommandId, null);
    // Delay one HTTP input while another remains in the client queue. Both were
    // typed into the old process and must never reach its replacement.
    const before = requests.length;
    holdInput = true; await page.keyboard.type("xy");
    await until(() => inputPending, Boolean);
    await session.stop(); await session.start(); await forwarding;
    releaseInput();
    await page.waitForFunction(() => window.terminalError?.includes("Terminal restarted"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const staleTypedInputs = requests.slice(before).filter(body => body.action === "input" && /^[xy]+$/.test(body.data));
    assert.ok(staleTypedInputs.length <= 1 && staleTypedInputs.every(body => "xy".startsWith(body.data) && body.generation < session.state.generation), "typed input may be batched or discarded, but it must stay on the old generation");
    assert.equal((await api({ action: "input", data: "STALE_INPUT\r", generation: session.state.generation - 1 })).status, 409);
    assert.doesNotMatch(session.snapshot().output, /STALE_INPUT/);
    unsubscribe(); await forwarding;
    const wire = wireSnapshot();
    await page.evaluate(wire => {
      const next = { ...wire, generation: wire.generation + 1, sequence: wire.sequence + 100, snapshot: { ...wire.snapshot, session: { ...wire.snapshot.session, generation: wire.generation + 1 }, output: "FRESH_SNAPSHOT\r\n" } };
      window.emitTerminal({ type: "output", terminalId: wire.terminalId, generation: wire.generation, sequence: wire.sequence + 1, data: "OLD_QUEUED_FRAME\r\n".repeat(10000) });
      window.emitTerminal(next);
      window.emitTerminal({ type: "output", terminalId: wire.terminalId, generation: wire.generation, sequence: 999999, data: "STALE_GENERATION\r\n" });
      window.emitTerminal({ type: "output", terminalId: wire.terminalId, generation: next.generation, sequence: next.sequence - 1, data: "STALE_SEQUENCE\r\n" });
      window.emitTerminal({ type: "output", terminalId: wire.terminalId, generation: next.generation, sequence: next.sequence + 1, data: "CURRENT_FRAME\r\n" });
    }, wire);
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("CURRENT_FRAME"));
    assert.doesNotMatch(await page.locator(".xterm-rows").innerText(), /OLD_QUEUED|STALE_GENERATION|STALE_SEQUENCE/);
    await page.evaluate(() => {
      const event = window.lastEvent;
      window.emitTerminal({ ...event, type: "output", sequence: event.sequence + 1, data: "BEFORE_CLEAR\r\n" });
      window.emitTerminal({ ...event, type: "clear", sequence: event.sequence + 2 });
      window.emitTerminal({ ...event, type: "output", sequence: event.sequence + 3, data: "AFTER_CLEAR\r\n" });
    });
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("AFTER_CLEAR"));
    assert.doesNotMatch(await page.locator(".xterm-rows").innerText(), /BEFORE_CLEAR|CURRENT_FRAME/);
    assert.deepEqual(errors, []);
  } finally {
    releaseInput?.(); unsubscribe(); await forwarding; await browser?.close(); await session.dispose(); await store.close();
    globalThis.__pioraManagedShells?.delete(session.state.id); delete globalThis.__pioraShellStore;
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-shell-surface-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
