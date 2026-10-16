import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const logic = await jiti.import("../desktop/src/browser-agent-logic.ts");
const { createBrowserAgentControl } = await jiti.import("../desktop/src/browser-agent-control.ts");

const {
  AGENT_OFFSCREEN_BOUNDS,
  IDLE_UNLOAD_MS,
  ISOLATED_WORLD_ID,
  PASSWORD_HINT,
  REFS_INVALID_ERROR,
  SNAPSHOT_COLLECT_SCRIPT,
  SCROLL_FUNCTION_SOURCE,
  classifyInputEvent,
  createPendingRequestTable,
  formatSnapshot,
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
    this.emitInputOnSend = false;
    this.snapshot = { title: "Page", url: "https://example.test/", nodes: [], truncated: false, passwordField: false };
    this.capture = { byteLength: 32, base64: "aGk=" };
    this.loadGate = null;
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
    const tab = this.tabs.find((candidate) => candidate.id === tabId);
    if (tab) tab.url = url;
    if (this.loadGate) return this.loadGate;
    return Promise.resolve();
  }
  goBack(tabId) { this.ops.push(["back", tabId]); }
  goForward(tabId) { this.ops.push(["forward", tabId]); }
  reload(tabId) { this.ops.push(["reload", tabId]); }
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
    if (code === "document.visibilityState") return "visible";
    if (code === "innerWidth") return this.innerWidth;
    if (code.includes("function pioraScroll")) return { ok: true, mode: "scrollBy", tag: "div" };
    if (code.includes("target.focus")) return { ok: true, x: 8, y: 9, width: 4, height: 4 };
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
  const collected = vm.runInNewContext(SNAPSHOT_COLLECT_SCRIPT, {
    document: { title: "Login", querySelectorAll: () => [password, button] },
    window: { innerWidth: 1280, innerHeight: 800 },
    location: { href: "https://example.test/login" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
  });
  assert.equal(JSON.stringify(collected).includes(secret), false);
  assert.equal(collected.passwordField, true);
  assert.equal(collected.nodes[0].password, true);
  assert.equal(password.attrs["data-piora-ref"], "e1");
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
  target.attrs = { "data-piora-ref": "e4" };
  const document = {
    documentElement: root,
    body,
    scrollingElement: root,
    elementFromPoint: () => target,
    querySelector: (selector) => (selector.includes("e4") ? target : null),
  };
  const context = { document, getComputedStyle: (element) => element.style, result: null };
  vm.runInNewContext(`${SCROLL_FUNCTION_SOURCE}\nresult = pioraScroll({ x: 4, y: 4, deltaX: 0, deltaY: 50 });`, context);
  assert.equal(context.result.mode, "scrollBy");
  assert.equal(context.result.tag, "div");
  assert.deepEqual(scroller.scrolled, { left: 0, top: 50, behavior: "instant" });
  assert.equal(root.scrolled, null);
  vm.runInNewContext(`${SCROLL_FUNCTION_SOURCE}\nresult = pioraScroll({ ref: "e4", intoView: true });`, context);
  assert.equal(context.result.mode, "intoView");
  assert.equal(target.intoView, true);
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
  assert.match(script.code, /elementFromPoint|data-piora-ref/);
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
});
