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

test("device folder tree pages independently, bounds rows, supports keyboard navigation and fences late reads", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-folder-tree-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "transfer.tsx"), "export const TransferJobs=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import{createRoot}from"react-dom/client";import{DeviceFiles}from"@/components/workspace/harmony/DeviceFiles";window.treeCommits=0;function Fixture(){const[serial,setSerial]=useState("phone");const[visible,setVisible]=useState(true);window.setTreeSerial=setSerial;window.setTreeVisible=setVisible;return <React.Profiler id="device-files" onRender={()=>window.treeCommits++}>{visible?<DeviceFiles serial={serial} chinese canControl={false} ensureControl={()=>{throw Error("folder browsing must not acquire control")}}/>:null}</React.Profiler>};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./TransferJobs": path.join(root, "transfer.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    const requests = [], errors = [];
    let failNext = false, delayNext = false, releaseNext;
    let failStorage = false, delayStorage = false, releaseStorage;
    const all = Array.from({ length: 1205 }, (_, index) => {
      const name = index === 0 ? ".hidden" : `folder-${String(index).padStart(4, "0")}`;
      return { path: `/data/local/tmp/${name}`, name, kind: index % 5 === 4 ? "file" : "directory", size: 0 };
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://folder-tree.test/**", async route => {
      const request = route.request(), url = new URL(request.url()), location = url.searchParams.get("path"), offset = Number(url.searchParams.get("offset") ?? 0);
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname.startsWith("/api/")) {
        requests.push({ method: request.method(), path: url.pathname, location, offset, stat: url.searchParams.has("stat"), serial: url.searchParams.get("serial") });
        assert.equal(request.method(), "GET", "directory tree never writes, takes over or acquires a lease");
        assert.equal(url.pathname, "/api/harmony/files");
        if (url.searchParams.has("stat")) return route.fulfill({ json: { file: { path: location, name: location.split("/").at(-1), kind: "directory" } } });
        if (location === "/storage" && failStorage) { failStorage = false; return route.fulfill({ status: 403, json: { error: { code: "FILE_ACCESS_DENIED", message: "synthetic restore denied" } } }); }
        if (location === "/storage" && delayStorage) { delayStorage = false; await new Promise(resolve => releaseStorage = resolve);
          return route.fulfill({ json: { files: [{ path: "/storage/late-restore-folder", name: "late-restore-folder", kind: "directory" }], truncated: false } }).catch(() => undefined); }
        if (location === "/data/local/tmp" && offset > 0) {
          if (delayNext) { delayNext = false; await new Promise(resolve => releaseNext = resolve); }
          if (failNext) { failNext = false; return route.fulfill({ status: 403, json: { error: { code: "FILE_ACCESS_DENIED", message: "synthetic folder page denied" } } }).catch(() => undefined); }
        }
        const entries = location === "/data/local/tmp" ? all.slice(offset, offset + 500) : [];
        return route.fulfill({ json: { files: entries, truncated: location === "/data/local/tmp" && offset + 500 < all.length } }).catch(() => undefined);
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#eee;--bg-selected:#edf2ff;--border:#ddd;--text:#222;--text-muted:#555;--text-dim:#777;--accent:#2563eb;--text-xs:12px;--text-base:14px;--font-mono:Consolas,monospace}body{font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://folder-tree.test/");
    const tree = page.getByRole("tree", { name: "设备目录树", exact: true });
    const tmp = tree.getByRole("treeitem", { name: "tmp", exact: true });
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
    await tree.getByRole("button", { name: "显示更多目录（还有 200 个）", exact: true }).waitFor();
    assert.equal(await tmp.getByRole("treeitem").count(), 200, "a 500-entry device page initially renders only 200 folders");
    assert.equal(await tree.getByRole("treeitem", { name: "folder-0004", exact: true }).count(), 0, "files never become folder nodes");
    const readsBeforeRendering = requests.length;
    await tree.getByRole("button", { name: "显示更多目录（还有 200 个）", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await tmp.getByRole("treeitem").count(), 400);
    assert.equal(requests.length, readsBeforeRendering, "rendering more cached rows does not open the parent or read the phone");
    assert.equal(await page.locator(".fileTreePane").evaluate(element => element.clientHeight <= 600 && element.scrollHeight > element.clientHeight), true,
      "large trees scroll independently instead of stretching the entire workbench");
    await tmp.focus();
    const commitsBeforeFocus = await page.evaluate(() => window.treeCommits);
    await page.keyboard.press("ArrowRight");
    assert.equal(await tree.getByRole("treeitem", { name: ".hidden", exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tmp.evaluate(element => document.activeElement === element), true);
    assert.equal(await page.evaluate(() => window.treeCommits), commitsBeforeFocus,
      "moving keyboard focus does not rerender the entire file workspace");
    assert.equal(await tmp.evaluate(element => {
      const row = element.querySelector("[data-device-folder-row]").getBoundingClientRect(), pane = element.closest(".fileTreePane").getBoundingClientRect();
      return row.top >= pane.top - 1 && row.bottom <= pane.bottom + 1;
    }), true, "returning to an expanded parent keeps its label visible rather than scrolling to the whole subtree");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await tmp.getAttribute("aria-expanded"), "false");
    await page.keyboard.press("ArrowRight");
    assert.equal(await tmp.getAttribute("aria-expanded"), "true");
    await page.keyboard.press("End");
    assert.equal(await tree.getByRole("treeitem", { name: "storage", exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("Home");
    assert.equal(await tmp.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("f");
    assert.equal(await tree.getByRole("treeitem", { name: "folder-0001", exact: true }).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press("Control+l");
    assert.equal(await page.getByRole("textbox", { name: "设备文件或文件夹路径", exact: true }).evaluate(element => document.activeElement === element
      && element.selectionStart === 0 && element.selectionEnd === element.value.length), true, "tree keyboard handling preserves the address shortcut");
    const listingBeforeMore = await page.getByRole("table", { name: "当前目录文件", exact: true }).textContent();
    const next = tmp.getByRole("button", { name: "继续读取下一页目录", exact: true });
    failNext = true;
    await next.focus(); await page.keyboard.press("Enter");
    await tmp.getByRole("alert").waitFor();
    assert.equal(await tmp.getByRole("treeitem").count(), 400, "a failed page keeps previously listed folders");
    await tmp.getByRole("button", { name: "重试 tmp", exact: true }).click();
    await tmp.getByText("已检查 1000 项，后面可能还有目录。", { exact: true }).waitFor({ timeout: 5000 }).catch(async error => {
      throw new Error(`Folder retry did not advance: ${JSON.stringify({ requests: requests.slice(-6), hints: await tmp.locator(".fileTreeHint").allTextContents(), expanded: await tmp.getAttribute("aria-expanded") })}`, { cause: error });
    });
    assert.equal(await page.getByRole("table", { name: "当前目录文件", exact: true }).textContent(), listingBeforeMore,
      "paging only the tree leaves the file list and current location intact");
    assert.equal(await tmp.getByRole("treeitem").count(), 400, "new device pages do not mount hundreds of additional rows automatically");
    await tmp.getByRole("button", { name: "显示更多目录（还有 400 个）", exact: true }).click();
    assert.equal(await tmp.getByRole("treeitem").count(), 600);
    await tmp.getByRole("button", { name: "继续读取下一页目录", exact: true }).click();
    await tmp.getByRole("button", { name: "显示更多目录（还有 364 个）", exact: true }).waitFor();
    assert.equal(await tmp.getByRole("button", { name: "继续读取下一页目录", exact: true }).count(), 0, "completed directory scan has no phantom next page");
    await tmp.getByRole("button", { name: "显示更多目录（还有 364 个）", exact: true }).click();
    await tmp.getByRole("button", { name: "显示更多目录（还有 164 个）", exact: true }).click();
    assert.equal(await tmp.getByRole("treeitem").count(), 964);
    assert.equal(new Set(await tmp.getByRole("treeitem").evaluateAll(items => items.map(item => item.getAttribute("aria-label")))).size, 964,
      "all three device pages expose every folder exactly once");
    await page.getByLabel("隐藏文件", { exact: true }).uncheck();
    assert.equal(await tree.getByRole("treeitem", { name: ".hidden", exact: true }).count(), 0);
    await page.getByLabel("隐藏文件", { exact: true }).check();
    assert.equal(await tree.getByRole("treeitem", { name: ".hidden", exact: true }).count(), 1);
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    await tmp.getByRole("button", { name: "继续读取下一页目录", exact: true }).waitFor();
    delayNext = true;
    await tmp.getByRole("button", { name: "继续读取下一页目录", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.fileTreeToggle')?.textContent === "…");
    while (!releaseNext) await page.waitForTimeout(10);
    await page.getByRole("button", { name: "刷新目录", exact: true }).click();
    releaseNext();
    await page.waitForFunction(() => document.querySelector('[aria-label="刷新目录"]')?.disabled === false);
    assert.equal(await tmp.getByText("已检查 1000 项，后面可能还有目录。", { exact: true }).count(), 0,
      "a late next-page reply cannot append to a refreshed first page");
    const child = tree.getByRole("treeitem", { name: "folder-0001", exact: true });
    await child.focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[aria-label="当前位置"]')?.textContent.replace(/\s/g, "") === "/data/local/tmp/folder-0001");
    const readsBeforeFocus = requests.length;
    await tree.getByRole("treeitem", { name: "storage", exact: true }).focus();
    await page.keyboard.press("ArrowUp");
    assert.equal(requests.length, readsBeforeFocus, "moving focus does not navigate or issue a device request");
    await page.keyboard.press("Alt+ArrowLeft");
    await page.waitForFunction(() => document.querySelector('[aria-label="当前位置"]')?.textContent.replace(/\s/g, "") === "/data/local/tmp");
    await page.setViewportSize({ width: 360, height: 850 });
    assert.equal(await page.locator(".fileTreePane").evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.clientHeight <= 155), true,
      "tree paging and retry controls stay inside the narrow panel");
    await tree.getByRole("button", { name: "展开或折叠 storage", exact: true }).click();
    await tree.getByRole("treeitem", { name: "storage", exact: true }).getByRole("button", { name: "展开或折叠 storage", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-folder-path="/storage"]')?.getAttribute("aria-expanded") === "true");
    await page.locator(".fileTreePane").evaluate(element => element.scrollTop = 210);
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('piora-harmony-folder-view:["phone","shared",""]') ?? "null")?.scrollTop === 210);
    const beforeRestore = requests.length;
    all[1] = { ...all[1], path: "/data/local/tmp/refreshed-folder", name: "refreshed-folder" };
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-folder-path="/storage"]')?.getAttribute("aria-expanded") === "true"
      && document.querySelector('[data-device-folder-tree]')?.getAttribute("data-tree-restoring") === "false"
      && document.querySelector('[data-device-folder-tree]')?.scrollTop === 210);
    assert.equal(await tree.getByRole("treeitem", { name: "refreshed-folder", exact: true }).count(), 1,
      "restoring a tree rereads the phone instead of displaying stale cached names");
    assert.equal(await tree.getByRole("treeitem", { name: "folder-0001", exact: true }).count(), 0);
    assert.equal(await tmp.getByRole("treeitem").count(), 400, "cached render choices survive closing the view but fresh page bounds still apply");
    assert.equal(requests.slice(beforeRestore).some(request => request.offset > 0), false,
      "view restoration never automatically pages through a large directory");
    const phoneTwoRead = page.waitForRequest(request => request.url().includes("serial=phone-two") && request.url().includes("stat=1"));
    await page.evaluate(() => window.setTreeSerial("phone-two")); await phoneTwoRead;
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false
      && document.querySelector('[data-folder-path="/data/local/tmp"]')?.getAttribute("aria-expanded") === "true");
    assert.equal(await tree.getByRole("treeitem", { name: "storage", exact: true }).getAttribute("aria-expanded"), "false",
      "another device does not inherit the first device's expanded folders");
    assert.equal(await page.locator(".fileTreePane").evaluate(element => element.scrollTop), 0);
    const phoneOneRead = page.waitForRequest(request => request.url().includes("serial=phone&") && request.url().includes("stat=1"));
    await page.evaluate(() => window.setTreeSerial("phone")); await phoneOneRead;
    await page.waitForFunction(() => document.querySelector('[data-folder-path="/storage"]')?.getAttribute("aria-expanded") === "true"
      && document.querySelector('[data-device-folder-tree]')?.scrollTop === 210);
    failStorage = true;
    await page.reload();
    const storage = tree.getByRole("treeitem", { name: "storage", exact: true });
    await storage.getByRole("button", { name: "重试 storage", exact: true }).waitFor();
    assert.equal(await storage.getAttribute("aria-expanded"), "true", "failed restoration keeps the branch and a retry instead of showing an empty successful folder");
    await storage.getByRole("button", { name: "重试 storage", exact: true }).click();
    await storage.getByRole("alert").waitFor({ state: "hidden" });
    delayStorage = true;
    await page.reload();
    while (!releaseStorage) await page.waitForTimeout(10);
    await tmp.focus(); await page.keyboard.press("ArrowLeft");
    assert.equal(await tmp.getAttribute("aria-expanded"), "false", "manual tree navigation wins while restoration is reading");
    releaseStorage();
    await page.waitForFunction(() => document.querySelector('[data-device-folder-tree]')?.getAttribute("data-tree-restoring") === "false");
    assert.equal(await tree.getByRole("treeitem", { name: "late-restore-folder", exact: true }).count(), 0, "a canceled restore cannot append its late device reply");
    await storage.getByRole("button", { name: "读取 storage 目录", exact: true }).click();
    await storage.getByRole("button", { name: "读取 storage 目录", exact: true }).waitFor({ state: "hidden" });
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('piora-harmony-folder-view:["phone","shared",""]') ?? "null")?.expandedPaths.includes("/data/local/tmp") === false);
    await page.evaluate(() => window.setTreeVisible(false));
    await page.getByRole("tree", { name: "设备目录树", exact: true }).waitFor({ state: "hidden" });
    await page.evaluate(() => window.setTreeVisible(true));
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false
      && document.querySelector('[data-folder-path="/data/local/tmp"]')?.getAttribute("aria-expanded") === "false"
      && document.querySelector('[data-device-folder-tree]')?.getAttribute("data-tree-restoring") === "false");
    assert.equal(await storage.getAttribute("aria-expanded"), "true", "closing and reopening the tools preserves independent branch choices");
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
});
