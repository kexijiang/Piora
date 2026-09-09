import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("independent companion bubble follows session snapshots inside the native window bounds", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-companion-bubble-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "i18n.ts"), `import {zhCNLocale} from ${JSON.stringify(path.join(repo, "lib/i18n/messages/zh-CN.ts"))};export const useI18n=()=>({t:key=>zhCNLocale.messages[key]??key});`);
    await writeFile(path.join(root, "entry.tsx"), `import {createRoot} from "react-dom/client";import {CompanionBubbleWindow} from ${JSON.stringify(path.join(repo, "components/CompanionBubbleWindow.tsx"))};createRoot(document.getElementById("root")).render(<CompanionBubbleWindow/>);`);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@/hooks/useI18n": path.join(root, "i18n.ts"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(root, "bundle.js"), "utf8");
    const css = await readFile(path.join(repo, "components/CompanionBubbleWindow.module.css"), "utf8");
    const task = { id: "session-1", title: "正在修复宠物消息弹框", runtime: "running", pendingApproval: false, lastPromptFailed: false, activity: { kind: "tool", message: "正在读取组件" } };
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 300, height: 128 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("http://companion-bubble.test/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/agent/running") return route.fulfill({ json: { runningSessions: [task] } });
      if (url.pathname === "/api/companion/state") return route.fulfill({ json: { updatedAt: 1, focusTimer: null, mind: { lastDecision: null } } });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><style>:root{--text-sm:12px;--text-xs:11px;--text-base:14px;--radius-panel:12px}*{box-sizing:border-box}body{margin:0}${css}</style><div id="root"></div>` });
    });
    await page.addInitScript(() => {
      window.EventSource = class {
        static OPEN = 1;
        readyState = 1;
        constructor() { window.taskStream = this; }
        close() {}
      };
      window.publishTasks = (tasks) => window.taskStream.onmessage({ data: JSON.stringify({ type: "running", runningSessions: tasks }) });
    });
    await page.goto("http://companion-bubble.test/");
    await page.clock.install();
    await page.addScriptTag({ content: bundle });
    const bubble = page.getByTestId("companion-activity-bubble");
    await bubble.waitFor();
    assert.match(await bubble.innerText(), /正在修复宠物消息弹框/);
    assert.match(await bubble.innerText(), /正在读取组件/);
    await page.clock.runFor(200);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("main")).opacity === "1");
    const longTask = { ...task, title: "很长的会话标题".repeat(30), activity: { kind: "thinking", message: "正在分析问题".repeat(40) } };
    await page.evaluate((tasks) => window.publishTasks(tasks), [longTask, { ...task, id: "session-2", title: "第二个任务" }]);
    await page.waitForFunction(() => document.querySelector('[data-testid="companion-activity-bubble"]')?.textContent.includes("1 / 2"));
    assert.equal(await bubble.getAttribute("data-status"), "waiting");
    const bounds = await bubble.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 300 && bounds.y + bounds.height <= 128, JSON.stringify(bounds));
    await page.clock.runFor(5_000);
    assert.equal(await bubble.getAttribute("data-session-id"), "session-2");
    await page.evaluate((tasks) => window.publishTasks(tasks), [{ ...task, runtime: "idle", pendingApproval: true }]);
    await page.waitForFunction(() => document.querySelector('[data-status="review"]'));
    await page.evaluate(() => window.publishTasks([]));
    await bubble.waitFor({ state: "detached" });
    await page.clock.runFor(200);
    await page.waitForFunction(() => getComputedStyle(document.querySelector("main")).opacity === "0");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
