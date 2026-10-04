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

test("an extensionless discovered SQLite file opens through its opaque catalog id", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-device-database-jump-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "transfer.tsx"), "export const TransferJobs=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import{createRoot}from"react-dom/client";import{DeviceFiles}from"@/components/workspace/harmony/DeviceFiles";window.openedDatabase="";createRoot(document.getElementById("root")).render(<DeviceFiles serial="phone" chinese={false} canControl={false} ensureControl={()=>{throw Error("database navigation must stay read-only")}} initialSandbox={{id:1,bundleName:"com.example.notes"}} onDatabaseOpen={id=>{window.openedDatabase=id}}/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./TransferJobs": path.join(root, "transfer.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const resolves = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://database-jump.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/harmony/apps") return route.fulfill({ json: { applications: [{ bundleName: "com.example.notes", label: "Notes" }] } });
      if (url.pathname === "/api/harmony/databases") {
        const input = request.postDataJSON();
        assert.equal(request.method(), "POST");
        assert.equal(input.action, "resolve");
        resolves.push(input);
        return route.fulfill({ json: { databaseId: input.path === "data/storage/el2/base/database/store" ? "opaque-database-id" : undefined } });
      }
      if (url.pathname === "/api/harmony/files") {
        assert.equal(request.method(), "GET", "file-to-database navigation does not acquire control or mutate the phone");
        const target = url.searchParams.get("path");
        if (url.searchParams.has("stat")) return route.fulfill({ json: { file: { path: target, name: target.split("/").at(-1), kind: "directory" } } });
        const files = target === "data/storage/el2/base" ? [
          { path: "data/storage/el2/base/database", name: "database", kind: "directory", size: 0 },
        ] : target === "data/storage/el2/base/database" ? [
          { path: "data/storage/el2/base/database/store", name: "store", kind: "file", size: 8192 },
        ] : [];
        return route.fulfill({ json: { files, truncated: false } });
      }
      if (url.pathname.startsWith("/api/")) throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#eee;--bg-selected:#edf2ff;--border:#ddd;--text:#222;--text-muted:#555;--text-dim:#777;--accent:#2563eb;--text-xs:12px;--text-base:14px;--font-mono:Consolas,monospace}body{font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://database-jump.test/");
    await page.waitForFunction(() => document.querySelector('[aria-label="Device file or folder path"]')?.value === "data/storage/el2/base"
      && !document.querySelector('[aria-label="Device file or folder path"]')?.disabled);
    const files = page.getByRole("region", { name: "Device files", exact: true });
    const listing = files.getByRole("table", { name: "Current directory files", exact: true });
    await listing.getByRole("button", { name: "database", exact: true }).click();
    await listing.getByRole("button", { name: "store", exact: true }).click();
    const open = files.getByRole("button", { name: "Open in database workbench", exact: true });
    await open.waitFor();
    assert.equal(resolves.at(-1)?.path, "data/storage/el2/base/database/store");
    assert.equal(resolves.at(-1)?.bundleName, "com.example.notes");
    await open.click();
    await page.waitForFunction(() => window.openedDatabase === "opaque-database-id");
    assert.equal(resolves.at(-1)?.path, "data/storage/el2/base/database/store");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
