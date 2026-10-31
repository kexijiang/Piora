import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";

const jiti = createJiti(import.meta.url);
const { evaluateBrowserPage } = await jiti.import("./browser-evaluate.ts");

test("pre-cancelled evaluate does not execute or close a page", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(evaluateBrowserPage({}, "1", {
    signal: controller.signal,
    onInterrupted: () => assert.fail("must not invalidate an untouched page"),
  }), /aborted/);
});

test("cancel discards late results and bounds an unresponsive tab close", async () => {
  const controller = new AbortController();
  let finish, invalidated = false;
  const pending = evaluateBrowserPage({
    evaluate: () => new Promise(resolve => { finish = resolve; }),
    close: () => new Promise(() => {}),
  }, "1", { signal: controller.signal, onInterrupted: () => { invalidated = true; } });
  const rejected = assert.rejects(pending, /aborted.*closing it could not be confirmed/);
  const started = Date.now();
  controller.abort();
  assert.equal(invalidated, true);
  finish("late success");
  await rejected;
  assert.ok(Date.now() - started < 3000);
});

test("real browser cancellation closes pending and CPU-bound evaluation; other tabs survive", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.PIORA_BROWSER_EXECUTABLE ? { executablePath: process.env.PIORA_BROWSER_EXECUTABLE } : process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  try {
    const context = await browser.newContext();
    const other = await context.newPage();
    await context.addCookies([{ name: "login", value: "retained", url: "https://piora.test" }]);
    for (const expression of [
      'console.log("started"); new Promise(() => {})',
      'console.log("started"); while (true) {}',
    ]) {
      const page = await context.newPage();
      const startedScript = page.waitForEvent("console", message => message.text() === "started");
      const controller = new AbortController();
      let invalidated = false;
      const result = evaluateBrowserPage(page, expression, {
        signal: controller.signal, onInterrupted: () => { invalidated = true; },
      });
      const rejected = assert.rejects(result, /aborted; the executing browser tab was closed/);
      await startedScript;
      const stoppedAt = Date.now();
      controller.abort();
      await rejected;
      assert.ok(Date.now() - stoppedAt < 2000);
      assert.equal(invalidated, true);
      assert.equal(page.isClosed(), true);
      assert.equal(await other.evaluate(() => 6 * 7), 42);
      assert.equal((await context.cookies())[0].value, "retained");
    }
    const timedPage = await context.newPage();
    let timedOut = false;
    await assert.rejects(evaluateBrowserPage(timedPage, "new Promise(() => {})", {
      timeoutMs: 50, onInterrupted: () => { timedOut = true; },
    }), /timed out; the executing browser tab was closed/);
    assert.equal(timedOut, true);
    assert.equal(timedPage.isClosed(), true);
    assert.equal(await evaluateBrowserPage(other, "({ answer: 42 })", {
      onInterrupted: () => assert.fail("successful evaluation must retain the page"),
    }).then(value => value.answer), 42);
    await assert.rejects(evaluateBrowserPage(other, 'throw new Error("script failed")', {
      onInterrupted: () => assert.fail("script errors must retain the page"),
    }), /script failed/);
    assert.equal(other.isClosed(), false);

    // Exercise the registered tool too: cancellation must remove the dead page
    // from its session, preserve the other tab, and allow the next tool call.
    const extension = await jiti.import("../extensions/piora-browser.ts");
    let tool;
    extension.default({ registerTool: value => { tool = value; }, on() {} });
    const runtime = globalThis.__pioraBrowserRuntime;
    const page = await context.newPage();
    const session = { context, page, pages: [page, other] };
    runtime.sessions.set("cancel-test", session);
    const ctx = { sessionManager: { getSessionId: () => "cancel-test" } };
    const controller = new AbortController();
    const startedScript = page.waitForEvent("console", message => message.text() === "started");
    const result = tool.execute("cancel-call", { action: "evaluate", text: 'console.log("started"); new Promise(() => {})' }, controller.signal, undefined, ctx);
    const rejected = assert.rejects(result, /aborted/);
    await startedScript;
    controller.abort();
    await rejected;
    assert.equal(session.page, other);
    assert.deepEqual(session.pages, [other]);
    assert.equal(runtime.activeActions, 0);
    const next = await tool.execute("next-call", { action: "evaluate", text: "40 + 2" }, undefined, undefined, ctx);
    assert.equal(next.content[0].text, "42");
    const lastPageController = new AbortController();
    const lastStarted = other.waitForEvent("console", message => message.text() === "started");
    const last = tool.execute("last-call", { action: "evaluate", text: 'console.log("started"); new Promise(() => {})' }, lastPageController.signal, undefined, ctx);
    const lastRejected = assert.rejects(last, /aborted/);
    await lastStarted;
    lastPageController.abort();
    await lastRejected;
    assert.equal(runtime.sessions.has("cancel-test"), false);
    assert.equal(runtime.activeActions, 0);
  } finally {
    await browser.close();
  }
});
