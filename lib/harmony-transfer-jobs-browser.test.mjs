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

test("background transfer UI queues reviewed paths and can cancel a listed task", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-transfers-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), "const ts=require(" + JSON.stringify(require.resolve("typescript")) + ");module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText");
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      "import {TransferJobs} from " + JSON.stringify(path.join(repo, "components/workspace/harmony/TransferJobs.tsx")) + ";",
      'createRoot(document.getElementById("root")).render(<TransferJobs serial="phone" scope={{kind:"shared"}} deviceDirectory="/data/local/tmp" cwd="C:\\workspace" selectedFiles={[{path:"/data/local/tmp/a.txt",name:"a.txt",kind:"file"}]} chinese={false} canControl={true} ensureControl={async()=>"manual-token"} onDownloadsQueued={()=>{window.downloadQueued=true}}/>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js", publicPath: "https://transfers.test/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const posted = [], cancelled = [], jobs = [];
    await page.route("https://transfers.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname === "/api/harmony/transfers" && route.request().method() === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobs }) });
      if (url.pathname === "/api/harmony/transfers" && route.request().method() === "POST") {
        const body = JSON.parse(route.request().postData()); posted.push(body);
        const job = { id: `job-${posted.length}`, serial: "phone", scope: body.scope, status: "queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          completedItems: 0, totalItems: body.items.length, completedBytes: 0, items: body.items.map(item => ({ ...item, status: "queued" })) };
        jobs.unshift(job);
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ job }) });
      }
      if (url.pathname === "/api/harmony/transfers" && route.request().method() === "DELETE") {
        cancelled.push(url.searchParams.get("id")); const job = jobs.find(item => item.id === cancelled.at(-1)); if (job) job.status = "cancelled";
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ job }) });
      }
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://transfers.test/");
    await page.getByRole("button", { name: "Download 1 selected files" }).click();
    await page.getByText("Queued transfer: job-1").waitFor();
    assert.deepEqual(posted[0].items, [{ direction: "download", path: "/data/local/tmp/a.txt", destinationPath: "C:\\workspace\\a.txt" }]);
    assert.equal(posted[0].leaseToken, undefined);
    await page.getByLabel("Local upload paths (one per line)").fill("C:\\workspace\\b.txt");
    await page.getByRole("button", { name: "Upload this batch" }).click();
    await page.getByText("Queued transfer: job-2").waitFor();
    assert.equal(posted[1].leaseToken, "manual-token");
    assert.deepEqual(posted[1].items, [{ direction: "upload", sourcePath: "C:\\workspace\\b.txt", path: "/data/local/tmp/b.txt", overwrite: false }]);
    await page.getByRole("button", { name: "Cancel" }).first().click();
    assert.deepEqual(cancelled, ["job-2"]);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
