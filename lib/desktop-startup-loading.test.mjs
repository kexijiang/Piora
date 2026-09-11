import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { runOptionalStartupTask } = await createJiti(import.meta.url).import("../desktop/src/startup-tasks.ts");
const { isStartupDocumentUrl } = await createJiti(import.meta.url).import("../desktop/src/startup-scene.ts");

const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("function createStartupWindow("), main.indexOf("type SmokeRendererState"));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture({ failedLoad = false, failedWrite = false, delayedLoad = false, abortOnStop = false, failedStop = false } = {}) {
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  let settleLoad, rejectLoad; let stopped = false;
  window.webContents.mainFrame = { url: pathToFileURL(resolve(".verification/startup-fixture/startup.html")).href };
  window.webContents.isDestroyed = () => false;
  window.webContents.stop = () => { stopped = true; if (failedStop) throw new Error("renderer exited"); if (abortOnStop) rejectLoad(Object.assign(new Error("ERR_ABORTED (-3)"), { code: "ERR_ABORTED", errno: -3 })); };
  Object.assign(window, { isDestroyed: () => false, show() {}, maximize() {}, loadFile: async (path) => { loaded.push(path); if (failedLoad) throw new Error("load failed"); if (delayedLoad) await new Promise((resolve, reject) => { settleLoad = resolve; rejectLoad = reject; }); } });
  const loaded = [], writes = [], timers = [];
  const bindings = {
    createMainWindowShell: () => ({ window, initialState: { maximized: false } }),
    readLastLaunchedVersion: () => "beta.5", app: { getPath: () => resolve(".verification/startup-fixture"), getVersion: () => "beta.7", getLocale: () => "en", isPackaged: false },
    join, resolve, pathToFileURL, isStartupDocumentUrl, setImmediate, __dirname: resolve("desktop/src"),
    loadStartupMedia: () => ({ video: "packaged-video" }), createStartupDocument: () => "x".repeat(8_200_000),
    STARTUP_MEDIA_TIMEOUT_MS: 10000, STARTUP_CONTINUE_CHANNEL: "pi:startup-continue", runOptionalStartupTask, PORTABLE_SMOKE_TEST: false,
    writeFileSync: (path, content) => { if (failedWrite) throw new Error("read-only"); writes.push({ path, size: content.length }); },
    setTimeout: (run) => { const timer = { run, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
  };
  const start = new Function(...Object.keys(bindings), compiled + ";return createStartupWindow;")(...Object.values(bindings));
  return { ...start({ warn() {}, info() {} }), loaded, writes, timers, settleLoad: () => settleLoad(), stopped: () => stopped };
}
test("large startup media loads from a file and does not end the intro on its own navigation", async () => {
  const f = fixture(); let finished = false; void f.finished.then(() => { finished = true; });
  assert.ok(f.writes[0].size > 8_000_000); assert.equal(f.loaded[0], f.writes[0].path);
  f.window.webContents.emit("did-navigate", {}, pathToFileURL(f.loaded[0]).href);
  await Promise.resolve(); assert.equal(finished, false);
  f.window.emit("ready-to-show"); await f.ready;
  f.window.webContents.emit("ipc-message", { senderFrame: f.window.webContents.mainFrame }, "pi:startup-continue");
  await f.finished;
  assert.equal(f.window.webContents.listenerCount("ipc-message"), 0);
  assert.equal(f.window.webContents.listenerCount("will-navigate"), 1, "guard survives until app commit");
  f.window.webContents.emit("did-navigate", {}, "http://127.0.0.1:30141/");
  assert.equal(f.window.webContents.listenerCount("will-navigate"), 0);
});
test("load failure, file-write failure and a renderer that never becomes ready release startup", async () => {
  await fixture({ failedLoad: true }).finished;
  await fixture({ failedWrite: true }).finished;
  const stalled = fixture();
  assert.equal(stalled.timers.length, 1, "watchdog starts before ready-to-show");
  stalled.timers[0].run(); await stalled.finished;
});

test("watchdog handoff stops and settles a pending navigation before releasing the app page", async () => {
  const f = fixture({ delayedLoad: true });
  let released = false; void f.finished.then(() => { released = true; });
  f.timers[0].run(); await Promise.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.stopped(), true);
  assert.equal(released, false, 'main navigation must wait for the cancelled file navigation to settle');
  f.settleLoad(); await f.finished;
  assert.equal(released, true);
  assert.equal(f.window.webContents.listenerCount('will-navigate'), 1);
});


test("aborted and permanently pending animation loads both release the application", { timeout: 3000 }, async () => {
  const aborted = fixture({ delayedLoad: true, abortOnStop: true });
  aborted.timers[0].run(); await aborted.finished;
  const stuck = fixture({ delayedLoad: true });
  stuck.timers[0].run(); await stuck.finished;
  assert.equal(stuck.stopped(), true);
  await fixture({ failedLoad: true, failedStop: true }).finished;
});

test("only the startup main frame can finish the intro; late legacy navigation remains blocked", async () => {
  const f = fixture(); let finished = false;
  void f.finished.then(() => { finished = true; });
  for (const senderFrame of [null, { url: f.window.webContents.mainFrame.url }]) {
    f.window.webContents.emit("ipc-message", { senderFrame }, "pi:startup-continue");
  }
  const frame = f.window.webContents.mainFrame;
  const startupUrl = frame.url;
  frame.url = "https://untrusted.invalid";
  f.window.webContents.emit("ipc-message", { senderFrame: frame }, "pi:startup-continue");
  frame.url = startupUrl;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  f.window.webContents.emit("ipc-message", { senderFrame: frame }, "pi:startup-continue");
  await f.finished;
  let blocked = false;
  f.window.webContents.emit("will-navigate", { preventDefault() { blocked = true; } }, "piora-startup://continue");
  assert.equal(blocked, true);
  f.window.webContents.emit("did-navigate", {}, "http://127.0.0.1:30141/");
  assert.equal(f.window.webContents.listenerCount("will-navigate"), 0);
});

test("successful application load can reveal a recovered shell without ready-to-show", async () => {
  const f = fixture({ failedWrite: true });
  let shows = 0;
  f.window.show = () => { shows++; };
  await f.finished;
  f.ensureVisible();
  assert.equal(typeof await f.ready, "number");
  f.ensureVisible();
  f.window.emit("ready-to-show");
  assert.equal(shows, 1, "late readiness must not reopen a window the user has hidden");
});

 test("startup document identity accepts equivalent URL encoding and rejects other documents", () => {
  const expected = resolve(".verification/RUNNER~1/user data/startup.html");
  const encoded = pathToFileURL(expected).href.replaceAll("~", "%7E");
  assert.equal(isStartupDocumentUrl(encoded, expected), true);
  assert.equal(isStartupDocumentUrl(encoded.replaceAll("%7E", "~"), expected), true);
  assert.equal(isStartupDocumentUrl(pathToFileURL(resolve("other/startup.html")).href, expected), false);
  assert.equal(isStartupDocumentUrl("http://127.0.0.1/startup.html", expected), false);
  assert.equal(isStartupDocumentUrl("not a url", expected), false);
});
