import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const logic = await jiti.import("../desktop/src/browser-agent-logic.ts");
const { createBrowserAgentControl } = await jiti.import("../desktop/src/browser-agent-control.ts");

const {
  ACTIVE_ELEMENT_PASSWORD_SCRIPT,
  AGENT_OFFSCREEN_BOUNDS,
  AUTO_IDLE_MS,
  IDLE_UNLOAD_MS,
  ISOLATED_WORLD_ID,
  EVALUATE_PAGE_CHANGED_ERROR,
  EVALUATE_SENSITIVE_REFUSAL,
  PASSWORD_FOCUS_UNCONFIRMED_ERROR,
  PASSWORD_HINT,
  SENSITIVE_PAGE_HINT,
  REF_LOOKUP_SOURCE,
  REF_NOT_FOUND_ERROR,
  REFS_INVALID_ERROR,
  SNAPSHOT_COLLECT_SCRIPT,
  SCROLL_FUNCTION_SOURCE,
  classifyInputEvent,
  createPendingRequestTable,
  evaluateAllowance,
  focusInvocation,
  formatNavigationToken,
  formatSnapshot,
  isNonFatalNavigationError,
  isPausedAction,
  rejectAgentCreateAtCapacity,
  resolveOwnedTab,
} = logic;

function requestId(n) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

class FakeHost {
  constructor() {
    this.nowMs = 1_000_000;
    this.platform = "linux";
    this.logs = [];
    this.tabs = [];
    this.mainWebContentsId = 7;
    this.shownId = null;
    this.bounds = { x: 12, y: 24, width: 640, height: 480 };
    this.innerWidth = 640;
    this.ops = [];
    this.commands = [];
    this.isolated = [];
    this.captures = [];
    this.listeners = new Map();
    this.throttling = new Map();
    this.attachedDebugger = new Set();
    this.nextId = 1;
    this.hangInput = false;
    this.hangIsolated = false;
    this.emitInputOnSend = false;
    this.snapshot = { title: "Page", url: "https://example.test/", nodes: [], truncated: false, passwordField: false };
    this.capture = { byteLength: 32, base64: "aGk=" };
    this.loadGate = null;
    this.historyGate = null;
    this.loadFailure = null;
    this.focusResult = null;
    this.mainResult = 2;
    this.activePassword = false;
    this.passwordProbe = null;
    this.navigationEpoch = new Map();
  }

  now() { return this.nowMs; }
  log = {
    info: (message, details) => this.logs.push({ level: "info", message, details }),
    warn: (message, details) => this.logs.push({ level: "warn", message, details }),
  };

  listTabs() { return this.tabs.filter((tab) => !tab.removed).map((tab) => ({ ...tab })); }
  createTab(sessionId, url) {
    const tab = {
      id: `tab-${this.nextId++}`,
      sessionId,
      webContentsId: 100 + this.nextId,
      closed: false,
      url,
      title: "Loaded",
      unloaded: false,
      removed: false,
    };
    this.tabs.push(tab);
    this.ops.push(["create", tab.id, url]);
    return { ...tab };
  }
  closeTab(tabId) {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab) tab.removed = true;
    this.ops.push(["close", tabId]);
  }
  loadURL(tabId, url) {
    this.ops.push(["load", tabId, url]);
    const apply = () => {
      const tab = this.tabs.find((candidate) => candidate.id === tabId);
      if (tab) tab.url = url;
    };
    if (this.loadFailure) {
      const error = new Error(this.loadFailure.message || "net::ERR_FAILED");
      if (this.loadFailure.errorCode !== undefined) error.errorCode = this.loadFailure.errorCode;
      if (this.loadFailure.code !== undefined) error.code = this.loadFailure.code;
      if (this.loadFailure.commit) apply();
      return Promise.reject(error);
    }
    apply();
    if (this.loadGate) return this.loadGate;
    return Promise.resolve();
  }
  goBack(tabId) {
    this.ops.push(["back", tabId]);
    if (this.historyGate) return this.historyGate;
    return Promise.resolve();
  }
  goForward(tabId) {
    this.ops.push(["forward", tabId]);
    if (this.historyGate) return this.historyGate;
    return Promise.resolve();
  }
  reload(tabId) {
    this.ops.push(["reload", tabId]);
    if (this.historyGate) return this.historyGate;
    return Promise.resolve();
  }
  discardTab(tabId) {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    tab.unloaded = true;
    tab.savedUrl = tab.url;
    this.ops.push(["discard", tabId]);
  }
  async restoreTab(tabId) {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab) {
      tab.unloaded = false;
      tab.url = tab.savedUrl || tab.url;
    }
    this.ops.push(["restore", tabId]);
  }
  isShowing(tabId) { return this.shownId === tabId; }
  panelBounds() { return this.bounds ? { ...this.bounds } : null; }
  setBounds(tabId, bounds) { this.ops.push(["bounds", tabId, { ...bounds }]); }
  attach(tabId) { this.ops.push(["attach", tabId]); }
  detach(tabId) { this.ops.push(["detach", tabId]); }
  setBackgroundThrottling(tabId, allowed) {
    this.throttling.set(tabId, allowed);
    this.ops.push(["throttle", tabId, allowed]);
  }
  async capturePage(tabId, options) {
    this.captures.push({ tabId, options });
    this.ops.push(["capture", tabId, { ...options }]);
    return this.capture;
  }
  async executeIsolated(tabId, worldId, code) {
    this.isolated.push({ tabId, worldId, code });
    if (this.hangIsolated) return new Promise(() => {});
    if (code === "document.visibilityState") return "visible";
    if (code === "innerWidth") return this.innerWidth;
    if (code.includes("isPasswordInput")) {
      if (this.passwordProbe?.reject) {
        const error = this.passwordProbe.reject;
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (this.passwordProbe && Object.prototype.hasOwnProperty.call(this.passwordProbe, "value")) return this.passwordProbe.value;
      return { password: this.activePassword === true };
    }
    if (code.includes("function pioraScroll")) return { ok: true, mode: "scrollBy", tag: "div" };
    if (code.includes("target.focus")) return this.focusResult ?? { ok: true, x: 8, y: 9, width: 4, height: 4 };
    if (code.includes("maxNodes")) return this.snapshot;
    return { ok: true };
  }
  debuggerAttach(tabId, version) {
    if (this.attachedDebugger.has(tabId)) throw new Error("Debugger is already attached");
    this.attachedDebugger.add(tabId);
    this.ops.push(["attach-debugger", tabId, version]);
  }
  debuggerDetach(tabId) {
    this.attachedDebugger.delete(tabId);
    this.ops.push(["detach-debugger", tabId]);
  }
  debuggerIsAttached(tabId) { return this.attachedDebugger.has(tabId); }
  debuggerSend(tabId, method, params) {
    this.commands.push({ tabId, method, params });
    if (this.emitInputOnSend && String(method).startsWith("Input.")) this.emit(tabId, "input-event", { type: "mouseDown" });
    if (this.hangInput && String(method).startsWith("Input.")) return new Promise(() => {});
    return Promise.resolve({});
  }
  onTabEvent(tabId, event, handler) {
    const key = `${tabId}:${event}`;
    const list = this.listeners.get(key) ?? [];
    list.push(handler);
    this.listeners.set(key, list);
    return () => {
      const current = this.listeners.get(key) ?? [];
      this.listeners.set(key, current.filter((item) => item !== handler));
    };
  }
  emit(tabId, event, payload) {
    for (const handler of this.listeners.get(`${tabId}:${event}`) ?? []) handler(payload);
  }
  async executeMain(tabId, code) {
    this.ops.push(["eval", tabId, code]);
    return this.mainResult;
  }
  navigationToken(tabId) {
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    return formatNavigationToken(this.navigationEpoch.get(tabId) ?? 0, tab?.url ?? "");
  }
  bumpNavigation(tabId) {
    this.navigationEpoch.set(tabId, (this.navigationEpoch.get(tabId) ?? 0) + 1);
  }
  activateSessionTab(sessionId, tabId) {
    this.ops.push(["activate", sessionId, tabId]);
  }
  pushActivity(activity) { this.ops.push(["activity", activity]); }
}

function setup(t, options = {}) {
  const host = new FakeHost();
  const control = createBrowserAgentControl(host, { cdpTimeoutMs: 40, requestTimeoutMs: 200, ...options });
  t.after(() => control.destroy());
  let n = 0;
  const call = (action, extra = {}, sessionId = "session-a") => {
    n += 1;
    return control.handleRequest({
      type: "pi-desktop:browser-agent-request",
      requestId: requestId(n),
      sessionId,
      action,
      ...extra,
    });
  };
  return { host, control, call };
}

test("pending requests time out, cancel, and fail together when the server exits", () => {
  const timers = new Map();
  let next = 1;
  const table = createPendingRequestTable({
    timeoutMs: 25,
    setTimer: (fn) => {
      const id = next;
      next += 1;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
  });
  const timed = new AbortController();
  table.track("a", timed);
  timers.get(1)();
  assert.equal(timed.signal.aborted, true);
  assert.match(String(timed.signal.reason), /timed out/);
  assert.equal(table.has("a"), false);

  const cancelled = new AbortController();
  table.track("b", cancelled);
  assert.equal(table.cancel("b"), true);
  assert.match(String(cancelled.signal.reason), /aborted/);
  assert.equal(table.cancel("missing"), false);

  const alive = new AbortController();
  table.track("c", alive);
  table.failAll(new Error("Web server process exited"));
  assert.match(String(alive.signal.reason), /Web server process exited/);
  assert.equal(table.size(), 0);
});

test("input events count as the user only when no agent command is in flight", () => {
  for (const type of ["mouseDown", "rawKeyDown", "keyDown", "char", "mouseWheel", "gestureScrollBegin"]) {
    assert.equal(classifyInputEvent(type, 0), "user");
    assert.equal(classifyInputEvent(type, 1), "ignore");
  }
  assert.equal(classifyInputEvent("mouseMove", 0), "ignore");
  assert.equal(classifyInputEvent("mouseUp", 0), "ignore");
});

test("tab ownership rejects the main window, other sessions, the manual browser, and closed tabs", () => {
  const tabs = [
    { id: "own", sessionId: "session-a", webContentsId: 4, closed: false },
    { id: "other", sessionId: "session-b", webContentsId: 5, closed: false },
    { id: "manual", sessionId: "__piora_browser_manual__", webContentsId: 6, closed: false },
    { id: "main", sessionId: "session-a", webContentsId: 7, closed: false },
    { id: "gone", sessionId: "session-a", webContentsId: 8, closed: true },
  ];
  assert.equal(resolveOwnedTab({ sessionId: "session-a", agentTabId: "own", tabs, mainWebContentsId: 7 }).tab.id, "own");
  assert.match(resolveOwnedTab({ sessionId: "session-a", requestedTabId: "other", tabs, mainWebContentsId: 7 }).error, /another session/);
  assert.match(resolveOwnedTab({ sessionId: "session-a", requestedTabId: "main", tabs, mainWebContentsId: 7 }).error, /main window/);
  assert.match(resolveOwnedTab({ sessionId: "session-a", requestedTabId: "manual", tabs, mainWebContentsId: 7 }).error, /manual browser/);
  assert.match(resolveOwnedTab({ sessionId: "__piora_browser_manual__", tabs, mainWebContentsId: 7 }).error, /manual browser/);
  assert.match(resolveOwnedTab({ sessionId: "session-a", requestedTabId: "gone", tabs, mainWebContentsId: 7 }).error, /closed/);
  assert.match(resolveOwnedTab({ sessionId: "session-a", tabs, mainWebContentsId: 7 }).error, /Open a page first/);
});

test("password values never appear in a snapshot and a hint is appended", () => {
  const secret = "p@ss-should-not-leak";
  const text = formatSnapshot({
    title: "Login",
    url: "https://example.test/login",
    nodes: [
      { ref: "e1", tag: "input", type: "password", password: true, name: secret, value: secret },
      { ref: "e2", tag: "button", role: "button", name: "Sign in" },
    ],
    passwordField: true,
  });
  assert.equal(text.includes(secret), false);
  assert.match(text, /\[e1\] .*type=password — password field/);
  assert.match(text, /\[e2\] button — Sign in/);
  assert.match(text, new RegExp(PASSWORD_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const password = { tagName: "INPUT", attrs: { type: "password" }, value: secret, text: "" };
  const button = { tagName: "BUTTON", attrs: {}, value: "", text: "Sign in" };
  for (const element of [password, button]) {
    element.getAttribute = (name) => element.attrs[name] || "";
    element.setAttribute = (name, value) => { element.attrs[name] = value; };
    element.getBoundingClientRect = () => ({ width: 40, height: 20, top: 0, left: 0, bottom: 20, right: 40 });
    Object.defineProperty(element, "innerText", { get: () => element.text });
  }
  const sandbox = {
    document: { title: "Login", querySelectorAll: () => [password, button] },
    window: { innerWidth: 1280, innerHeight: 800 },
    location: { href: "https://example.test/login" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  };
  const collected = vm.runInNewContext(SNAPSHOT_COLLECT_SCRIPT, sandbox);
  assert.equal(JSON.stringify(collected).includes(secret), false);
  assert.equal(collected.passwordField, true);
  assert.equal(collected.nodes[0].password, true);
  assert.equal(password.attrs["data-piora-ref"], undefined);
  assert.doesNotMatch(SNAPSHOT_COLLECT_SCRIPT, /data-piora-ref/);
  assert.match(SNAPSHOT_COLLECT_SCRIPT, /__pioraRefs/);
  const held = sandbox.__pioraRefs.get("e1");
  assert.equal(typeof held.deref === "function" ? held.deref() : held, password);
  password.attrs["data-piora-ref"] = "e1";
  const replaced = vm.runInNewContext(SNAPSHOT_COLLECT_SCRIPT, sandbox);
  assert.equal(replaced.nodes[0].ref, "e1");
  assert.equal(sandbox.__pioraRefs.get("e9"), undefined);
});

test("scroll script moves the nearest scrollable ancestor instead of the document", () => {
  const make = (tag, style, parent) => {
    const element = {
      nodeType: 1,
      tagName: tag.toUpperCase(),
      parentElement: parent,
      style,
      scrollHeight: style.scrollHeight ?? 0,
      clientHeight: style.clientHeight ?? 0,
      scrollWidth: 0,
      clientWidth: 0,
      scrolled: null,
      intoView: false,
      scrollBy(amount) { this.scrolled = amount; },
      scrollIntoView() { this.intoView = true; },
    };
    return element;
  };
  const root = make("html", {}, null);
  const body = make("body", {}, root);
  const scroller = make("div", { overflowY: "auto", scrollHeight: 800, clientHeight: 100 }, body);
  const target = make("button", {}, scroller);
  target.attrs = { "data-piora-ref": "forged" };
  target.isConnected = true;
  const decoy = make("a", {}, body);
  decoy.attrs = { "data-piora-ref": "e4" };
  const document = {
    documentElement: root,
    body,
    scrollingElement: root,
    elementFromPoint: () => target,
    querySelector: (selector) => (selector.includes("e4") ? decoy : null),
  };
  const refs = new Map([["e4", { deref: () => target }]]);
  const context = { document, getComputedStyle: (element) => element.style, __pioraRefs: refs, result: null };
  const source = `${REF_LOOKUP_SOURCE}\n${SCROLL_FUNCTION_SOURCE}`;
  vm.runInNewContext(`${source}\nresult = pioraScroll({ x: 4, y: 4, deltaX: 0, deltaY: 50 });`, context);
  assert.equal(context.result.mode, "scrollBy");
  assert.equal(context.result.tag, "div");
  assert.equal(scroller.scrolled.left, 0);
  assert.equal(scroller.scrolled.top, 50);
  assert.equal(scroller.scrolled.behavior, "instant");
  assert.equal(root.scrolled, null);
  vm.runInNewContext(`${source}\nresult = pioraScroll({ ref: "e4", intoView: true });`, context);
  assert.equal(context.result.mode, "intoView");
  assert.equal(target.intoView, true);
  assert.equal(decoy.intoView, false);
  target.isConnected = false;
  vm.runInNewContext(`${source}\nresult = pioraScroll({ ref: "e4", intoView: true });`, context);
  assert.equal(context.result.ok, false);
  assert.equal(context.result.error, REF_NOT_FOUND_ERROR);
  assert.doesNotMatch(source, /data-piora-ref/);
});

test("the hidden agent tab stays attached offscreen and only that tab skips throttling", async (t) => {
  const { host, control, call } = setup(t);
  host.createTab("session-a", "https://user.test/");
  const userTab = host.tabs[0].id;
  const opened = await call("open", { url: "https://example.test/start" });
  assert.equal(opened.ok, true);
  const agentTab = opened.value.tabId;
  assert.notEqual(agentTab, userTab);
  assert.equal(control.agentTabId("session-a"), agentTab);
  assert.deepEqual(host.ops.filter((op) => op[0] === "bounds").at(-1)[2], { ...AGENT_OFFSCREEN_BOUNDS });
  assert.equal(host.ops.some((op) => op[0] === "attach" && op[1] === agentTab), true);
  assert.equal(host.throttling.get(agentTab), false);
  assert.equal(host.throttling.has(userTab), false);
  assert.equal(host.commands.some((command) => command.method === "Emulation.setDeviceMetricsOverride" && command.tabId === agentTab && command.params.width === 1280 && command.params.height === 800 && command.params.deviceScaleFactor === 1 && command.params.mobile === false), true);
  assert.equal(host.commands.some((command) => command.tabId === userTab), false);
  const selfCheck = host.logs.filter((entry) => String(entry.message).includes("[browser-agent] offscreen-selfcheck"));
  assert.equal(selfCheck.length, 1);
  assert.match(selfCheck[0].message, /platform=linux/);
  assert.match(selfCheck[0].message, /visibilityState=visible/);
  assert.match(selfCheck[0].message, /image=32/);
  assert.equal(host.captures.every((capture) => capture.options.stayHidden === true && capture.options.stayAwake === true), true);
  await call("snapshot");
  assert.equal(host.logs.filter((entry) => String(entry.message).includes("offscreen-selfcheck")).length, 1, "self-check runs once per tab");
  assert.equal(host.throttling.get(userTab) === false, false);
});

test("showing the agent tab clears the device override and verifies innerWidth", async (t) => {
  const { host, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/start" });
  const agentTab = opened.value.tabId;
  host.ops.length = 0;
  host.commands.length = 0;
  host.shownId = agentTab;
  host.innerWidth = 639;
  await call("snapshot");
  const bounds = host.ops.filter((op) => op[0] === "bounds").map((op) => op[2]);
  assert.deepEqual(bounds[0], host.bounds);
  assert.equal(bounds.some((rect) => rect.width === host.bounds.width + 1), true);
  assert.deepEqual(bounds.at(-1), host.bounds);
  assert.equal(host.commands.some((command) => command.method === "Emulation.clearDeviceMetricsOverride"), true);
  assert.equal(host.isolated.some((callInfo) => callInfo.code === "innerWidth" && callInfo.worldId === ISOLATED_WORLD_ID), true);
  assert.equal(host.throttling.get(agentTab), true);
  host.ops.length = 0;
  host.commands.length = 0;
  host.innerWidth = 640;
  await call("press", { key: "Enter" });
  assert.equal(host.commands.some((command) => command.method === "Emulation.clearDeviceMetricsOverride"), false);
  host.shownId = null;
  await call("press", { key: "Tab" });
  assert.deepEqual(host.ops.filter((op) => op[0] === "bounds").at(-1)[2], { ...AGENT_OFFSCREEN_BOUNDS });
  assert.equal(host.throttling.get(agentTab), false);
  assert.equal(host.commands.some((command) => command.method === "Emulation.setDeviceMetricsOverride"), true);
});

test("switching tabs or ending the turn restores throttling on the previous agent tab", async (t) => {
  const { host, control, call } = setup(t);
  const first = await call("open", { url: "https://example.test/one" });
  const firstId = first.value.tabId;
  const second = await call("new_tab", { url: "https://example.test/two" });
  assert.equal(control.agentTabId("session-a"), second.value.tabId);
  assert.notEqual(second.value.tabId, firstId);
  assert.equal(host.throttling.get(firstId), true);
  assert.equal(host.ops.some((op) => op[0] === "detach" && op[1] === firstId), true);
  assert.equal(host.commands.some((command) => command.tabId === firstId && command.method === "Emulation.clearDeviceMetricsOverride"), true);
  assert.equal(host.throttling.get(second.value.tabId), false);
  await call("idle");
  assert.equal(host.throttling.get(second.value.tabId), true);
  assert.equal(control.status("session-a").operating, false);
  assert.deepEqual(control.heldTabs(), []);
});

test("the agent tab stays independent of the tab the user is looking at", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  const userTab = host.createTab("session-a", "https://user.test/").id;
  host.shownId = userTab;
  const shot = await call("snapshot");
  assert.equal(shot.value.tabId, agentTab);
  assert.equal(host.isolated.at(-1).tabId, agentTab);
  assert.equal(control.agentTabId("session-a"), agentTab);
  const routed = await call("snapshot", { tabId: userTab });
  assert.equal(routed.value.tabId, userTab);
  assert.equal(control.agentTabId("session-a"), agentTab);
  const hidden = host.createTab("session-a", "https://hidden.test/");
  const extra = await call("snapshot", { tabId: hidden.id });
  assert.equal(extra.value.tabId, hidden.id);
  assert.equal(control.agentTabId("session-a"), agentTab);
  assert.equal(host.throttling.get(agentTab), false);
  assert.equal(host.throttling.get(hidden.id), true);
  assert.equal(control.heldTabs().some((entry) => entry.id === hidden.id), false);
  const switched = await call("switch_tab", { tabId: userTab });
  assert.equal(switched.ok, true);
  assert.equal(control.agentTabId("session-a"), userTab);
});

test("closed tabs, foreign tabs, and the manual session are refused", async (t) => {
  const { host, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  host.createTab("session-b", "https://other.test/");
  const foreign = host.tabs.find((tab) => tab.sessionId === "session-b");
  const other = await call("click", { tabId: foreign.id, ref: "e1" });
  assert.equal(other.ok, false);
  assert.match(other.error, /another session/);
  host.tabs.push({ id: "main-tab", sessionId: "session-a", webContentsId: host.mainWebContentsId, closed: false, url: "https://app.test/", title: "App", unloaded: false, removed: false });
  const mainWindow = await call("click", { tabId: "main-tab", ref: "e1" });
  assert.match(mainWindow.error, /main window/);
  const manual = await call("open", { url: "https://example.test/" }, "__piora_browser_manual__");
  assert.match(manual.error, /manual browser/);
  host.closeTab(agentTab);
  const closed = await call("snapshot", { tabId: agentTab });
  assert.match(closed.error, /closed/);
});

test("evaluate is disabled and a user pause blocks input until resume", async (t) => {
  const { control, call } = setup(t);
  await call("open", { url: "https://example.test/agent" });
  const evaluate = await call("evaluate", { text: "1+1" });
  assert.match(evaluate.error, /needs user confirmation/);
  control.pauseSession("session-a");
  const paused = await call("click", { ref: "e1" });
  assert.match(paused.error, /paused by user/);
  const reading = await call("snapshot");
  assert.equal(reading.ok, true);
  control.resumeSession("session-a");
  const resumed = await call("press", { key: "Enter" });
  assert.equal(resumed.ok, true);
});

test("screenshots use capturePage and scroll uses the isolated-world script", async (t) => {
  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/agent" });
  host.commands.length = 0;
  host.isolated.length = 0;
  const image = await call("screenshot");
  assert.equal(image.ok, true);
  assert.equal(image.value.imageBase64, "aGk=");
  assert.equal(host.captures.at(-1).options.stayHidden, true);
  assert.equal(host.captures.at(-1).options.stayAwake, true);
  assert.equal(host.commands.some((command) => command.method === "Page.captureScreenshot"), false);
  const scrolled = await call("scroll", { ref: "e2", deltaY: 180 });
  assert.equal(scrolled.ok, true);
  const script = host.isolated.at(-1);
  assert.equal(script.worldId, ISOLATED_WORLD_ID);
  assert.match(script.code, /function pioraScroll/);
  assert.match(script.code, /overflowY/);
  assert.match(script.code, /elementFromPoint/);
  assert.match(script.code, /__pioraRefs/);
  assert.doesNotMatch(script.code, /data-piora-ref/);
  assert.equal(host.commands.some((command) => /mouseWheel|dispatchMouseEvent/i.test(command.method)), false);
  const clicked = await call("click", { x: 3, y: 4 });
  const mouse = host.commands.filter((command) => command.method === "Input.dispatchMouseEvent").map((command) => command.params.type);
  assert.deepEqual(mouse.slice(-3), ["mouseMoved", "mousePressed", "mouseReleased"]);
  assert.equal(clicked.ok, true);
});

test("agent commands do not pause themselves, and a later user click does", async (t) => {
  const { host, control, call } = setup(t);
  host.emitInputOnSend = true;
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  const clicked = await call("click", { ref: "e1" });
  assert.equal(clicked.ok, true);
  assert.equal(control.isPaused("session-a"), false);
  assert.equal(control.inFlight(agentTab), 0);
  host.emit(agentTab, "input-event", { type: "mouseMove" });
  assert.equal(control.isPaused("session-a"), false);
  host.emit(agentTab, "input-event", { type: "mouseDown" });
  assert.equal(control.isPaused("session-a"), true);
});

test("a crashed or timed-out command clears the in-flight counter before the next user click", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  host.hangInput = true;
  const crashed = call("click", { ref: "e1" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(control.inFlight(agentTab) > 0, true);
  host.emit(agentTab, "render-process-gone");
  const crashedResult = await crashed;
  assert.match(crashedResult.error, /crashed/);
  assert.equal(control.inFlight(agentTab), 0);
  host.emit(agentTab, "input-event", { type: "mouseDown" });
  assert.equal(control.isPaused("session-a"), true);

  const second = setup(t);
  const openedAgain = await second.call("open", { url: "https://example.test/agent" });
  second.host.hangInput = true;
  const timed = await second.call("type", { text: "hi" });
  assert.match(timed.error, /timed out/);
  assert.equal(second.control.inFlight(openedAgain.value.tabId), 0);
  second.host.emit(openedAgain.value.tabId, "input-event", { type: "keyDown" });
  assert.equal(second.control.isPaused("session-a"), true);
});

test("detach reports a closed tab and a session close detaches every tab", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/one" });
  await call("new_tab", { url: "https://example.test/two" });
  host.hangInput = true;
  const pending = call("press", { key: "a" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  host.emit(opened.value.tabId, "debugger-detach");
  const detached = await pending;
  assert.match(detached.error, /closed|timed out|Unsupported/);
  const closed = await call("session_closed");
  assert.equal(closed.ok, true);
  assert.equal(control.agentTabId("session-a"), null);
  assert.equal(host.tabs.filter((tab) => tab.sessionId === "session-a" && !tab.removed).length, 0);
  assert.equal(host.ops.filter((op) => op[0] === "detach-debugger").length >= 1, true);
});

test("a session can open at most five agent tabs", async (t) => {
  const { call } = setup(t);
  for (let index = 0; index < 5; index += 1) {
    const opened = await call("new_tab", { url: `https://example.test/${index}` });
    assert.equal(opened.ok, true, opened.error);
  }
  const blocked = await call("new_tab", { url: "https://example.test/extra" });
  assert.match(blocked.error, /Close unused tabs/);
});

test("an idle tab is discarded and the next interaction asks for a new snapshot", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/keep" });
  await call("idle");
  const unloaded = control.sweepIdle(host.nowMs + IDLE_UNLOAD_MS + 5);
  assert.deepEqual(unloaded, [opened.value.tabId]);
  const clicked = await call("click", { ref: "e1" });
  assert.equal(clicked.ok, false);
  assert.equal(clicked.error, REFS_INVALID_ERROR);
  host.snapshot = {
    title: "Reloaded",
    url: "https://example.test/keep",
    nodes: [{ ref: "e1", tag: "button", role: "button", name: "Go" }],
    truncated: false,
    passwordField: false,
  };
  const snapshot = await call("snapshot");
  assert.match(snapshot.value.text, /reloaded/);
  assert.match(snapshot.value.text, /\[e1\] button — Go/);
  const after = await call("click", { ref: "e1" });
  assert.equal(after.ok, true);
});

test("cancel and server restart fail the in-flight desktop request", async (t) => {
  const { host, control } = setup(t);
  const opened = await control.handleRequest({
    type: "pi-desktop:browser-agent-request",
    requestId: requestId(1),
    sessionId: "session-a",
    action: "open",
    url: "https://example.test/start",
  });
  assert.equal(opened.ok, true);
  let release = () => {};
  host.loadGate = new Promise((resolve) => { release = resolve; });
  const pending = control.handleRequest({
    type: "pi-desktop:browser-agent-request",
    requestId: requestId(2),
    sessionId: "session-a",
    action: "open",
    url: "https://example.test/next",
  });
  control.cancel(requestId(2));
  const cancelled = await pending;
  assert.match(cancelled.error, /aborted/);
  release();
  host.loadGate = new Promise(() => {});
  const restart = control.handleRequest({
    type: "pi-desktop:browser-agent-request",
    requestId: requestId(3),
    sessionId: "session-a",
    action: "open",
    url: "https://example.test/later",
  });
  control.failAll("Web server process exited");
  const failed = await restart;
  assert.match(failed.error, /Web server process exited/);
});

test("a desktop snapshot redacts password fields returned by the page", async (t) => {
  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/login" });
  const secret = "hunter2-secret";
  host.snapshot = {
    title: "Login",
    url: "https://example.test/login",
    nodes: [{ ref: "e1", tag: "input", type: "password", password: true, name: secret, value: secret }],
    truncated: false,
    passwordField: true,
  };
  const snapshot = await call("snapshot");
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.value.text.includes(secret), false);
  assert.match(snapshot.value.text, /password field/);
  assert.match(snapshot.value.text, /wait_for_user/);
  assert.equal(snapshot.value.text.includes(SENSITIVE_PAGE_HINT), false);
});

test("focus script reports a password field and typing into one is refused", async (t) => {
  const input = {
    nodeType: 1,
    isConnected: true,
    attrs: { type: "password" },
    value: "secret-value",
    focused: false,
    selected: false,
    getAttribute(name) { return this.attrs[name] || ""; },
    focus() { this.focused = true; },
    select() { this.selected = true; },
    getBoundingClientRect: () => ({ left: 2, top: 4, width: 10, height: 8 }),
  };
  const sandbox = {
    document: { querySelector: () => null },
    __pioraRefs: new Map([["e1", { deref: () => input }]]),
    result: null,
  };
  vm.runInNewContext(`result = ${focusInvocation({ ref: "e1" })}`, sandbox);
  assert.equal(sandbox.result.password, true);
  assert.equal(sandbox.result.type, "password");
  assert.equal(input.focused, true);
  assert.equal(input.selected, false);
  assert.equal(JSON.stringify(sandbox.result).includes("secret-value"), false);
  assert.doesNotMatch(focusInvocation({ ref: "e1" }), /data-piora-ref/);

  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/login" });
  host.focusResult = { ok: true, x: 1, y: 1, width: 4, height: 4, type: "password", password: true };
  const refused = await call("type", { ref: "e1", text: "secret-value" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /wait_for_user/);
  assert.equal(host.commands.some((command) => command.method === "Input.insertText"), false);
  host.focusResult = { ok: true, x: 1, y: 1, width: 4, height: 4, type: "text", password: false };
  const typed = await call("type", { ref: "e2", text: "hello" });
  assert.equal(typed.ok, true);
  assert.equal(host.commands.some((command) => command.method === "Input.insertText" && command.params.text === "hello"), true);
});

test("user input pauses only while the agent turn is active", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  await call("idle");
  host.emit(agentTab, "input-event", { type: "mouseDown" });
  host.emit(agentTab, "input-event", { type: "keyDown" });
  host.emit(agentTab, "input-event", { type: "mouseWheel" });
  assert.equal(control.isPaused("session-a"), false);
  await call("snapshot");
  host.emit(agentTab, "input-event", { type: "mouseMove" });
  assert.equal(control.isPaused("session-a"), false);
  host.emit(agentTab, "input-event", { type: "mouseDown" });
  assert.equal(control.isPaused("session-a"), true);
});

test("open, history, and reload wait for navigation and surface real load failures", async (t) => {
  assert.equal(isNonFatalNavigationError({ errorCode: -3 }), true);
  assert.equal(isNonFatalNavigationError({ code: "ERR_ABORTED" }), true);
  assert.equal(isNonFatalNavigationError({ message: "ERR_ABORTED (-3) loading 'https://example.test/'" }), true);
  assert.equal(isNonFatalNavigationError({ errorCode: -105 }), false);

  const created = setup(t, { navigationTimeoutMs: 40, requestTimeoutMs: 500 });
  let releaseLoad = () => {};
  created.host.loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let createdDone = false;
  const creating = created.call("new_tab", { url: "https://example.test/fresh" }).then((result) => {
    createdDone = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(createdDone, false);
  const freshId = created.host.tabs.at(-1).id;
  assert.equal(created.host.tabs.find((tab) => tab.id === freshId).url, "https://example.test/fresh");
  releaseLoad();
  const createdResult = await creating;
  assert.equal(createdResult.ok, true);
  assert.equal(createdResult.value.tabId, freshId);

  const existing = setup(t, { navigationTimeoutMs: 40, requestTimeoutMs: 500 });
  const first = await existing.call("open", { url: "https://example.test/first" });
  let releaseExisting = () => {};
  existing.host.loadGate = new Promise((resolve) => { releaseExisting = resolve; });
  let existingDone = false;
  const reopening = existing.call("open", { url: "https://example.test/second" }).then((result) => {
    existingDone = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(existingDone, false);
  assert.equal(existing.host.ops.filter((op) => op[0] === "load" && op[1] === first.value.tabId).length >= 2, true);
  releaseExisting();
  const reopened = await reopening;
  assert.equal(reopened.ok, true);
  assert.equal(reopened.value.url, "https://example.test/second");

  const aborted = setup(t);
  await aborted.call("open", { url: "https://example.test/start" });
  aborted.host.loadFailure = { message: "ERR_ABORTED (-3) loading 'https://example.test/next'", errorCode: -3, commit: true };
  const redirected = await aborted.call("open", { url: "https://example.test/next" });
  assert.equal(redirected.ok, true, redirected.error);

  const failed = setup(t);
  await failed.call("open", { url: "https://example.test/start" });
  failed.host.loadFailure = { message: "ERR_NAME_NOT_RESOLVED (-105) loading 'https://missing.test/'", errorCode: -105 };
  const missing = await failed.call("open", { url: "https://missing.test/" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Page failed to load/);
  assert.match(missing.error, /-105|ERR_NAME_NOT_RESOLVED/);

  const history = setup(t);
  const opened = await history.call("open", { url: "https://example.test/start" });
  let releaseHistory = () => {};
  history.host.historyGate = new Promise((resolve) => { releaseHistory = resolve; });
  let historyDone = false;
  const goingBack = history.call("back").then((result) => {
    historyDone = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(historyDone, false);
  assert.equal(history.host.ops.some((op) => op[0] === "back" && op[1] === opened.value.tabId), true);
  releaseHistory();
  const backed = await goingBack;
  assert.equal(backed.ok, true);
  history.host.historyGate = Promise.resolve();
  const forwarded = await history.call("forward");
  const reloaded = await history.call("reload");
  assert.equal(forwarded.ok, true);
  assert.equal(reloaded.ok, true);
  assert.match(reloaded.value.text, /reloaded|invalid/i);

  const timed = setup(t, { navigationTimeoutMs: 30, requestTimeoutMs: 500 });
  await timed.call("open", { url: "https://example.test/start" });
  timed.host.loadGate = new Promise(() => {});
  const timeout = await timed.call("open", { url: "https://example.test/slow" });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /timed out/);
});

test("a hanging isolated script is rejected when the renderer crashes and the next click can pause", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  const agentTab = opened.value.tabId;
  host.hangIsolated = true;
  const pending = call("snapshot");
  await new Promise((resolve) => setTimeout(resolve, 15));
  host.emit(agentTab, "render-process-gone");
  const crashed = await pending;
  assert.match(crashed.error, /crashed/);
  assert.equal(control.inFlight(agentTab), 0);
  host.hangIsolated = false;
  host.emit(agentTab, "input-event", { type: "mouseDown" });
  assert.equal(control.isPaused("session-a"), true);
});

test("a sensitive page hints at wait_for_user without blocking the snapshot", async (t) => {
  const { host, call } = setup(t);
  await call("open", { url: "https://shop.test/checkout" });
  host.snapshot = {
    title: "Checkout",
    url: "https://shop.test/checkout",
    nodes: [{ ref: "e1", tag: "button", role: "button", name: "Pay" }],
    truncated: false,
    passwordField: false,
    visibleText: "Payment and billing",
  };
  const snapshot = await call("snapshot");
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.value.text, /\[e1\] button — Pay/);
  assert.match(snapshot.value.text, new RegExp(SENSITIVE_PAGE_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("waiting rejects other actions, ignores user input, and invalidates refs when it ends", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/login" });
  const began = await call("wait_begin", { reason: "Sign in to the account" });
  assert.equal(began.ok, true);
  assert.equal(host.ops.some((op) => op[0] === "activate" && op[1] === "session-a" && op[2] === opened.value.tabId), true);
  const activity = host.ops.filter((op) => op[0] === "activity").at(-1)[1];
  assert.equal(activity.waiting, true);
  assert.equal(activity.reason, "Sign in to the account");
  const idleDuringWait = await call("idle");
  assert.match(idleDuringWait.error, /waiting for the user/);
  host.nowMs += IDLE_UNLOAD_MS + 5;
  assert.deepEqual(control.sweepIdle(), []);
  assert.equal(host.tabs.find((tab) => tab.id === opened.value.tabId).unloaded, false);
  const blocked = await call("snapshot");
  assert.match(blocked.error, /waiting for the user/);
  const script = await call("evaluate", { text: "1", confirmed: true });
  assert.match(script.error, /waiting for the user/);
  host.emit(opened.value.tabId, "input-event", { type: "mouseDown" });
  host.emit(opened.value.tabId, "input-event", { type: "keyDown" });
  assert.equal(control.isPaused("session-a"), false);
  const ended = await call("wait_end");
  assert.equal(ended.ok, true);
  const stale = await call("click", { ref: "e1" });
  assert.equal(stale.error, REFS_INVALID_ERROR);
  host.emit(opened.value.tabId, "input-event", { type: "mouseDown" });
  assert.equal(control.isPaused("session-a"), true);
});

test("a wait after the turn ends still keeps the agent tab loaded", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/login" });
  await call("idle");
  const began = await call("wait_begin", { reason: "Sign in" });
  assert.equal(began.ok, true);
  host.nowMs += IDLE_UNLOAD_MS + 5;
  assert.deepEqual(control.sweepIdle(), []);
  assert.equal(host.tabs.find((tab) => tab.id === opened.value.tabId).unloaded, false);
  await call("wait_end");
});

test("desktop evaluate runs in the page only after confirmation", async (t) => {
  const { host, control, call } = setup(t);
  await call("open", { url: "https://example.test/app" });
  const denied = await call("evaluate", { text: "1+1" });
  assert.match(denied.error, /needs user confirmation/);
  assert.equal(host.ops.some((op) => op[0] === "eval"), false);
  const check = await call("evaluate_check");
  assert.equal(check.ok, true, check.error);
  assert.equal(check.value.allowed, true);
  const allowed = await call("evaluate", { text: "1+1", confirmed: true, navigationToken: check.value.navigationToken });
  assert.equal(allowed.ok, true, allowed.error);
  assert.equal(allowed.value.text, "2");
  assert.equal(host.ops.some((op) => op[0] === "eval" && op[2] === "1+1"), true);
  control.pauseSession("session-a");
  const paused = await call("evaluate", { text: "1", confirmed: true, navigationToken: check.value.navigationToken });
  assert.match(paused.error, /paused by user/);
  const pausedCheck = await call("evaluate_check");
  assert.equal(pausedCheck.ok, true, pausedCheck.error);
});

test("evaluate is refused on password and sensitive pages, and when the document changes before it runs", async (t) => {
  assert.equal(isPausedAction("evaluate"), true);
  assert.equal(isPausedAction("evaluate_check"), false);
  assert.deepEqual(
    evaluateAllowance({ passwordField: true, url: "https://example.test/welcome", title: "Welcome", visibleText: "hello" }),
    { allowed: false, reason: EVALUATE_SENSITIVE_REFUSAL },
  );
  assert.equal(evaluateAllowance({ passwordField: false, url: "https://shop.test/cart", title: "Cart", visibleText: "Payment and billing" }).allowed, false);
  assert.equal(evaluateAllowance({ passwordField: false, url: "https://example.test/settings", title: "账号安全", visibleText: "email" }).allowed, false);
  assert.equal(evaluateAllowance({ passwordField: false, url: "https://id.example/sign-in", title: "Hi", visibleText: "docs" }).allowed, false);
  assert.deepEqual(
    evaluateAllowance({ passwordField: false, url: "https://example.test/docs", title: "Docs", visibleText: "hello" }),
    { allowed: true },
  );
  assert.notEqual(formatNavigationToken(1, "https://example.test/a"), formatNavigationToken(2, "https://example.test/a"));
  assert.notEqual(formatNavigationToken(1, "https://example.test/a"), formatNavigationToken(1, "https://example.test/b"));

  const managerSource = readFileSync(new URL("../desktop/src/browser-manager.ts", import.meta.url), "utf8");
  const startNav = managerSource.slice(managerSource.indexOf('contents.on("did-start-navigation"'), managerSource.indexOf("contents.setWindowOpenHandler"));
  assert.match(startNav, /if \(isMainFrame\) this\.noteMainFrameNavigation\(tab\)/);
  const didNavigate = managerSource.slice(managerSource.indexOf('contents.on("did-navigate"'), managerSource.indexOf('contents.on("did-navigate-in-page"'));
  assert.match(didNavigate, /this\.noteMainFrameNavigation\(tab\)/);
  const inPage = managerSource.slice(managerSource.indexOf('contents.on("did-navigate-in-page"'), managerSource.indexOf('contents.on("did-fail-load"'));
  assert.match(inPage, /isMainFrame === true/);
  assert.match(inPage, /noteMainFrameNavigation/);
  assert.match(managerSource.slice(managerSource.indexOf("createAgentHost()")), /navigationToken:/);

  const { host, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/app" });
  const tabId = opened.value.tabId;
  const evalCount = () => host.ops.filter((op) => op[0] === "eval").length;

  host.snapshot = {
    title: "Welcome",
    url: "https://example.test/welcome",
    nodes: [],
    truncated: false,
    passwordField: true,
    visibleText: "hello",
  };
  const password = await call("evaluate_check");
  assert.equal(password.ok, true, password.error);
  assert.equal(password.value.allowed, false);
  assert.equal(password.value.reason, EVALUATE_SENSITIVE_REFUSAL);
  assert.equal(password.value.tabId, tabId);
  assert.equal(password.value.url, "https://example.test/welcome");
  assert.equal(typeof password.value.navigationToken, "string");
  assert.match(host.isolated.at(-1).code, /passwordField/);
  assert.match(host.isolated.at(-1).code, /maxNodes/);
  assert.equal(host.isolated.at(-1).worldId, ISOLATED_WORLD_ID);
  const forced = await call("evaluate", { text: "document.cookie", confirmed: true, navigationToken: password.value.navigationToken });
  assert.equal(forced.ok, false);
  assert.equal(forced.error, EVALUATE_SENSITIVE_REFUSAL);
  assert.equal(evalCount(), 0);

  host.snapshot = {
    title: "Cart",
    url: "https://shop.test/cart",
    nodes: [],
    truncated: false,
    passwordField: false,
    visibleText: "Payment and billing",
  };
  const payment = await call("evaluate_check");
  assert.equal(payment.value.allowed, false);
  assert.equal(payment.value.reason, EVALUATE_SENSITIVE_REFUSAL);
  host.snapshot = {
    title: "账号安全",
    url: "https://example.test/settings",
    nodes: [],
    truncated: false,
    passwordField: false,
    visibleText: "email",
  };
  const security = await call("evaluate_check");
  assert.equal(security.value.allowed, false);
  assert.equal(security.value.reason, EVALUATE_SENSITIVE_REFUSAL);
  assert.equal(evalCount(), 0);

  host.snapshot = {
    title: "Docs",
    url: "https://example.test/docs",
    nodes: [{ ref: "e1", tag: "a", role: "link", name: "Guide" }],
    truncated: false,
    passwordField: false,
    visibleText: "hello",
  };
  const check = await call("evaluate_check");
  assert.equal(check.value.allowed, true);
  assert.equal(check.value.reason, undefined);
  assert.equal(check.value.url, "https://example.test/docs");
  const issued = check.value.navigationToken;
  const pageUrl = host.tabs.find((tab) => tab.id === tabId).url;

  const missing = await call("evaluate", { text: "1+1", confirmed: true });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, EVALUATE_PAGE_CHANGED_ERROR);
  assert.equal(evalCount(), 0);

  host.snapshot = {
    title: "Welcome",
    url: "https://example.test/welcome",
    nodes: [],
    truncated: false,
    passwordField: true,
    visibleText: "hello",
  };
  const becameSensitive = await call("evaluate", { text: "document.cookie", confirmed: true, navigationToken: issued });
  assert.equal(becameSensitive.ok, false);
  assert.equal(becameSensitive.error, EVALUATE_SENSITIVE_REFUSAL);
  assert.equal(evalCount(), 0);
  host.snapshot = {
    title: "Docs",
    url: "https://example.test/docs",
    nodes: [],
    truncated: false,
    passwordField: false,
    visibleText: "hello",
  };

  host.bumpNavigation(tabId);
  assert.equal(host.tabs.find((tab) => tab.id === tabId).url, pageUrl);
  const sameUrl = await call("evaluate", { text: "1+1", confirmed: true, navigationToken: issued });
  assert.equal(sameUrl.ok, false);
  assert.equal(sameUrl.error, EVALUATE_PAGE_CHANGED_ERROR);
  assert.equal(evalCount(), 0);

  const afterNavigation = await call("evaluate_check");
  assert.equal(afterNavigation.value.allowed, true);
  assert.notEqual(afterNavigation.value.navigationToken, issued);
  const tab = host.tabs.find((candidate) => candidate.id === tabId);
  tab.url = "https://example.test/after";
  const renamed = await call("evaluate", { text: "1+1", confirmed: true, navigationToken: afterNavigation.value.navigationToken });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.error, EVALUATE_PAGE_CHANGED_ERROR);
  assert.equal(evalCount(), 0);

  tab.url = pageUrl;
  const ready = await call("evaluate_check");
  assert.equal(ready.value.allowed, true);
  const ran = await call("evaluate", { text: "1+1", confirmed: true, navigationToken: ready.value.navigationToken });
  assert.equal(ran.ok, true, ran.error);
  assert.equal(ran.value.text, "2");
  assert.equal(evalCount(), 1);
  assert.equal(host.ops.some((op) => op[0] === "eval" && op[2] === "1+1"), true);
});

test("agent tab creation refuses the global tab cap instead of reusing a user tab", () => {
  assert.doesNotThrow(() => rejectAgentCreateAtCapacity(19));
  assert.throws(() => rejectAgentCreateAtCapacity(20), /Close a tab before the agent opens another/);
  const source = readFileSync(new URL("../desktop/src/browser-manager.ts", import.meta.url), "utf8");
  assert.match(source, /rejectAgentCreateAtCapacity\(this\.tabs\.length,\s*MAX_TABS\)/);
  assert.match(source, /deferLoad = false/);
  const agentHost = source.slice(source.indexOf("createAgentHost()"));
  assert.match(agentHost, /rejectAgentCreateAtCapacity\(this\.tabs\.length,\s*MAX_TABS\)/);
  assert.match(agentHost, /this\.createTab\(url, false, sessionId, undefined, true\)/);
});

test("type without a ref refuses a focused password field and sends no insertText", async (t) => {
  const password = { nodeType: 1, tagName: "INPUT", getAttribute: (name) => (name === "type" ? "password" : "") };
  const text = { nodeType: 1, tagName: "INPUT", getAttribute: (name) => (name === "type" ? "text" : "") };
  const shadowHost = { nodeType: 1, tagName: "DIV", shadowRoot: { activeElement: password } };
  const frame = { nodeType: 1, tagName: "IFRAME", contentDocument: { activeElement: password } };
  const crossOrigin = {
    nodeType: 1,
    tagName: "IFRAME",
    get contentDocument() { throw new Error("cross-origin"); },
  };
  const run = (active) => {
    const sandbox = { document: { activeElement: active }, result: null };
    vm.runInNewContext(`result = ${ACTIVE_ELEMENT_PASSWORD_SCRIPT}`, sandbox);
    return sandbox.result;
  };
  assert.equal(run(password).password, true);
  assert.equal(run(text).password, false);
  assert.equal(run(shadowHost).password, true);
  assert.equal(run(frame).password, true);
  assert.equal(run(crossOrigin).password, null);
  assert.equal(run(crossOrigin).reason, "inaccessible-frame");
  const nullDocument = { nodeType: 1, tagName: "FRAME", contentDocument: null };
  assert.equal(run(nullDocument).password, null);
  assert.equal(run(nullDocument).reason, "inaccessible-frame");
  const throwingChild = {
    nodeType: 1,
    tagName: "IFRAME",
    contentDocument: { get activeElement() { throw new Error("cross-origin"); } },
  };
  assert.equal(run(throwingChild).password, null);
  assert.notEqual(run(crossOrigin).password, false);
  assert.equal(run(null).password, false);
  assert.match(ACTIVE_ELEMENT_PASSWORD_SCRIPT, /shadowRoot/);
  assert.match(ACTIVE_ELEMENT_PASSWORD_SCRIPT, /contentDocument/);

  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/login" });
  host.activePassword = true;
  host.commands.length = 0;
  const refused = await call("type", { text: "secret-value" });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /password field/);
  assert.match(refused.error, /wait_for_user/);
  assert.equal(host.commands.some((command) => command.method === "Input.insertText"), false);
  assert.equal(host.isolated.some((entry) => entry.worldId === ISOLATED_WORLD_ID && entry.code.includes("isPasswordInput")), true);
  host.activePassword = false;
  const typed = await call("type", { text: "hello" });
  assert.equal(typed.ok, true, typed.error);
  assert.equal(host.commands.some((command) => command.method === "Input.insertText" && command.params.text === "hello"), true);
});

test("type without a ref fails closed unless focus is confirmed not to be a password", async (t) => {
  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/login" });
  const refuse = async (probe) => {
    host.passwordProbe = probe;
    host.commands.length = 0;
    const result = await call("type", { text: "secret-value" });
    assert.equal(result.ok, false);
    assert.equal(result.error, PASSWORD_FOCUS_UNCONFIRMED_ERROR);
    assert.equal(host.commands.some((command) => command.method === "Input.insertText"), false);
  };
  await refuse({ value: { password: null, reason: "inaccessible-frame" } });
  await refuse({ value: null });
  await refuse({ value: undefined });
  await refuse({ value: "no" });
  await refuse({ reject: new Error("isolated world failed") });
  host.passwordProbe = { value: { password: false } };
  host.commands.length = 0;
  const typed = await call("type", { text: "hello" });
  assert.equal(typed.ok, true, typed.error);
  assert.equal(host.commands.some((command) => command.method === "Input.insertText" && command.params.text === "hello"), true);
});

test("type into an iframe or frame target fails closed and sends no insertText", async (t) => {
  const frameTarget = {
    nodeType: 1,
    isConnected: true,
    tagName: "IFRAME",
    attrs: {},
    getAttribute() { return ""; },
    focus() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 10 }),
  };
  const sandbox = {
    document: { querySelector: () => null },
    __pioraRefs: new Map([["e9", { deref: () => frameTarget }]]),
    result: null,
  };
  vm.runInNewContext(`result = ${focusInvocation({ ref: "e9" })}`, sandbox);
  assert.equal(sandbox.result.tag, "iframe");
  assert.equal(sandbox.result.password, false);

  const { host, call } = setup(t);
  await call("open", { url: "https://example.test/embed" });
  for (const tag of ["iframe", "FRAME"]) {
    host.focusResult = { ok: true, x: 1, y: 1, width: 4, height: 4, type: "", password: false, tag };
    host.commands.length = 0;
    const refused = await call("type", { ref: "e9", text: "hello" });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, PASSWORD_FOCUS_UNCONFIRMED_ERROR);
    assert.equal(host.commands.some((command) => command.method === "Input.insertText"), false);
  }
});

test("idle unload discards agent-opened tabs and keeps user and manual tabs", async (t) => {
  const { host, control, call } = setup(t);
  const opened = await call("open", { url: "https://example.test/agent" });
  host.createTab("session-a", "https://example.test/form");
  host.createTab("__piora_browser_manual__", "https://example.test/manual");
  const userTab = host.tabs.find((tab) => tab.url === "https://example.test/form");
  const manualTab = host.tabs.find((tab) => tab.sessionId === "__piora_browser_manual__");
  const switched = await call("switch_tab", { tabId: userTab.id });
  assert.equal(switched.ok, true, switched.error);
  assert.equal(control.agentTabId("session-a"), userTab.id);
  await call("idle");
  control.noteUsed(opened.value.tabId);
  control.noteUsed(userTab.id);
  control.noteUsed(manualTab.id);
  host.nowMs += IDLE_UNLOAD_MS + 5;
  const unloaded = control.sweepIdle();
  assert.deepEqual(unloaded, [opened.value.tabId]);
  assert.equal(host.tabs.find((tab) => tab.id === opened.value.tabId).unloaded, true);
  assert.equal(userTab.unloaded, false);
  assert.equal(manualTab.unloaded, false);
  assert.equal(host.ops.some((op) => op[0] === "discard" && op[1] === userTab.id), false);
  assert.equal(host.ops.some((op) => op[0] === "discard" && op[1] === manualTab.id), false);
});

test("server exit idles every session and restores offscreen tabs without closing them", async (t) => {
  const { host, control, call } = setup(t);
  const first = await call("open", { url: "https://example.test/one" });
  const second = await call("open", { url: "https://example.test/two" }, "session-b");
  await call("wait_begin", { reason: "Sign in" }, "session-b");
  assert.equal(control.status("session-a").operating, true);
  assert.equal(control.status("session-b").waiting, true);
  assert.equal(host.throttling.get(first.value.tabId), false);
  host.shownId = second.value.tabId;
  control.failAll("Web server process exited");
  const idled = await control.idleAll();
  assert.equal(idled.includes("session-a"), true);
  assert.equal(idled.includes("session-b"), true);
  assert.equal(control.status("session-a").operating, false);
  assert.equal(control.status("session-b").operating, false);
  assert.equal(control.status("session-b").waiting, false);
  assert.equal(host.throttling.get(first.value.tabId), true);
  assert.equal(host.throttling.get(second.value.tabId), true);
  assert.equal(host.commands.some((command) => command.tabId === first.value.tabId && command.method === "Emulation.clearDeviceMetricsOverride"), true);
  assert.equal(host.ops.some((op) => op[0] === "detach" && op[1] === first.value.tabId), true);
  assert.equal(host.ops.some((op) => op[0] === "detach" && op[1] === second.value.tabId), false);
  assert.equal(host.tabs.filter((tab) => !tab.removed).length, 2);
  const activity = host.ops.filter((op) => op[0] === "activity" && op[1].sessionId === "session-a").at(-1)[1];
  assert.equal(activity.operating, false);
  assert.equal(activity.waiting, false);
  const manager = readFileSync(new URL("../desktop/src/browser-manager.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
  assert.match(manager, /failAgentRequests\(message: string\): void \{\s*this\.agentControl\?\.failAll\(message\);\s*void this\.agentControl\?\.idleAll\(\)/);
  assert.match(manager, /Browser manager was closed[\s\S]*void this\.agentControl\?\.idleAll\(\)/);
  assert.match(main, /onProcessExit: \(\) => \{\s*desktopBrowserManager\?\.failAgentRequests\("Web server process exited"\);/);
});

test("an active session with no request for 3 minutes auto-idles unless it is waiting or in flight", async (t) => {
  const timers = [];
  const { host, control, call } = setup(t, {
    setIntervalTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { fn, ms };
    },
    clearIntervalTimer: () => {},
  });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  const opened = await call("open", { url: "https://example.test/hold" });
  host.nowMs += AUTO_IDLE_MS - 1;
  assert.deepEqual(await control.sweepAutoIdle(), []);
  assert.equal(control.status("session-a").operating, true);
  host.nowMs += 1;
  const idled = await control.sweepAutoIdle();
  assert.deepEqual(idled, ["session-a"]);
  assert.equal(control.status("session-a").operating, false);
  assert.equal(host.throttling.get(opened.value.tabId), true);
  assert.equal(host.commands.some((command) => command.tabId === opened.value.tabId && command.method === "Emulation.clearDeviceMetricsOverride"), true);
  assert.equal(host.tabs.find((tab) => tab.id === opened.value.tabId).removed, false);
  assert.equal(host.logs.some((entry) => String(entry.message).includes("[browser-agent] auto-idle")), true);

  await call("snapshot");
  host.hangInput = true;
  const pending = call("type", { text: "still-running" });
  await new Promise((resolve) => setTimeout(resolve, 15));
  host.nowMs += AUTO_IDLE_MS + 5;
  assert.deepEqual(await control.sweepAutoIdle(), []);
  assert.equal(control.status("session-a").operating, true);
  host.hangInput = false;
  host.emit(opened.value.tabId, "render-process-gone");
  const crashed = await pending;
  assert.match(crashed.error, /crashed/);

  await call("snapshot");
  await call("wait_begin", { reason: "Sign in" });
  host.nowMs += AUTO_IDLE_MS + 5;
  assert.deepEqual(await control.sweepAutoIdle(), []);
  assert.equal(control.status("session-a").waiting, true);
  await call("wait_end");
  host.nowMs += AUTO_IDLE_MS + 5;
  timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(control.status("session-a").operating, false);
  assert.equal(host.logs.filter((entry) => String(entry.message).includes("[browser-agent] auto-idle")).length >= 2, true);
});
