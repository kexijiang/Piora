import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;

test("sandboxed preload works without Electron 45's removed Node shims and hides IPC events", async () => {
  const handlers = new Map();
  const calls = [];
  let bridge;
  const electron = {
    contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "piDesktop"); bridge = value; } },
    ipcRenderer: {
      on(name, listener) { handlers.set(name, listener); },
      removeListener(name, listener) { assert.equal(handlers.get(name), listener); handlers.delete(name); },
      invoke: async (...args) => { calls.push(args); return true; },
      send: (...args) => calls.push(args),
    },
    webUtils: { getPathForFile: file => file.path ?? "" },
  };
  // Deliberately provide neither Buffer/setImmediate/clearImmediate nor the
  // events/timers/url modules removed from sandboxed preloads in Electron 45.
  runInNewContext(compile(readFileSync(new URL("../desktop/src/preload.ts", import.meta.url), "utf8")), {
    exports: {}, document: { documentElement: { inert: false } },
    process: { platform: "linux", versions: { chrome: "156", electron: "45.0.0" } },
    require(name) { assert.equal(name, "electron", "preload must not require Node shims"); return electron; },
  });
  assert.ok(Object.isFrozen(bridge));
  assert.equal(bridge.versions.electron, "45.0.0");
  const received = [];
  const stop = bridge.onNotificationSession((...args) => received.push(args));
  handlers.get("pi:notification-session")({ sender: "privileged event" }, "session-1");
  handlers.get("pi:notification-session")({}, "bad\nidentifier");
  assert.deepEqual(received, [["session-1"]]);
  stop();
  assert.equal(handlers.has("pi:notification-session"), false);
  assert.equal(await bridge.notifyCompletion("Completed", "session-1"), true);
  assert.equal(calls.at(-1)[0], "pi:completion-notification");
  assert.equal(calls.at(-1)[1].sessionId, "session-1");
  assert.equal(bridge.files.getPathForFile({}), "");
  assert.equal(bridge.files.getPathForFile({ path: "/chosen/file" }), "/chosen/file");
  assert.equal(bridge.ipcRenderer, undefined);
  assert.equal(bridge.process, undefined);
});

test("desktop permission callbacks keep Electron 45 display capture and unknown media denied", () => {
  const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  const start = source.indexOf("function configureSession(");
  const end = source.indexOf("async function waitForDesktopDevelopmentServer(", start);
  assert.ok(start >= 0 && end > start);
  const configure = new Function("URL", `${compile(source.slice(start, end))}; return configureSession;`)(URL);
  let check, request;
  configure({
    setPermissionCheckHandler(handler) { check = handler; },
    setPermissionRequestHandler(handler) { request = handler; },
    webRequest: { onBeforeSendHeaders() {}, onErrorOccurred() {}, onCompleted() {} },
  }, "http://127.0.0.1:30141", "test-token");
  const origin = "http://127.0.0.1:30141";
  const ask = (permission, overrides = {}) => {
    let allowed;
    request(null, permission, value => { allowed = value; }, { isMainFrame: true, securityOrigin: origin, mediaTypes: ["audio"], ...overrides });
    assert.equal(typeof allowed, "boolean");
    return allowed;
  };
  assert.equal(ask("media"), true);
  assert.equal(check(null, "media", origin, { isMainFrame: true, mediaType: "audio" }), true);
  assert.equal(ask("clipboard-sanitized-write"), true);
  for (const permission of ["display-capture", "unknown-capture", "camera", "geolocation"]) {
    assert.equal(ask(permission), false, permission);
    assert.equal(check(null, permission, origin, { isMainFrame: true, mediaType: "audio" }), false, permission);
  }
  for (const mediaTypes of [[], ["video"], ["audio", "video"], ["unknown"], undefined]) {
    assert.equal(ask("media", { mediaTypes }), false);
  }
  for (const mediaType of ["video", "unknown", undefined]) {
    assert.equal(check(null, "media", origin, { isMainFrame: true, mediaType }), false);
  }
  for (const overrides of [{ isMainFrame: false }, { securityOrigin: "https://attacker.invalid" }, { securityOrigin: "not a URL" }]) {
    assert.equal(ask("media", overrides), false);
    assert.equal(ask("clipboard-sanitized-write", overrides), false);
  }
  assert.equal(check(null, "media", origin, { isMainFrame: false, mediaType: "audio" }), false);
  assert.equal(check(null, "media", "https://attacker.invalid", { isMainFrame: true, mediaType: "audio" }), false);
});
