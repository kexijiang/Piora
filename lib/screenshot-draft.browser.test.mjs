import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const root = path.resolve(import.meta.dirname, "..");

test("captured images are durably appended once without replacing text or files", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-screenshot-draft-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "entry.ts"), `import{appendCapturedImageToDraft,hydrateDraft,setDraft,SCREENSHOT_DRAFT_UPDATED_EVENT}from${JSON.stringify(path.join(root, "lib", "draft-store.ts"))};window.captureDraft={appendCapturedImageToDraft,hydrateDraft,setDraft,SCREENSHOT_DRAFT_UPDATED_EVENT};`);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.ts"),
      output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".ts", ".js"], modules: [path.join(root, "node_modules")] },
      module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => (
      error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()
    ))));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("http://localhost:31998/**", (route) => route.request().url().endsWith("/bundle.js")
      ? route.fulfill({ body: bundle, contentType: "application/javascript" })
      : route.fulfill({ body: '<div id="root"></div><script src="/bundle.js"></script>', contentType: "text/html" }));
    await page.goto("http://localhost:31998/");
    const result = await page.evaluate(async () => {
      const key = "draft:target";
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("piora-composer", 1);
        request.onupgradeneeded = () => { request.result.createObjectStore("drafts"); request.result.createObjectStore("replies", { keyPath: "key" }); };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put({ value: "keep my text", images: [], files: [{ name: "note.txt", size: 4, text: "note" }] }, key);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      const events = [];
      window.addEventListener(window.captureDraft.SCREENSHOT_DRAFT_UPDATED_EVENT, (event) => events.push(event.detail.captureId));
      await window.captureDraft.appendCapturedImageToDraft(key, "capture-1", data);
      await window.captureDraft.appendCapturedImageToDraft(key, "capture-1", data);
      await window.captureDraft.appendCapturedImageToDraft(key, "capture-2", data);
      const raceKey = "draft:race";
      window.captureDraft.setDraft(raceKey, { value: "before", images: [], files: [] });
      const attaching = window.captureDraft.appendCapturedImageToDraft(raceKey, "capture-race", data);
      window.captureDraft.setDraft(raceKey, { value: "edited during capture", images: [], files: [] });
      await attaching;
      await new Promise((resolve) => setTimeout(resolve, 50));
      const raceDraft = await window.captureDraft.hydrateDraft(raceKey);
      const draft = await window.captureDraft.hydrateDraft(key);
      const stored = await new Promise((resolve, reject) => {
        const request = indexedDB.open("piora-composer", 1);
        request.onsuccess = () => {
          const read = request.result.transaction("drafts").objectStore("drafts").get(key);
          read.onsuccess = () => { resolve(read.result); request.result.close(); };
          read.onerror = () => reject(read.error);
        };
        request.onerror = () => reject(request.error);
      });
      const raceStored = await new Promise((resolve, reject) => {
        const request = indexedDB.open("piora-composer", 1);
        request.onsuccess = () => {
          const read = request.result.transaction("drafts").objectStore("drafts").get(raceKey);
          read.onsuccess = () => { resolve(read.result); request.result.close(); };
          read.onerror = () => reject(read.error);
        };
        request.onerror = () => reject(request.error);
      });
      return { draft, stored, events, raceDraft, raceStored };
    });
    assert.equal(result.draft.value, "keep my text");
    assert.deepEqual(result.draft.files, [{ name: "note.txt", size: 4, text: "note" }]);
    assert.deepEqual(result.draft.images.map((image) => image.captureId), ["capture-1", "capture-2"]);
    assert.deepEqual(result.stored, result.draft);
    assert.deepEqual(result.events, ["capture-1", "capture-2", "capture-race"]);
    assert.equal(result.raceDraft.value, "edited during capture");
    assert.deepEqual(result.raceDraft.images.map((image) => image.captureId), ["capture-race"]);
    assert.deepEqual(result.raceStored, result.raceDraft);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
});
