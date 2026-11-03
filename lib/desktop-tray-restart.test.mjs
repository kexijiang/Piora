import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const menu = source.slice(source.indexOf("function updateTrayMenu("), source.indexOf("async function refreshTrayTaskCount("));
const stop = source.slice(source.indexOf("async function stopApplication("), source.indexOf("// Smoke tests run in isolated"));
const beforeQuit = source.slice(source.indexOf('  app.on("before-quit",'), source.indexOf("  const startupWatchdog ="));
const compiled = ts.transpileModule(`${menu}\n${stop}\n${beforeQuit}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ chinese = true, prepareQuit = async () => true, stopServer = async () => {}, stopClipboard = async () => {} } = {}) {
  const calls = [], errors = [];
  let items, handler;
  class ClipboardDraftFlushError extends Error {}
  const env = {
    ClipboardDraftFlushError, restartRequested: false, quitRequested: false, shutdownComplete: false, shutdownPromise: undefined,
    DESKTOP_DISPLAY_NAME: "Piora", DESKTOP_TOKEN_HEADER: "token", brandText: text => text,
    companionShouldBeVisible: false, runningTaskCount: 2, mainWindow: null,
    focusMainWindow() {}, showCompanionPanel() {},
    app: { getLocale: () => chinese ? "zh-CN" : "en-US", on: (_name, callback) => { handler = callback; },
      quit: () => { calls.push("quit"); handler({ preventDefault() { calls.push("defer"); } }); },
      relaunch: () => calls.push("relaunch") },
    tray: { setToolTip() {}, setContextMenu: value => { items = value; }, destroy: () => calls.push("tray-destroy") },
    Menu: { buildFromTemplate: value => value },
    harmonyWindows: { prepareQuit, destroy: () => calls.push("harmony-windows") },
    clipboardController: { stop: async () => { calls.push("clipboard"); await stopClipboard(ClipboardDraftFlushError); } },
    dshMeme: { dispose: async () => { calls.push("meme"); } },
    dshPet: { dispose: async () => { calls.push("pet"); } },
    desktopBrowserManager: { flushStorage: async () => { calls.push("browser-flush"); }, destroy: () => calls.push("browser-destroy") },
    server: { stop: async () => { calls.push("server-stop"); await stopServer(); calls.push("server-stopped"); } },
    serverUrl: new URL("http://localhost:30141"), applicationToken: "fixture",
    fetch: async () => { calls.push("computer-stop"); }, URL, AbortSignal,
    requestHarmonyEmergencyStop: async () => { calls.push("harmony-stop"); },
    scheduledUpdateTimer: undefined, automaticUpdateCheckTimer: undefined, trayPollTimer: undefined,
    clearTimeout, clearInterval, globalShortcut: { unregisterAll: () => calls.push("shortcuts") },
    removeDisplayReconciliation() {}, logger: { info() {}, warn() {}, error() {} },
    dialog: { showErrorBox: (...args) => errors.push(args) },
  };
  runInNewContext(`${compiled}\nupdateTrayMenu();`, env);
  return { env, calls, errors, restart: () => items.find(item => /Restart|重启/.test(item.label)), quit: () => items.find(item => /Quit|彻底退出/.test(item.label)) };
}

test("tray restart waits for full shutdown, then relaunches once and exits", async () => {
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const f = fixture({ stopServer: () => stopped });
  assert.equal(f.restart().label, "重启 Piora");
  const click = f.restart().click;
  click(); click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.restart().enabled, false);
  assert.equal(f.calls.filter(call => call === "server-stop").length, 1);
  assert.equal(f.calls.includes("relaunch"), false, "no new process while the old service owns its port");
  release(); await f.env.shutdownPromise;
  assert.deepEqual(f.calls.filter(call => ["meme", "pet", "browser-flush", "browser-destroy", "harmony-stop", "computer-stop", "server-stop", "server-stopped", "tray-destroy", "relaunch"].includes(call)),
    ["meme", "pet", "browser-flush", "browser-destroy", "harmony-stop", "computer-stop", "server-stop", "server-stopped", "tray-destroy", "relaunch"]);
  assert.equal(f.calls.at(-1), "quit");
  assert.equal(f.env.shutdownComplete, true);
  assert.equal(f.env.restartRequested, false);
  assert.equal(f.env.server, undefined);
});

test("cancelled shutdown cancels the restart and a later ordinary quit never relaunches", async () => {
  let allow = false;
  const f = fixture({ chinese: false, prepareQuit: async () => allow });
  assert.equal(f.restart().label, "Restart Piora");
  f.restart().click(); await f.env.shutdownPromise;
  assert.equal(f.env.restartRequested, false); assert.equal(f.restart().enabled, true);
  assert.equal(f.calls.includes("server-stop"), false);
  allow = true; f.quit().click(); await f.env.shutdownPromise;
  assert.equal(f.calls.includes("server-stopped"), true);
  assert.equal(f.calls.includes("relaunch"), false);
});

test("unsaved clipboard drafts and failed service shutdown never queue a relaunch", async () => {
  for (const options of [
    { stopClipboard: async ErrorType => { throw new ErrorType("draft"); } },
    { stopServer: async () => { throw new Error("service still running"); } },
  ]) {
    const f = fixture(options);
    f.restart().click(); await f.env.shutdownPromise;
    assert.equal(f.env.restartRequested, false);
    assert.equal(f.env.quitRequested, false);
    assert.equal(f.env.shutdownComplete, false);
    assert.equal(f.calls.includes("relaunch"), false);
    assert.equal(f.errors.length, 1);
  }
});
