import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const runtime = await createJiti(import.meta.url).import("../lib/companion-runtime.ts");

test("Pocket todos drag and keyboard reorder through persisted state, preserving hidden rows and failed saves", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-todo-order-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  let browser;
  try {
    const initial = runtime.createDefaultCompanionRuntimeState();
    initial.todos = ["计划A", "已完成项目", "计划B", "计划C", "资料D", "计划E"].map((text, index) => ({ id: `todo:${index}`, text, completed: index === 1, progress: index === 1 ? 100 : 45, reminderEnabled: true, notes: "保留备注", createdAt: 1, updatedAt: 42 }));
    runtime.writeCompanionRuntimeState(initial);
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), `import React,{useEffect,useRef,useState}from'react';import{createRoot}from'react-dom/client';import{CompanionTodoList}from'@/components/CompanionTodoList';import{fetchCompanionRuntimeState,saveCompanionRuntimeState}from'@/lib/companion-runtime-client';
function Fixture(){const[state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');const current=useRef(null),pending=useRef(false);window.setTodoBusy=setBusy;useEffect(()=>{void fetchCompanionRuntimeState().then(next=>{current.current=next;setState(next)})},[]);async function change(update){if(pending.current)return false;pending.current=true;setBusy(true);setError('');try{const next=await saveCompanionRuntimeState({...current.current,todos:update(current.current.todos)});current.current=next;setState(next);return true}catch(e){setError(e.message);return false}finally{pending.current=false;setBusy(false)}}return state?<><CompanionTodoList todos={state.todos} busy={busy} onChange={change}/>{error&&<p role='alert'>{error}</p>}</>:null}createRoot(document.getElementById('root')).render(<Fixture/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await Promise.all(["app/globals.css", "components/CompanionTodoList.module.css"].map(file => readFile(path.join(repo, file), "utf8")))).join("\n").replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 760, height: 850 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let failSave = false;
    // HTTP hosting is a fixture; the component, client requests and private disk
    // serialization are production code, isolated under this temporary agent dir.
    await page.route("https://todo-order.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/companion/state") {
        if (route.request().method() === "PUT") {
          if (failSave) return route.fulfill({ status: 500, json: { error: "fixture disk failure" } });
          return route.fulfill({ json: runtime.writeCompanionRuntimeState(route.request().postDataJSON().state) });
        }
        return route.fulfill({ json: runtime.readCompanionRuntimeState() });
      }
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(pathname))) });
      if (pathname.startsWith("/fonts/")) return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0;padding:24px;--pocket-accent:var(--accent)}button{font:inherit}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    const handle = text => page.getByRole("button", { name: `排序：${text}`, exact: true });
    const row = text => page.locator("article").filter({ has: handle(text) });
    const order = () => runtime.readCompanionRuntimeState().todos.map(todo => todo.text);
    await page.goto("https://todo-order.test/");
    await handle("计划B").waitFor();
    await handle("计划B").dragTo(row("计划A"), { targetPosition: { x: 100, y: 4 } });
    await page.getByRole("status").getByText("已调整待办顺序", { exact: true }).waitFor();
    assert.deepEqual(order(), ["计划B", "计划A", "已完成项目", "计划C", "资料D", "计划E"]);
    const moved = runtime.readCompanionRuntimeState().todos[0];
    assert.deepEqual([moved.progress, moved.notes, moved.updatedAt, moved.reminderEnabled], [45, "保留备注", 42, true]);
    await page.reload();
    await handle("计划B").waitFor();
    assert.equal(await page.locator("article").first().getAttribute("data-todo-id"), "todo:2", "saved order survives a fresh page load");
    const keyboardSave = page.waitForResponse(response => response.url().endsWith("/api/companion/state") && response.request().method() === "PUT");
    await handle("计划B").focus(); await page.keyboard.press("Alt+ArrowDown");
    await keyboardSave;
    await page.waitForFunction(() => !document.querySelector('[aria-label="排序：计划B"]')?.disabled);
    assert.deepEqual(order(), ["计划A", "计划B", "已完成项目", "计划C", "资料D", "计划E"]);
    await page.getByLabel("搜索待办").fill("计划");
    const filteredSave = page.waitForResponse(response => response.url().endsWith("/api/companion/state") && response.request().method() === "PUT");
    await handle("计划E").dragTo(row("计划B"), { targetPosition: { x: 100, y: 4 } });
    await filteredSave;
    await page.waitForFunction(() => !document.querySelector('[aria-label="排序：计划E"]')?.disabled);
    assert.deepEqual(order(), ["计划A", "计划E", "计划B", "已完成项目", "计划C", "资料D"], "filtering does not discard or reorder unrelated hidden rows");
    failSave = true;
    await handle("计划C").dragTo(row("计划A"), { targetPosition: { x: 100, y: 4 } });
    await page.getByRole("alert").getByText("fixture disk failure", { exact: true }).waitFor();
    assert.deepEqual(order(), ["计划A", "计划E", "计划B", "已完成项目", "计划C", "资料D"]);
    assert.deepEqual(await page.locator("article").evaluateAll(rows => rows.map(row => row.dataset.todoId)), ["todo:0", "todo:5", "todo:2", "todo:3"]);
    failSave = false;
    await page.evaluate(() => window.setTodoBusy(true));
    assert.equal(await handle("计划A").isDisabled(), true);
    assert.equal(await handle("计划A").getAttribute("draggable"), "false");
    await page.evaluate(() => window.setTodoBusy(false));
    await page.getByLabel("搜索待办").fill("");
    await page.getByRole("button", { name: "查看已完成", exact: true }).click();
    assert.equal(await page.locator("article").count(), 6);
    await page.getByRole("button", { name: "编辑：资料D", exact: true }).click();
    assert.equal(await handle("计划A").isDisabled(), true, "an edit cannot be displaced by a concurrent drag");
    await page.getByLabel("编辑待办内容").fill("资料D已更新");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "编辑：资料D已更新", exact: true }).waitFor();
    assert.deepEqual(order(), ["计划A", "计划E", "计划B", "已完成项目", "计划C", "资料D已更新"]);
    assert.equal(runtime.readCompanionRuntimeState().todos.find(todo => todo.id === "todo:1").completed, true);
    await mkdir(path.join(repo, ".verification/todo-order"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/todo-order/sorted.png") });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
