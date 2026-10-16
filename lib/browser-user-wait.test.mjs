import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(".") } });
const wait = await jiti.import("./browser-user-wait.ts");
const route = await jiti.import("../app/api/agent/[id]/browser-wait/route.ts");
const sessions = await jiti.import("./session-reader.ts");
const browser = await jiti.import("../extensions/piora-browser.ts");

const { BROWSER_USER_WAIT_TEXT, BROWSER_USER_WAIT_UNSUPPORTED_TEXT, readBrowserUserWait, resolveBrowserUserWait, waitForUser } = wait;

test("a browser user wait resolves continue, cancel, timeout, and abort", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const continued = waitForUser({ sessionId, toolCallId: "call-1", reason: "Sign in", timeoutMs: 5_000 });
  assert.equal(readBrowserUserWait(sessionId).reason, "Sign in");
  assert.equal(readBrowserUserWait(sessionId).toolCallId, "call-1");
  assert.equal(resolveBrowserUserWait(sessionId, "continue", "call-1"), true);
  assert.equal(await continued, "continued");
  assert.equal(readBrowserUserWait(sessionId), null);
  assert.match(BROWSER_USER_WAIT_TEXT.continued, /Take a new snapshot/);

  const cancelled = waitForUser({ sessionId, toolCallId: "call-2", reason: "Pay", timeoutMs: 5_000 });
  assert.equal(resolveBrowserUserWait(sessionId, "cancel", "call-2"), true);
  assert.equal(await cancelled, "cancelled");
  assert.match(BROWSER_USER_WAIT_TEXT.cancelled, /did not complete/);
  assert.match(BROWSER_USER_WAIT_TEXT.cancelled, /signed in/);
  assert.match(BROWSER_USER_WAIT_TEXT.timeout, /did not complete/);
  assert.match(BROWSER_USER_WAIT_TEXT.timeout, /signed in/);

  const timed = await waitForUser({ sessionId, toolCallId: "call-3", reason: "Code", timeoutMs: 15 });
  assert.equal(timed, "timeout");

  const controller = new AbortController();
  const started = Date.now();
  const aborted = waitForUser({ sessionId, toolCallId: "call-4", reason: "Stop", timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, "aborted");
  assert.equal(Date.now() - started < 1000, true);
  assert.match(BROWSER_USER_WAIT_TEXT.aborted, /did not complete/);
  assert.equal(readBrowserUserWait(sessionId), null);
});

test("aborting before the wait starts resolves immediately and a new wait cancels the previous one", async () => {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const controller = new AbortController();
  controller.abort();
  assert.equal(await waitForUser({ sessionId, toolCallId: "gone", reason: "Late", signal: controller.signal, timeoutMs: 60_000 }), "aborted");
  const first = waitForUser({ sessionId, toolCallId: "first", reason: "One", timeoutMs: 60_000 });
  const second = waitForUser({ sessionId, toolCallId: "second", reason: "Two", timeoutMs: 60_000 });
  assert.equal(await first, "cancelled");
  assert.equal(readBrowserUserWait(sessionId).toolCallId, "second");
  resolveBrowserUserWait(sessionId, "continue", "second");
  assert.equal(await second, "continued");
});

test("the browser wait route validates the session and the decision", async () => {
  const missing = await route.GET(new Request("http://localhost/api"), { params: Promise.resolve({ id: "not-a-session" }) });
  assert.equal(missing.status, 400);
  const absent = await route.POST(new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "continue", toolCallId: "missing-call" }),
  }), { params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }) });
  assert.equal(absent.status, 404);
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const pending = waitForUser({ sessionId, toolCallId: "tool-9", reason: "Enter the code", timeoutMs: 5_000, backend: "desktop" });
  const current = await route.GET(new Request("http://localhost/api"), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(current.status, 404);
  const bad = await route.POST(new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "yes" }),
  }), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(bad.status, 400);
  const missingId = await route.POST(new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "continue" }),
  }), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(missingId.status, 400);
  resolveBrowserUserWait(sessionId, "cancel", "tool-9");
  assert.equal(await pending, "cancelled");
});

test("a stale browser wait toolCallId does not end the newer wait", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  sessions.cacheSessionPath(sessionId, "/tmp/piora-browser-wait-stale.jsonl");
  const first = waitForUser({ sessionId, toolCallId: "old-call", reason: "Old login", timeoutMs: 60_000 });
  const second = waitForUser({ sessionId, toolCallId: "new-call", reason: "New login", timeoutMs: 60_000 });
  try {
    assert.equal(await first, "cancelled");
    assert.equal(resolveBrowserUserWait(sessionId, "continue", "old-call"), false);
    assert.equal(readBrowserUserWait(sessionId).toolCallId, "new-call");
    const stale = await route.POST(new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "continue", toolCallId: "old-call" }),
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(stale.status, 409);
    assert.equal(readBrowserUserWait(sessionId).toolCallId, "new-call");
    assert.equal(readBrowserUserWait(sessionId).reason, "New login");
    const matched = await route.POST(new Request("http://localhost/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "cancel", toolCallId: "new-call" }),
    }), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(matched.status, 200);
    assert.equal(await second, "cancelled");
    assert.equal(readBrowserUserWait(sessionId), null);
  } finally {
    resolveBrowserUserWait(sessionId, "cancel", "new-call");
    sessions.invalidateSessionPathCache(sessionId);
  }
});

test("playwright wait_for_user returns unsupported immediately and does not register a wait", async () => {
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const previousIpc = process.env.PIORA_DESKTOP_NETWORK_IPC;
  delete process.env.PIORA_DESKTOP_NETWORK_IPC;
  const started = Date.now();
  try {
    const result = await browser.waitForBrowserUser(sessionId, "call-unsupported", "Sign in to GitHub", AbortSignal.timeout(500));
    assert.equal(Date.now() - started < 500, true);
    assert.equal(result.details.status, "unsupported");
    assert.equal(result.details.backend, "playwright");
    assert.equal(result.details.action, "wait_for_user");
    assert.equal(result.content[0].text, BROWSER_USER_WAIT_UNSUPPORTED_TEXT);
    assert.match(result.content[0].text, /cannot take over the browser/i);
    assert.match(result.content[0].text, /signed in/);
    assert.match(result.content[0].text, /chat/);
    assert.equal(readBrowserUserWait(sessionId), null);
  } finally {
    if (previousIpc === undefined) delete process.env.PIORA_DESKTOP_NETWORK_IPC;
    else process.env.PIORA_DESKTOP_NETWORK_IPC = previousIpc;
    resolveBrowserUserWait(sessionId, "cancel", "call-unsupported");
  }
});

test("a desktop bridge that fails during wait_for_user falls back to unsupported", async () => {
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const previousIpc = process.env.PIORA_DESKTOP_NETWORK_IPC;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = process.send;
  const previousConnected = Object.getOwnPropertyDescriptor(process, "connected");
  process.env.PIORA_DESKTOP_NETWORK_IPC = "1";
  delete process.env.PI_CODING_AGENT_DIR;
  Object.defineProperty(process, "connected", { configurable: true, get: () => true });
  process.send = (message, callback) => {
    if (typeof callback === "function") callback(new Error("Desktop browser bridge unavailable."));
    return true;
  };
  const started = Date.now();
  try {
    const result = await browser.waitForBrowserUser(sessionId, "call-fallback", "Sign in", AbortSignal.timeout(800));
    assert.equal(Date.now() - started < 800, true);
    assert.equal(result.details.status, "unsupported");
    assert.equal(result.details.backend, "playwright");
    assert.equal(result.content[0].text, BROWSER_USER_WAIT_UNSUPPORTED_TEXT);
    assert.equal(readBrowserUserWait(sessionId), null);
  } finally {
    if (previousIpc === undefined) delete process.env.PIORA_DESKTOP_NETWORK_IPC;
    else process.env.PIORA_DESKTOP_NETWORK_IPC = previousIpc;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSend === undefined) delete process.send;
    else process.send = previousSend;
    if (previousConnected) Object.defineProperty(process, "connected", previousConnected);
    else delete process.connected;
    resolveBrowserUserWait(sessionId, "cancel", "call-fallback");
  }
});
