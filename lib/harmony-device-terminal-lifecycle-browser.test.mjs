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
const origin = "https://device-terminal-lifecycle.test";
const pause = () => new Promise(resolve => setTimeout(resolve, 150));

test("device terminal lifecycle and paste behavior in the rendered workbench", {
  skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 150_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-device-terminal-lifecycle-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=()=>"export default {}"');
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      `import {DeviceShellTabs} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/DeviceShellTabs.tsx"))};`,
      'function App(){const [shown,setShown]=React.useState(true);const [target,setTarget]=React.useState();window.setShown=setShown;window.setTarget=setTarget;window.outputSnapshots ||= [];return shown?<DeviceShellTabs serial="phone" scope={{kind:"shared"}} chinese={false} canControl={true} ensureControl={async()=>"lease"} onOutputsChange={value=>window.outputSnapshots.push(value)} searchTarget={target}/>:null}',
      'createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js", publicPath: `${origin}/` },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const css = await readFile(path.join(repo, "node_modules/@xterm/xterm/css/xterm.css"), "utf8");

    const fixture = async () => {
      const page = await browser.newPage({ viewport: { width: 1000, height: 850 } });
      const requests = [], errors = [], sessions = new Map();
      let nextId = 0;
      let holdNext = null;
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        window.terminalStreams = {};
        window.piDesktop = { clipboard: {
          readText: async () => { window.desktopClipboardReads = (window.desktopClipboardReads || 0) + 1; return window.clipboardText || ""; },
          writeText: async text => { window.copiedText = text; },
        } };
        window.EventSource = class {
          constructor(url) {
            this.id = new URL(url, location.href).searchParams.get("id");
            this.closed = false;
            (window.terminalStreams[this.id] ||= []).push(this);
            setTimeout(() => { if (!this.closed) this.emit({ type: "snapshot", connected: true, output: `$ ${this.id}\r\n` }); }, 10);
          }
          emit(message) { if (!this.closed) this.onmessage?.({ data: JSON.stringify(message) }); }
          close() { this.closed = true; }
        };
      });
      await page.route(`${origin}/**`, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/api/harmony/device-terminal") {
          const body = request.postDataJSON();
          requests.push(body);
          let failure;
          if (holdNext?.action === body.action) {
            const held = holdNext;
            holdNext = null;
            held.seen(body);
            failure = await held.releasePromise;
          }
          if (failure) return route.fulfill({ status: failure.status, json: { error: { message: failure.message } } });
          if (body.action === "start") {
            const existing = [...sessions.values()].find(item => item.clientTerminalId === body.clientTerminalId);
            const session = existing ?? { id: `pty-${++nextId}`, clientTerminalId: body.clientTerminalId };
            sessions.set(session.id, session);
            return route.fulfill({ json: { id: session.id } });
          }
          if (body.action === "stop") sessions.delete(body.id);
          return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
        return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      });
      await page.goto(`${origin}/`);
      const hold = action => {
        let release, seen;
        const releasePromise = new Promise(resolve => { release = resolve; });
        const seenPromise = new Promise(resolve => { seen = resolve; });
        holdNext = { action, releasePromise, seen };
        return { release, seen: seenPromise };
      };
      const panel = () => page.getByRole("tabpanel");
      const open = async () => {
        await panel().getByRole("button", { name: "Open device shell", exact: true }).click();
        await panel().getByText("Connected", { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('[role="tabpanel"]:not([hidden]) .xterm-helper-textarea'));
        return requests.filter(item => item.action === "start").at(-1);
      };
      const emit = async (id, message) => page.evaluate(({ id, message }) => window.terminalStreams[id].at(-1).emit(message), { id, message });
      const detach = async () => {
        await page.evaluate(() => window.setShown(false));
        await pause();
        assert.deepEqual(errors, []);
        await page.close();
      };
      return { page, requests, errors, sessions, hold, panel, open, emit, detach };
    };

    await t.test("close waits for exactly one acknowledged stop before reopening", async () => {
      const f = await fixture();
      try {
        await f.open();
        const held = f.hold("stop");
        await f.panel().getByRole("button", { name: "Close device shell", exact: true }).click();
        assert.equal((await held.seen).id, "pty-1");
        await pause();
        assert.equal(await f.panel().getByRole("button", { name: "Close device shell", exact: true }).isDisabled(), true);
        assert.equal(await f.panel().getByRole("button", { name: "Open device shell", exact: true }).count(), 0);
        assert.equal(f.requests.filter(item => item.action === "stop").length, 1);
        assert.equal(f.requests.filter(item => item.action === "start").length, 1);
        held.release();
        await f.panel().getByRole("button", { name: "Open device shell", exact: true }).waitFor();
        await f.open();
        assert.deepEqual([...f.sessions.keys()], ["pty-2"]);
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-1").length, 1);
        const closing = f.hold("stop");
        await f.panel().getByRole("button", { name: "Close device shell", exact: true }).click();
        await closing.seen;
        await f.page.evaluate(() => window.setShown(false));
        await pause();
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-2").length, 1, "teardown shares an in-flight explicit stop");
        closing.release();
        await pause();
        await f.detach();
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-2").length, 1);
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });

    await t.test("a failed close keeps its session identity and offers a safe retry", async () => {
      const f = await fixture();
      try {
        await f.open();
        const held = f.hold("stop");
        await f.panel().getByRole("button", { name: "Close device shell", exact: true }).click();
        await held.seen;
        held.release({ status: 500, message: "Stop not confirmed" });
        await f.page.getByRole("alert").filter({ hasText: "Stop not confirmed" }).waitFor();
        assert.equal(await f.panel().getByRole("button", { name: "Open device shell", exact: true }).count(), 0);
        assert.deepEqual([...f.sessions.keys()], ["pty-1"]);
        await f.panel().getByRole("button", { name: "Close device shell", exact: true }).click();
        await f.panel().getByRole("button", { name: "Open device shell", exact: true }).waitFor();
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-1").length, 2);
        await f.open();
        assert.deepEqual([...f.sessions.keys()], ["pty-2"]);
        await f.detach();
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });

    await t.test("stream failure exposes reconnect, preserves prior output, and retires only the old PTY", async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.emit("pty-1", { type: "output", data: "prior-command-output\r\n" });
        await f.page.waitForFunction(() => window.outputSnapshots.at(-1)?.[0]?.output.includes("prior-command-output"));
        await f.page.evaluate(() => window.terminalStreams["pty-1"].at(-1).onerror());
        const held = f.hold("stop");
        await f.panel().getByRole("button", { name: "Reconnect a new session" }).click();
        await held.seen;
        await pause();
        assert.equal(f.requests.filter(item => item.action === "start").length, 1);
        assert.equal(f.requests.filter(item => item.action === "stop").length, 1);
        held.release();
        await f.panel().getByText("Connected", { exact: true }).waitFor();
        await f.page.waitForFunction(() => window.terminalStreams["pty-2"]?.at(-1));
        assert.deepEqual([...f.sessions.keys()], ["pty-2"]);
        await f.page.getByText("Previous disconnected output", { exact: true }).click();
        assert.match(await f.page.locator("details pre").innerText(), /prior-command-output/);
        assert.equal(await f.page.evaluate(() => window.terminalStreams["pty-1"].every(item => item.closed)), true);
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-1").length, 1);
        await f.detach();
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });

    await t.test("a start response arriving after panel unmount is released without creating a renderer", async () => {
      const f = await fixture();
      try {
        const held = f.hold("start");
        await f.panel().getByRole("button", { name: "Open device shell", exact: true }).click();
        await held.seen;
        await f.page.evaluate(() => window.setShown(false));
        held.release();
        await f.page.waitForFunction(() => !document.querySelector('[role="tabpanel"]'));
        await pause();
        assert.equal(f.requests.filter(item => item.action === "start").length, 1);
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-1").length, 1);
        assert.equal(f.sessions.size, 0);
        assert.deepEqual(await f.page.evaluate(() => Object.keys(window.terminalStreams)), []);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });

    await t.test("desktop and native paste enter a review draft; only explicit reviewed actions send input", async () => {
      const f = await fixture();
      try {
        await f.open();
        const inputs = () => f.requests.filter(item => item.action === "input").map(item => item.data);
        await f.page.evaluate(() => { window.clipboardText = "echo first\necho second\n"; });
        await f.panel().getByRole("button", { name: "Paste", exact: true }).click();
        const draft = f.page.getByRole("textbox", { name: "Text to paste" });
        assert.equal(await draft.inputValue(), "echo first\necho second\n");
        assert.equal(await f.page.getByRole("button", { name: "Insert into terminal input" }).isDisabled(), true);
        assert.deepEqual(inputs(), []);
        assert.equal(await f.page.evaluate(() => window.desktopClipboardReads), 1);
        await f.page.getByRole("button", { name: "Cancel paste" }).click();
        await f.page.locator(".xterm-helper-textarea").evaluate(target => {
          const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "pwd\r\necho native\r\n");
          const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
          window.nativePastePrevented = !target.dispatchEvent(event);
        });
        assert.equal(await draft.inputValue(), "pwd\necho native\n", "textarea normalizes pasted CRLF for display");
        assert.equal(await f.page.evaluate(() => window.nativePastePrevented), true);
        assert.deepEqual(inputs(), []);
        await f.page.getByRole("button", { name: "Run reviewed text" }).click();
        await pause();
        assert.deepEqual(inputs(), ["pwd\recho native\r"]);
        await f.page.evaluate(() => { window.clipboardText = "single-line"; });
        await f.panel().getByRole("button", { name: "Paste", exact: true }).click();
        await f.page.getByRole("button", { name: "Insert into terminal input" }).click();
        await pause();
        assert.deepEqual(inputs(), ["pwd\recho native\r", "single-line"]);
        await f.page.evaluate(() => { window.clipboardText = "echo unsafe\u001b[2J"; });
        await f.panel().getByRole("button", { name: "Paste", exact: true }).click();
        assert.equal(await f.page.getByRole("button", { name: "Run reviewed text" }).isDisabled(), true);
        assert.equal(await f.page.getByRole("button", { name: "Insert into terminal input" }).isDisabled(), true);
        await f.page.getByRole("button", { name: "Cancel paste" }).click();
        await f.page.evaluate(() => { window.clipboardText = "x".repeat(16_001); });
        await f.panel().getByRole("button", { name: "Paste", exact: true }).click();
        assert.equal(await draft.inputValue(), "x".repeat(16_001), "the review draft never silently truncates clipboard data");
        assert.equal(await f.page.getByRole("button", { name: "Run reviewed text" }).isDisabled(), true);
        await f.page.getByRole("button", { name: "Cancel paste" }).click();
        assert.deepEqual(inputs(), ["pwd\recho native\r", "single-line"]);
        await f.detach();
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });

    await t.test("hidden terminal tabs keep independent streams, search selects them, and tab navigation retains focus", async () => {
      const f = await fixture();
      try {
        await f.open();
        await f.page.getByRole("button", { name: "New device shell tab" }).click();
        await f.open();
        assert.equal(f.requests.filter(item => item.action === "start").length, 2);
        assert.notEqual(f.requests.filter(item => item.action === "start")[0].clientTerminalId, f.requests.filter(item => item.action === "start")[1].clientTerminalId);
        await f.emit("pty-1", { type: "output", data: "needle-shell-one\r\n" });
        await f.emit("pty-2", { type: "output", data: "shell-two-survives\r\n" });
        await f.page.waitForFunction(() => window.outputSnapshots.at(-1)?.[0]?.output.includes("needle-shell-one") && window.outputSnapshots.at(-1)?.[1]?.output.includes("shell-two-survives"));
        const tab2 = f.page.getByRole("tab", { name: "Shell 2 · Connected", exact: true });
        await tab2.focus();
        await f.page.keyboard.press("ArrowLeft");
        assert.equal(await f.page.getByRole("tab", { name: "Shell 1 · Connected", exact: true }).evaluate(node => node === document.activeElement), true);
        await f.page.keyboard.press("End");
        assert.equal(await tab2.evaluate(node => node === document.activeElement), true);
        await f.page.evaluate(() => window.setTarget({ tabId: 1, query: "needle-shell-one", revision: 1 }));
        await f.page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes("Shell 1"));
        await f.panel().getByRole("button", { name: "Copy selection" }).click();
        await f.page.waitForFunction(() => window.copiedText === "needle-shell-one");
        await f.page.getByRole("button", { name: "New device shell tab" }).click();
        await pause();
        assert.equal(await f.page.getByRole("tab", { name: "Shell 3 · Not connected", exact: true }).getAttribute("aria-selected"), "true", "an old search selection never overrides a newly opened tab");
        assert.equal(f.requests.filter(item => item.action === "stop").length, 0, "renders and hidden tabs never end their PTYs, including StrictMode effect replay");
        await tab2.click();
        await f.page.getByRole("button", { name: "Close device shell tab 1", exact: true }).click();
        await pause();
        assert.deepEqual([...f.sessions.keys()], ["pty-2"]);
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-1").length, 1);
        assert.equal(f.requests.filter(item => item.action === "stop" && item.id === "pty-2").length, 0);
        assert.equal(await f.panel().getByText("Connected", { exact: true }).isVisible(), true);
        assert.equal(await tab2.evaluate(node => node === document.activeElement), true, "closing a tab retains keyboard focus on the active tab");
        await f.detach();
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });

    await t.test("the rendered workbench allows eight tabs and does not start a PTY while adding or navigating them", async () => {
      const f = await fixture();
      try {
        const add = f.page.getByRole("button", { name: "New device shell tab" });
        for (let index = 1; index < 8; index++) await add.click();
        assert.equal(await f.page.getByRole("tab").count(), 8);
        assert.equal(await add.isDisabled(), true);
        const last = f.page.getByRole("tab", { name: "Shell 8 · Not connected", exact: true });
        await last.focus();
        await f.page.keyboard.press("Home");
        const first = f.page.getByRole("tab", { name: "Shell 1 · Not connected", exact: true });
        assert.equal(await first.evaluate(node => node === document.activeElement), true);
        assert.equal(await first.getAttribute("aria-selected"), "true");
        assert.deepEqual(f.requests, []);
        await f.detach();
      } finally { if (!f.page.isClosed()) await f.page.close(); }
    });
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
