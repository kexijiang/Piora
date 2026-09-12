import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("async function startApplication("), main.indexOf("async function stopApplication("));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  let rejectClipboard, finishIntro;
  const logs = [], loaded = [];
  const window = { isDestroyed: () => false };
  const env = {
    join, logger: undefined, recordStartupStage() {}, piAgentDirectoryPath: undefined, mainWindow: undefined,
    applicationToken: undefined, serverUrl: undefined, clipboardController: undefined, quitRequested: false,
    app: { whenReady: async () => {}, setAppUserModelId() {}, getPath: () => "fixture", getVersion: () => "beta.28" },
    process: { versions: { electron: "test" } },
    FileLogger: class { info() {} warn(message) { logs.push(message); } },
    desktopDevelopmentRuntime: { url: new URL("http://127.0.0.1:30141"), token: "fixture" },
    clearObsoleteDesktopWebCaches: async () => {}, resolvePiAgentDirectory: () => "fixture",
    createStartupWindow: () => ({ window, ready: Promise.resolve(0), ensureVisible() {}, finished: new Promise(resolve => { finishIntro = resolve; }) }),
    waitForDesktopDevelopmentServer: async () => {}, electronSession: { fromPartition: () => ({}) },
    DESKTOP_PARTITION: "fixture", PORTABLE_SMOKE_TEST: false,
    ClipboardController: class {
      start() { return new Promise((_resolve, reject) => { rejectClipboard = reject; }); }
      setShortcut() {} warm() { return Promise.resolve(); }
    },
    keyboardShortcutBindings: { "companion.clipboard": "Alt+C" }, toElectronAccelerator: value => value,
    loadApplicationWindow: async (_window, url) => { loaded.push(url.origin); },
  };
  for (const name of [
    "installTray", "configureSession", "warmInitialModelCatalog", "registerCompletionNotificationHandler",
    "registerCompanionWindowHandlers", "registerAutoLaunchHandlers", "registerGlobalShortcutHandler",
    "registerKeyboardShortcutHandler", "registerNetworkProxyHandler", "registerHarmonyRuntimePickerHandler",
    "attachDesktopBrowserManager", "registerDirectoryPickerHandler", "registerAgentDataDirectoryHandlers",
    "installApplicationMenu", "registerApplicationMenuPopupHandler", "initializeDesktopUpdater",
    "registerFileShellHandlers", "installDisplayReconciliation", "writeLastLaunchedVersion",
  ]) env[name] = () => {};
  runInNewContext(compiled + ";globalThis.start = startApplication;", env);
  return { env, logs, loaded, finish: () => finishIntro(), failClipboard: () => rejectClipboard(new Error("migration failed")) };
}

test("slow clipboard initialization does not prevent the main window from opening", { timeout: 2000 }, async () => {
  const f = fixture(); const running = f.env.start();
  // Let the service and optional worker initialize up to the intro handoff.
  await new Promise(resolve => setImmediate(resolve));
  f.finish(); await running;
  assert.equal(f.loaded.length, 1);
  f.failClipboard(); await Promise.resolve();
  assert.ok(f.logs.includes("Clipboard startup failed; application remains available"));
});

test("quitting during the intro never loads a cleared service URL", { timeout: 2000 }, async () => {
  const f = fixture(); const running = f.env.start();
  await new Promise(resolve => setImmediate(resolve));
  f.env.quitRequested = true; f.env.serverUrl = undefined;
  f.finish(); await running;
  assert.equal(f.loaded.length, 0);
});

test("desktop does not navigate until authenticated development assets are ready", { timeout: 2000 }, async () => {
  const f = fixture();
  let releaseAssets;
  f.env.waitForDesktopDevelopmentServer = async (url, token) => {
    assert.equal(url.origin, "http://127.0.0.1:30141");
    assert.equal(token, "fixture");
    await new Promise(resolve => { releaseAssets = resolve; });
  };
  const running = f.env.start();
  await new Promise(resolve => setImmediate(resolve));
  f.finish();
  assert.deepEqual(f.loaded, []);
  releaseAssets();
  await running;
  assert.equal(f.loaded.length, 1);
});
