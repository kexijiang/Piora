import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
  const logs = [], loaded = [], warmed = [];
  const window = { isDestroyed: () => false };
  const env = {
    join, logger: undefined, recordStartupStage() {}, piAgentDirectoryPath: undefined, mainWindow: undefined,
    applicationToken: undefined, serverUrl: undefined, clipboardController: undefined, quitRequested: false,
    harmonyWindows: undefined, __dirname: "fixture",
    HarmonyWindows: class { constructor(dependencies) { this.dependencies = dependencies; } },
    app: { whenReady: async () => {}, setAppUserModelId() {}, getPath: () => "fixture", getVersion: () => "beta.28" },
    process: Object.assign(new EventEmitter(), { versions: { electron: "test" }, connected: true, send() {} }),
    FileLogger: class { info() {} warn(message) { logs.push(message); } },
    desktopDevelopmentRuntime: { url: new URL("http://127.0.0.1:30141"), token: "fixture" },
    clearObsoleteDesktopWebCaches: async () => {}, resolvePiAgentDirectory: () => "fixture",
    createStartupWindow: () => ({ window, ready: Promise.resolve(0), ensureVisible() {}, finished: new Promise(resolve => { finishIntro = resolve; }) }),
    waitForDesktopDevelopmentServer: async () => {}, electronSession: { fromPartition: () => ({}) },
    DESKTOP_PARTITION: "fixture", PORTABLE_SMOKE_TEST: false,
    ClipboardController: class {
      start() { return new Promise((_resolve, reject) => { rejectClipboard = reject; }); }
      setShortcut() {} warm() { warmed.push(true); return Promise.resolve(); }
    },
    isTrustedMainWindowSender: () => true,
    syncSavedDesktopNetworkProxy: async () => {},
    keyboardShortcutBindings: { "companion.clipboard": "Alt+C" }, toElectronAccelerator: value => value,
    loadApplicationWindow: async (_window, url) => { loaded.push(url.origin); },
  };
  for (const name of [
    "installTray", "configureSession", "warmInitialModelCatalog", "registerCompletionNotificationHandler",
    "registerCompanionWindowHandlers", "registerAutoLaunchHandlers", "registerRuntimeLogHandler", "registerGlobalShortcutHandler",
    "registerKeyboardShortcutHandler", "registerNetworkProxyHandler", "registerHarmonyRuntimePickerHandler",
    "attachDesktopBrowserManager", "registerDirectoryPickerHandler", "registerAgentDataDirectoryHandlers",
    "installApplicationMenu", "registerApplicationMenuPopupHandler", "initializeDesktopUpdater",
    "registerFileShellHandlers", "installDisplayReconciliation", "writeLastLaunchedVersion",
  ]) env[name] = () => {};
  runInNewContext(compiled + ";globalThis.start = startApplication;", env);
  return { env, logs, loaded, warmed, finish: () => finishIntro(), failClipboard: () => rejectClipboard(new Error("migration failed")) };
}

test("slow clipboard initialization does not prevent the main window from opening", { timeout: 2000 }, async () => {
  const f = fixture(); const running = f.env.start();
  // Let the service and optional worker initialize up to the intro handoff.
  await new Promise(resolve => setImmediate(resolve));
  f.finish(); await running;
  assert.equal(f.loaded.length, 1);
  assert.equal(f.warmed.length, 0, "startup keeps clipboard capture active without creating a hidden renderer");
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

test("desktop development refuses startup without a connected IPC launcher", async () => {
  for (const missing of ["send", "connected"]) {
    const f = fixture();
    f.env.process[missing] = undefined;
    await assert.rejects(f.env.start(), /requires the dev:desktop IPC launcher/);
    assert.deepEqual(f.loaded, []);
  }
});

test("desktop development dispatches IPC and responds only while connected", async () => {
  const f = fixture();
  const requests = [], responses = [];
  const response = { type: "pi-desktop:browser-agent-response", requestId: "fixture", ok: true };
  f.env.handleStandaloneMessage = async message => { requests.push(message); return response; };
  f.env.process.send = message => responses.push(message);
  const running = f.env.start();
  await new Promise(resolve => setImmediate(resolve));
  f.finish();
  await running;
  const request = { type: "pi-desktop:browser-agent-request", requestId: "fixture" };
  f.env.process.emit("message", request);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [request]);
  assert.deepEqual(responses, [response]);
  f.env.process.emit("message", request);
  f.env.process.connected = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(responses.length, 1);
});
