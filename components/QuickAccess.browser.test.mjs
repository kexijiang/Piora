import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const dependencies = process.env.PIORA_TEST_NODE_MODULES || path.join(repo, "node_modules");
const require = createRequire(path.join(dependencies, ".quick-access-test.cjs"));
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const { chromium } = require("playwright-core");

test("quick access integrates with the real cabin navigation, launcher, editing, menus and keyboard", { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-quick-access-browser-"));
  const screenshots = path.join(repo, ".verification", "quick-access");
  await mkdir(screenshots, { recursive: true });
  let browser;
  t.after(async () => { await browser?.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
  await writeFile(path.join(root, "css.cjs"), `const path=require('node:path');module.exports=function(s){const prefix=path.basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(m,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)};`);
  await writeFile(path.join(root, "stub.tsx"), `export const CompanionTodoList=()=>null;export const CompanionStorageSettings=()=>null;export const CompanionTransferStation=()=>null;export const JsonWorkbench=()=>null;export const ClipboardWorkbench=()=>null;`);
  await writeFile(path.join(root, "image.tsx"), `export default function Image({unoptimized,...props}){return <img {...props}/>}`);
  await writeFile(path.join(root, "dynamic.tsx"), `export default ()=>()=>null;`);
  await writeFile(path.join(root, "entry.tsx"), `import {createRoot} from 'react-dom/client';import {I18nProvider} from '@/hooks/useI18n';import {CompanionPanel} from '@/components/CompanionPanel';createRoot(document.getElementById('root')).render(<I18nProvider><CompanionPanel/></I18nProvider>);`);
  const compiler = webpack({
    mode: "development", target: "web", devtool: false,
    entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" },
    resolve: { extensions: [".tsx", ".ts", ".js"], modules: [dependencies, path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo, "next/image": path.join(root, "image.tsx"), "next/dynamic": path.join(root, "dynamic.tsx") } },
    plugins: [new webpack.NormalModuleReplacementPlugin(/[/\\](CompanionTodoList|CompanionStorageSettings|CompanionTransferStation|JsonWorkbench|ClipboardWorkbench)$/, path.join(root, "stub.tsx"))],
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
  });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
  const page = await browser.newPage({ viewport: { width: 1040, height: 800 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "zh-CN");
    if (!localStorage.getItem("pi-pocket-launcher-recent")) localStorage.setItem("pi-pocket-launcher-recent", JSON.stringify(["hosts-app"]));
    const original = [
      { id: "hosts", name: "hosts", path: "C:\\Windows\\System32\\drivers\\etc\\hosts", kind: "file", preset: "hosts", pinned: true, availability: "available" },
      { id: "downloads", name: "", path: "C:\\Users\\用户\\Downloads", kind: "folder", preset: "downloads", pinned: true, availability: "available" },
      { id: "documents", name: "", path: "C:\\Users\\用户\\Documents", kind: "folder", preset: "documents", pinned: true, availability: "available" },
      { id: "missing", name: "旧资料", path: "D:\\已删除的资料", kind: "folder", pinned: false, availability: "missing" },
    ];
    const subscribers = new Set();
    window.calls = [];
    window.pickedPath = null;
    window.adminStatus = "cancelled";
    const read = () => JSON.parse(localStorage.getItem("test-quick-access") || JSON.stringify(original));
    const snapshot = () => ({ items: read().sort((a, b) => Number(b.pinned) - Number(a.pinned)), presets: [] });
    const save = items => { localStorage.setItem("test-quick-access", JSON.stringify(items)); subscribers.forEach(listener => listener()); };
    window.piDesktop = {
      platform: "win32",
      launcher: { list: async () => ({ supported: true, warning: "", items: [{ id: "notepad", name: "记事本", kind: "app", keywords: "notepad 记事本", description: "本机应用" }, { id: "sound", name: "声音", kind: "setting", keywords: "声音", description: "Windows 设置" }, { id: "hosts-app", name: "hosts", kind: "app", keywords: "hosts", description: "本机应用" }] }), open: async id => window.calls.push({ app: id }) },
      quickAccess: {
        list: async () => {
          const value = snapshot();
          if (window.holdNextList) {
            window.holdNextList = false;
            return new Promise(resolve => { window.releaseList = () => { window.releaseList = null; resolve(value); }; });
          }
          return value;
        },
        subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
        pick: async kind => { window.calls.push({ pick: kind }); return window.pickedPath; },
        open: async (id, action = "open") => {
          window.calls.push({ id, action });
          const item = read().find(item => item.id === id);
          if (item.availability === "missing" && action !== "copy") throw new Error("quickAccess.error.missing");
          if (window.failOpen) throw new Error("quickAccess.error.openFailed");
          return { status: action === "edit-admin" ? window.adminStatus : "opened" };
        },
        mutate: async input => {
          window.calls.push({ mutation: input });
          let items = read();
          if (input.type === "add") {
            if (items.some(item => item.path === input.path)) throw new Error("quickAccess.error.duplicate");
            items.push({ id: `added-${Date.now()}`, name: input.name || input.path.split(/[\\/]/).pop(), path: input.path, kind: /\.(txt|lnk|url)$/i.test(input.path) ? "file" : "folder", pinned: false, availability: "available" });
          } else if (input.type === "update") items = items.map(item => item.id === input.id ? { ...item, ...input, availability: input.path ? "available" : item.availability } : item);
          else if (input.type === "remove") items = items.filter(item => item.id !== input.id);
          else if (input.type === "reorder") items = input.ids.map(id => items.find(item => item.id === id));
          save(items); return snapshot();
        },
      },
    };
    if (new URL(location.href).searchParams.has("web")) delete window.piDesktop;
  });
  const runtime = {
    version: 3, updatedAt: 1, migratedFromLocalStorage: false,
    settings: { interactionModel: null, shareWorkContext: true, autonomyLevel: "balanced", autonomyPaused: false, personality: "", quietHours: { enabled: false, start: "22:30", end: "08:00" }, allowMovement: true, allowProactiveSpeech: true, autoCaptureSessions: true },
    todos: [], taskRecords: [], library: [], memories: [],
    focusTimer: { phase: "focus", status: "idle", durations: { focus: 1500, "short-break": 300, "long-break": 900 }, longBreakEvery: 4, autoStartNextPhase: false, petReminderEnabled: true, durationSeconds: 1500, remainingSeconds: 1500, startedAt: null, endsAt: null, linkedTodoId: null, completedFocusSessions: 0 },
    mind: { mood: "calm", lastDecision: null, decisionHistory: [], nextWakeAt: null },
  };
  const preflight = await readFile(path.join(dependencies, "tailwindcss/preflight.css"), "utf8");
  await page.route("http://quick-access.test/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/companion/state") return route.fulfill({ json: runtime });
    if (url.pathname.startsWith("/api/agent/")) return route.fulfill({ json: { sessionIds: [], sessions: [], snapshots: [] } });
    if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: await readFile(path.join(root, path.basename(url.pathname))) });
    if (url.pathname.startsWith("/icons/")) return route.fulfill({ contentType: "image/png", body: await readFile(path.join(repo, "public", url.pathname.slice(1))) });
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><style>${preflight}:root{--text:#253029;--text-muted:#68746b;--text-dim:#849087;--bg:#f7f8f5;--bg-panel:#fff;--bg-hover:#edf0e9;--bg-selected:#e8efdf;--border:#dde2d8;--accent:#6b835b;--btn-primary-fg:#fff;--btn-primary-bg:#35462f;--ui-font-size:14px;--ui-font-family:system-ui;--text-xs:12px;--text-sm:13px;--text-base:14px;--radius-control:7px;--radius-surface:12px;--control-height-large:42px;--font-mono:Consolas,monospace;--shadow-popover:0 12px 36px #1a291b20}*{box-sizing:border-box}body{margin:0;font:14px system-ui}button,input{font:inherit}button{cursor:pointer}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
  });
  await page.goto("http://quick-access.test/");
  const navigation = page.getByRole("tab", { name: "快捷访问", exact: true });
  await navigation.waitFor({ timeout: 10000 }).catch(async cause => {
    throw new Error(`Cabin failed to mount: ${errors.join("; ")} | ${await page.locator("body").innerText()} | ${cause.message}`);
  });
  const pins = page.getByRole("region", { name: "快捷访问" });
  assert.equal(await pins.getByRole("button", { name: "hosts", exact: true }).count(), 1);
  await pins.getByRole("button", { name: "下载", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls.at(-1)), { id: "downloads", action: "open" });
  const search = page.getByRole("combobox", { name: "搜索工具和常用位置" });
  await search.fill("hosts"); await search.press("Enter");
  await page.waitForFunction(() => window.calls.some(call => call.id === "hosts"));
  await search.fill("声音"); await search.press("Enter");
  await page.waitForFunction(() => window.calls.some(call => call.app === "sound"));
  await search.fill("记事本"); await search.press("Enter");
  await page.waitForFunction(() => window.calls.some(call => call.app === "notepad"));
  // Add unpinned entries through the real editor. Path-only matches must outrank
  // exact tool/app/settings names, including apps already in the recent list.
  for (const [target, name, term] of [
    ["D:\\常用\\声音 JSON 工具.lnk", "启动入口", "声音"],
    ["D:\\常用\\记事本 JSON 工具", "工作目录", "记事本"],
  ]) {
    await navigation.click();
    await page.getByRole("button", { name: "添加", exact: true }).click();
    const add = page.getByRole("dialog", { name: "添加快捷访问" });
    await page.evaluate(value => { window.pickedPath = value; }, target);
    await add.getByRole("button", { name: target.endsWith(".lnk") ? "选择文件或快捷方式" : "选择文件夹", exact: true }).click();
    assert.equal(await add.getByLabel("完整路径").inputValue(), target);
    await add.getByLabel("显示名称").fill(name);
    await add.getByRole("button", { name: "保存", exact: true }).click();
    await add.waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "工具台", exact: true }).click();
    await pins.getByRole("button", { name, exact: true }).waitFor();
    await search.fill(term);
    assert.match(await page.getByRole("option").first().innerText(), /启动入口|工作目录/);
    if (target.endsWith(".lnk")) assert.match(await page.getByRole("option").first().innerText(), /快捷方式/);
    await search.press("Enter");
    await page.waitForFunction(value => {
      const item = JSON.parse(localStorage.getItem("test-quick-access")).find(item => item.path === value);
      return !item.pinned && window.calls.some(call => call.id === item.id && call.action === "open");
    }, target);
  }
  await search.fill("JSON 工具");
  assert.match(await page.getByRole("option").nth(0).innerText(), /启动入口|工作目录/);
  assert.match(await page.getByRole("option").nth(1).innerText(), /启动入口|工作目录/);
  assert.match(await page.getByRole("option").nth(2).innerText(), /格式化、校验与文本转换/);
  // Remove these fixtures through the menu before the existing sorting/filter cases.
  await navigation.click();
  for (const name of ["启动入口", "工作目录"]) {
    await page.getByRole("button", { name: `${name} 的操作`, exact: true }).click();
    await page.getByRole("menuitem", { name: "移除快捷入口", exact: true }).click();
  }
  const list = page.getByRole("list", { name: "快捷访问" });
  await list.waitFor();
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加快捷访问" });
  const centered = await dialog.boundingBox();
  assert.ok(Math.abs(centered.x + centered.width / 2 - 520) < 1, JSON.stringify(centered));
  assert.ok(Math.abs(centered.y + centered.height / 2 - 400) < 1, JSON.stringify(centered));
  await page.screenshot({ path: path.join(screenshots, "editor-centered.png") });
  const handle = await dialog.getByRole("heading").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 120, handle.y + handle.height / 2 - 80, { steps: 8 });
  await page.mouse.up();
  const dragged = await dialog.boundingBox();
  assert.ok(Math.abs(dragged.x - centered.x - 120) < 1 && Math.abs(dragged.y - centered.y + 80) < 1, JSON.stringify(dragged));
  await page.setViewportSize({ width: 390, height: 600 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector("dialog").getBoundingClientRect();
    return bounds.left >= 16 && bounds.top >= 16 && bounds.right <= innerWidth - 15 && bounds.bottom <= innerHeight - 15;
  });
  await page.screenshot({ path: path.join(screenshots, "editor-narrow.png") });
  await page.setViewportSize({ width: 1040, height: 800 });
  await page.evaluate(() => { window.pickedPath = "D:\\工作资料\\中文 文件.txt"; });
  await dialog.getByRole("button", { name: "选择文件或快捷方式", exact: true }).click();
  assert.equal(await dialog.getByLabel("完整路径").inputValue(), "D:\\工作资料\\中文 文件.txt");
  await dialog.getByLabel("显示名称").fill("常用配置");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const config = list.getByRole("listitem").filter({ hasText: "常用配置" });
  await config.waitFor();
  await page.evaluate(() => { window.holdNextList = true; window.dispatchEvent(new Event("focus")); });
  await page.waitForFunction(() => typeof window.releaseList === "function");
  await config.getByRole("button", { name: "常用配置 的操作" }).click();
  await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
  await config.getByRole("img", { name: "已置顶" }).waitFor();
  await page.evaluate(() => window.releaseList());
  assert.equal(await config.getByRole("img", { name: "已置顶" }).count(), 1, "a late background read must not undo a newer edit");
  await page.reload(); await navigation.click();
  await config.waitFor();
  const before = await list.getByRole("listitem").allTextContents();
  await config.getByRole("button", { name: "常用配置 的操作" }).click();
  await page.getByRole("menuitem", { name: "上移", exact: true }).focus();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole("menuitem", { name: "上移", exact: true }).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.calls.some(call => call.mutation?.type === "reorder"));
  assert.notDeepEqual(await list.getByRole("listitem").allTextContents(), before);
  assert.equal(await page.getByText("已更新顺序", { exact: true }).count(), 0);
  await page.getByRole("tab", { name: "工具台", exact: true }).click();
  assert.equal(await page.getByText("已更新顺序", { exact: true }).count(), 0);
  const homeOrder = await pins.locator("button[title]").evaluateAll(buttons => buttons.map(button => button.title));
  const savedOrder = await page.evaluate(() => JSON.parse(localStorage.getItem("test-quick-access")).sort((a, b) => Number(b.pinned) - Number(a.pinned)).map(item => item.path));
  assert.deepEqual(homeOrder, savedOrder);
  await navigation.click();
  const filesFilter = page.getByRole("button", { name: "文件", exact: true });
  await filesFilter.click();
  assert.equal(await list.getByRole("listitem").count(), 2);
  await page.getByRole("button", { name: "全部", exact: true }).click();
  const managerSearch = page.getByRole("textbox", { name: "搜索名称或路径…" });
  await managerSearch.fill("D:/工作资料");
  assert.equal(await list.getByRole("listitem").count(), 1);
  await managerSearch.fill("");
  const documents = list.getByRole("listitem").filter({ hasText: "C:\\Users\\用户\\Documents" });
  await documents.locator('[draggable="true"]').dragTo(list.getByRole("listitem").first());
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("test-quick-access"))[0].id === "documents");
  const missing = list.getByRole("listitem").filter({ hasText: "旧资料" });
  await missing.getByRole("button", { name: "旧资料 的操作" }).click();
  await page.getByRole("menuitem", { name: "重命名或修改路径" }).click();
  const edit = page.getByRole("dialog", { name: "编辑快捷访问" });
  const editBounds = await edit.boundingBox();
  assert.ok(Math.abs(editBounds.x + editBounds.width / 2 - 520) < 1 && Math.abs(editBounds.y + editBounds.height / 2 - 400) < 1, JSON.stringify(editBounds));
  await edit.getByLabel("完整路径").fill("D:\\恢复后的资料");
  await edit.getByRole("button", { name: "保存", exact: true }).click();
  await edit.waitFor({ state: "detached" });
  assert.equal(await missing.getByText("位置不存在", { exact: true }).count(), 0);
  const hostsMenu = page.getByRole("button", { name: "hosts 的操作" });
  await hostsMenu.click(); await page.getByRole("menuitem", { name: "以管理员身份编辑" }).click();
  await page.getByRole("status").filter({ hasText: "已取消管理员授权" }).waitFor();
  await page.evaluate(() => { window.adminStatus = "opened"; });
  await hostsMenu.click(); await page.getByRole("menuitem", { name: "以管理员身份编辑" }).click();
  await page.getByRole("status").filter({ hasText: "已请求打开 hosts" }).waitFor();
  await page.evaluate(() => { window.failOpen = true; });
  await hostsMenu.click(); await page.getByRole("menuitem", { name: "打开", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "未能打开此位置" }).waitFor();
  await page.evaluate(() => { window.failOpen = false; });
  await page.getByRole("button", { name: "关闭提示" }).click();
  await config.getByRole("button", { name: "常用配置 的操作" }).click();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  assert.equal(await config.getByRole("button", { name: "常用配置 的操作" }).evaluate(element => document.activeElement === element), true);
  await page.screenshot({ path: path.join(screenshots, "manager.png") });
  await page.setViewportSize({ width: 420, height: 780 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await hostsMenu.click();
  const menuBounds = await page.getByRole("menu").boundingBox();
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 421 && menuBounds.y >= 0 && menuBounds.y + menuBounds.height <= 781, JSON.stringify(menuBounds));
  await page.keyboard.press("Escape");
  await page.screenshot({ path: path.join(screenshots, "manager-narrow.png") });
  await page.getByRole("tab", { name: "工具台", exact: true }).click();
  await page.setViewportSize({ width: 1040, height: 800 });
  await page.screenshot({ path: path.join(screenshots, "home.png") });
  await page.evaluate(() => { localStorage.setItem("pi-locale", "en"); });
  await page.reload();
  await page.getByRole("tab", { name: "Quick access", exact: true }).click();
  await page.getByRole("heading", { name: "Quick access", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("dialog", { name: "Add to quick access" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const duplicateDialog = page.getByRole("dialog", { name: "Add to quick access" });
  await duplicateDialog.getByLabel("Full path").fill("C:\\Windows\\System32\\drivers\\etc\\hosts");
  await duplicateDialog.getByRole("button", { name: "Save", exact: true }).click();
  await duplicateDialog.getByRole("alert").filter({ hasText: "This location has already been added." }).waitFor();
  assert.equal(await duplicateDialog.getByLabel("Full path").inputValue(), "C:\\Windows\\System32\\drivers\\etc\\hosts");
  await page.evaluate(() => { window.pickedPath = null; });
  await duplicateDialog.getByRole("button", { name: "Choose folder", exact: true }).click();
  assert.equal(await duplicateDialog.getByLabel("Full path").inputValue(), "C:\\Windows\\System32\\drivers\\etc\\hosts");
  await duplicateDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem("test-quick-access"));
    for (let index = 0; index < 5; index++) items.push({ id: `extra-${index}`, name: `Extra ${index}`, path: `D:\\Folder ${index}`, kind: "folder", pinned: true, availability: "available" });
    localStorage.setItem("test-quick-access", JSON.stringify(items));
  });
  await page.reload();
  assert.equal(await page.getByRole("region", { name: "Quick access" }).locator('button[title]').count(), await page.evaluate(() => JSON.parse(localStorage.getItem("test-quick-access")).length));
  await page.goto("http://quick-access.test/?web");
  await page.getByRole("tab", { name: "Quick access", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Add", exact: true }).isDisabled(), true);
  await page.getByText("Quick access requires Piora desktop to open local files and folders.").waitFor();
  assert.deepEqual(errors, []);
});
