import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { browserLoginCompleted, readBrowserLoginState } = await jiti.import("../desktop/src/browser-login.ts");
const { browserWaitPurpose } = await jiti.import("./browser-wait-policy.ts");
const { waitForUser, readBrowserUserWait, resolveBrowserUserWait } = await jiti.import("./browser-user-wait.ts");

test("login waits need a new visible authenticated state, never just navigation or disappearing forms", () => {
  const before = { ready: true, loginVisible: true, authenticated: false, url: "https://site.test/login" };
  assert.equal(browserLoginCompleted(before, { ...before, loginVisible: false, url: "https://site.test/home" }), false);
  assert.equal(browserLoginCompleted(before, { ...before, loginVisible: false, authenticated: true }), true, "SPA sign-in does not need a URL change");
  assert.equal(browserLoginCompleted(before, { ...before, authenticated: true }), false, "a visible password or 2FA step still blocks completion");
  assert.equal(browserLoginCompleted(before, { ...before, ready: false, loginVisible: false, authenticated: true }), false);
  assert.equal(browserLoginCompleted({ ...before, authenticated: true }, { ...before, loginVisible: false, authenticated: true }), false, "closing a reauthentication dialog is not success");
  assert.equal(readBrowserLoginState({ ready: true }), null);
  assert.equal(readBrowserLoginState({ ...before, url: "about:blank" }), null);
  assert.equal(browserWaitPurpose("Sign in to GitHub"), "login");
  assert.equal(browserWaitPurpose("请登录"), "login");
  assert.equal(browserWaitPurpose("Confirm payment after login"), "confirmation");
  assert.equal(browserWaitPurpose("Sign in", "confirmation"), "confirmation");
});

test("a login wait resumes automatically and retries transient observation failures", async () => {
  let checks = 0;
  const result = await waitForUser({ sessionId: "login-auto", toolCallId: "auto", reason: "Sign in", purpose: "login", backend: "desktop", timeoutMs: 1000, checkIntervalMs: 2,
    checkCompletion: async () => { checks++; if (checks === 1) throw new Error("Navigation replaced the document"); return checks >= 3; },
  });
  assert.equal(result, "continued");
  assert.equal(checks, 3);
  assert.equal(readBrowserUserWait("login-auto"), null);
});

test("late login observations cannot revive stopped or superseded waits", async () => {
  let finish;
  const controller = new AbortController();
  const old = waitForUser({ sessionId: "login-stale", toolCallId: "old", reason: "Sign in", purpose: "login", signal: controller.signal, checkCompletion: () => new Promise(resolve => { finish = resolve; }) });
  controller.abort();
  assert.equal(await old, "aborted");
  const current = waitForUser({ sessionId: "login-stale", toolCallId: "new", reason: "Confirm", purpose: "confirmation" });
  finish(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readBrowserUserWait("login-stale").toolCallId, "new");
  resolveBrowserUserWait("login-stale", "cancel", "new");
  assert.equal(await current, "cancelled");
});

test("non-login confirmations never auto-resume; inconclusive login checks time out", async () => {
  let checks = 0;
  const manual = waitForUser({ sessionId: "manual-wait", toolCallId: "manual", reason: "Confirm payment", purpose: "confirmation", timeoutMs: 1000, checkCompletion: async () => { checks++; return true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checks, 0);
  resolveBrowserUserWait("manual-wait", "cancel", "manual");
  assert.equal(await manual, "cancelled");
  assert.equal(await waitForUser({ sessionId: "login-timeout", toolCallId: "timeout", reason: "Sign in", purpose: "login", timeoutMs: 15, checkIntervalMs: 2, checkCompletion: async () => false }), "timeout");
});
