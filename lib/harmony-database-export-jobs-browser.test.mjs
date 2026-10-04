import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("database export task page keeps results visible and saves a completed artifact", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-db-export-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css-loader.cjs"), `module.exports=()=>"module.exports = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });"`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {DatabaseExportJobs} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/DatabaseExportJobs.tsx"))};createRoot(document.getElementById("root")).render(<DatabaseExportJobs serial="phone" chinese={false}/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.module\.css$/, use: path.join(root, "css-loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.savedChunks = [];
      window.showSaveFilePicker = function() {
        if (this !== window) throw new Error("file picker receiver was lost");
        return Promise.resolve({ createWritable: async () => new WritableStream({ write: chunk => window.savedChunks.push(...chunk) }) });
      };
    });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const completed = { id: "12345678-1234-1234-1234-123456789abc", serial: "phone", source: "Notes / sample.db / sample", format: "csv", range: "page", offset: 200,
      encoding: "utf-8", status: "completed", rows: 3, bytes: 14, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" };
    const running = { ...completed, id: "87654321-4321-4321-4321-cba987654321", status: "running", rows: undefined, bytes: undefined };
    const jobs = [completed, running];
    await page.route("https://db-export.test/**", route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/harmony/database-exports") {
        requests.push({ method: request.method(), query: url.searchParams.toString() });
        if (url.searchParams.has("download")) return route.fulfill({ contentType: "text/csv", body: "id,note\n1,中文\n" });
        if (request.method() === "DELETE") {
          const job = jobs.find(item => item.id === url.searchParams.get("id"));
          if (url.searchParams.get("remove") === "1") jobs.splice(jobs.indexOf(job), 1);
          else if (job) job.status = "cancelled";
          return route.fulfill({ json: { job } });
        }
        return route.fulfill({ json: { jobs } });
      }
      return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#f0f0f1;--border:#e4e4e7;--text:#18181b;--text-muted:#52525b;--text-dim:#71717a;--accent:#2563eb;--text-xs:12px;--text-sm:13px;--text-base:14px}html,body,#root{height:100%;margin:0}body{font:14px system-ui,sans-serif;background:#f4f4f5}#root{width:100%;padding:24px;box-sizing:border-box}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://db-export.test/");
    await page.getByText("Notes / sample.db / sample", { exact: false }).first().waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-export-tasks.png") });
    }
    await page.getByRole("button", { name: "Download result…" }).click();
    await page.waitForFunction(() => new TextDecoder().decode(new Uint8Array(window.savedChunks)) === "id,note\n1,中文\n");
    await page.getByText("Saved harmony-database-12345678.csv").waitFor();
    await page.getByRole("button", { name: "Cancel export" }).click();
    await page.getByText("Cancelled", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Remove job record" }).first().click();
    await page.getByRole("button", { name: "Download result…" }).waitFor({ state: "detached" });
    assert.ok(requests.some(request => request.query.includes(`download=${completed.id}`)));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
