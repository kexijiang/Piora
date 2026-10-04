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
const origin = "https://harmony-tree-resize.test";

test("file and database trees resize in the real rendered tool layouts", {
  skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: 120_000,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-harmony-tree-resize-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "transfer.tsx"), "export const TransferJobs=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), [
      'import React from "react";import {createRoot} from "react-dom/client";',
      'import {DeviceFiles} from "@/components/workspace/harmony/DeviceFiles";import {SqliteViewer} from "@/components/workspace/harmony/SqliteViewer";',
      'function App(){const [width,setWidth]=React.useState(960),[serial,setSerial]=React.useState("phone-a"),[hidden,setHidden]=React.useState(false),[mounted,setMounted]=React.useState(true),[initialDatabaseId,setInitialDatabaseId]=React.useState();window.setWidth=setWidth;window.setSerial=setSerial;window.setHidden=setHidden;window.setMounted=setMounted;window.setInitialDatabaseId=setInitialDatabaseId;return <div id="fixture" style={{width}} hidden={hidden}>{mounted?(location.pathname.includes("database")?<SqliteViewer serial={serial} initialDatabaseId={initialDatabaseId} chinese={false}/>:<DeviceFiles serial={serial} chinese={false} canControl={false} ensureControl={()=>{throw Error("resizing must never acquire device control")}}/>):null}</div>}',
      'createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);',
    ].join("\n"));
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./TransferJobs": path.join(root, "transfer.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");

    for (const tool of ["files", "databases"]) await t.test(`${tool}: live pointer resize, keyboard limits, responsive restoration and isolated preferences`, async () => {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const requests = [], errors = [];
      let snapshotSequence = 0;
      page.on("pageerror", error => errors.push(error.message));
      const database = tool === "databases";
      const layoutClass = database ? ".dbLayout" : ".fileExplorerBody";
      const treeClass = database ? ".dbObjects" : ".fileTreePane";
      const contentClass = database ? ".dbContent" : ".fileMain";
      const separatorLabel = database ? "Resize database application tree" : "Resize file folder tree";
      const minimum = database ? 220 : 160;
      const storageKey = `piora-harmony-${tool}-tree-width:phone-a`;
      const separator = page.getByRole("separator", { name: separatorLabel, exact: true });
      const tree = page.locator(treeClass);
      const content = page.locator(contentClass);
      const width = async locator => (await locator.boundingBox()).width;
      const waitWidth = async (selector, expected) => page.waitForFunction(({ selector, expected }) => {
        const actual = document.querySelector(selector)?.getBoundingClientRect().width;
        return actual !== undefined && Math.abs(actual - expected) < 1.1;
      }, { selector, expected });
      const setWidth = async value => {
        await page.evaluate(value => window.setWidth(value), value);
        await page.waitForFunction(value => document.getElementById("fixture").clientWidth === value, value);
        await page.waitForTimeout(300);
      };
      const openDatabase = async () => {
        const application = page.getByRole("button", { name: "Resize fixture", exact: true });
        await application.waitFor();
        if (await application.getAttribute("aria-expanded") !== "true") await application.click();
        await page.getByRole("button", { name: "sample.db", exact: true }).click();
        await page.getByText("Snapshot open", { exact: true }).waitFor();
        await separator.waitFor();
      };
      try {
        await page.route(`${origin}/**`, async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
          if (url.pathname.startsWith("/api/")) {
            requests.push({ method: request.method(), path: url.pathname, ...(request.method() === "POST" ? request.postDataJSON() : {}) });
            if (url.pathname === "/api/harmony/files") {
              const location = url.searchParams.get("path") || "/data/local/tmp";
              const file = { name: location.split("/").at(-1), path: location, kind: "directory" };
              return route.fulfill({ json: url.searchParams.has("stat") ? { file } : { files: [], truncated: false } });
            }
            if (url.pathname === "/api/harmony/databases") {
              const serial = url.searchParams.get("serial") || "phone-a";
              if (request.method() === "GET") return route.fulfill({ json: { scanning: false, startedAt: "2026-10-03T00:00:00Z", applications: [
                { bundleName: "dev.piora.resize.fixture", label: "Resize fixture", status: "ready", databases: [{ id: `${serial}-db`, identity: "resize-db", name: "sample.db" }] },
              ] } });
              const body = request.postDataJSON();
              const result = { tables: ["items"], views: [], indexes: [], fields: [], columns: ["name"], rows: [[body.serial]],
                table: body.action === "read" ? body.table : undefined, offset: 0, hasMore: false };
              return route.fulfill({ json: body.action === "open" ? { id: `snapshot-${body.databaseId}-${++snapshotSequence}`, capturedAt: "2026-10-03T00:01:00Z", result }
                : body.action === "read" ? { result } : { ok: true } });
            }
            throw new Error(`Unexpected request: ${request.method()} ${url.pathname}`);
          }
          return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#eee;--bg-selected:#edf2ff;--border:#ddd;--text:#222;--text-muted:#555;--text-dim:#777;--accent:#2563eb;--text-xs:12px;--text-base:14px;--font-mono:Consolas,monospace}*{box-sizing:border-box}html,body,#root{margin:0}body{font:14px system-ui}#fixture{max-width:100%}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
        });
        await page.goto(`${origin}/${tool}`);
        if (database) {
          await page.getByRole("button", { name: "Resize fixture", exact: true }).waitFor();
          assert.equal(await separator.count(), 0, "the full-width initial application tree has no resize target");
          assert.ok(Math.abs(await width(tree) - (await width(page.locator(layoutClass)) - 2)) <= 1);
          await openDatabase();
        } else await page.getByRole("textbox", { name: "Device file or folder path", exact: true }).waitFor();
        await separator.waitFor();
        await page.waitForTimeout(350);
        const baseline = await width(tree);
        assert.equal(await separator.getAttribute("aria-orientation"), "vertical");
        assert.equal(await separator.getAttribute("aria-valuemin"), String(minimum));
        const controls = await separator.getAttribute("aria-controls");
        assert.equal(await tree.getAttribute("id"), controls);
        const resizeRequests = () => requests.filter(item => item.method !== "GET" || item.path !== "/api/harmony/databases");
        const requestsBeforeResize = resizeRequests().length;
        const bounds = await separator.boundingBox();
        const x = bounds.x + bounds.width / 2, y = bounds.y + Math.min(bounds.height / 2, 100);
        await page.mouse.move(x, y); await page.mouse.down();
        await page.mouse.move(x + 64, y, { steps: 4 });
        assert.ok(Math.abs(await width(tree) - (baseline + 64)) < 1.1, "the tree width changes before the mouse is released");
        assert.equal(await separator.getAttribute("aria-valuenow"), String(Math.round(baseline + 64)));
        assert.equal(await page.evaluate(() => document.body.style.cursor), "col-resize");
        await page.mouse.up();
        assert.equal(await page.evaluate(() => document.body.style.cursor), "");
        const remembered = Math.round(await width(tree));
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), String(remembered));
        await separator.focus();
        await page.keyboard.press("Home");
        await waitWidth(treeClass, minimum);
        await setWidth(700);
        const smallPreferredMaximum = await page.locator(layoutClass).evaluate(element => element.clientWidth - 328);
        assert.equal(await width(tree), minimum);
        assert.equal(await separator.getAttribute("aria-valuemax"), String(smallPreferredMaximum), "announced limits update even if the preferred width does not need clamping");
        await setWidth(960);
        assert.equal(await separator.getAttribute("aria-valuemax"), "600");
        await page.keyboard.press("Shift+ArrowRight");
        await waitWidth(treeClass, minimum + 32);
        await page.keyboard.press("ArrowLeft");
        await waitWidth(treeClass, minimum + 20);
        await page.keyboard.press("End");
        await waitWidth(treeClass, 600);
        assert.ok(await width(content) >= 319, "keyboard maximum keeps a usable content pane");
        assert.equal(await separator.getAttribute("aria-valuemax"), "600");
        await page.keyboard.press("Enter");
        assert.ok(Math.abs(await width(tree) - baseline) < 1.1, "reset restores the responsive default rather than a fixed saved width");
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), null);
        // Grow to a known preference; container resizing must temporarily clamp without replacing it.
        const start = await separator.boundingBox();
        await page.mouse.move(start.x + 4, start.y + 40); await page.mouse.down();
        await page.mouse.move(start.x + 4 + (500 - baseline), start.y + 40); await page.mouse.up();
        await waitWidth(treeClass, 500);
        assert.equal(resizeRequests().length, requestsBeforeResize, "resizing and resetting never dispatches device operations; independent catalog polling may continue");
        const viewport = await page.evaluate(() => innerWidth);
        await setWidth(700);
        const maximum = await page.locator(layoutClass).evaluate(element => element.clientWidth - 328);
        await waitWidth(treeClass, maximum);
        assert.ok(await width(content) >= 319);
        assert.equal(await separator.getAttribute("aria-valuemax"), String(maximum));
        assert.equal(await page.evaluate(() => innerWidth), viewport, "this checks container changes without a window resize");
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), "500");
        await setWidth(960); await waitWidth(treeClass, 500);
        await page.evaluate(() => window.setHidden(true));
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), "500");
        await page.evaluate(() => window.setHidden(false));
        await waitWidth(treeClass, 500);
        await setWidth(360);
        assert.equal(await separator.count(), 0, "narrow tools do not expose a horizontal resize target");
        assert.ok(Math.abs(await width(tree) - await width(content)) < 1.1, "the narrow tree and content each use the entire row width");
        const treeBox = await tree.boundingBox(), contentBox = await content.boundingBox();
        assert.ok(contentBox.y >= treeBox.y + treeBox.height - 1, "narrow panes stack vertically");
        assert.equal(await page.locator("#fixture").evaluate(element => element.scrollWidth > element.clientWidth), false);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), "500");
        await setWidth(960); await waitWidth(treeClass, 500);
        await page.evaluate(() => window.setSerial("phone-b"));
        await page.waitForTimeout(300);
        if (database) await openDatabase();
        if (database) assert.equal(await page.getByRole("tablist", { name: "Open databases", exact: true }).getByRole("tab").count(), 1, "open database tabs belong only to the selected device, even when catalog timestamps match");
        assert.ok(Math.abs(await width(tree) - baseline) < 1.1, "a second device starts with its own default");
        await separator.focus(); await page.keyboard.press("Home");
        await waitWidth(treeClass, minimum);
        await page.evaluate(() => window.setSerial("phone-a"));
        await page.waitForTimeout(300);
        if (database) await openDatabase();
        await waitWidth(treeClass, 500);
        if (database) {
          await page.getByRole("button", { name: "Close database", exact: true }).click();
          await page.waitForFunction(() => document.querySelector('.dbLayout')?.getAttribute('data-has-snapshot') === 'false');
          assert.equal(await separator.count(), 0);
          assert.ok(Math.abs(await width(tree) - (await width(page.locator(layoutClass)) - 2)) <= 1);
          await page.getByRole("button", { name: "sample.db", exact: true }).click();
          await waitWidth(treeClass, 500);
        }
        await page.reload();
        if (database) await page.getByText("Snapshot open", { exact: true }).waitFor();
        await separator.waitFor(); await waitWidth(treeClass, 500);
        if (database) {
          // Hold a fully read response after transport has finished. The component must still fence a late continuation after detach.
          await page.evaluate(() => {
            const fetchOriginal = window.fetch.bind(window);
            window.holdNextSnapshot = true;
            window.fetch = async (url, options) => {
              const body = options?.body ? JSON.parse(options.body) : null;
              const hold = window.holdNextSnapshot && String(url).includes("/api/harmony/databases") && body?.action === "open";
              if (hold) window.holdNextSnapshot = false;
              const response = await fetchOriginal(url, options);
              if (!hold) return response;
              const value = await response.json();
              window.pendingSnapshotId = value.id;
              const released = new Promise(resolve => { window.releaseSnapshot = resolve; });
              return { ok: response.ok, status: response.status, json: async () => { await released; return value; } };
            };
          });
          await page.getByRole("button", { name: "Refresh snapshot", exact: true }).click();
          await page.waitForFunction(() => typeof window.pendingSnapshotId === "string");
          const lateId = await page.evaluate(() => window.pendingSnapshotId);
          await page.evaluate(() => { window.setSerial("phone-b"); window.setInitialDatabaseId("phone-b-db"); });
          await page.getByText("Snapshot open", { exact: true }).waitFor();
          await page.getByRole("button", { name: "items", exact: true }).click();
          await page.getByRole("cell", { name: "phone-b", exact: true }).waitFor();
          assert.equal(await page.getByRole("tablist", { name: "Open databases", exact: true }).getByRole("tab").count(), 1);
          await page.evaluate(() => window.releaseSnapshot());
          await page.waitForTimeout(200);
          assert.deepEqual(requests.filter(item => item.action === "close" && item.id === lateId).map(item => item.serial), ["phone-a"], "a late snapshot is released using its original device identity");
          assert.equal(await page.getByRole("cell", { name: "phone-a", exact: true }).count(), 0, "late data cannot overwrite the new device's results");
          assert.equal(await page.getByRole("cell", { name: "phone-b", exact: true }).isVisible(), true);
          assert.ok(requests.some(item => item.action === "open" && item.serial === "phone-b" && item.databaseId === "phone-b-db"), "a new initialDatabaseId still opens the discovered database after switching devices");
          await page.evaluate(() => { window.setInitialDatabaseId(undefined); window.setSerial("phone-a"); });
          await page.getByText("Snapshot open", { exact: true }).waitFor();
          await waitWidth(treeClass, 500);
        }
        const drag = await separator.boundingBox();
        await page.mouse.move(drag.x + 4, drag.y + 40); await page.mouse.down();
        await page.mouse.move(drag.x + 24, drag.y + 40);
        await page.evaluate(() => window.setMounted(false));
        await page.waitForFunction(() => document.body.style.cursor === "" && document.body.style.userSelect === "");
        await page.mouse.up();
        assert.equal(await page.evaluate(key => localStorage.getItem(key), storageKey), "500", "unmount cancels an unfinished resize without persisting it");
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
