import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const panel = source.slice(source.indexOf("function createCompanionPanelWindow("), source.indexOf("function syncCompanionPanelShortcut("));
const compiled = ts.transpileModule(panel, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture() {
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.calls = []; this.fullscreen = false; this.visible = false;
      this.webContents = new EventEmitter(); this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }
    isDestroyed() { return this.destroyed ?? false; }
    isMinimized() { return this.minimized ?? false; }
    isMaximized() { return this.maximized ?? false; }
    isFocused() { return this.focused ?? false; }
    isFullScreen() { return this.fullscreen; }
    isVisible() { return this.visible; }
    restore() { this.minimized = false; this.calls.push("restore"); }
    setFullScreen(value) { this.fullscreen = value; this.calls.push("fullscreen"); this.emit(value ? "enter-full-screen" : "leave-full-screen"); }
    show() { this.visible = true; this.calls.push("show"); }
    hide() { this.visible = false; this.focused = false; }
    focus() { this.focused = true; this.calls.push("focus"); }
    async loadURL(url) { this.url = url; }
  }
  const env = {
    BrowserWindow: Window, URL, serverUrl: new URL("http://localhost:30141"), logger: {},
    companionPanelWindow: null, companionPanelKeepVisibleUntilClose: false, companionPanelNativeDialogDepth: 0,
    quitRequested: false, shutdownComplete: false, COMPANION_PANEL_WIDTH: 490, COMPANION_PANEL_HEIGHT: 720,
    screen: { getPrimaryDisplay: () => ({ workArea: { height: 1080 } }) }, brandText: value => value,
    __dirname: "/fixture", join: (...parts) => parts.join("/"), DESKTOP_PARTITION: "fixture", app: { isPackaged: true },
    installRendererDiagnostics() {}, isAllowedAppUrl: () => true,
  };
  runInNewContext(compiled, env);
  return { env, windows };
}

test("first wake enters fullscreen before showing; focus changes do not hide it", () => {
  const { env, windows } = fixture();
  assert.equal(env.showCompanionPanel("clipboard"), true);
  const window = windows[0];
  assert.equal(window.visible, false);
  assert.ok(window.url.endsWith("?tool=clipboard"));
  window.emit("ready-to-show");
  assert.deepEqual(window.calls, ["fullscreen", "show", "focus"]);
  window.emit("blur"); assert.equal(window.visible, true);
  window.setFullScreen(false); window.emit("blur");
  assert.equal(window.visible, false, "normal window retains the existing blur behavior");
});

test("shortcut, closed-to-tray and minimized windows wake fullscreen using the same window", () => {
  const { env, windows } = fixture();
  env.showCompanionPanel(); const window = windows[0]; window.emit("ready-to-show");
  env.toggleCompanionPanel(); assert.equal(window.visible, false);
  window.fullscreen = false;
  env.toggleCompanionPanel(); assert.equal(window.fullscreen, true);
  window.emit("close", { preventDefault() {} }); assert.equal(window.visible, false);
  window.minimized = true; window.fullscreen = false; window.calls = [];
  env.showCompanionPanel();
  assert.deepEqual(window.calls, ["restore", "fullscreen", "show", "focus"]);
  assert.equal(windows.length, 1);
});

test("a late ready event cannot reopen the panel during application shutdown", () => {
  const { env, windows } = fixture();
  env.showCompanionPanel(); env.quitRequested = true;
  windows[0].emit("ready-to-show");
  assert.deepEqual(windows[0].calls, []);
});
