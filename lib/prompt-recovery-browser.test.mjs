import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import ts from "typescript";

test("real browser recovery transactions survive reload with full text and attachments", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://recovery.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Prompt recovery test</title>" }));
    await page.goto("http://recovery.test/");
    const source = await readFile(new URL("./prompt-recovery.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const script = `${compiled}\nwindow.recovery = {savePendingPrompt,readPendingPrompts,confirmPendingPrompts,mergePendingPrompts};`;
    await page.addScriptTag({ type: "module", content: script });
    const record = { id: "send-1", scope: "session", message: { role: "user", content: "preview", timestamp: 1 }, draft: { value: "完整原文\n".repeat(20000), images: [{ data: "YWJj", mimeType: "image/png" }], files: [{ name: "日志.txt", text: "完整附件", size: 12 }] } };
    await page.evaluate((record) => window.recovery.savePendingPrompt(record), record);
    await page.reload();
    await page.addScriptTag({ type: "module", content: script });
    assert.deepEqual(await page.evaluate(() => window.recovery.readPendingPrompts("session")), [record]);
    const failed = await page.evaluate(async () => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = () => { throw new DOMException("Storage full", "QuotaExceededError"); };
      try { await window.recovery.savePendingPrompt({ id: "send-2", scope: "session" }); return false; }
      catch { return true; } finally { IDBObjectStore.prototype.put = put; }
    });
    assert.equal(failed, true);
    assert.deepEqual(await page.evaluate(() => window.recovery.readPendingPrompts("session")), [record]);
    // A completed command's disk receipt clears only that exact recovery copy.
    const command = { ...record, id: "command-send", draft: { value: "/example", images: [], files: [] } };
    await page.evaluate((command) => window.recovery.savePendingPrompt(command), command);
    const recovered = await page.evaluate(async () => {
      const pending = await window.recovery.readPendingPrompts("session");
      const result = window.recovery.mergePendingPrompts([], [], pending, ["command-send"]);
      await window.recovery.confirmPendingPrompts(result.confirmedIds);
      return result;
    });
    assert.deepEqual(recovered.confirmedIds, [command.id]);
    assert.equal(recovered.messages.length, 1);
    await page.reload();
    await page.addScriptTag({ type: "module", content: script });
    assert.deepEqual(await page.evaluate(() => window.recovery.readPendingPrompts("session")), [record]);
  } finally { await browser.close(); }
});
