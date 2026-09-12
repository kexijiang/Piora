import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright-core";
import ts from "typescript";
test("browser backup preserves custom background blobs and original drafts across restore/reload; quota failures roll back", async () => {
  const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const storage = compile(await readFile(new URL("./reply-storage.ts", import.meta.url), "utf8"));
  const storageUrl = `data:text/javascript;base64,${Buffer.from(storage).toString("base64")}`;
  const draft = compile(await readFile(new URL("./draft-store.ts", import.meta.url), "utf8")).replace('"./reply-storage"', JSON.stringify(storageUrl));
  const draftUrl = `data:text/javascript;base64,${Buffer.from(draft).toString("base64")}`;
  const source = compile(await readFile(new URL("./app-backup-client.ts", import.meta.url), "utf8")).replace('"./draft-store"', JSON.stringify(draftUrl));
  const script = `${source}\nimport {setDraft,getDraft} from ${JSON.stringify(draftUrl)};window.backupClient={snapshotClientBackup,restoreClientBackup,setDraft,getDraft};`;
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage(); await page.route("http://backup.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Backup test</title>" })); await page.goto("http://backup.test"); await page.addScriptTag({ type: "module", content: script });
    const snapshot = await page.evaluate(async () => {
      localStorage.setItem("pi-theme", "dark"); localStorage.setItem("unrelated", "keep");
      window.backupClient.setDraft("session", { value: "  原文\n".repeat(10000), images: [{ data: "YWJj", mimeType: "image/png" }], files: [{ name: "材料", size: 12, text: "附件原文" }] });
      await window.backupClient.snapshotClientBackup();
      // A draft not loaded into memory must still be present in the backup.
      await new Promise((resolve, reject) => { const r = indexedDB.open("piora-composer"); r.onsuccess = () => { const db = r.result; const tx = db.transaction("drafts", "readwrite"); tx.objectStore("drafts").put({ value: "未打开的草稿", images: [], files: [], replySpans: [] }, "unopened"); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; }; });
      await new Promise((resolve, reject) => { const request = indexedDB.open("piora-appearance", 1); request.onsuccess = () => { const db = request.result; const tx = db.transaction("backgrounds", "readwrite"); tx.objectStore("backgrounds").put({ id: "active", blob: new Blob(["image-bytes"], { type: "image/png" }) }); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; }; });
      return window.backupClient.snapshotClientBackup();
    });
    assert.equal(snapshot.drafts.find(([key]) => key === "unopened")?.[1].value, "未打开的草稿");
    await page.evaluate(async (snapshot) => { localStorage.setItem("pi-theme", "light"); await window.backupClient.restoreClientBackup(snapshot); }, snapshot);
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-theme")), "dark"); assert.equal(await page.evaluate(() => localStorage.getItem("unrelated")), "keep");
    await page.reload(); await page.addScriptTag({ type: "module", content: script });
    assert.deepEqual(await page.evaluate(() => window.backupClient.getDraft("session")), snapshot.drafts[0][1]);
    const restored = await page.evaluate(() => window.backupClient.snapshotClientBackup()); assert.deepEqual(restored.databases, snapshot.databases);
    const failure = await page.evaluate(async (snapshot) => {
      const original = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === "pi-theme" && value === "fail-quota") throw new DOMException("Full", "QuotaExceededError"); return original.call(this, key, value); };
      try { await window.backupClient.restoreClientBackup({ ...snapshot, local: { ...snapshot.local, "pi-theme": "fail-quota" }, databases: snapshot.databases.map((entry) => ({ ...entry, records: [] })) }); return false; } catch { return true; } finally { Storage.prototype.setItem = original; }
    }, snapshot);
    assert.equal(failure, true); assert.equal(await page.evaluate(() => localStorage.getItem("pi-theme")), "dark"); assert.deepEqual((await page.evaluate(() => window.backupClient.snapshotClientBackup())).databases, snapshot.databases);
  } finally { await browser.close(); }
});
