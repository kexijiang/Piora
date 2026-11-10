import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createBrowserAgentControl } = await jiti.import("../desktop/src/browser-agent-control.ts");
const { BROWSER_LOGIN_STATE_SCRIPT } = await jiti.import("../desktop/src/browser-login.ts");
const { waitForUser } = await jiti.import("./browser-user-wait.ts");

test("real DOM sign-in resumes the wait in under three seconds, including marker-free retained auth routes", { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://login.test/**", route => route.fulfill({ contentType: "text/html", body: '<form aria-label="Sign in"><input type="password"><button type="submit">Sign in</button></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.body.innerHTML="<main>Welcome to your workspace</main>"}</script>' }));
  await page.goto("http://login.test/auth");
  const tab = { id: "login-tab", sessionId: "login-browser-fixture", closed: false, unloaded: false, url: page.url(), webContentsId: 9 };
  let shown = false;
  const host = { now: Date.now, listTabs: () => [tab], log: { info() {}, warn() {} }, pushActivity() {}, activateSessionTab() { shown = true; },
    onTabEvent: () => () => {}, executeIsolated: (_id, _world, script) => page.evaluate(script) };
  const control = createBrowserAgentControl(host, { autoIdleMs: 60_000 });
  t.after(() => control.destroy());
  // Only the Electron host is a fixture; the production probe, state machine,
  // polling and wait registry all run unchanged against an actual browser DOM.
  control.agentTabs.set(tab.sessionId, tab.id);
  const call = async (action, waitId) => {
    const response = await control.handleRequest({ type: "pi-desktop:browser-agent-request", requestId: randomUUID(), sessionId: tab.sessionId, action, purpose: "login", reason: "Sign in", waitId });
    assert.equal(response.ok, true, response.error); return response.value;
  };
  assert.equal((await page.evaluate(BROWSER_LOGIN_STATE_SCRIPT)).loginVisible, true);
  await call("wait_begin", "spa"); assert.equal(shown, true);
  const waiting = waitForUser({ sessionId: tab.sessionId, toolCallId: "spa", purpose: "login", reason: "Sign in", timeoutMs: 10_000, checkIntervalMs: 250,
    checkCompletion: async () => (await call("wait_check", "spa")).completed });
  await page.locator('input[type="password"]').fill("fixture-only");
  const started = performance.now(); await page.getByRole("button", { name: "Sign in" }).click();
  assert.equal(await waiting, "continued");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 3000, `marker-free SPA detection took ${elapsed.toFixed(0)} ms`);
  t.diagnostic(`marker-free SPA detection: ${elapsed.toFixed(0)} ms`);
  await call("wait_end", "spa");
  await page.evaluate(() => { document.body.innerHTML = '<button aria-label="User menu">Profile</button>'; });
  await call("wait_begin", "already");
  const alreadyStarted = performance.now();
  assert.equal(await waitForUser({ sessionId: tab.sessionId, toolCallId: "already", purpose: "login", reason: "Sign in", timeoutMs: 5000, checkIntervalMs: 250,
    checkCompletion: async () => (await call("wait_check", "already")).completed }), "continued");
  assert.ok(performance.now() - alreadyStarted < 3000);
  await call("wait_end", "already");
  await page.evaluate(() => { document.body.innerHTML = '<input autocomplete="one-time-code" aria-label="Code">'; });
  await call("wait_begin", "otp");
  assert.equal((await call("wait_check", "otp")).completed, false);
  await call("wait_end", "otp");
});
