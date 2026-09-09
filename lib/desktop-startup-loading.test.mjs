import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const source = main.slice(main.indexOf("function createStartupWindow("), main.indexOf("type SmokeRendererState"));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function fixture({ failedLoad = false, failedWrite = false } = {}) {
  const window = new EventEmitter(); window.webContents = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, show() {}, maximize() {}, loadFile: async (path) => { loaded.push(path); if (failedLoad) throw new Error("load failed"); } });
  const loaded = [], writes = [], timers = [];
  const bindings = {
    createMainWindowShell: () => ({ window, initialState: { maximized: false } }),
    readLastLaunchedVersion: () => "beta.5", app: { getPath: () => resolve(".verification/startup-fixture"), getVersion: () => "beta.7", getLocale: () => "en", isPackaged: false },
    join, resolve, pathToFileURL, __dirname: resolve("desktop/src"),
    loadStartupMedia: () => ({ video: "packaged-video" }), createStartupDocument: () => "x".repeat(8_200_000),
    STARTUP_MEDIA_TIMEOUT_MS: 10000, STARTUP_CONTINUE_URL: "piora-startup://continue", PORTABLE_SMOKE_TEST: false,
    writeFileSync: (path, content) => { if (failedWrite) throw new Error("read-only"); writes.push({ path, size: content.length }); },
    setTimeout: (run) => { const timer = { run, unref() {} }; timers.push(timer); return timer; }, clearTimeout() {},
  };
  const start = new Function(...Object.keys(bindings), compiled + ";return createStartupWindow;")(...Object.values(bindings));
  return { ...start({ warn() {} }), loaded, writes, timers };
}
test("large startup media loads from a file and does not end the intro on its own navigation", async () => {
  const f = fixture(); let finished = false; void f.finished.then(() => { finished = true; });
  assert.ok(f.writes[0].size > 8_000_000); assert.equal(f.loaded[0], f.writes[0].path);
  f.window.webContents.emit("did-navigate", {}, pathToFileURL(f.loaded[0]).href);
  await Promise.resolve(); assert.equal(finished, false);
  f.window.emit("ready-to-show"); await f.ready;
  f.window.webContents.emit("will-navigate", { preventDefault() {} }, "piora-startup://continue");
  await f.finished;
  assert.equal(f.window.webContents.listenerCount("will-navigate"), 0);
});
test("load failure, file-write failure and a renderer that never becomes ready release startup", async () => {
  await fixture({ failedLoad: true }).finished;
  await fixture({ failedWrite: true }).finished;
  const stalled = fixture();
  assert.equal(stalled.timers.length, 1, "watchdog starts before ready-to-show");
  stalled.timers[0].run(); await stalled.finished;
});
