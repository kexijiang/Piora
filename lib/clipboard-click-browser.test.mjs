import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { buildClipboardUI, clipboardTheme } from "./clipboard-ui-fixture.mjs";
import { setup } from "./clipboard-test-data.mjs";

test("pocket clipboard copies on click with a small transient acknowledgement", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-clipboard-click-"));
  let browser;
  try {
    const { bundle, css } = await buildClipboardUI(directory, { workbench: true });
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://clipboard-click.test/**", route => route.fulfill(route.request().url().endsWith("bundle.js")
      ? { contentType: "text/javascript", body: bundle }
      : { contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${clipboardTheme}${css}</style><div id="root"></div><script>${setup}</script><script src="/bundle.js"></script>` }));
    await page.goto("https://clipboard-click.test/");
    const row = page.locator("#clipboard-row-0");
    await row.waitFor();
    await row.hover();
    assert.equal(await row.evaluate(node => getComputedStyle(node).cursor), "pointer");
    const before = await page.getByRole("listbox").boundingBox();
    await row.click();
    const toast = page.getByRole("status").filter({ hasText: "已复制" });
    await toast.waitFor();
    assert.deepEqual(await page.evaluate(() => window.commands.filter(c => c.type === "copy").map(c => c.ids)), [["row-0"]]);
    assert.deepEqual(await page.getByRole("listbox").boundingBox(), before, "acknowledgement must not shift the list");
    const bounds = await toast.boundingBox();
    assert.ok(bounds.width < 110 && bounds.height < 32);
    assert.equal(await toast.evaluate(node => getComputedStyle(node).pointerEvents), "none");
    await toast.waitFor({ state: "hidden", timeout: 3000 });
    await row.dblclick();
    await toast.waitFor();
    assert.equal(await page.evaluate(() => window.commands.filter(c => c.type === "paste").length), 0);
    assert.equal(await page.evaluate(() => window.commands.filter(c => c.type === "copy").length), 2, "double click must not copy twice");
    await page.locator("#clipboard-row-1").click({ modifiers: ["Control"] });
    await page.getByLabel("选择 产品说明", { exact: true }).check();
    assert.equal(await page.evaluate(() => window.commands.filter(c => c.type === "copy").length), 2, "multi-selection must not copy");
    await toast.waitFor({ state: "hidden", timeout: 3000 });
    await page.evaluate(() => { window.piDesktop.clipboard.historyV2.copy = async () => { throw new Error("copy denied"); }; });
    await row.click();
    await page.getByRole("alert").filter({ hasText: "copy denied" }).waitFor();
    assert.equal(await toast.count(), 0, "failure must not show success");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
