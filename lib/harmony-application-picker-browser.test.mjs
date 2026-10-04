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

test("application workbench discovers apps, classifies explicit facts and fences maintenance", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-app-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "privilege.tsx"), "export const PrivilegeConfig=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {ApplicationPicker} from "@/components/workspace/harmony/ApplicationPicker";function Fixture(){const[active,setActive]=useState(false);const[serial,setSerial]=useState("phone");const[canControl,setCanControl]=useState(true);window.setActive=setActive;window.setSerial=setSerial;window.setCanControl=setCanControl;window.sandboxes=[];window.acquireCalls??=0;return <ApplicationPicker serial={serial} active={active} canControl={canControl} chinese={true} onOpenSandbox={bundle=>window.sandboxes.push(bundle)} ensureControl={()=>{window.acquireCalls++;return window.delayLease?new Promise(resolve=>window.completeLease=()=>resolve("lease")):Promise.resolve("lease");}}/>};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./PrivilegeConfig": path.join(root, "privilege.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1150, height: 900 } });
    const errors = [], reads = [], writes = [], sandboxReads = [], nativeDialogs = [];
    let activeDetails = 0, maxDetails = 0, version = "1.0", versionCode = 12, sandboxDenied = false, installStale = true, fixtureEnabled = true;
    const protectedApp = { bundleName: "com.vendor.core", label: "受保护应用", source: "bm-label", isSystemApp: true };
    const debugApp = { bundleName: "com.example.fixture", label: "调试应用", source: "bm-label", isSystemApp: false };
    const releaseApp = { bundleName: "com.example.release", label: "发行应用", source: "bm-label", isSystemApp: false };
    const apps = [protectedApp, debugApp, releaseApp, ...Array.from({ length: 151 }, (_, i) => ({ bundleName: `com.sample.app${i}`, label: `应用${i}`, source: "bm-label" }))];
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.route("https://app-workbench.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/harmony/apps") {
        reads.push(url.searchParams.toString());
        if (url.searchParams.get("serial") === "other") return route.fulfill({ json: { applications: [{ bundleName: "com.other.only", label: "另一台设备", source: "bm-label" }] } });
        const name = url.searchParams.get("bundleName");
        if (!name) return route.fulfill({ json: { applications: apps } });
        activeDetails++; maxDetails = Math.max(maxDetails, activeDetails);
        await new Promise(resolve => setTimeout(resolve, 25));
        activeDetails--;
        if (name === "com.sample.app0") return route.fulfill({ status: 403, json: { error: { code: "CAPABILITY_UNAVAILABLE", message: "Details inaccessible" } } });
        const app = apps.find(app => app.bundleName === name);
        const isSystemApp = name === protectedApp.bundleName || Number(name.match(/app(\d+)$/)?.[1]) % 2 === 0;
        return route.fulfill({ json: { applications: app ? [{ ...app, abilities: ["EntryAbility"], isSystemApp, enabled: name === protectedApp.bundleName ? false : name === debugApp.bundleName ? fixtureEnabled : true,
          removable: name !== protectedApp.bundleName, dataClearable: name !== protectedApp.bundleName, versionName: version, versionCode,
          provisionType: name === releaseApp.bundleName ? "release" : "debug", installSource: "com.example.store", process: name + ":worker" }] : [] } });
      }
      if (url.pathname === "/api/harmony/logs") return route.fulfill({ json: { processes: [{ pid: 42, name: debugApp.bundleName + ":worker" }, { pid: 43, name: debugApp.bundleName + ".foreign" }] } });
      if (url.pathname === "/api/harmony/files") {
        sandboxReads.push(Object.fromEntries(url.searchParams));
        return sandboxDenied ? route.fulfill({ status: 403, json: { error: { code: "CAPABILITY_UNAVAILABLE", message: "Sandbox access denied" } } }) : route.fulfill({ json: { files: [] } });
      }
      if (url.pathname === "/api/harmony/action") {
        const input = request.postDataJSON(); writes.push(input);
        if (input.action === "install_app" && installStale) return route.fulfill({ status: 409, json: { error: { code: "STALE_SNAPSHOT", message: "Preview changed", details: { reason: "hap-preview-changed" } } } });
        version = input.action === "install_app" ? "3.0" : "2.0"; versionCode = input.action === "install_app" ? 30 : 12;
        if (input.action === "disable_app") fixtureEnabled = false;
        if (input.action === "enable_app") fixtureEnabled = true;
        if (input.action === "uninstall_app") apps.splice(apps.findIndex(app => app.bundleName === input.bundleName), 1);
        return route.fulfill({ json: { result: { receipt: { verification: "passed" } } } });
      }
      if (url.pathname === "/api/harmony/packages") return route.fulfill({ json: { preview: { filename: "app.hap", size: 8192, sha256: "a".repeat(64),
        bundleName: debugApp.bundleName, versionName: "3.0", versionCode: 30, moduleName: "entry", moduleType: "entry", abilities: ["EntryAbility"],
        deviceTypes: ["phone"], permissions: ["ohos.permission.CAMERA"], signature: "unverified" } } });
      return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#f0f0f1;--border:#ddd;--text:#18181b;--text-muted:#52525b;--text-dim:#71717a;--accent:#2563eb;--text-xs:12px;--text-sm:13px;--text-base:14px;--font-mono:Consolas,monospace}body{margin:0;font:14px system-ui}#root{box-sizing:border-box;width:100%;padding:16px;container-type:inline-size;container-name:harmony-panel}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://app-workbench.test/");
    const region = page.getByRole("region", { name: "应用管理", exact: true });
    await region.waitFor(); assert.equal(reads.length, 0, "hidden apps tab must not read the phone");
    await page.evaluate(() => window.setActive(true));
    await page.getByText("154 / 154 个应用", { exact: false }).waitFor();
    const list = region.getByRole("list", { name: "应用列表", exact: true });
    assert.equal(await list.getByRole("button").count(), 100, "large lists render one bounded page");
    await region.getByRole("button", { name: "下一页", exact: true }).click();
    assert.equal(await list.getByRole("button").count(), 54);
    const query = region.getByRole("textbox", { name: "应用名称或包名" });
    const listReads = reads.length;
    await query.fill("受保护"); await list.getByRole("button").waitFor();
    assert.equal(await list.getByRole("button").count(), 1); assert.equal(reads.length, listReads, "search uses the full fetched list");
    await list.getByRole("button").click();
    await region.getByText("设备标记此应用不可卸载。", { exact: true }).waitFor();
    for (const name of ["启动", "清除数据", "卸载"]) assert.equal(await region.getByRole("button", { name, exact: true }).isDisabled(), true);
    assert.match(await region.innerText(), /com.example.store/);
    await query.fill("调试应用"); await list.getByRole("button").click();
    await region.getByText(/PID 42/).waitFor(); assert.doesNotMatch(await region.innerText(), /PID 42, 43/);
    await page.evaluate(() => window.setCanControl(false));
    await region.getByRole("button", { name: "打开应用沙箱", exact: true }).click();
    await page.waitForFunction(() => window.sandboxes.length === 1);
    assert.deepEqual(sandboxReads[0], { serial: "phone", kind: "sandbox", bundleName: debugApp.bundleName, path: "data/storage/el2/base" });
    assert.equal(await page.evaluate(() => window.acquireCalls), 0); assert.equal(writes.length, 0, "sandbox navigation never starts the app or acquires control");
    sandboxDenied = true;
    await region.getByRole("button", { name: "打开应用沙箱", exact: true }).click();
    await region.getByRole("alert").waitFor(); assert.equal(await page.evaluate(() => window.sandboxes.length), 1);
    await query.fill("发行应用"); await list.getByRole("button").click();
    await region.getByText("发行签名不能使用此调试沙箱入口。", { exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "打开应用沙箱", exact: true }).isDisabled(), true);
    await query.fill("");
    await region.getByRole("combobox", { name: "应用分类", exact: true }).selectOption("system");
    await region.getByRole("button", { name: "停止读取分类", exact: true }).waitFor();
    await region.getByRole("button", { name: "停止读取分类", exact: true }).click();
    await region.getByRole("button", { name: "继续读取分类", exact: true }).waitFor();
    assert.ok(maxDetails <= 3, "classification limits concurrent phone reads");
    await region.getByRole("button", { name: "继续读取分类", exact: true }).click();
    await region.getByRole("button", { name: "停止读取分类", exact: true }).waitFor({ state: "detached" });
    assert.ok(maxDetails <= 3); assert.equal(writes.length, 0);
    await region.getByRole("combobox", { name: "应用分类", exact: true }).selectOption("unknown");
    await list.getByRole("button", { name: /com.sample.app0/ }).waitFor();
    assert.equal(await list.getByRole("button").count(), 1, "inaccessible metadata stays unknown, never third-party");
    await region.getByRole("combobox", { name: "应用分类", exact: true }).selectOption("all");
    await query.fill("调试应用"); await list.getByRole("button").click();
    await region.getByRole("button", { name: "清除缓存", exact: true }).waitFor();
    await page.evaluate(() => window.setCanControl(true));
    assert.equal(writes.length, 0, "selecting an application never performs maintenance");
    const clickMaintenance = async (name, action) => {
      const before = writes.length;
      const response = page.waitForResponse(reply => new URL(reply.url()).pathname === "/api/harmony/action"
        && reply.request().postDataJSON()?.action === action);
      await region.getByRole("button", { name, exact: true }).click();
      assert.equal((await response).status(), 200);
      await region.getByRole("button", { name: "取消操作", exact: true }).waitFor({ state: "detached" });
      assert.equal(writes.length, before + 1, "one explicit click dispatches exactly one application action");
      assert.equal(writes.at(-1).action, action); assert.equal(writes.at(-1).bundleName, debugApp.bundleName);
      assert.equal(writes.at(-1).leaseToken, "lease"); assert.deepEqual(nativeDialogs, []);
    };
    await clickMaintenance("清除缓存", "clear_app_cache");
    await region.getByText("版本: 2.0 (12)", { exact: true }).waitFor();
    assert.equal(writes[0].action, "clear_app_cache"); assert.equal(writes[0].leaseToken, "lease");
    await clickMaintenance("清除数据", "clear_app_data");
    await region.getByText("高级：应用使能状态", { exact: true }).click();
    await clickMaintenance("禁用应用", "disable_app");
    await region.getByText("使能状态: 已禁用", { exact: true }).waitFor();
    assert.equal(await region.getByRole("button", { name: "启动", exact: true }).isDisabled(), true);
    await clickMaintenance("使能应用", "enable_app");
    await region.getByText("使能状态: 已启用", { exact: true }).waitFor();
    const beforeCancelledLaunch = writes.length;
    await page.evaluate(() => { window.delayLease = true; });
    await region.getByRole("button", { name: "启动", exact: true }).click();
    await region.getByRole("button", { name: "取消操作", exact: true }).click();
    await page.evaluate(() => { window.completeLease(); window.delayLease = false; });
    await region.getByRole("button", { name: "取消操作", exact: true }).waitFor({ state: "detached" });
    assert.equal(writes.length, beforeCancelledLaunch, "a cancelled lease preparation cannot dispatch a late app launch");
    await region.getByRole("textbox", { name: "HAP 完整路径", exact: true }).fill("C:\\workspace\\app.hap");
    assert.equal(await region.getByRole("button", { name: "安装", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.setCanControl(false));
    const acquisitions = await page.evaluate(() => window.acquireCalls);
    await region.getByRole("button", { name: "预览安装包", exact: true }).click();
    await region.getByText("安装版本: 3.0 (30)", { exact: true }).waitFor();
    await region.getByText("设备现有版本: 2.0 (12)", { exact: true }).waitFor();
    await region.getByText("签名尚未验证，最终由设备安装时校验。", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.acquireCalls), acquisitions, "package preview does not acquire phone control");
    assert.equal(writes.length, beforeCancelledLaunch, "a current package preview waits for an explicit install click");
    await page.evaluate(() => window.setCanControl(true));
    await region.getByRole("checkbox", { name: "替换已安装版本", exact: true }).uncheck();
    await region.getByRole("button", { name: "安装", exact: true }).click();
    await region.getByRole("alert").filter({ hasText: "安装包在预览后发生了变化" }).waitFor();
    assert.equal(writes.length, beforeCancelledLaunch + 1);
    assert.equal(writes.at(-1).expectedHash, "a".repeat(64)); assert.equal(writes.at(-1).replace, false);
    assert.deepEqual(nativeDialogs, []);
    assert.equal(await region.getByRole("button", { name: "安装", exact: true }).isDisabled(), true, "changed packages require a new preview");
    await region.getByRole("button", { name: "预览安装包", exact: true }).click();
    await region.getByText("安装版本: 3.0 (30)", { exact: true }).waitFor();
    await region.getByRole("textbox", { name: "HAP 完整路径", exact: true }).fill("C:\\workspace\\another.hap");
    assert.equal(await region.getByRole("button", { name: "安装", exact: true }).isDisabled(), true, "editing the path invalidates its package preview");
    await region.getByRole("button", { name: "预览安装包", exact: true }).click();
    await region.getByText("安装版本: 3.0 (30)", { exact: true }).waitFor();
    const beforeInstall = writes.length;
    installStale = false;
    await region.getByRole("button", { name: "安装", exact: true }).click();
    await region.getByText("已回读设备应用，版本与安装包一致：com.example.fixture。", { exact: true }).waitFor();
    assert.equal(writes.length, beforeInstall + 1); assert.equal(writes.at(-1).action, "install_app");
    assert.equal(writes.at(-1).expectedHash, "a".repeat(64)); assert.equal(writes.at(-1).replace, false);
    assert.deepEqual(nativeDialogs, []);
    await list.getByRole("button").click(); await region.getByRole("button", { name: "卸载", exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "application details and actions fit a narrow panel");
    const beforeUninstall = writes.length;
    await region.getByRole("button", { name: "卸载", exact: true }).click();
    await region.getByText("选择应用查看详情与可用操作", { exact: true }).waitFor();
    assert.equal(await list.getByRole("button").count(), 0, "uninstall result is confirmed by rereading the device list");
    assert.equal(writes.length, beforeUninstall + 1); assert.equal(writes.at(-1).action, "uninstall_app");
    assert.equal(writes.at(-1).bundleName, debugApp.bundleName); assert.deepEqual(nativeDialogs, []);
    await query.fill(""); await page.evaluate(() => window.setSerial("other"));
    await list.getByRole("button", { name: /另一台设备/ }).waitFor();
    assert.equal(await list.getByRole("button").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (root.startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
