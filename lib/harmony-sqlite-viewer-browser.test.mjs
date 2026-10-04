import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("SQLite viewer keeps distinct drafts across rescans, copies results and queues configurable exports", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-sqlite-viewer-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css-loader.cjs"), `module.exports=()=>"module.exports = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });"`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {SqliteViewer} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/SqliteViewer.tsx"))};createRoot(document.getElementById("root")).render(<SqliteViewer serial="phone" chinese={false}/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.module\.css$/, use: path.join(root, "css-loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ acceptDownloads: true });
    const actions = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.copiedText = "";
      window.piDesktop = { clipboard: { writeText: async text => { window.copiedText = text; } } };
    });
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    let catalogGeneration = 1, catalogScanning = false, holdNextCatalog, catalogReads = 0, rejectNextRescan = false;
    await page.route("https://sqlite-viewer.test/**", async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/api/harmony/database-exports") {
        if (request.method() === "POST") { actions.push(request.postDataJSON()); return route.fulfill({ status: 202, json: { job: { id: "12345678-1234-1234-1234-123456789abc", status: "queued" } } }); }
        return route.fulfill({ json: { jobs: [] } });
      }
      if (pathname === "/api/harmony/databases") {
        if (request.method() === "GET") {
          catalogReads++;
          if (new URL(request.url()).searchParams.has("refresh") && rejectNextRescan) {
            rejectNextRescan = false;
            return route.fulfill({ status: 503, json: { error: { message: "Scan unavailable; retry" } } });
          }
          if (new URL(request.url()).searchParams.has("refresh")) catalogGeneration++;
          const data = { scanning: catalogScanning, startedAt: `2026-09-29T00:0${catalogGeneration}:00Z`, applications: [
            { bundleName: "com.example.notes", label: "Notes", status: catalogScanning ? "scanning" : "ready", databases: catalogScanning ? [] : [
              { id: `database-1-g${catalogGeneration}`, identity: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "sample.db" },
              { id: `database-2-g${catalogGeneration}`, identity: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "sample.db" },
            ] }, { bundleName: "com.example.empty", label: "Empty", status: catalogScanning ? "pending" : "empty", databases: [] },
            { bundleName: "com.example.locked", label: "Locked", status: "inaccessible", reason: "App sandbox unavailable; use a running debug app", databases: [] },
          ] };
          const held = holdNextCatalog; holdNextCatalog = undefined;
          if (held) { held.started(); await held.wait; }
          return route.fulfill({ json: data });
        }
        const input = request.postDataJSON(); actions.push(input);
        if (input.action === "read" && input.sql?.includes("FRM sample")) return route.fulfill({ status: 502,
          json: { error: { code: "INVALID_RESPONSE", message: 'SQLite operation failed: near "sample": syntax error', details: { sqlErrorOffset: input.sql.lastIndexOf("sample") } } } });
        if (input.action === "read" && input.sql === "SELECT (") return route.fulfill({ status: 502,
          json: { error: { code: "INVALID_RESPONSE", message: "SQLite operation failed: incomplete input" } } });
        const result = { tables: ["sample", "empty"], views: [], table: input.action === "read" ? input.table : undefined,
          columns: ["name", "count"], rows: input.table === "empty" ? [] : [[catalogGeneration === 1 ? "中文" : `Fresh data ${catalogGeneration}`, 12]],
          fields: input.table === "sample" ? [
            { name: "name", type: "TEXT", notNull: true, primaryKey: 0, defaultValue: "'untitled'" },
            { name: "count", type: "INTEGER", notNull: false, primaryKey: 0, defaultValue: null, generated: "stored" },
          ] : [], indexes: [
            { name: "expression_idx", table: "sample", unique: false, partial: true, origin: "created", columns: ["count"],
              keyParts: [{ kind: "expression", descending: true, collation: "NOCASE" }, { kind: "column", name: "count", descending: false, collation: "BINARY" }],
              definition: "CREATE INDEX expression_idx ON sample(lower(name) COLLATE NOCASE DESC, count ASC) WHERE count > 0" },
            { name: "sqlite_autoindex_sample_1", table: "sample", unique: true, partial: false, origin: "unique", columns: ["name"],
              keyParts: [{ kind: "column", name: "name", descending: false, collation: "BINARY" }] },
          ], foreignKeys: input.table === "sample" ? [{ from: "name", table: "parent", to: null }] : [],
          definition: input.table === "sample" ? "CREATE TABLE sample(name TEXT NOT NULL UNIQUE DEFAULT 'untitled', count INTEGER GENERATED ALWAYS AS (length(name)) STORED)" : undefined,
          offset: 0, hasMore: false };
        return route.fulfill({ json: input.action === "open" ? { id: `snapshot-${input.databaseId}`, capturedAt: `2026-09-29T00:0${catalogGeneration}:30Z`, result } : { result } });
      }
      return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#f0f0f1;--border:#e4e4e7;--text:#18181b;--text-muted:#52525b;--text-dim:#71717a;--accent:#2563eb;--font-mono:Consolas,monospace;--text-xs:12px;--text-sm:13px;--text-base:14px;--control-height:34px;--radius-control:8px;--radius-surface:12px}html,body,#root{height:100%;margin:0}body{font:14px system-ui,sans-serif;background:#f4f4f5}#root{width:100%;padding:24px;box-sizing:border-box;container:harmony-drawer / inline-size}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://sqlite-viewer.test/");
    const tree = page.getByRole("tree", { name: "Database objects", exact: true });
    const notesItem = tree.getByRole("treeitem", { name: "Notes", exact: true });
    const emptyItem = tree.getByRole("treeitem", { name: "Empty", exact: true });
    const lockedItem = tree.getByRole("treeitem", { name: "Locked", exact: true });
    const lockedApp = lockedItem.getByRole("button", { name: "Locked", exact: true });
    await lockedApp.waitFor();
    assert.equal(await tree.getByRole("treeitem").count(), 3);
    assert.equal(await notesItem.getAttribute("tabindex"), "0");
    assert.equal(await emptyItem.getAttribute("tabindex"), "-1");
    assert.equal(await lockedItem.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByText("App sandbox unavailable; use a running debug app", { exact: true }).count(), 0);
    const compactHeight = await lockedApp.locator("..").evaluate(element => element.getBoundingClientRect().height);
    assert.ok(compactHeight <= 60, `a collapsed app row must remain compact: ${compactHeight}`);
    await lockedApp.click();
    await page.getByText("App sandbox unavailable; use a running debug app", { exact: true }).waitFor();
    assert.equal(await lockedItem.getAttribute("aria-expanded"), "true");
    assert.equal(await lockedItem.evaluate(element => document.activeElement === element), true, "clicking a disclosure leaves keyboard focus on its tree item");
    await lockedItem.press("ArrowLeft");
    assert.equal(await lockedItem.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByText("App sandbox unavailable; use a running debug app", { exact: true }).count(), 0);
    await notesItem.focus();
    await notesItem.press("ArrowDown");
    assert.equal(await emptyItem.evaluate(element => document.activeElement === element), true);
    await emptyItem.press("ArrowDown");
    assert.equal(await lockedItem.evaluate(element => document.activeElement === element), true);
    await lockedItem.press("Home");
    assert.equal(await notesItem.evaluate(element => document.activeElement === element), true);
    assert.equal(await tree.locator('[data-database-tree-item][tabindex="0"]').count(), 1, "the tree exposes one roving tab stop");
    await notesItem.press("ArrowRight");
    assert.equal(await notesItem.getAttribute("aria-expanded"), "true");
    await notesItem.press("ArrowRight");
    const databaseItem = tree.getByRole("treeitem", { name: "sample.db · aaaaaa", exact: true });
    assert.equal(await databaseItem.evaluate(element => document.activeElement === element), true);
    assert.equal(await databaseItem.getAttribute("aria-level"), "2");
    await databaseItem.press("Enter");
    await page.getByText("Snapshot open", { exact: true }).waitFor();
    assert.equal(await databaseItem.getAttribute("aria-expanded"), "true");
    await databaseItem.press("ArrowRight");
    const sampleItem = tree.getByRole("treeitem", { name: "sample", exact: true });
    assert.equal(await sampleItem.evaluate(element => document.activeElement === element), true);
    assert.equal(await sampleItem.getAttribute("aria-level"), "3");
    await sampleItem.press("ArrowLeft");
    assert.equal(await databaseItem.evaluate(element => document.activeElement === element), true);
    await databaseItem.press("ArrowLeft");
    assert.equal(await databaseItem.getAttribute("aria-expanded"), "false");
    assert.equal(await tree.getByRole("treeitem", { name: "sample", exact: true }).count(), 0);
    await databaseItem.press("ArrowRight");
    assert.equal(await databaseItem.getAttribute("aria-expanded"), "true");
    await databaseItem.press("ArrowRight");
    await sampleItem.press("Enter");
    assert.equal(actions.find(action => action.action === "read")?.serial, "phone", "database reads must carry the selected device identity");
    await page.getByRole("tab", { name: "Structure", exact: true }).click();
    const structure = page.getByRole("region", { name: "Table structure" });
    await structure.getByText("Generated · STORED", { exact: true }).waitFor();
    await structure.getByText("name → parent (primary key)", { exact: true }).waitFor();
    const expression = page.getByRole("article", { name: "Index expression_idx", exact: true });
    await expression.getByText("Partial index", { exact: true }).waitFor();
    await expression.getByText("Expression (see definition) · DESC · COLLATE NOCASE", { exact: true }).waitFor();
    await expression.getByText("count · ASC · COLLATE BINARY", { exact: true }).waitFor();
    assert.match(await expression.getByLabel("Index definition expression_idx", { exact: true }).innerText(), /WHERE count > 0/);
    assert.match(await structure.getByLabel("Object definition", { exact: true }).innerText(), /GENERATED ALWAYS/);
    await page.getByRole("article", { name: "Index sqlite_autoindex_sample_1", exact: true }).getByText("Created by a UNIQUE constraint", { exact: true }).waitFor();
    await page.getByRole("button", { name: "expression_idx", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expression.getByText("Selected index", { exact: true }).waitFor();
    assert.equal(await expression.getAttribute("data-selected"), "true");
    assert.equal(await structure.getByText(/parent\.null/).count(), 0);
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-structure.png") });
    }
    await page.setViewportSize({ width: 360, height: 900 });
    await structure.getByLabel("Object definition", { exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.locator("#root").evaluate(element => element.scrollWidth > element.clientWidth), false,
      "long expression definitions and generated-column labels must not overflow the narrow workbench");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-structure-narrow.png") });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "sample", exact: true }).click();
    const resize = page.getByRole("separator", { name: "Resize name column" });
    await resize.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await resize.getAttribute("aria-valuenow"), "166");
    const grip = await resize.boundingBox();
    assert.ok(grip);
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 48, grip.y + grip.height / 2);
    await page.mouse.up();
    assert.equal(await resize.getAttribute("aria-valuenow"), "214");
    assert.equal(await page.getByRole("button", { name: "Sort current page by name" }).innerText(), "name");
    await page.getByRole("cell", { name: "中文" }).click();
    await page.getByRole("button", { name: "Copy cell" }).click();
    await page.waitForFunction(() => window.copiedText === "中文");
    await page.getByRole("button", { name: "Copy row" }).click();
    await page.waitForFunction(() => window.copiedText === "中文\t12");
    await page.getByRole("textbox", { name: "Filter current page" }).fill("not present");
    await page.getByText("No rows match on this page. Clear the filter to show them again.").waitFor();
    assert.equal(await page.getByRole("button", { name: "Copy cell" }).isDisabled(), true, "filtering a selected row must clear the hidden selection");
    await page.getByRole("textbox", { name: "Filter current page" }).fill("");
    await page.getByRole("button", { name: "empty", exact: true }).click();
    await page.getByText("No rows on this page.").waitFor();
    await page.getByRole("button", { name: "sample", exact: true }).click();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database.png") });
    }
    await page.getByRole("button", { name: "Export CSV" }).click();
    await page.getByRole("combobox", { name: "Export range" }).selectOption("page");
    await page.getByRole("combobox", { name: "File encoding" }).selectOption("utf-16le");
    await page.getByRole("textbox", { name: "Local target path (optional)" }).fill("C:\\Piora\\notes.csv");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-export-options.png") });
    await page.getByRole("button", { name: "Start export job" }).click();
    await page.getByText(/Export job 12345678 queued/).waitFor();
    const csv = actions.find(action => action.action === "create" && action.format === "csv");
    assert.equal(csv.table, "sample");
    assert.deepEqual(csv.options, { range: "page", offset: 0, encoding: "utf-16le" });
    assert.equal(csv.destinationPath, "C:\\Piora\\notes.csv");
    await page.getByRole("button", { name: "Export JSON" }).click();
    assert.equal(await page.getByRole("combobox", { name: "File encoding" }).isDisabled(), true);
    await page.getByRole("textbox", { name: "Local target path (optional)" }).fill("");
    await page.getByRole("combobox", { name: "Export range" }).selectOption("all");
    await page.getByRole("button", { name: "Start export job" }).click();
    await page.waitForFunction(() => window.document.body.innerText.includes("Export job 12345678 queued"));
    const json = actions.find(action => action.action === "create" && action.format === "json");
    assert.deepEqual(json.options, { range: "all", offset: 0, encoding: "utf-8" });
    assert.equal(json.destinationPath, undefined);
    await page.getByRole("tab", { name: "SQL console", exact: true }).click();
    const editor = page.getByRole("textbox", { name: "Read-only SQL query" });
    const fullSql = "SELECT 1\nSELECT '中文😀 sample' FRM sample";
    await editor.fill(fullSql);
    await editor.evaluate(element => element.setSelectionRange(element.value.indexOf("\n") + 1, element.value.length));
    await editor.press("Control+Enter");
    await page.getByRole("alert").filter({ hasText: "syntax error" }).waitFor();
    await page.getByText("Line 2 · column 25", { exact: true }).waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-query-error.png") });
    assert.equal(await page.getByRole("cell", { name: "中文" }).count(), 1, "a failed query retains the prior result");
    await page.getByRole("button", { name: "Locate error", exact: true }).click();
    assert.equal(await editor.evaluate(element => element.selectionStart), fullSql.lastIndexOf("sample"));
    await editor.fill(fullSql + " ");
    assert.equal(await page.getByRole("button", { name: "Locate error", exact: true }).isDisabled(), true);
    await page.getByText("The draft changed. Run it again to update the position.", { exact: true }).waitFor();
    await editor.fill("SELECT (");
    await editor.press("Control+Enter");
    await page.getByRole("alert").filter({ hasText: "incomplete input" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Locate error", exact: true }).count(), 0);
    await page.getByText("No verified error location is available. Check the SQLite error message.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("cell", { name: "中文" }).count(), 1);
    await page.getByRole("textbox", { name: "Read-only SQL query" }).fill("SELECT 1");
    await page.getByRole("button", { name: "sample.db · bbbbbb" }).click();
    await page.getByRole("textbox", { name: "Read-only SQL query" }).fill("SELECT 2");
    await page.waitForFunction(() => {
      const saved = JSON.parse(sessionStorage.getItem("piora-harmony-database-tabs:phone") ?? "null");
      return saved?.tabs?.length === 2 && saved.active?.identity === "bbbbbbbbbbbbbbbbbbbbbbbb"
        && saved.tabs[0].sql === "SELECT 1" && saved.tabs[1].sql === "SELECT 2";
    });
    await page.reload();
    const databaseTabs = page.getByRole("tablist", { name: "Open databases" });
    await databaseTabs.getByRole("tab", { name: "Notes / sample.db · bbbbbb" }).waitFor();
    assert.equal(await databaseTabs.getByRole("tab", { name: "Notes / sample.db · bbbbbb" }).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 2");
    await databaseTabs.getByRole("tab", { name: "Notes / sample.db · aaaaaa" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 1");
    await page.getByRole("button", { name: "sample", exact: true }).click();
    await page.getByRole("cell", { name: "中文" }).waitFor();
    // Another window (or the server TTL) starts a scan without clicking this viewer's Rescan button.
    catalogGeneration = 2; catalogScanning = true;
    await page.getByText("Scanning · 1/3 apps", { exact: true }).waitFor();
    assert.equal(await page.getByRole("cell", { name: "中文" }).count(), 0, "old results must disappear as soon as a new scan is observed");
    assert.equal(await page.getByText("Snapshot open", { exact: true }).count(), 0);
    assert.ok(actions.some(action => action.action === "close" && action.id === "snapshot-database-1-g1"));
    catalogScanning = false;
    await page.getByText("Snapshot open", { exact: true }).waitFor();
    await page.getByRole("button", { name: "sample", exact: true }).click();
    await page.getByRole("cell", { name: "Fresh data 2" }).waitFor();
    assert.ok(actions.some(action => action.action === "open" && action.databaseId === "database-1-g2"), "active tab must bind to the new operation ID");
    assert.equal(actions.filter(action => action.action === "read").at(-1).id, "snapshot-database-1-g2");
    await page.getByRole("tab", { name: "SQL console", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 1");
    await databaseTabs.getByRole("tab", { name: "Notes / sample.db · bbbbbb" }).click();
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 2", "same-named databases keep distinct drafts across an external rescan");
    await databaseTabs.getByRole("tab", { name: "Notes / sample.db · aaaaaa" }).click();
    await page.getByRole("tablist", { name: "Open objects" }).getByRole("tab", { name: "sample", exact: true }).waitFor();
    // A delayed old poll must not overwrite a newer explicit rescan response.
    let releasePoll, pollStarted;
    const started = new Promise(resolve => { pollStarted = resolve; });
    holdNextCatalog = { started: pollStarted, wait: new Promise(resolve => { releasePoll = resolve; }) };
    await started;
    const readsWhileHeld = catalogReads;
    await page.waitForTimeout(2800);
    assert.equal(catalogReads, readsWhileHeld, "a slow discovery response must not accumulate overlapping polls");
    await page.getByRole("button", { name: "Rescan", exact: true }).click();
    await page.getByText("Snapshot open", { exact: true }).waitFor();
    await page.getByRole("button", { name: "sample", exact: true }).click();
    await page.getByRole("cell", { name: "Fresh data 3" }).waitFor();
    releasePoll();
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("cell", { name: "Fresh data 3" }).count(), 1);
    await page.getByRole("tab", { name: "SQL console", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 1");
    assert.equal(actions.filter(action => action.action === "open").at(-1).databaseId, "database-1-g3");
    rejectNextRescan = true;
    await page.getByRole("button", { name: "Rescan", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Scan unavailable; retry" }).waitFor();
    assert.equal(await page.getByText("Snapshot open", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Rescan", exact: true }).isEnabled(), true, "failed discovery must allow an immediate explicit retry");
    await page.getByRole("button", { name: "Rescan", exact: true }).click();
    await page.getByText("Snapshot open", { exact: true }).waitFor();
    await page.getByRole("button", { name: "sample", exact: true }).click();
    await page.getByRole("cell", { name: "Fresh data 4" }).waitFor();
    await page.getByRole("tab", { name: "SQL console", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "Read-only SQL query" }).inputValue(), "SELECT 1");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.setViewportSize({ width: 480, height: 900 });
    const rows = await page.locator(".dbObjectGroup").evaluateAll(elements => elements.slice(0, 2).map(element => {
      const { x, y, width } = element.getBoundingClientRect(); return { x, y, width };
    }));
    assert.equal(rows.length, 2);
    assert.ok(Math.abs(rows[0].x - rows[1].x) < 2 && rows[1].y > rows[0].y && rows.every(row => row.width > 350),
      `narrow database app tree must stack vertically at full width: ${JSON.stringify(rows)}`);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});

test("successful SQL reveals the bounded result grid in the real drawer without moving drafts, focus or the app tree", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-sqlite-result-reveal-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css-loader.cjs"), `module.exports=()=>"module.exports = new Proxy({}, { get: (_target, key) => key === '__esModule' ? false : String(key) });"`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {SqliteViewer} from ${JSON.stringify(path.join(repo, "components/workspace/harmony/SqliteViewer.tsx"))};
      createRoot(document.getElementById("root")).render(<main className="root" data-maximized="true" style={{position:"fixed",top:40,left:20,width:"calc(100vw - 40px)",height:720}}>
        <header className="deviceHeader">Device header</header><div className="workspace"><section className="toolDrawer" data-tab="databases">
          <div className="drawerHeading">Database tools</div><div className="drawerTabs"><button>Databases</button></div>
          <div className="drawerBody"><div className="workbench"><div><SqliteViewer serial="phone" chinese={false}/></div></div></div>
        </section></div><footer className="actionBar">Shared screenshot toolbar</footer></main>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"),
      output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.module\.css$/, use: path.join(root, "css-loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1450, height: 900 } });
    const errors = [], reads = [];
    page.on("pageerror", error => errors.push(error.message));
    const bundle = await readFile(path.join(root, "bundle.js")), css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    let nextReadGate;
    await page.route("https://sqlite-reveal.test/**", async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/api/harmony/databases") {
        if (request.method() === "GET") return route.fulfill({ json: { scanning: false, startedAt: "2026-10-03T00:00:00Z", applications: [
          { bundleName: "com.example.notes", label: "Notes", status: "ready", databases: [{ id: "db", name: "sample.db" }] },
          ...Array.from({ length: 50 }, (_, index) => ({ bundleName: `com.example.empty${index}`, label: `Empty ${index}`, status: "empty", databases: [] })),
        ] } });
        const input = request.postDataJSON();
        if (input.action === "close") return route.fulfill({ json: {} });
        if (input.action === "open") return route.fulfill({ json: { id: "snapshot", capturedAt: "2026-10-03T00:00:01Z", result: { tables: ["sample"] } } });
        assert.equal(input.action, "read"); assert.equal(input.id, "snapshot"); reads.push(input);
        const gate = nextReadGate; nextReadGate = undefined;
        if (gate) { gate.started(); await gate.wait; }
        const rows = input.sql.includes("WHERE 0") ? [] : [["中文与空格"], ["second row"], ...Array.from({ length: 48 }, (_, index) => [`More row ${index}`])];
        return route.fulfill({ json: { result: { tables: ["sample"], sql: input.sql, columns: ["label"], rows, offset: 0, hasMore: false } } });
      }
      assert.ok(!pathname.startsWith("/api/"), "result revealing must not start any extra operation");
      return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#eee;--border:#ddd;--text:#222;--text-muted:#555;--text-dim:#777;--accent:#2563eb;--font-mono:Consolas,monospace;--text-xs:12px;--text-base:14px}body{margin:0;overflow:hidden;font:14px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://sqlite-reveal.test/");
    await page.getByRole("button", { name: "Notes", exact: true }).click();
    await page.getByRole("button", { name: "sample.db", exact: true }).click();
    await page.getByText("Snapshot open", { exact: true }).waitFor();
    const editor = page.getByRole("textbox", { name: "Read-only SQL query", exact: true });
    const grid = page.getByRole("region", { name: "Query result grid", exact: true });
    const visibleInOverflow = locator => locator.evaluate(element => {
      const rect = element.getBoundingClientRect();
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(ancestor).overflowY)) continue;
        const bounds = ancestor.getBoundingClientRect();
        if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) return false;
      }
      return rect.top >= 0 && rect.bottom <= innerHeight && element.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
    const outsideState = () => page.evaluate(() => ({
      treeTop: document.querySelector(".dbObjects").getBoundingClientRect().top,
      treeScroll: document.querySelector(".dbObjects").scrollTop,
      searchTop: document.querySelector(".dbOpenBar").getBoundingClientRect().top,
      toolbarTop: document.querySelector(".drawerHeading").getBoundingClientRect().top,
      drawerScroll: document.querySelector(".drawerBody").scrollTop, windowScroll: scrollY,
    }));
    const run = async (sql, empty = false) => {
      await editor.fill(sql);
      await editor.evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
      await page.locator(".dbObjects").evaluate(element => { element.scrollTop = 45; });
      const before = await outsideState();
      let release, started;
      const began = new Promise(resolve => { started = resolve; });
      nextReadGate = { started, wait: new Promise(resolve => { release = resolve; }) };
      await editor.press("Control+Enter"); await began;
      assert.equal(await editor.evaluate(element => document.activeElement === element), true);
      release();
      await page.waitForFunction(() => document.querySelector(".dbQueryActions button")?.disabled === false);
      await page.waitForFunction(expected => document.querySelector(".dbResultsHeader")?.textContent.includes(expected), empty ? "0 rows" : "50 rows");
      assert.equal(await visibleInOverflow(grid.locator("thead th").first()), true, "query result column header must be visible in the real content viewport");
      if (empty) assert.equal(await visibleInOverflow(page.getByText("The query returned no rows.", { exact: true })), true,
        "empty SQL results must reveal their explanation in the real scroll container");
      else for (const label of ["中文与空格", "second row"]) assert.equal(await visibleInOverflow(grid.getByRole("cell", { name: label, exact: true })), true,
        `the first two rows must be fully readable without manual scrolling: ${label}`);
      assert.equal(await grid.evaluate(element => element.scrollTop), 0, "each successful query returns the bounded grid to its first screen");
      assert.equal(await editor.inputValue(), sql);
      assert.deepEqual(await editor.evaluate(element => ({ focused: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd })),
        { focused: true, start: sql.length, end: sql.length }, "reveal must preserve SQL draft, caret and keyboard focus");
      assert.deepEqual(await outsideState(), before, "only the result content may scroll; the tree, search path and external toolbar stay in place");
      assert.equal(await visibleInOverflow(page.getByRole("textbox", { name: "Search app or bundle", exact: true })), true);
    };
    for (const width of [1450, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await run(`SELECT label FROM sample\n-- preserved draft ${width}`);
      await grid.evaluate(element => { element.scrollTop = element.scrollHeight; });
      assert.ok(await grid.evaluate(element => element.scrollTop > 0));
      await run(`SELECT label FROM sample\n-- repeated query ${width}`);
      await run(`SELECT label FROM sample WHERE 0\n-- preserved empty draft ${width}`, true);
      if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
        await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
        await page.locator("main.root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, `database-result-reveal-${width}.png`) });
      }
    }
    assert.equal(reads.length, 6);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) await rm(root, { recursive: true, force: true });
  }
});
