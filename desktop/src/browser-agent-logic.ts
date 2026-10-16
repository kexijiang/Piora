/** Pure browser-agent rules. No Electron imports: unit tests drive these directly. */

export const AGENT_OFFSCREEN_BOUNDS = { x: -3000, y: 0, width: 1280, height: 800 } as const;
export const AGENT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false } as const;
export const ISOLATED_WORLD_ID = 1001;
export const MAX_AGENT_TABS = 5;
export const MAX_SNAPSHOT_NODES = 400;
export const IDLE_UNLOAD_MS = 10 * 60 * 1000;
export const MANUAL_BROWSER_SESSION_ID = "__piora_browser_manual__";
export const CDP_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 40_000;

export const PAUSED_BY_USER_ERROR = "Browser agent is paused by user.";
export const EVALUATE_DISABLED_ERROR = "evaluate is disabled on the desktop browser and needs user confirmation.";
export const MAX_AGENT_TABS_ERROR = "This session already has 5 agent browser tabs. Close unused tabs before opening another.";
export const REFS_INVALID_ERROR = "Element refs are invalid after the tab was reloaded. Take a new snapshot before interacting.";
export const RENDERER_CRASHED_ERROR = "Browser tab renderer crashed.";
export const BRIDGE_UNAVAILABLE_ERROR = "Desktop browser bridge unavailable.";
export const RELOAD_NOTICE = "This tab was unloaded while idle and has been reloaded. Previous element refs are invalid; take a snapshot before clicking or typing.";
export const PASSWORD_HINT = "A password field is present. Call wait_for_user instead of typing a password.";
export const PASSWORD_TYPE_ERROR = "Refusing to type into a password field. Call wait_for_user so the user can enter it.";
export const NAVIGATION_TIMEOUT_MS = 30_000;
export const GLOBAL_BROWSER_TAB_CAP = 20;
export const AGENT_GLOBAL_TAB_CAP_ERROR = "The browser tab limit of 20 has been reached. Close a tab before the agent opens another.";
export const SENSITIVE_PAGE_HINT = "This page looks like a login, captcha, verification, payment, or account-security page. Call wait_for_user and do not type secrets or payment details.";
export const WAITING_FOR_USER_ERROR = "The browser is waiting for the user. Other browser actions are rejected until the user continues or cancels.";

const SENSITIVE_PAGE_PATTERN = /login|sign[\s-]?in|captcha|verify|2fa|otp|checkout|payment|billing|security|登录|验证码|支付|账号安全/i;

export function rejectAgentCreateAtCapacity(openTabs: number, cap = GLOBAL_BROWSER_TAB_CAP): void {
  if (openTabs >= cap) throw new Error(AGENT_GLOBAL_TAB_CAP_ERROR);
}

export function isNonFatalNavigationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errorCode?: unknown; errno?: unknown; code?: unknown; message?: unknown };
  if (candidate.errorCode === -3 || candidate.errno === -3) return true;
  if (candidate.code === "ERR_ABORTED" || candidate.code === -3) return true;
  return typeof candidate.message === "string" && (/ERR_ABORTED/.test(candidate.message) || /\(-3\)/.test(candidate.message));
}

export function navigationFailure(error: unknown): Error {
  if (error instanceof Error && /timed out|crashed|closed|aborted/i.test(error.message) && !isNonFatalNavigationError(error)) return error;
  const message = error instanceof Error && error.message ? error.message : "Page failed to load.";
  if (/^Page failed to load\b/i.test(message)) return error instanceof Error ? error : new Error(message);
  return new Error(`Page failed to load: ${message}`);
}

export function sensitivePageNotice(input: { url?: string; title?: string; visibleText?: string; passwordField?: boolean }): string | undefined {
  if (input.passwordField) return undefined;
  const haystack = `${input.url ?? ""}\n${input.title ?? ""}\n${input.visibleText ?? ""}`;
  return SENSITIVE_PAGE_PATTERN.test(haystack) ? SENSITIVE_PAGE_HINT : undefined;
}

const USER_INPUT_EVENT_TYPES = new Set([
  "mouseDown",
  "rawKeyDown",
  "keyDown",
  "char",
  "mouseWheel",
  "gestureScrollBegin",
]);

export function classifyInputEvent(type: string, inFlight: number): "user" | "ignore" {
  if (!USER_INPUT_EVENT_TYPES.has(type)) return "ignore";
  return inFlight === 0 ? "user" : "ignore";
}

export class InFlightCounter {
  private readonly counts = new Map<string, number>();

  increment(id: string): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  decrement(id: string): void {
    const next = (this.counts.get(id) ?? 0) - 1;
    if (next <= 0) this.counts.delete(id);
    else this.counts.set(id, next);
  }

  count(id: string): number {
    return this.counts.get(id) ?? 0;
  }
}

export interface PendingRequestTable {
  track(id: string, controller: AbortController): void;
  cancel(id: string, error?: Error): boolean;
  failAll(error: Error): void;
  finish(id: string): void;
  has(id: string): boolean;
  size(): number;
}

export function createPendingRequestTable(options: {
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  timeoutError?: () => Error;
} = {}): PendingRequestTable {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const entries = new Map<string, { controller: AbortController; timer: unknown }>();
  const timeoutError = options.timeoutError ?? (() => new Error("Browser agent request timed out"));

  return {
    track(id, controller) {
      const existing = entries.get(id);
      if (existing) clearTimer(existing.timer);
      const timer = setTimer(() => {
        const current = entries.get(id);
        if (!current) return;
        entries.delete(id);
        if (!controller.signal.aborted) controller.abort(timeoutError());
      }, timeoutMs);
      entries.set(id, { controller, timer });
    },
    cancel(id, error = new Error("Browser action aborted")) {
      const current = entries.get(id);
      if (!current) return false;
      clearTimer(current.timer);
      entries.delete(id);
      if (!current.controller.signal.aborted) current.controller.abort(error);
      return true;
    },
    failAll(error) {
      for (const [id, current] of entries) {
        clearTimer(current.timer);
        entries.delete(id);
        if (!current.controller.signal.aborted) current.controller.abort(error);
      }
    },
    finish(id) {
      const current = entries.get(id);
      if (!current) return;
      clearTimer(current.timer);
      entries.delete(id);
    },
    has(id) {
      return entries.has(id);
    },
    size() {
      return entries.size;
    },
  };
}

export interface OwnedTabCandidate {
  id: string;
  sessionId: string;
  webContentsId: number;
  closed: boolean;
}

export function resolveOwnedTab(input: {
  sessionId: string;
  requestedTabId?: string;
  agentTabId?: string;
  tabs: readonly OwnedTabCandidate[];
  mainWebContentsId: number;
  manualSessionId?: string;
}): { ok: true; tab: OwnedTabCandidate } | { ok: false; error: string } {
  const manualSessionId = input.manualSessionId ?? MANUAL_BROWSER_SESSION_ID;
  const sessionId = input.sessionId.trim();
  if (!sessionId || sessionId === manualSessionId) {
    return { ok: false, error: "Refusing to control the manual browser session." };
  }
  const targetId = input.requestedTabId || input.agentTabId;
  if (!targetId) return { ok: false, error: "No agent tab for this session. Open a page first." };
  const tab = input.tabs.find((candidate) => candidate.id === targetId);
  if (!tab || tab.closed) return { ok: false, error: "Browser tab is closed." };
  if (tab.webContentsId === input.mainWebContentsId) {
    return { ok: false, error: "Refusing to control the main window." };
  }
  if (tab.sessionId === manualSessionId) {
    return { ok: false, error: "Refusing to control the manual browser session." };
  }
  if (tab.sessionId !== sessionId) {
    return { ok: false, error: "Refusing to control a tab from another session." };
  }
  return { ok: true, tab };
}

export function assertAgentTabCapacity(openAgentTabs: number): void {
  if (openAgentTabs >= MAX_AGENT_TABS) throw new Error(MAX_AGENT_TABS_ERROR);
}

export interface SnapshotNode {
  ref: string;
  tag: string;
  role: string;
  type?: string;
  name?: string;
  password?: boolean;
  value?: string;
}

export function formatSnapshotNode(node: SnapshotNode): string {
  const kind = node.role || node.tag || "element";
  if (node.password || node.type === "password") {
    return `[${node.ref}] ${kind} type=password — password field`;
  }
  const label = (node.name ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
  return `[${node.ref}] ${kind}${label ? ` — ${label}` : ""}`;
}

export function formatSnapshot(input: {
  title?: string;
  url?: string;
  nodes: readonly SnapshotNode[];
  truncated?: boolean;
  passwordField?: boolean;
  notice?: string;
}): string {
  const elements = input.nodes.map((node) => formatSnapshotNode(node));
  const passwordField = input.passwordField === true || input.nodes.some((node) => node.password === true || node.type === "password");
  let text = `${input.title || "Untitled"}\n${input.url || ""}\n\nInteractive elements:\n${elements.join("\n") || "(none)"}`;
  if (input.notice) text += `\n${input.notice}`;
  if (input.truncated) text += "\n… snapshot truncated";
  if (passwordField) text += `\n${PASSWORD_HINT}`;
  return text;
}

export const REF_NOT_FOUND_ERROR = "Element ref was not found. Take a new snapshot.";

/** Isolated-world only. The page cannot see or forge this map. */
export const REF_LOOKUP_SOURCE = `function pioraRefElement(ref) {
  const map = globalThis.__pioraRefs;
  const held = map && typeof map.get === "function" ? map.get(ref) : undefined;
  const element = held && typeof held.deref === "function" ? held.deref() : held;
  if (!element || element.nodeType !== 1 || element.isConnected === false) return null;
  return element;
}`;

export const SNAPSHOT_COLLECT_SCRIPT = `(() => {
  const maxNodes = ${MAX_SNAPSHOT_NODES};
  const selectors = "a, button, input, textarea, select, summary, [role], [contenteditable='true']";
  const refs = new Map();
  globalThis.__pioraRefs = refs;
  const nodes = [];
  let passwordField = false;
  let truncated = false;
  const width = window.innerWidth || ${AGENT_VIEWPORT.width};
  const height = window.innerHeight || ${AGENT_VIEWPORT.height};
  const elements = document.querySelectorAll(selectors);
  for (const element of elements) {
    if (nodes.length >= maxNodes) { truncated = true; break; }
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > height || rect.left > width) continue;
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute("type") || "").toLowerCase();
    const password = type === "password";
    if (password) passwordField = true;
    const ref = "e" + (nodes.length + 1);
    refs.set(ref, typeof WeakRef === "function" ? new WeakRef(element) : element);
    const role = element.getAttribute("role") || "";
    const name = password ? "" : String(
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.getAttribute("placeholder")
      || element.innerText
      || ""
    ).replace(/\\s+/g, " ").trim().slice(0, 180);
    nodes.push({ ref, tag, role, type, name, password });
  }
  const visibleText = String((document.body && document.body.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 4000);
  return { title: document.title || "", url: String(location.href || ""), nodes, truncated, passwordField, visibleText };
})()`;

export const SCROLL_FUNCTION_SOURCE = `function pioraScroll(args) {
  const overflowScroll = (value) => value === "auto" || value === "scroll" || value === "overlay";
  const canScroll = (element) => {
    if (!element || element.nodeType !== 1) return false;
    const style = getComputedStyle(element);
    const vertical = overflowScroll(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    const horizontal = overflowScroll(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    return vertical || horizontal;
  };
  const nearestScrollable = (start) => {
    let current = start;
    while (current && current !== document.documentElement && current !== document.body) {
      if (canScroll(current)) return current;
      current = current.parentElement;
    }
    if (canScroll(document.body)) return document.body;
    if (canScroll(document.documentElement)) return document.documentElement;
    return document.scrollingElement || document.documentElement;
  };
  let target = null;
  if (args.ref) target = pioraRefElement(args.ref);
  else if (args.selector) target = document.querySelector(args.selector);
  else if (typeof args.x === "number" && typeof args.y === "number") target = document.elementFromPoint(args.x, args.y);
  if ((args.ref || args.selector) && !target) return { ok: false, error: ${JSON.stringify(REF_NOT_FOUND_ERROR)} };
  if (args.intoView && target && target.scrollIntoView) {
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
    return { ok: true, mode: "intoView" };
  }
  const scroller = nearestScrollable(target);
  if (scroller && scroller.scrollBy) scroller.scrollBy({ left: Number(args.deltaX) || 0, top: Number(args.deltaY) || 0, behavior: "instant" });
  return { ok: true, mode: "scrollBy", tag: scroller && scroller.tagName ? String(scroller.tagName).toLowerCase() : "" };
}`;

export function scrollInvocation(args: {
  ref?: string;
  selector?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  intoView?: boolean;
}): string {
  return `(() => {\nconst args = ${JSON.stringify(args)};\n${REF_LOOKUP_SOURCE}\n${SCROLL_FUNCTION_SOURCE}\nreturn pioraScroll(args);\n})()`;
}

export function focusInvocation(args: { ref?: string; selector?: string }): string {
  return `(() => {\nconst args = ${JSON.stringify(args)};\n${REF_LOOKUP_SOURCE}\nconst target = args.ref ? pioraRefElement(args.ref) : args.selector ? document.querySelector(args.selector) : null;\nif (!target) return { ok: false, error: ${JSON.stringify(REF_NOT_FOUND_ERROR)} };\nconst type = String((target.getAttribute && target.getAttribute("type")) || "").toLowerCase();\nconst password = type === "password";\nif (target.focus) target.focus();\nif (!password && typeof target.select === "function") target.select();\nconst rect = target.getBoundingClientRect();\nreturn { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height, type: type, password: password };\n})()`;
}

export function elementCenterInvocation(args: { ref?: string; selector?: string }): string {
  return focusInvocation(args);
}

export interface KeyDispatchEvent {
  type: "keyDown" | "keyUp" | "char";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  modifiers: number;
  text?: string;
}

const NAMED_KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Esc: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  " ": { key: " ", code: "Space", keyCode: 32 },
};

const MODIFIER_KEYS: Record<string, { key: string; code: string; keyCode: number; bit: number }> = {
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  Ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  Command: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  Cmd: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
};

function namedKey(token: string): { key: string; code: string; keyCode: number; text?: string } {
  const named = NAMED_KEYS[token];
  if (named) return named.key === " " ? { ...named, text: " " } : named;
  if (/^[a-zA-Z]$/.test(token)) {
    const letter = token.toLowerCase();
    return { key: letter, code: `Key${letter.toUpperCase()}`, keyCode: letter.toUpperCase().charCodeAt(0), text: letter };
  }
  if (/^[0-9]$/.test(token)) {
    return { key: token, code: `Digit${token}`, keyCode: token.charCodeAt(0), text: token };
  }
  return { key: token, code: token, keyCode: 0 };
}

export function buildKeyDispatchEvents(combo: string): KeyDispatchEvent[] {
  const parts = combo.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("press requires a key");
  const modifiers = [];
  const main = parts[parts.length - 1] ?? "";
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_KEYS[part];
    if (!modifier) throw new Error(`Unsupported modifier: ${part}`);
    modifiers.push(modifier);
  }
  if (MODIFIER_KEYS[main] && parts.length === 1) {
    const only = MODIFIER_KEYS[main];
    return [
      { type: "keyDown", key: only.key, code: only.code, windowsVirtualKeyCode: only.keyCode, modifiers: 0 },
      { type: "keyUp", key: only.key, code: only.code, windowsVirtualKeyCode: only.keyCode, modifiers: only.bit },
    ];
  }
  const resolved = namedKey(main);
  const mask = modifiers.reduce((bits, modifier) => bits | modifier.bit, 0);
  const events: KeyDispatchEvent[] = [];
  let running = 0;
  for (const modifier of modifiers) {
    events.push({ type: "keyDown", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: running });
    running |= modifier.bit;
  }
  events.push({ type: "keyDown", key: resolved.key, code: resolved.code, windowsVirtualKeyCode: resolved.keyCode, modifiers: mask });
  if (resolved.text && mask === 0) {
    events.push({ type: "char", key: resolved.key, code: resolved.code, windowsVirtualKeyCode: resolved.keyCode, modifiers: 0, text: resolved.text });
  } else if (resolved.text && (mask & ~8) === 0) {
    const shifted = mask & 8 ? resolved.text.toUpperCase() : resolved.text;
    events.push({ type: "char", key: shifted, code: resolved.code, windowsVirtualKeyCode: resolved.keyCode, modifiers: mask, text: shifted });
  }
  events.push({ type: "keyUp", key: resolved.key, code: resolved.code, windowsVirtualKeyCode: resolved.keyCode, modifiers: mask });
  for (const modifier of [...modifiers].reverse()) {
    running &= ~modifier.bit;
    events.push({ type: "keyUp", key: modifier.key, code: modifier.code, windowsVirtualKeyCode: modifier.keyCode, modifiers: running });
  }
  return events;
}

export function abortReason(signal: AbortSignal, fallback: string): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason) return new Error(reason);
  return new Error(fallback);
}

export function httpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The built-in browser accepts only http:// and https:// URLs.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The built-in browser accepts only http:// and https:// URLs.");
  }
  return parsed.href;
}

export const INPUT_ACTIONS = new Set(["open", "back", "forward", "reload", "click", "type", "press", "scroll", "new_tab", "switch_tab", "close_tab", "evaluate"]);

export function isPausedAction(action: string): boolean {
  return INPUT_ACTIONS.has(action);
}
