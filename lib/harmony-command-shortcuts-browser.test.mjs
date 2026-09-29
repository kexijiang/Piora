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

test("Harmony shortcuts preview parameters and import without executing", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-harmony-shortcuts-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), "const ts=require(" + JSON.stringify(require.resolve("typescript")) + ");module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText");
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      "import {CommandShortcuts} from " + JSON.stringify(path.join(repo, "components/workspace/harmony/CommandShortcuts.tsx")) + ";",
      'window.filled=[];createRoot(document.getElementById("root")).render(<CommandShortcuts serial="phone" chinese={false} busy={false} currentCommand="pwd" currentKind="shared" currentBundleName="" onFillDevice={(command,kind,bundleName)=>window.filled.push({command,kind,bundleName})} onOpenLocalTerminal={()=>{window.openedLocal=true}}/>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js", publicPath: "https://shortcuts.test/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 720, height: 650 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("piora-harmony-command-shortcuts:phone", JSON.stringify([
      { id: "first", name: "Show file", group: "Files", target: "device", kind: "shared", command: "cat {{path}}", favorite: true },
    ])));
    await page.route("https://shortcuts.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://shortcuts.test/");
    await page.getByText("Command shortcuts").click();
    await page.getByRole("button", { name: "Show file", exact: true }).click();
    await page.getByLabel("path").fill("hello world");
    await page.getByText("cat 'hello world'").waitFor();
    assert.deepEqual(await page.evaluate(() => window.filled), []);
    await page.getByRole("button", { name: "Fill device command" }).click();
    assert.deepEqual(await page.evaluate(() => window.filled), [{ command: "cat 'hello world'", kind: "shared", bundleName: "" }]);
    const archive = JSON.stringify({ format: "piora-harmony-shortcuts", version: 1, shortcuts: [
      { id: "second", name: "Next", group: "Files", target: "device", kind: "shared", command: "pwd", favorite: false },
    ] });
    await page.locator('input[type="file"]').setInputFiles({ name: "shortcuts.json", mimeType: "application/json", buffer: Buffer.from(archive) });
    await page.getByRole("button", { name: "Next", exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.filled)).length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
