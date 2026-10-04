import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("device file drafts survive navigation and reload, isolate scopes and reject stale reads", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-file-drafts-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "transfer.tsx"), "export const TransferJobs=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {DeviceFiles} from "@/components/workspace/harmony/DeviceFiles";import * as drafts from "@/lib/harmony/device-file-drafts";window.drafts=drafts;window.copied=[];navigator.clipboard.writeText=text=>{window.copied.push(text);return Promise.resolve()};function Fixture(){const[serial,setSerial]=useState("phone");const[visible,setVisible]=useState(true);window.setSerial=setSerial;window.setVisible=setVisible;return visible?<DeviceFiles serial={serial} chinese={true} canControl={true} ensureControl={()=>window.delayLease?new Promise(resolve=>window.completeLease=()=>resolve("lease")):Promise.resolve("lease")}/>:null};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./TransferJobs": path.join(root, "transfer.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1050, height: 900 } });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const errors = [], writes = [], reads = [], nativeDialogs = [];
    let changed = false, denyText = false, slowText = false, releaseSlow;
    const file = location => ({ path: location, name: location.split("/").at(-1), kind: "file", size: 8 });
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.route("https://device-drafts.test/**", async route => {
      const request = route.request(), url = new URL(request.url()), location = url.searchParams.get("path"), scope = url.searchParams.get("kind");
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/seed") return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><p>Local migration fixture</p>' });
      if (url.pathname.startsWith("/api/harmony/") && request.method() === "GET") reads.push(url.pathname + url.search);
      if (url.pathname === "/api/harmony/apps") return route.fulfill({ json: { applications: [{ bundleName: "com.example.a", label: "A" }, { bundleName: "com.example.b", label: "B" }] } });
      if (url.pathname === "/api/harmony/files") {
        if (location?.includes("missing") && url.searchParams.has("stat")) return route.fulfill({ status: 404, json: { error: "Device file missing" } });
        const base = scope === "sandbox" ? "data/storage/el2/base" : "/data/local/tmp";
        return route.fulfill({ json: url.searchParams.has("stat") ? { file: location.endsWith(".txt") ? file(location) : { path: location, name: "folder", kind: "directory" } }
          : { files: [file(`${base}/notes.txt`), file(`${base}/other.txt`)], truncated: false } });
      }
      if (url.pathname === "/api/harmony/files/text") {
        if (request.method() === "POST") { writes.push(request.postDataJSON()); return route.fulfill({ json: { result: { verification: "passed" } } }); }
        if (slowText) { slowText = false; await new Promise(resolve => releaseSlow = resolve); }
        if (denyText) return route.fulfill({ status: 403, json: { error: "Device text unavailable" } }).catch(() => undefined);
        const text = location.endsWith("other.txt") ? "OTHER" : changed ? "CHANGED" : "ORIGINAL";
        return route.fulfill({ json: { result: { text: `${scope}:${url.searchParams.get("bundleName") ?? ""}:${url.searchParams.get("serial")}:${text}`, hash: changed ? "new-hash" : "original-hash", size: 8, encoding: "utf-8", newline: "lf" } } }).catch(() => undefined);
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` });
    });
    await page.goto("https://device-drafts.test/seed");
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("piora-harmony-file-drafts", 1); request.onupgradeneeded = () => request.result.createObjectStore("drafts"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        for (const serial of ["phone", "other-phone"]) {
          const draft = { serial, scope: { kind: "shared" }, path: "/data/local/tmp/legacy-missing.txt", original: { text: "CAPTURED LEGACY ORIGINAL", hash: "legacy-hash", size: 24, encoding: "utf-8", newline: "none" }, text: serial === "phone" ? "LEGACY RECOVERY DRAFT" : "FOREIGN PRIVATE DRAFT" };
          transaction.objectStore("drafts").put(draft, JSON.stringify([serial, "shared", "", draft.path]));
        }
        transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
      }); db.close();
    });
    await page.goto("https://device-drafts.test/");
    await page.locator(".fileManager").waitFor({ timeout: 5000 }).catch(error => { throw new Error(`Fixture failed to mount: ${errors.join("; ")} (${error.message})`); });
    const editor = page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true });
    const address = page.getByRole("textbox", { name: "设备文件或文件夹路径", exact: true });
    const go = async target => { await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false); await address.fill(target); const textRead = page.waitForResponse(response => new URL(response.url()).pathname === "/api/harmony/files/text" && new URL(response.url()).searchParams.get("path") === target); await page.getByRole("button", { name: "前往", exact: true }).click(); await textRead; await editor.waitFor(); await page.waitForFunction(() => document.querySelector('[aria-label="设备文件编辑草稿"]')?.disabled === false); };
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
    const local = page.getByRole("region", { name: "本机文件草稿", exact: true });
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    const legacy = local.getByRole("button", { name: /legacy-missing\.txt/ });
    await legacy.waitFor();
    const readsBeforeRecovery = reads.length;
    await legacy.click();
    const recovered = local.getByRole("textbox", { name: "本机恢复草稿内容", exact: true });
    await recovered.waitFor();
    assert.equal(await recovered.inputValue(), "LEGACY RECOVERY DRAFT");
    assert.equal(await recovered.isEditable(), false);
    assert.equal(reads.length, readsBeforeRecovery, "opening a migrated draft must not contact the device");
    const recoveryLayout = await local.evaluate(element => {
      const catalog = element.querySelector(".fileDraftCatalog").getBoundingClientRect();
      const recovery = element.querySelector(".fileDraftRecovery").getBoundingClientRect();
      return { catalogRight: catalog.right, recoveryLeft: recovery.left, topDelta: Math.abs(catalog.top - recovery.top) };
    });
    assert.ok(recoveryLayout.recoveryLeft >= recoveryLayout.catalogRight && recoveryLayout.topDelta < 2,
      `a wide draft panel shows the catalog beside its recovery copy: ${JSON.stringify(recoveryLayout)}`);
    assert.equal(await local.getByText(" · 修改时间未知", { exact: false }).count(), 1, "migration does not invent timestamps");
    await local.getByRole("button", { name: "复制恢复草稿", exact: true }).click();
    await page.waitForFunction(() => window.copied.includes("LEGACY RECOVERY DRAFT"));
    await local.getByRole("button", { name: "核对设备文件", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Device file missing" }).waitFor();
    assert.equal(await recovered.inputValue(), "LEGACY RECOVERY DRAFT", "a missing device file must not prevent local recovery");
    await local.getByText("查看采集时原文", { exact: true }).click();
    assert.equal(await local.getByRole("textbox", { name: "草稿采集时原文", exact: true }).inputValue(), "CAPTURED LEGACY ORIGINAL");
    await local.getByRole("button", { name: "放弃这份本机草稿", exact: true }).click();
    await local.getByText("这份本机草稿已放弃；设备文件未更改。", { exact: true }).waitFor();
    assert.equal(await local.getByRole("button", { name: /legacy-missing\.txt/ }).count(), 0);
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await go("/data/local/tmp/notes.txt");
    const original = page.getByRole("textbox", { name: "设备文件采集时原文", exact: true });
    assert.equal(await original.isEditable(), false);
    assert.equal(await original.inputValue(), "shared::phone:ORIGINAL");
    const readsBeforeCompare = reads.length;
    await page.getByRole("button", { name: "原文对照", exact: true }).click();
    assert.equal(await original.count(), 0);
    await page.getByRole("button", { name: "原文对照", exact: true }).click();
    assert.equal(await original.inputValue(), "shared::phone:ORIGINAL");
    assert.equal(reads.length, readsBeforeCompare, "original comparison toggles only the captured local copy");
    await page.setViewportSize({ width: 1450, height: 900 });
    const comparisonLayout = await page.evaluate(() => {
      const source = document.querySelector('[aria-label="设备文件采集时原文"]').getBoundingClientRect();
      const draft = document.querySelector('[aria-label="设备文件编辑草稿"]').getBoundingClientRect();
      return { sourceRight: source.right, draftLeft: draft.left, topDelta: Math.abs(source.top - draft.top) };
    });
    assert.ok(comparisonLayout.draftLeft >= comparisonLayout.sourceRight && comparisonLayout.topDelta < 2,
      `wide file preview offers original and draft side by side: ${JSON.stringify(comparisonLayout)}`);
    await editor.fill("MY SHARED DRAFT 中文");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    assert.equal(await original.inputValue(), "shared::phone:ORIGINAL", "editing never changes the captured original or expected hash");
    await page.getByRole("button", { name: "预览差异", exact: true }).click();
    await page.getByLabel("文本差异预览", { exact: true }).waitFor();
    await editor.fill("MY SHARED DRAFT 中文 renewed");
    assert.equal(await page.getByLabel("文本差异预览", { exact: true }).count(), 0, "editing invalidates the previous diff");
    await editor.fill("MY SHARED DRAFT 中文");
    await editor.scrollIntoViewIfNeeded();
    const toolbar = await page.getByRole("button", { name: "核对原内容并保存", exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect(), bounds = button.closest(".fileDetails").getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, containerTop: bounds.top, containerBottom: bounds.bottom,
        clickable: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
    });
    assert.ok(toolbar.top >= toolbar.containerTop && toolbar.bottom <= toolbar.containerBottom && toolbar.clickable,
      `editing keeps primary actions visible without scrolling below the editor: ${JSON.stringify(toolbar)}`);
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator(".fileManager").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "file-original-draft-wide.png") });
    await page.setViewportSize({ width: 1050, height: 900 });
    await page.evaluate(() => {
      window.originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...args) { if (this.name === "piora-harmony-file-drafts" && (args[1] === "readwrite" || window.failCatalog && args[0] === "catalog")) throw new Error("synthetic quota failure"); return window.originalTransaction.apply(this, args); };
    });
    await editor.fill("PERSISTENCE FAILED DRAFT");
    await page.getByText("本机持久保存失败，草稿仍在当前窗口；关闭前请复制。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false,
      "uncommitted drafts must warn before page destruction");
    await page.getByRole("button", { name: "放弃草稿并重新读取", exact: true }).click();
    await page.getByText("本机持久保存失败，草稿仍在当前窗口；关闭前请复制。", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件编辑草稿"]')?.disabled === false);
    assert.equal(await editor.inputValue(), "PERSISTENCE FAILED DRAFT", "a failed durable discard does not lose the memory draft");
    await page.evaluate(() => window.failCatalog = true);
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await local.getByRole("alert").filter({ hasText: "本机持久存储不可读" }).waitFor();
    await local.getByRole("button", { name: /\/data\/local\/tmp\/notes\.txt/ }).click();
    assert.equal(await recovered.inputValue(), "PERSISTENCE FAILED DRAFT", "an unreadable durable catalog still exposes the current window's draft");
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await page.evaluate(() => window.failCatalog = false);
    await go("/data/local/tmp/other.txt");
    await go("/data/local/tmp/notes.txt");
    assert.equal(await editor.inputValue(), "PERSISTENCE FAILED DRAFT", "storage failures retain the synchronous memory copy");
    await page.evaluate(() => IDBDatabase.prototype.transaction = window.originalTransaction);
    await editor.fill("MY SHARED DRAFT 中文");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    await page.getByRole("button", { name: "notes.txt", exact: true }).click();
    await page.getByText("已恢复本机未保存草稿，设备原内容未变。", { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文");
    await go("/data/local/tmp/other.txt");
    assert.match(await editor.inputValue(), /OTHER$/);
    await go("/data/local/tmp/notes.txt");
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文");
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("sandbox");
    await page.getByRole("combobox", { name: "选择应用（名称或包名）", exact: true }).fill("com.example.a");
    await go("data/storage/el2/base/notes.txt");
    assert.match(await editor.inputValue(), /^sandbox:com.example.a:phone:ORIGINAL$/);
    await editor.fill("APP A DRAFT");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "选择应用（名称或包名）", exact: true }).fill("com.example.b");
    await go("data/storage/el2/base/notes.txt");
    assert.match(await editor.inputValue(), /^sandbox:com.example.b:phone:ORIGINAL$/);
    await page.getByRole("combobox", { name: "选择应用（名称或包名）", exact: true }).fill("com.example.a");
    await go("data/storage/el2/base/notes.txt");
    assert.equal(await editor.inputValue(), "APP A DRAFT");
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("shared");
    await go("/data/local/tmp/notes.txt");
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文");
    await page.reload();
    await page.getByText("已恢复本机未保存草稿，设备原内容未变。", { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文", "IndexedDB survives a completely new module instance");
    await page.evaluate(() => window.setVisible(false));
    await page.locator(".fileManager").waitFor({ state: "detached" });
    await page.evaluate(() => window.setVisible(true));
    await page.getByText("已恢复本机未保存草稿，设备原内容未变。", { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文", "closing and reopening the tools keeps the draft");
    await Promise.all([page.waitForResponse(response => response.url().includes("serial=other-phone") && new URL(response.url()).pathname === "/api/harmony/files"), page.evaluate(() => window.setSerial("other-phone"))]);
    await go("/data/local/tmp/notes.txt");
    assert.match(await editor.inputValue(), /^shared::other-phone:ORIGINAL$/);
    await page.evaluate(() => window.setSerial("phone"));
    await page.getByText("已恢复本机未保存草稿，设备原内容未变。", { exact: true }).waitFor();
    changed = true;
    await page.getByRole("button", { name: "预览文本（最多 2 MiB）", exact: true }).click();
    await page.getByText(/设备文件已变化；保留草稿与原文/).waitFor();
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文");
    assert.equal(await page.getByRole("button", { name: "核对原内容并保存", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "复制草稿", exact: true }).click();
    await page.waitForFunction(() => window.copied.includes("MY SHARED DRAFT 中文"));
    denyText = true;
    await page.getByRole("button", { name: "预览文本（最多 2 MiB）", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Device text unavailable" }).waitFor();
    assert.equal(await editor.inputValue(), "MY SHARED DRAFT 中文", "failed rereads retain both draft and original");
    denyText = false;
    await page.getByRole("button", { name: "放弃草稿并重新读取", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件编辑草稿"]')?.value.endsWith("CHANGED"));
    await editor.fill("NEW DRAFT");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    await page.evaluate(() => window.delayLease = true);
    await page.getByRole("button", { name: "核对原内容并保存", exact: true }).click();
    await page.waitForFunction(() => typeof window.completeLease === "function");
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("sandbox");
    await page.evaluate(() => window.completeLease());
    await page.waitForTimeout(100);
    assert.equal(writes.length, 0, "scope changes cancel a save still waiting for a lease");
    await page.evaluate(() => window.delayLease = false);
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("shared");
    await go("/data/local/tmp/notes.txt");
    assert.equal(await editor.inputValue(), "NEW DRAFT");
    slowText = true;
    await page.getByRole("button", { name: "预览文本（最多 2 MiB）", exact: true }).click();
    while (!releaseSlow) await page.waitForTimeout(10);
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("sandbox");
    releaseSlow();
    await page.waitForTimeout(100);
    assert.equal(await editor.count(), 0, "late shared text cannot appear in the new sandbox");
    await page.getByRole("combobox", { name: "文件范围", exact: true }).selectOption("shared");
    await go("/data/local/tmp/notes.txt");
    await page.getByRole("button", { name: "核对原内容并保存", exact: true }).click();
    await page.getByText("设备已核对新文本哈希；重新打开可查看最新内容。", { exact: true }).waitFor();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].text, "NEW DRAFT"); assert.equal(writes[0].expectedHash, "new-hash");
    await go("/data/local/tmp/notes.txt");
    assert.match(await editor.inputValue(), /CHANGED$/);
    assert.equal(await page.getByRole("button", { name: "核对原内容并保存", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.drafts.readDeviceFileDraft("phone", { kind: "shared" }, "/data/local/tmp/notes.txt")), null,
      "verified save cleared the draft; the copy action can still copy the freshly captured text");
    await editor.fill("DISCARD FROM RECOVERY LIST");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await local.getByRole("button", { name: /\/data\/local\/tmp\/notes\.txt/ }).click();
    assert.equal(await recovered.inputValue(), "DISCARD FROM RECOVERY LIST");
    await editor.fill("NEWER LIVE EDIT");
    await page.getByText("未保存到手机 · 本机草稿已保留", { exact: true }).waitFor();
    await local.getByRole("button", { name: "放弃这份本机草稿", exact: true }).click();
    await local.getByRole("alert").filter({ hasText: "草稿已有新编辑或已变化" }).waitFor();
    assert.equal(await local.getByRole("button", { name: "放弃这份本机草稿", exact: true }).isDisabled(), true);
    assert.equal(await editor.inputValue(), "NEWER LIVE EDIT", "an older recovery copy cannot discard unseen newer edits");
    await local.getByRole("button", { name: "刷新草稿列表", exact: true }).click();
    await local.getByRole("button", { name: /\/data\/local\/tmp\/notes\.txt/ }).click();
    assert.equal(await recovered.inputValue(), "NEWER LIVE EDIT");
    await local.getByRole("button", { name: "放弃这份本机草稿", exact: true }).click();
    await local.getByText("这份本机草稿已放弃；设备文件未更改。", { exact: true }).waitFor();
    assert.equal(await editor.count(), 0, "discarding a recovery copy also clears the matching live editor");
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await go("/data/local/tmp/notes.txt");
    assert.match(await editor.inputValue(), /CHANGED$/);
    const paging = await page.evaluate(async () => {
      const draft = index => ({ serial: "phone", scope: { kind: "shared" }, path: `/data/local/tmp/paging-${String(index).padStart(3, "0")}.txt`, original: { text: "base", hash: "page-hash", size: 4 }, text: `draft-${index}` });
      await Promise.all(Array.from({ length: 112 }, (_, index) => window.drafts.rememberDeviceFileDraft(draft(index))));
      const discard = window.drafts.forgetDeviceFileDraft("phone", { kind: "shared" }, draft(0).path);
      const replaced = window.drafts.rememberDeviceFileDraft({ ...draft(0), text: "NEWER EDIT MUST SURVIVE" });
      const settled = await Promise.allSettled([discard, replaced]);
      const newest = await window.drafts.readDeviceFileDraft("phone", { kind: "shared" }, draft(0).path);
      const originalTransaction = IDBDatabase.prototype.transaction;
      let textReads = 0;
      IDBDatabase.prototype.transaction = function(names, mode, ...rest) { if (mode === "readonly" && (names === "drafts" || Array.isArray(names) && names.includes("drafts"))) textReads++; return originalTransaction.call(this, names, mode, ...rest); };
      const pages = [], keys = []; let after;
      do { const result = await window.drafts.listDeviceFileDrafts("phone", after); pages.push(result.entries.length); keys.push(...result.entries.map(entry => entry.key)); after = result.next; } while (after);
      IDBDatabase.prototype.transaction = originalTransaction;
      return { pages, keys, textReads, discardStatus: settled[0].status, newest: newest.text };
    });
    assert.deepEqual(paging.pages, [50, 50, 13]);
    assert.equal(new Set(paging.keys).size, 113, "metadata pages have neither duplicates nor missing drafts");
    assert.equal(paging.textReads, 0, "listing reads metadata only, never all edited bodies");
    assert.equal(paging.discardStatus, "rejected"); assert.equal(paging.newest, "NEWER EDIT MUST SURVIVE");
    await local.getByRole("button", { name: /^本机草稿/ }).click();
    await local.getByText("第 1 页，本页 50 份；每页最多 50 份", { exact: true }).waitFor();
    assert.equal(await local.getByRole("list", { name: "本机草稿列表", exact: true }).getByRole("button").count(), 50);
    await local.getByRole("button", { name: "下一页草稿", exact: true }).click();
    await local.getByRole("button", { name: /paging-049\.txt/ }).waitFor();
    await local.getByRole("button", { name: "下一页草稿", exact: true }).click();
    await local.getByRole("button", { name: /paging-111\.txt/ }).waitFor();
    assert.equal(await local.getByRole("button", { name: "下一页草稿", exact: true }).isDisabled(), true);
    await local.getByRole("button", { name: "上一页草稿", exact: true }).click();
    await local.getByText("第 2 页，本页 50 份；每页最多 50 份", { exact: true }).waitFor();
    await local.getByRole("button", { name: "上一页草稿", exact: true }).click();
    await local.getByText("第 1 页，本页 50 份；每页最多 50 份", { exact: true }).waitFor();
    assert.equal(await local.getByRole("button", { name: "上一页草稿", exact: true }).isDisabled(), true);
    await page.setViewportSize({ width: 360, height: 800 });
    assert.equal(await page.locator(".fileTextEditor").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true,
      "original comparison and primary editing actions stay within a narrow device panel");
    assert.equal(await page.locator(".fileDrafts").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true,
      "draft recovery controls stay within a narrow device panel");
    assert.deepEqual(nativeDialogs, [], "explicit draft actions never open a native confirmation");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});

test("file jumps preserve a visible address and reveal offscreen actions inside the actual drawer viewport", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-file-reveal-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "transfer.tsx"), "export const TransferJobs=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {DeviceFiles} from "@/components/workspace/harmony/DeviceFiles";
      createRoot(document.getElementById("root")).render(<main className="root" data-maximized="true" style={{position:"fixed",top:40,left:20,width:"calc(100vw - 40px)",height:"calc(100vh - 80px)"}}>
        <div className="workspace"><section className="toolDrawer" data-tab="files"><div className="drawerHeading">真实工具布局夹具</div><div className="drawerTabs"><button>文件</button></div>
          <div className="drawerBody"><DeviceFiles serial="phone" chinese canControl={true} ensureControl={()=>Promise.resolve("lease")} initialSandbox={{id:1,bundleName:"com.example.fixture"}} onDatabaseOpen={()=>{}}/></div>
        </section></div></main>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./TransferJobs": path.join(root, "transfer.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1450, height: 900 } });
    const bundle = await readFile(path.join(root, "bundle.js")), css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const errors = [], textReads = [];
    let largeParent = false, nextTextReadGate;
    const base = "data/storage/el2/base";
    const entry = target => ({ path: target, name: target.split("/").at(-1), kind: /\.(?:txt|db)$/.test(target) ? "file" : "directory", size: 8 });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://file-reveal.test/**", async route => {
      const request = route.request(), url = new URL(request.url()), location = url.searchParams.get("path");
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/harmony/apps") return route.fulfill({ json: { applications: [{ bundleName: "com.example.fixture" }] } });
      if (url.pathname === "/api/harmony/databases") {
        assert.equal(request.postDataJSON()?.action, "resolve");
        return route.fulfill({ json: { databaseId: "fixture-db-id" } });
      }
      if (url.pathname === "/api/harmony/files") return route.fulfill({ json: url.searchParams.has("stat") ? { file: entry(location) }
        : { files: [entry(`${base}/sample.db`), entry(`${base}/notes.txt`), ...(largeParent
          ? [entry(`${base}/delayed.txt`), ...Array.from({ length: 80 }, (_, index) => entry(`${base}/folder-${index}`))] : [])], truncated: false } });
      if (url.pathname === "/api/harmony/files/text") {
        assert.equal(request.method(), "GET"); textReads.push(location);
        const gate = nextTextReadGate; nextTextReadGate = undefined;
        if (gate) { gate.started(); await gate.wait; }
        return route.fulfill({ json: { result: { text: "READ ONLY FIXTURE", hash: "fixture-hash", size: 17, encoding: "utf-8", newline: "none" } } });
      }
      assert.ok(!url.pathname.startsWith("/api/"), "preview revealing must not write or acquire control");
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#eee;--bg-selected:#edf2ff;--border:#ddd;--text:#222;--text-muted:#555;--text-dim:#777;--accent:#2563eb;--text-xs:12px;--text-base:14px;--font-mono:Consolas,monospace}body{margin:0;overflow:hidden;font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://file-reveal.test/");
    const address = page.getByRole("textbox", { name: "设备文件或文件夹路径", exact: true });
    const drawer = page.locator(".drawerBody"), actions = page.getByRole("group", { name: "文件编辑操作", exact: true });
    const actualVisibility = locator => locator.evaluate(element => {
      const rect = element.getBoundingClientRect(), viewport = element.closest(".drawerBody").getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 30), y = rect.top + rect.height / 2;
      return { top: rect.top, bottom: rect.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom,
        withinWindow: rect.top >= 0 && rect.bottom <= innerHeight,
        visible: rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1 && element.contains(document.elementFromPoint(x, y)) };
    });
    const go = async target => {
      await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
      await address.fill(target); await page.getByRole("button", { name: "前往", exact: true }).click();
      await page.waitForFunction(target => document.querySelector('[aria-label="选中项详情"]')?.dataset.path === target
        && ![...document.querySelectorAll("button")].some(button => button.textContent === "取消当前操作"), target);
      if (target.endsWith(".txt")) await actions.waitFor();
      else await page.getByRole("button", { name: "在数据库工作台打开", exact: true }).waitFor();
    };
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
    await drawer.evaluate(element => element.scrollTop = 0);
    await go(`${base}/sample.db`);
    assert.equal(await drawer.evaluate(element => element.scrollTop), 0, "already-visible short preview controls must not scroll away the path and tree heading");
    assert.equal((await actualVisibility(address)).visible, true, "the actual path bar remains visible below the fixed tool heading");
    assert.equal((await actualVisibility(page.getByRole("navigation", { name: "当前位置", exact: true }))).visible, true);
    assert.equal((await actualVisibility(page.getByRole("button", { name: "在数据库工作台打开", exact: true }))).visible, true);
    await go(`${base}/notes.txt`);
    assert.equal((await actualVisibility(address)).visible, true, "async text preview must preserve a path which shares the visible viewport with its actions");
    assert.equal((await actualVisibility(actions)).visible, true);

    // A short drawer is wholly inside the browser window: window-only bounds
    // would incorrectly consider these clipped actions visible behind/below the
    // fixed tool controls. Reselecting the cached file must still reveal them.
    await page.locator("main.root").evaluate(element => element.style.height = "380px");
    await drawer.evaluate(element => element.scrollTop = 0);
    const clipped = await actualVisibility(actions);
    assert.equal(clipped.withinWindow, true); assert.equal(clipped.visible, false);
    const readsBeforeReselect = textReads.length;
    await page.locator(".fileListing").getByRole("button", { name: /^notes\.txt/ }).click();
    assert.equal((await actualVisibility(actions)).visible, true, "cached preview actions must scroll into the real overflow ancestor, below its tool heading");
    assert.equal(textReads.length, readsBeforeReselect, "revealing the selected cached file does not refetch or lose its draft");
    assert.ok(await drawer.evaluate(element => element.scrollTop > 0));

    await page.locator("main.root").evaluate(element => element.style.height = "calc(100vh - 80px)");
    await page.setViewportSize({ width: 480, height: 900 });
    await drawer.evaluate(element => element.scrollTop = 0);
    largeParent = true;
    // Separate the metadata commit/path-jump completion from the actual text
    // response, both for a new file and a forced refresh of its cached preview.
    for (const stage of ["new selection", "forced cached path jump"]) {
      let release, started;
      const began = new Promise(resolve => { started = resolve; });
      nextTextReadGate = { started, wait: new Promise(resolve => { release = resolve; }) };
      const navigation = go(`${base}/delayed.txt`);
      await began;
      await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
      assert.equal(await page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true }).count(), 0,
        `${stage}: metadata/path-jump completion must remain separate from the held text preview`);
      release(); await navigation;
      assert.equal((await actualVisibility(page.getByRole("button", { name: "核对原内容并保存", exact: true }))).visible, true,
        `${stage}: the actual save button must be hit-testable inside the narrow overflow viewport after delayed text arrives`);
    }
    largeParent = false;
    await go(`${base}/notes.txt`);
    assert.equal((await actualVisibility(actions)).visible, true, "a narrow stacked preview still reaches its primary actions after a path jump");
    assert.ok(await drawer.evaluate(element => element.scrollTop > 0));
    assert.equal(await page.locator(".fileManager").evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    const row = page.locator(".fileListing").getByRole("button", { name: /^notes\.txt/ });
    await row.focus(); await page.keyboard.press("Shift+F10");
    await page.getByRole("menu").waitFor(); await page.keyboard.press("Escape");
    assert.equal(await row.evaluate(element => document.activeElement === element), true, "context-menu dismissal retains its existing row focus behavior");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
