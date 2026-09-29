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

test("Harmony device shell renders live PTY, forwards input and closes with its panel", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-device-terminal-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), "const ts=require(" + JSON.stringify(require.resolve("typescript")) + ");module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText");
    await writeFile(path.join(root, "css.cjs"), 'module.exports=()=>"export default {}"');
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      "import {InteractiveDeviceShell} from " + JSON.stringify(path.join(repo, "components/workspace/harmony/InteractiveDeviceShell.tsx")) + ";",
      'function App(){const [visible,setVisible]=React.useState(true);const [target,setTarget]=React.useState();window.setVisible=setVisible;window.setTarget=setTarget;window.outputs ||= [];return visible?<InteractiveDeviceShell serial="phone" scope={{kind:"shared"}} chinese={false} canControl={true} ensureControl={async()=>"lease"} onOutputChange={output=>window.outputs.push(output)} searchTarget={target}/>:null}',
      'createRoot(document.getElementById("root")).render(<App/>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js", publicPath: "https://device-terminal.test/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 720, height: 600 } });
    const requests = [];
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class {
        constructor() { window.deviceStream = this; setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "snapshot", connected: true, output: "$ " }) }), 10); }
        close() { window.streamClosed = true; }
      };
    });
    const css = await readFile(path.join(repo, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");
    await page.route("https://device-terminal.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/harmony/device-terminal") {
        const body = route.request().postDataJSON(); requests.push(body);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body.action === "start" ? { id: "terminal-id" } : { ok: true }) });
      }
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://device-terminal.test/");
    await page.getByRole("button", { name: "Open device shell" }).click();
    await page.getByText("Connected", { exact: true }).waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => window.outputs.includes("$ "));
    await page.evaluate(() => window.deviceStream.onmessage({ data: JSON.stringify({ type: "output", data: "needle-device\r\n" }) }));
    await page.waitForFunction(() => window.outputs.some(output => output.includes("needle-device")));
    await page.evaluate(() => window.setTarget({ query: "needle-device", revision: 1 }));
    const input = page.locator(".xterm-helper-textarea");
    await input.focus(); await page.keyboard.type("pwd"); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.includes("$"));
    await page.waitForTimeout(100);
    assert.equal(requests.find(item => item.action === "start")?.serial, "phone");
    assert(requests.some(item => item.action === "resize" && item.cols >= 20));
    assert(requests.some(item => item.action === "input" && item.data.includes("p")));
    await page.evaluate(() => window.setVisible(false));
    await page.waitForFunction(() => window.streamClosed === true);
    await page.waitForTimeout(100);
    assert(requests.some(item => item.action === "stop" && item.id === "terminal-id"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
