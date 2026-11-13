import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const menu = source.slice(source.indexOf("async function requestDesktopRestart("), source.indexOf("async function refreshTrayTaskCount("));
const applicationMenu = source.slice(source.indexOf("function installApplicationMenu("), source.indexOf("function registerApplicationMenuPopupHandler("));
const stop = source.slice(source.indexOf("async function stopApplication("), source.indexOf("// Smoke tests run in isolated"));
const beforeQuit = source.slice(source.indexOf('  app.on("before-quit",'), source.indexOf("  const startupWatchdog ="));
const compiled = ts.transpileModule(`${applicationMenu}\n${menu}\n${stop}\n${beforeQuit}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ chinese = true, prepareQuit = async () => true, stopServer = async () => {}, stopClipboard = async () => {}, runningTaskCount = 0, confirm = async () => ({ response: 1 }) } = {}) {
  const calls = [], errors = [];
  let items, handler;
  class ClipboardDraftFlushError extends Error {}
  const env = {
    ClipboardDraftFlushError, restartRequested: false, restartConfirmationPending: false, quitRequested: false, shutdownComplete: false, shutdownPromise: undefined,
    applicationMenu: null, applicationMenuLocale: null, APP_DISPLAY_NAME: "Piora", desktopUpdateState: { status: "idle" },
    updateVersionLabel: () => "", menuAcceleratorOption: () => ({}), withSymbolicMenuShortcuts: items => items, isUpdateAttentionState: () => false, process,
    DESKTOP_DISPLAY_NAME: "Piora", DESKTOP_TOKEN_HEADER: "token", brandText: text => text,
    companionShouldBeVisible: false, runningTaskCount, mainWindow: null,
    focusMainWindow() {}, showCompanionPanel() {},
    app: { getLocale: () => chinese ? "zh-CN" : "en-US", on: (_name, callback) => { handler = callback; },
      quit: () => { calls.push("quit"); handler({ preventDefault() { calls.push("defer"); } }); },
      relaunch: () => calls.push("relaunch") },
    tray: { setToolTip() {}, setContextMenu: value => { items = value; }, destroy: () => calls.push("tray-destroy") },
    Menu: { buildFromTemplate: value => { value.getMenuItemById = id => value.flatMap(item => [item, ...(item.submenu ?? [])]).find(item => item.id === id); return value; }, setApplicationMenu() {} },
    harmonyWindows: { prepareQuit, destroy: () => calls.push("harmony-windows") },
    clipboardController: { stop: async () => { calls.push("clipboard"); await stopClipboard(ClipboardDraftFlushError); } },
    desktopAnalytics: { stop: () => calls.push("analytics-stop") },
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
    dialog: { showErrorBox: (...args) => errors.push(args), showMessageBox: options => { calls.push("confirm"); return confirm(options); } },
  };
  runInNewContext(`${compiled}\ninstallApplicationMenu(); updateTrayMenu();`, env);
  return { env, calls, errors, fileRestart: () => env.applicationMenu.getMenuItemById("app-menu-restart"), restart: () => items.find(item => /Restart|重启/.test(item.label)), quit: () => items.find(item => /Quit|彻底退出/.test(item.label)) };
}

for (const entry of ["restart", "fileRestart"]) test(`${entry} waits for full shutdown, then relaunches once and exits`, async () => {
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const f = fixture({ stopServer: () => stopped });
  assert.equal(f.restart().label, "重启 Piora");
  const click = f[entry]().click;
  click(); click(); f.restart().click(); f.fileRestart().click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.restart().enabled, false);
  assert.equal(f.fileRestart().enabled, false);
  assert.equal(f.calls.filter(call => call === "server-stop").length, 1);
  assert.equal(f.calls.includes("relaunch"), false, "no new process while the old service owns its port");
  release(); await f.env.shutdownPromise;
  assert.deepEqual(f.calls.filter(call => ["meme", "pet", "browser-flush", "browser-destroy", "harmony-stop", "computer-stop", "server-stop", "server-stopped", "analytics-stop", "tray-destroy", "relaunch"].includes(call)),
    ["meme", "pet", "browser-flush", "browser-destroy", "harmony-stop", "computer-stop", "server-stop", "server-stopped", "analytics-stop", "tray-destroy", "relaunch"]);
  assert.equal(f.env.desktopAnalytics, undefined);
  assert.equal(f.calls.at(-1), "quit");
  assert.equal(f.env.shutdownComplete, true);
  assert.equal(f.env.restartRequested, false);
  assert.equal(f.env.server, undefined);
});

for (const entry of ["restart", "fileRestart"]) test(`${entry}: cancelled shutdown never relaunches on a later ordinary quit`, async () => {
  let allow = false;
  const f = fixture({ chinese: false, prepareQuit: async () => allow });
  assert.equal(f.restart().label, "Restart Piora");
  f[entry]().click(); await f.env.shutdownPromise;
  assert.equal(f.env.restartRequested, false); assert.equal(f.restart().enabled, true);
  assert.equal(f.calls.includes("server-stop"), false);
  allow = true; f.quit().click(); await f.env.shutdownPromise;
  assert.equal(f.calls.includes("server-stopped"), true);
  assert.equal(f.calls.includes("relaunch"), false);
});

for (const entry of ["restart", "fileRestart"]) test(`${entry}: unsaved drafts and failed service shutdown never queue a relaunch`, async () => {
  for (const options of [
    { stopClipboard: async ErrorType => { throw new ErrorType("draft"); } },
    { stopServer: async () => { throw new Error("service still running"); } },
  ]) {
    const f = fixture(options);
    f[entry]().click(); await f.env.shutdownPromise;
    assert.equal(f.env.restartRequested, false);
    assert.equal(f.env.quitRequested, false);
    assert.equal(f.env.shutdownComplete, false);
    assert.equal(f.calls.includes("relaunch"), false);
    assert.equal(f.errors.length, 1);
  }
});

test("file menu restart is localized, next to quit, and works without a tray", async () => {
  for (const chinese of [true, false]) {
    const f = fixture({ chinese });
    assert.equal(f.fileRestart().label, chinese ? "重启 Piora" : "Restart Piora");
    const items = f.env.applicationMenu.getMenuItemById("app-menu-file").submenu;
    assert.equal(items[items.indexOf(f.fileRestart()) + 1].role, "quit");
    f.env.tray = undefined;
    f.fileRestart().click();
    await f.env.shutdownPromise;
    assert.equal(f.calls.filter(call => call === "relaunch").length, 1);
  }
});

test("busy restart confirms once across both menus; cancel or concurrent quit cannot leave a restart", async () => {
  for (const ordinaryQuit of [false, true]) {
    let resolve;
    const f = fixture({ runningTaskCount: 2, confirm: options => {
      assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0);
      return new Promise(done => { resolve = done; });
    } });
    f.fileRestart().click(); f.restart().click();
    assert.equal(f.calls.filter(call => call === "confirm").length, 1);
    assert.equal(f.fileRestart().enabled, false);
    assert.equal(f.restart().enabled, false);
    assert.equal(f.calls.includes("server-stop"), false);
    if (ordinaryQuit) f.quit().click();
    resolve({ response: ordinaryQuit ? 1 : 0 });
    await new Promise(done => setImmediate(done));
    await f.env.shutdownPromise;
    assert.equal(f.env.restartRequested, false);
    assert.equal(f.calls.includes("relaunch"), false);
    if (!ordinaryQuit) assert.equal(f.fileRestart().enabled, true);
  }
});

test("confirming busy restart enters the shared shutdown and relaunch path", async () => {
  const f = fixture({ runningTaskCount: 2 });
  f.fileRestart().click();
  await new Promise(done => setImmediate(done));
  await f.env.shutdownPromise;
  assert.equal(f.calls.filter(call => call === "relaunch").length, 1);
  assert.ok(f.calls.indexOf("server-stopped") < f.calls.indexOf("relaunch"));
});
