import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("device logs virtualize retained rows, keep collecting while paused and export exact filtered bytes", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-log-viewer-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {HarmonyLogViewer} from "@/components/workspace/HarmonyLogViewer";function Fixture(){const[online,setOnline]=useState(true);const[serial,setSerial]=useState("phone");window.setLogOnline=setOnline;window.setLogSerial=setSerial;return <HarmonyLogViewer active serial={serial} online={online} copy={zh=>zh}/>};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    await new Promise((resolve, reject) => webpack({ mode: "development", target: "web", devtool: false, context: repo, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": repo }, modules: [path.join(repo, "node_modules"), "node_modules"] },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } },
      (error, stats) => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 850, height: 650 }, acceptDownloads: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.stack ?? error.message));
    await page.addInitScript(() => {
      window.logStreams = []; window.copiedLogs = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => window.copiedLogs.push(value) } });
      window.EventSource = class extends EventTarget {
        constructor(url) { super(); this.url = url; this.closed = false; window.logStreams.push(this); queueMicrotask(() => this.dispatchEvent(new MessageEvent("connected"))); }
        close() { this.closed = true; }
      };
      window.emitLogs = (entries, dropped = 0) => window.logStreams.at(-1).dispatchEvent(new MessageEvent("logs", { data: JSON.stringify({ entries, dropped }) }));
    });
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const bundle = await readFile(path.join(root, "bundle.js"));
    await page.route("https://logs.test/**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript;charset=utf-8", body: bundle });
      if (url.pathname === "/api/harmony/logs") return route.fulfill({ json: { processes: [{ pid: 42, name: "synthetic.app" }] } });
      return route.fulfill({ contentType: "text/html;charset=utf-8", body: `<style>:root{--text-xs:12px;--font-mono:monospace;--bg:#111;--text:#ddd;--border:#444;--text-muted:#aaa;--radius-control:4px;--accent:#78f}*{box-sizing:border-box}body{margin:0}#root{height:100vh;display:flex;flex-direction:column}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://logs.test/");
    await page.waitForFunction(() => window.logStreams.length === 1).catch(async error => {
      throw new Error(`${error.message}; page errors: ${JSON.stringify(errors)}; streams: ${await page.evaluate(() => window.logStreams.length)}`);
    });
    await page.evaluate(() => window.emitLogs(Array.from({ length: 10050 }, (_, index) => ({ timestamp: "09-30 10:00:00.001", level: "info", pid: 42, tag: index % 2 ? "TagA" : "TagB",
      message: `row-${index} 中文日志`, raw: `09-30 10:00:00.001 42 1 I ${index % 2 ? "TagA" : "TagB"}: row-${index} 中文日志` })), 7));
    await page.getByText(/10000 \/ 10000/).waitFor();
    await page.getByText(/未接收 7.*超出保留上限 50/).waitFor();
    await page.getByText("row-10049 中文日志", { exact: true }).waitFor();
    assert.ok(await page.locator("[data-log-id]").count() < 100, "10k retained rows do not become 10k DOM nodes");
    await page.locator('[role="log"]').evaluate(output => { output.scrollTop = 15000; });
    const anchorBefore = await page.locator('[role="log"]').evaluate(output => {
      const top = output.getBoundingClientRect().top;
      const row = [...output.querySelectorAll("[data-log-id]")].find(row => row.getBoundingClientRect().bottom > top);
      return { id: row.dataset.logId, offset: row.getBoundingClientRect().top - top };
    });
    await page.evaluate(() => window.emitLogs(Array.from({ length: 10 }, (_, index) => ({ timestamp: "09-30 10:04:00.001", level: "info", pid: 42, tag: "TagB",
      message: `anchor-extra-${index}`, raw: `09-30 10:04:00.001 42 1 I TagB: anchor-extra-${index}` }))));
    await page.getByText(/超出保留上限 60/).waitFor();
    const anchorAfter = await page.locator('[role="log"]').evaluate((output, id) => {
      const row = output.querySelector(`[data-log-id="${id}"]`);
      return row ? row.getBoundingClientRect().top - output.getBoundingClientRect().top : null;
    }, anchorBefore.id);
    assert.ok(anchorAfter !== null && Math.abs(anchorAfter - anchorBefore.offset) <= 1, "stream eviction preserves the row currently being read");
    await page.getByRole("button", { name: "跟随最新日志", exact: true }).click();
    await page.getByRole("button", { name: "暂停显示日志", exact: true }).click();
    const raw = "09-30 10:05:00.900 42 1 W TagA: paused-new 中文完整日志";
    await page.evaluate(raw => window.emitLogs([{ timestamp: "09-30 10:05:00.900", level: "warn", pid: 42, tag: "TagA", message: "paused-new 中文完整日志", raw }], 3), raw);
    await page.getByText(/已暂停显示，继续采集.*未接收 10/).waitFor();
    assert.equal(await page.getByText("paused-new 中文完整日志", { exact: true }).count(), 0);
    const originalDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出保留日志", exact: true }).click();
    const original = await readFile(await (await originalDownload).path(), "utf8");
    assert.ok(original.includes("row-10049 中文日志") && !original.includes("paused-new"));
    assert.equal(original.trimEnd().split("\n").length, 10000);
    await page.getByRole("button", { name: "跟随最新日志", exact: true }).click();
    await page.getByText("paused-new 中文完整日志", { exact: true }).waitFor();
    await page.getByRole("textbox", { name: "日志 TAG", exact: true }).fill("taga");
    await page.getByRole("textbox", { name: "日志开始时间", exact: true }).fill("10:05:00");
    await page.getByRole("textbox", { name: "日志结束时间", exact: true }).fill("10:05:00");
    await page.getByText(/1 \/ 10000/).waitFor();
    const filteredDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出筛选结果", exact: true }).click();
    assert.equal(await readFile(await (await filteredDownload).path(), "utf8"), raw + "\n");
    await page.getByRole("button", { name: "查看日志详情", exact: true }).click();
    await page.getByRole("button", { name: "复制完整行", exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedLogs.at(-1)), raw);
    await page.getByRole("textbox", { name: "日志开始时间", exact: true }).fill("24:00");
    await page.getByRole("alert").filter({ hasText: "时间格式无效" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "导出筛选结果", exact: true }).isDisabled(), true);
    await page.getByRole("textbox", { name: "日志开始时间", exact: true }).fill("10:05:00");
    await page.evaluate(() => window.setLogOnline(false));
    await page.getByText(/已断开，保留已采集日志/).waitFor();
    assert.equal(await page.evaluate(() => window.logStreams.at(-1).closed), true);
    await page.getByText("paused-new 中文完整日志", { exact: true }).waitFor();
    await page.getByRole("button", { name: "清空当前视图", exact: true }).click();
    await page.getByText(/0 \/ 0/).waitFor();
    assert.equal(await page.getByRole("button", { name: "导出保留日志", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("[data-log-id]").count(), 0);
    await page.setViewportSize({ width: 360, height: 800 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.evaluate(() => { window.setLogOnline(true); window.setLogSerial("another-phone"); });
    await page.waitForFunction(() => window.logStreams.length === 2);
    assert.equal(await page.getByRole("region", { name: "日志详情" }).count(), 0);
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "logs.png") });
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
