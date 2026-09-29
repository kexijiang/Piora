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

test("SQLite viewer saves CSV through the browser stream picker and JSON through ordinary download", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-sqlite-viewer-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {SqliteViewer} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/SqliteViewer.tsx"))};createRoot(document.getElementById("root")).render(<SqliteViewer initialPath="C:/workspace/sample.db" chinese={false}/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const actions = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.savedChunks = [];
      window.showSaveFilePicker = function() {
        if (this !== window) throw new Error("file picker receiver was lost");
        return Promise.resolve({ createWritable: async () => new WritableStream({ write: chunk => window.savedChunks.push(...chunk) }) });
      };
    });
    const bundle = await readFile(path.join(root, "bundle.js"));
    await page.route("https://sqlite-viewer.test/**", route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/api/harmony/sqlite") {
        const input = request.postDataJSON(); actions.push(input);
        if (input.action === "export") return route.fulfill({ contentType: input.format === "csv" ? "text/csv" : "application/json", body: input.format === "csv" ? "name\n中文\n" : '[{"name":"中文"}]' });
        const result = { tables: ["sample"], views: [], table: input.action === "read" ? "sample" : undefined,
          columns: ["name"], rows: [["中文"]], fields: [], indexes: [], offset: 0, hasMore: false };
        return route.fulfill({ json: input.action === "open" ? { id: "snapshot-12345678", result } : { result } });
      }
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://sqlite-viewer.test/");
    await page.getByRole("button", { name: "Open database snapshot" }).click();
    await page.getByRole("button", { name: "sample", exact: true }).click();
    await page.getByRole("button", { name: "Export CSV" }).click();
    await page.waitForFunction(() => new TextDecoder().decode(new Uint8Array(window.savedChunks)) === "name\n中文\n");
    assert.equal(actions.filter(action => action.action === "export")[0].table, "sample");
    await page.evaluate(() => { delete window.showSaveFilePicker; });
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON" }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "harmony-database-snapshot.json");
    assert.equal(await readFile(await download.path(), "utf8"), '[{"name":"中文"}]');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
