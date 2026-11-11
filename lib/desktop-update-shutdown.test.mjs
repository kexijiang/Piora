import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
const functions = ["installDownloadedDesktopUpdate", "performDownloadedDesktopUpdate"].map(name => {
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `missing ${name}`);
  return node.getText(ast);
}).join("\n");
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ fresh = true, prepareQuit = async () => true, stop = async () => {}, install = true,
  blockers = [], running = 0, confirm = async () => ({ response: 0 }) } = {}) {
  const calls = [], messages = [], errors = [];
  class ClipboardDraftFlushError extends Error {}
  const env = {
    desktopUpdateInstallPromise: undefined, shutdownPromise: undefined, shutdownComplete: false, quitRequested: false,
    desktopUpdateState: { status: "downloaded", availableVersion: "0.5.11-beta.2" },
    desktopUpdateController: {
      prepareForInstall: async () => { calls.push("freshness"); return fresh; },
      quitAndInstall: silent => { calls.push(`install:${silent}`); return install; },
    },
    harmonyWindows: {
      prepareQuit: async silent => { calls.push(`prepare:${silent}`); return prepareQuit(silent); },
      destroy: () => calls.push("destroy-mirrors"),
    },
    stopApplication: async () => { calls.push("stop"); await stop(ClipboardDraftFlushError); calls.push("stopped"); },
    updateBlockers: new Set(blockers), runningTaskCount: running, powerMonitor: { getSystemIdleTime: () => 120 },
    ClipboardDraftFlushError, APP_DISPLAY_NAME: "Piora", brandText: text => text, updateVersionLabel: () => " v0.5.11-beta.2",
    showDesktopMessage: async options => { messages.push(options); return confirm(options); },
    app: { getLocale: () => "zh-CN", relaunch: () => calls.push("relaunch"), quit: () => calls.push("quit") },
    logger: { error() {} }, dialog: { showErrorBox: (...args) => errors.push(args) },
  };
  runInNewContext(compiled, env);
  return { env, calls, messages, errors, install: (confirm = false, silent = false) => env.installDownloadedDesktopUpdate(confirm, silent) };
}

test("update install destroys prepared mirror windows and awaits service exit before handing off once", async () => {
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  const f = fixture({ stop: () => stopped });
  const pending = [f.install(), f.install(true), f.install(false, true)];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls, ["freshness", "prepare:false", "destroy-mirrors", "stop"]);
  assert.equal(f.env.shutdownComplete, false);
  assert.equal(f.messages.length, 0, "other entry points join the admitted installation");
  release();
  assert.deepEqual(await Promise.all(pending), [true, true, true]);
  assert.deepEqual(f.calls, ["freshness", "prepare:false", "destroy-mirrors", "stop", "stopped", "install:false"]);
  assert.equal(f.env.shutdownComplete, true);
  assert.equal(await f.install(), false, "an already exiting process cannot start another installer");
  assert.equal(f.calls.filter(call => call.startsWith("install:")).length, 1);
});

test("cancelled mirror recording confirmation leaves the app running and permits a later retry", async () => {
  let allow = false;
  const f = fixture({ prepareQuit: async () => allow });
  assert.equal(await f.install(), false);
  assert.deepEqual(f.calls, ["freshness", "prepare:false"]);
  assert.equal(f.env.quitRequested, false);
  assert.equal(f.env.desktopUpdateInstallPromise, undefined);
  allow = true;
  assert.equal(await f.install(), true);
  assert.equal(f.calls.filter(call => call === "destroy-mirrors").length, 1);
});

test("unsaved files block manual installation and silently defer scheduled installation", async () => {
  for (const silent of [false, true]) {
    const f = fixture({ blockers: ["file.ts"] });
    assert.equal(await f.install(false, silent), false);
    assert.deepEqual(f.calls, silent ? [] : ["freshness"]);
    assert.equal(f.messages.length, silent ? 0 : 1);
    if (!silent) assert.equal(f.messages[0].message, "有文件尚未保存");
    assert.equal(f.env.quitRequested, false);
  }
});

test("scheduled installation defers a recording without prompting or stopping the service", async () => {
  const f = fixture({ prepareQuit: async silent => { assert.equal(silent, true); return false; } });
  assert.equal(await f.install(false, true), false);
  assert.deepEqual(f.calls, ["prepare:true"]);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.errors, []);
});

test("freshness, active tasks and cancelled install confirmation cannot shut down the app", async () => {
  for (const options of [{ fresh: false }, { running: 1 }, { confirm: async () => ({ response: 1 }) }]) {
    const f = fixture(options);
    assert.equal(await f.install(true), false);
    assert.deepEqual(f.calls, ["freshness"]);
    assert.equal(f.env.quitRequested, false);
  }
});

test("failed clipboard draft persistence aborts handoff and allows a safe retry", async () => {
  let fail = true;
  const f = fixture({ stop: async ErrorType => { if (fail) throw new ErrorType("draft not saved"); } });
  assert.equal(await f.install(), false);
  assert.equal(f.env.quitRequested, false);
  assert.equal(f.env.shutdownComplete, false);
  assert.equal(f.env.shutdownPromise, undefined);
  assert.equal(f.calls.some(call => call.startsWith("install:") || call === "relaunch" || call === "quit"), false);
  assert.equal(f.errors.length, 1);
  fail = false;
  assert.equal(await f.install(), true);
});

test("failed installer handoff reports failure and restores the app through the existing relaunch path", async () => {
  const f = fixture({ install: false });
  assert.equal(await f.install(), false);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.calls.slice(-3), ["install:false", "relaunch", "quit"]);
});
