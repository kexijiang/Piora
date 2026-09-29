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

test("device command tabs search all outputs and move text through the clipboard without executing it", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-device-console-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=()=>"export default {}"');
    await writeFile(path.join(root, "stubs.tsx"), "export const InteractiveDeviceShell=()=>null;export const CommandShortcuts=()=>null;export const SmartShellPanel=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {DeviceConsole} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/DeviceConsole.tsx"))};createRoot(document.getElementById("root")).render(<DeviceConsole serial="phone" chinese={false} canControl={true} ensureControl={async()=>"lease"} visible={false}/>);`);
    const aliases = Object.fromEntries(["./InteractiveDeviceShell", "./CommandShortcuts", "../SmartShellPanel"].map(name => [name, path.join(root, "stubs.tsx")]));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { ...aliases, "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const commands = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.clipboardText = "";
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async value => { window.clipboardText = value; },
        readText: async () => window.clipboardText,
      } });
    });
    const bundle = await readFile(path.join(root, "bundle.js"));
    await page.route("https://device-console.test/**", route => {
      const request = route.request();
      if (new URL(request.url()).pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (new URL(request.url()).pathname === "/api/harmony/console") {
        const body = request.postDataJSON(); commands.push(body.command);
        return route.fulfill({ json: { result: { stdout: body.command === "first" ? "needle-one" : "needle-two", stderr: "", exitCode: 0, durationMs: 1 } } });
      }
      return route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("https://device-console.test/");
    const draft = page.getByRole("textbox", { name: "Command (Ctrl+Enter to run)" });
    await draft.fill("first");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByText("needle-one", { exact: true }).waitFor();
    await page.getByRole("button", { name: "+", exact: true }).click();
    await draft.fill("second");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByText("needle-two", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Search all command tabs" }).fill("needle-one");
    await page.getByRole("group", { name: "Cross-tab search results" }).getByRole("button", { name: /Tab 1/ }).click();
    assert.equal(await page.getByRole("tab", { name: "1" }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: "Copy standard output" }).click();
    assert.equal(await page.evaluate(() => window.clipboardText), "needle-one");
    await page.getByRole("tab", { name: "2" }).click();
    await page.getByRole("button", { name: "Paste clipboard into draft" }).click();
    assert.equal(await draft.inputValue(), "needle-one");
    assert.deepEqual(commands, ["first", "second"], "clipboard paste never runs a command");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
