import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../desktop/src/browser-manager.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const bounds = { x: 500, y: 100, width: 600, height: 700 };

function setup(t) {
  const handlers = new Map();
  const views = [];
  const logs = [];
  class Contents extends EventEmitter {
    url = "about:blank";
    loads = [];
    closeCount = 0;
    navigationHistory = { canGoBack: () => false, canGoForward: () => false, clear() {} };
    setWindowOpenHandler(handler) { this.openWindow = handler; }
    getURL() { return this.url; }
    getTitle() { return "Test login page"; }
    isDestroyed() { return this.closeCount > 0; }
    close() { this.closeCount += 1; }
    async loadURL(url) {
      this.loads.push(url);
      this.url = url;
      this.emit("did-navigate");
    }
  }
  class View {
    webContents = new Contents();
    visible = false;
    constructor() { views.push(this); }
    setBackgroundColor() {}
    setBounds(rect) { this.bounds = rect; }
    setVisible(visible) { this.visible = visible; }
  }
  const win = Object.assign(new EventEmitter(), {
    visible: true,
    minimized: false,
    destroyed: false,
    isVisible() { return this.visible; },
    isMinimized() { return this.minimized; },
    isDestroyed() { return this.destroyed; },
    getContentBounds() {
      return { x: 0, y: 0, width: this.minimized ? 0 : 1200, height: this.minimized ? 0 : 900 };
    },
    webContents: { isDestroyed: () => false, send() {} },
    contentView: {
      children: [],
      addChildView(view) {
        assert.equal(this.children.includes(view), false, "do not attach twice");
        this.children.push(view);
      },
      removeChildView(view) {
        assert.equal(this.children.includes(view), true, "only detach attached views");
        this.children.splice(this.children.indexOf(view), 1);
      },
    },
  });
  const browserSession = Object.assign(new EventEmitter(), {
    cookies: Object.assign(new EventEmitter(), { flushStore: async () => {} }),
    flushStorageData() {},
    setDownloadPath() {},
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
  });
  const electron = {
    app: { getPath: () => "unused-test-directory", isPackaged: false },
    WebContentsView: View,
    session: { fromPartition: () => browserSession },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel),
    },
  };
  const commonJs = { exports: {} };
  vm.runInNewContext(compiled, {
    module: commonJs,
    exports: commonJs.exports,
    require: (id) => id === "electron" ? electron : require(id),
    process, URL, setTimeout, clearTimeout,
  });
  const api = commonJs.exports;
  const manager = new api.DesktopBrowserManager(win, {
    info: (...args) => logs.push(args), warn() {}, error() {},
  }, (event) => event.trusted === true);
  t.after(() => manager.destroy());
  const invoke = (channel, ...args) => handlers.get(channel)({ trusted: true }, ...args);
  return {
    manager, win, views, logs, handlers, api,
    action: (input) => invoke(api.BROWSER_ACTION_CHANNEL, input),
    viewport: (visible, rect = bounds) => invoke(api.BROWSER_VIEWPORT_CHANNEL, rect, visible),
    state: () => invoke(api.BROWSER_GET_STATE_CHANNEL),
  };
}

test("collapse detaches the native surface but preserves the same live login page", async (t) => {
  const { action, viewport, views, win, logs } = setup(t);
  assert.equal(win.contentView.children.length, 0);
  await action({ action: "navigate", url: "https://login.example.test/" });
  const page = views[0];
  viewport(true);
  assert.deepEqual(win.contentView.children, [page]);
  assert.equal(page.visible, true);
  viewport(false, { x: 0, y: 0, width: 0, height: 0 });
  assert.equal(win.contentView.children.length, 0);
  assert.equal(page.visible, false);
  assert.equal(page.webContents.closeCount, 0);
  assert.equal(page.webContents.loads.length, 1);
  viewport(true);
  assert.deepEqual(win.contentView.children, [page]);
  assert.equal(page.webContents.loads.length, 1, "reopen must not reload login state");
  assert.equal(JSON.stringify(logs).includes("login.example.test"), false);
});

test("navigation and managed login popups cannot reopen a collapsed panel", async (t) => {
  const { action, viewport, views, win, state } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  viewport(true);
  viewport(false);
  await views[0].webContents.loadURL("https://account.example.test/redirect");
  const response = views[0].webContents.openWindow({ url: "https://account.example.test/popup" });
  assert.equal(response.action, "deny");
  assert.equal(state().tabs.length, 2);
  assert.equal(win.contentView.children.length, 0);
  assert.equal(views.every((view) => !view.visible), true);
  viewport(true);
  assert.deepEqual(win.contentView.children, [views[1]]);
});

test("minimize hides every native view and delayed resize cannot restore it", async (t) => {
  const { action, viewport, views, win } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  viewport(true);
  win.minimized = true;
  win.emit("minimize");
  viewport(true);
  await views[0].webContents.loadURL("https://login.example.test/redirect");
  assert.equal(win.contentView.children.length, 0);
  win.minimized = false;
  win.emit("restore");
  assert.deepEqual(win.contentView.children, [views[0]]);
  viewport(false);
  win.minimized = true;
  win.emit("minimize");
  win.minimized = false;
  win.emit("restore");
  assert.equal(win.contentView.children.length, 0, "restore respects a collapsed panel");
});

test("window hide/show respects the latest panel visibility", async (t) => {
  const { action, viewport, win } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  viewport(true);
  win.visible = false;
  win.emit("hide");
  viewport(true);
  assert.equal(win.contentView.children.length, 0);
  win.visible = true;
  win.emit("show");
  assert.equal(win.contentView.children.length, 1);
  viewport(false);
  win.emit("show");
  assert.equal(win.contentView.children.length, 0);
});

test("tab and session switches attach only the selected page; background Agent work stays hidden", async (t) => {
  const { action, viewport, views, win, state, manager } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  const firstTab = state().activeTabId;
  await action({ action: "new_tab", url: "https://login.example.test/second" });
  viewport(true);
  assert.deepEqual(win.contentView.children, [views[1]]);
  await action({ action: "switch_tab", tabId: firstTab });
  assert.deepEqual(win.contentView.children, [views[0]]);
  await manager.performAgentAction("background-session", { action: "open", url: "https://agent.example.test/" });
  assert.deepEqual(win.contentView.children, [views[0]]);
  viewport(false);
  await action({ action: "set_session", sessionId: "background-session" });
  await manager.performAgentAction("background-session", { action: "new_tab", url: "https://agent.example.test/next" });
  assert.equal(win.contentView.children.length, 0);
  viewport(true);
  assert.deepEqual(win.contentView.children, [views.at(-1)]);
});

test("empty and invalid viewport bounds detach instead of leaving a native sliver", async (t) => {
  const { action, viewport, win } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  for (const rect of [
    { ...bounds, width: 0 }, { ...bounds, height: -1 },
    { ...bounds, x: 1300 }, { ...bounds, width: NaN },
  ]) {
    viewport(true);
    assert.equal(win.contentView.children.length, 1);
    assert.equal(viewport(true, rect), false);
    assert.equal(win.contentView.children.length, 0);
  }
});

test("untrusted viewport IPC cannot change visibility", async (t) => {
  const { action, viewport, win, handlers, api } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  const untrusted = (visible) => handlers.get(api.BROWSER_VIEWPORT_CHANNEL)({}, bounds, visible);
  assert.equal(untrusted(true), false);
  assert.equal(win.contentView.children.length, 0);
  viewport(true);
  assert.equal(untrusted(false), false);
  assert.equal(win.contentView.children.length, 1);
});

test("destroy closes attached and retained pages exactly once", async (t) => {
  const { action, viewport, win, views, manager } = setup(t);
  await action({ action: "navigate", url: "https://login.example.test/" });
  await action({ action: "new_tab", url: "https://login.example.test/second" });
  viewport(true);
  manager.destroy();
  manager.destroy();
  assert.equal(win.contentView.children.length, 0);
  assert.equal(views.every((view) => view.webContents.closeCount === 1), true);
  win.emit("hide");
  win.emit("restore");
  assert.equal(win.contentView.children.length, 0);
});
