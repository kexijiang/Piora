#!/usr/bin/env node
// Isolated native smoke test; no Next build or real browser profile is needed.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

if (!process.versions.electron) {
  const profile = mkdtempSync(join(tmpdir(), "piora-browser-visibility-"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [scriptPath, profile], { env, stdio: "inherit", windowsHide: true });
  const timer = setTimeout(() => {
    console.error("Native browser visibility test timed out after 45 seconds.");
    child.kill();
  }, 45_000);
  try {
    const [code] = await once(child, "exit");
    process.exitCode = code ?? 1;
  } finally {
    clearTimeout(timer);
    // Delete only the exact test profile we just created, never an app profile.
    assert.match(relative(resolve(tmpdir()), resolve(profile)), /^piora-browser-visibility-[\w-]+$/);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  // Electron emits ready after the entry module finishes evaluating; do not
  // top-level-await it or the ESM loader and app startup wait on each other.
  void runNativeTest().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
}

async function runNativeTest() {
  const { app, BrowserWindow } = require("electron");
  const profile = process.argv[2];
  assert.match(relative(resolve(tmpdir()), resolve(profile)), /^piora-browser-visibility-[\w-]+$/);
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  app.commandLine.appendSwitch("site-per-process");
  await app.whenReady();
  const filename = join(projectRoot, "desktop", "src", "browser-manager.ts");
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = new Module(filename);
  compiledModule.filename = filename;
  compiledModule.paths = Module._nodeModulePaths(dirname(filename));
  compiledModule._compile(compiled, filename);
  const { DesktopBrowserManager, BROWSER_ACTION_CHANNEL, BROWSER_VIEWPORT_CHANNEL } = compiledModule.exports;
  let origin;
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(req.url === "/frame"
      ? '<style>body{margin:0;background:#ff0000}div{position:fixed;inset:0;background:#ff0000}</style><div>Cross-origin login frame</div>'
      : `<style>body{margin:0}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}</style><input id="draft"><iframe src="${origin.replace("127.0.0.1", "localhost")}/frame"></iframe>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({
    width: 640, height: 480, show: false, backgroundColor: "#0000ff",
    // Only our static host fixture has Node. Managed pages retain production sandboxing.
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
  });
  const log = { info() {}, warn() {}, error() {} };
  const hostChildren = [...win.contentView.children];
  const manager = new DesktopBrowserManager(win, log, (event) => event.sender === win.webContents);
  const invoke = (channel, ...args) => win.webContents.executeJavaScript(
    `require('electron').ipcRenderer.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
  );
  const viewport = (visible) => invoke(BROWSER_VIEWPORT_CHANNEL, { x: 20, y: 20, width: 440, height: 320 }, visible);
  const assertDetached = () => assert.deepEqual(win.contentView.children, hostChildren, "no browser surface remains attached");
  try {
    await win.loadURL("data:text/html,<style>body{margin:0;background:%230000ff}</style>Host renderer");
    win.showInactive();
    await invoke(BROWSER_ACTION_CHANNEL, { action: "navigate", url: origin });
    await viewport(true);
    assert.equal(win.contentView.children.length, hostChildren.length + 1);
    const view = win.contentView.children.find((child) => child.webContents !== win.webContents);
    const contents = view.webContents;
    assert.equal(contents.mainFrame.frames.some((frame) => frame.url.startsWith("http://localhost:")), true);
    assert.equal(await contents.mainFrame.frames[0].executeJavaScript("getComputedStyle(document.querySelector('div')).position"), "fixed");
    await contents.executeJavaScript("document.querySelector('#draft').value = 'preserved draft'");
    // BrowserWindow.capturePage captures the host renderer, not its sibling
    // WebContentsViews. Assert the real native hierarchy and retained contents.
    await viewport(false);
    assertDetached();
    assert.equal(view.getVisible(), false);
    assert.equal(contents.isDestroyed(), false);
    await viewport(true);
    assert.equal(win.contentView.children.includes(view), true);
    assert.equal(await contents.executeJavaScript("document.querySelector('#draft').value"), "preserved draft");
    win.minimize();
    await delay(200);
    assert.equal(win.isMinimized(), true);
    await viewport(true);
    assertDetached();
    win.restore();
    await delay(200);
    assert.equal(win.contentView.children.includes(view), true, `restored state: visible=${win.isVisible()}, minimized=${win.isMinimized()}`);
    await viewport(false);
    await contents.loadURL(`${origin}/redirect`);
    assertDetached();
    await viewport(true);
    assert.equal(win.contentView.children.includes(view), true);
    console.log("PASS: real Electron cross-origin iframe hides, retained page reopens, minimize/restore and hidden navigation respect visibility.");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    manager.destroy();
    win.destroy();
    server.close();
    app.exit(process.exitCode || 0);
  }
}
