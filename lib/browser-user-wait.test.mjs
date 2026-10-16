import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const wait = await jiti.import("./browser-user-wait.ts");
const route = await jiti.import("../app/api/agent/[id]/browser-wait/route.ts");

const { BROWSER_USER_WAIT_TEXT, readBrowserUserWait, resolveBrowserUserWait, waitForUser } = wait;

test("a browser user wait resolves continue, cancel, timeout, and abort", async () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const continued = waitForUser({ sessionId, toolCallId: "call-1", reason: "Sign in", timeoutMs: 5_000 });
  assert.equal(readBrowserUserWait(sessionId).reason, "Sign in");
  assert.equal(readBrowserUserWait(sessionId).toolCallId, "call-1");
  assert.equal(resolveBrowserUserWait(sessionId, "continue"), true);
  assert.equal(await continued, "continued");
  assert.equal(readBrowserUserWait(sessionId), null);
  assert.match(BROWSER_USER_WAIT_TEXT.continued, /Take a new snapshot/);

  const cancelled = waitForUser({ sessionId, toolCallId: "call-2", reason: "Pay", timeoutMs: 5_000 });
  assert.equal(resolveBrowserUserWait(sessionId, "cancel"), true);
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
  resolveBrowserUserWait(sessionId, "continue");
  assert.equal(await second, "continued");
});

test("the browser wait route validates the session and the decision", async () => {
  const missing = await route.GET(new Request("http://localhost/api"), { params: Promise.resolve({ id: "not-a-session" }) });
  assert.equal(missing.status, 400);
  const absent = await route.POST(new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ decision: "continue" }),
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
  resolveBrowserUserWait(sessionId, "cancel");
  assert.equal(await pending, "cancelled");
});
