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

test("file change arrows navigate real editors, drafts, folds, independent tabs, source and long/deleted diffs", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-file-navigation-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "stubs.tsx"), 'export const useTheme=()=>({isDark:false});export const CodeBlock=()=>null;export const MermaidBlock=()=>null;');
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {EditorView} from "@codemirror/view";import {FileViewer} from "@/components/FileViewer";import {I18nProvider,useI18n} from "@/hooks/useI18n";
      function Fixture(){const [active,setActive]=useState("one.json");const {setLocale}=useI18n();window.setLocale=setLocale;window.setActiveFile=setActive;window.editorView=name=>EditorView.findFromDOM(document.querySelector('[data-file="'+name+'"] .cm-content'));return <>{["one.json","two.md","clean.txt","large.txt","deleted.txt"].map(name=><section key={name} data-file={name} style={{display:active===name?"block":"none",height:"100%"}}><FileViewer filePath={"/project/"+name} cwd="/project" active={active===name}/></section>)}</>};createRoot(document.getElementById("root")).render(<I18nProvider><Fixture/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@/hooks/useTheme": path.join(root, "stubs.tsx"), "./MermaidBlock": path.join(root, "stubs.tsx"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const jsonLines = ["{", ...Array.from({ length: 360 }, (_, i) => `  "row${i + 1}": ${i + 1}${i < 359 ? "," : ""}`), "}"];
    const changes = [4, 5, 180, 350];
    const jsonPatch = "--- a/one.json\n+++ b/one.json\n" + [
      "@@ -4,2 +4,2 @@\n-  old3\n-  old4\n+" + jsonLines[3] + "\n+" + jsonLines[4],
      ...[180, 350].map(line => `@@ -${line} +${line} @@\n-old\n+${jsonLines[line - 1]}`),
    ].join("\n");
    const largeLines = Array.from({ length: 1300 }, (_, i) => `line ${i + 1}`);
    const largePatch = "--- a/large.txt\n+++ b/large.txt\n@@ -1,1300 +1,1300 @@\n" + largeLines.map((line, i) => [2, 1199].includes(i) ? `-old ${i + 1}\n+${line}` : ` ${line}`).join("\n");
    const files = {
      "one.json": { content: jsonLines.join("\n"), language: "json", patch: jsonPatch },
      "two.md": { content: "# Title\n\nchanged\n\nlast", language: "markdown", patch: "--- a/two.md\n+++ b/two.md\n@@ -3 +3 @@\n-old\n+changed" },
      "clean.txt": { content: "one\ntwo\nthree\nfour\nfive", language: "text" },
      "large.txt": { content: largeLines.join("\n"), language: "text", patch: largePatch },
      "deleted.txt": { patch: "--- a/deleted.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-deleted first\n-deleted last", status: "deleted" },
    };
    const css = (await Promise.all(["app/globals.css", "components/FileEditor.module.css", "components/DiffView.module.css", "components/FileCodeEditor.css", "components/EditorSearch.css"].map(file => readFile(path.join(repo, file), "utf8")))).join("\n").replace(/:global\(([^)]+)\)/g, "$1").replace('@import "tailwindcss";', "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem("pi-locale", "zh-CN"); window.EventSource = class { addEventListener() {} close() {} }; });
    await page.route("http://file-navigation.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname.startsWith("/fonts/")) return route.fulfill({ status: 404, body: "" });
      if (url.pathname === "/api/git/diff") {
        const file = files[path.posix.basename(url.searchParams.get("path"))];
        return route.fulfill({ json: { supported: !!file.patch, patch: file.patch, status: file.status ?? "modified" } });
      }
      if (url.pathname.startsWith("/api/files/")) {
        if (route.request().method() !== "GET") writes.push(route.request().url());
        const file = files[path.posix.basename(decodeURIComponent(url.pathname))];
        return route.fulfill(file?.content === undefined ? { status: 404, json: { error: "File not found" } } : { json: { content: file.content, language: file.language, size: file.content.length, version: "v1", mtime: 1 } });
      }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}html,body{margin:0;height:100%;background:var(--bg-panel)}#root{height:calc(100% - 48px);margin:24px;border:1px solid var(--border);overflow:hidden;border-radius:8px}</style><div id="root"></div><script src="/bundle.js"></script>` });
      return route.fulfill({ json: {} });
    });
    await page.goto("http://file-navigation.test/");
    const file = name => page.locator(`[data-file="${name}"]`);
    const one = file("one.json");
    const next = scope => scope.getByRole("button", { name: "下一处改动", exact: true });
    const prev = scope => scope.getByRole("button", { name: "上一处改动", exact: true });
    const expectLine = async (name, line) => {
      await page.waitForFunction(({ name, line }) => { const view = window.editorView(name); return view && view.state.doc.lineAt(view.state.selection.main.head).number === line; }, { name, line });
      const visible = await page.evaluate(({ name, line }) => { const view = window.editorView(name); const rect = view.coordsAtPos(view.state.doc.line(line).from); const bounds = view.scrollDOM.getBoundingClientRect(); return rect && rect.top >= bounds.top && rect.bottom <= bounds.bottom; }, { name, line });
      assert.ok(visible, `line ${line} is visible in ${name}`);
    };
    const activate = async name => { await page.evaluate(name => window.setActiveFile(name), name); await file(name).getByRole("group", { name: "改动导航" }).waitFor(); };
    await next(one).waitFor();
    assert.equal(await one.locator(".changeCount").getAttribute("title"), "共 3 处改动");
    await next(one).click(); await expectLine("one.json", changes[0]);
    await next(one).click(); await expectLine("one.json", 180);
    await next(one).click(); await expectLine("one.json", 350);
    await next(one).click(); await expectLine("one.json", 4);
    await prev(one).click(); await expectLine("one.json", 350);
    await prev(one).click(); await expectLine("one.json", 180);
    assert.equal(await one.locator(".changeCount").getAttribute("title"), "第 2 处改动，共 3 处");
    assert.equal(await one.getByRole("button", { name: "保存文件", exact: true }).isDisabled(), true);
    if (process.env.PIORA_FILE_NAV_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_FILE_NAV_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.PIORA_FILE_NAV_SCREENSHOT_DIR, "editor.png") });
    }

    // Navigation must follow a manually moved cursor and live, unsaved changes.
    await page.evaluate(() => { const view = window.editorView("one.json"); view.dispatch({ selection: { anchor: view.state.doc.line(80).from } }); view.focus(); });
    await page.keyboard.insertText("draft ");
    await one.locator('.changeCount[title="第 2 处改动，共 4 处"]').waitFor();
    await next(one).click(); await expectLine("one.json", 180);
    await prev(one).click(); await expectLine("one.json", 80);
    await page.keyboard.press("Control+z");
    await one.locator('.changeCount[title="共 3 处改动"]').waitFor();
    await next(one).click(); await expectLine("one.json", 180);

    // Mounted, inactive files retain their independent navigation state.
    await activate("two.md"); await next(file("two.md")).click(); await expectLine("two.md", 3);
    await activate("one.json"); await next(one).click(); await expectLine("one.json", 350);
    await activate("clean.txt"); assert.equal(await next(file("clean.txt")).isDisabled(), true); assert.equal(await prev(file("clean.txt")).isDisabled(), true);
    await file("clean.txt").locator(".cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.insertText(" edited");
    await file("clean.txt").locator('.changeCount[title="第 1 处改动，共 1 处"]').waitFor();
    await next(file("clean.txt")).click(); await expectLine("clean.txt", 5);
    await page.keyboard.press("Control+z"); await file("clean.txt").locator('.changeCount[title="当前文件没有改动"]').waitFor();

    // Revealing a change opens its enclosing fold without editing the document.
    await activate("one.json");
    await one.locator(".cm-content").click(); await page.keyboard.press("Control+Home");
    await one.locator('.cm-file-fold-chevron[data-open="true"]').first().click();
    await one.locator(".cm-foldPlaceholder").waitFor();
    await next(one).click(); await expectLine("one.json", 4);
    assert.equal(await one.locator(".cm-foldPlaceholder").count(), 0);
    await one.getByRole("button", { name: "源代码", exact: true }).click();
    await next(one).click();
    await one.locator('.file-source-line[data-line-number="180"].search-reveal-line').waitFor();
    assert.equal(await one.getByRole("button", { name: "源代码", exact: true }).getAttribute("aria-pressed"), "true");

    // Preview and narrow split preview reveal the editable source when navigating.
    await activate("two.md");
    await file("two.md").getByRole("button", { name: "预览", exact: true }).click();
    await next(file("two.md")).click(); await expectLine("two.md", 3);
    await page.setViewportSize({ width: 560, height: 760 });
    await file("two.md").getByRole("button", { name: "并排预览", exact: true }).click();
    await file("two.md").locator('.file-viewer-mode-switch[aria-label="并排预览"]').getByRole("button", { name: "预览", exact: true }).click();
    await prev(file("two.md")).click(); await expectLine("two.md", 3);
    assert.ok(await file("two.md").locator('.file-viewer-controls').evaluate(element => {
      const parent = element.closest('.file-viewer-toolbar').getBoundingClientRect();
      return [...element.querySelectorAll('button,a')].every(button => { const bounds = button.getBoundingClientRect(); return bounds.left >= parent.left && bounds.right <= parent.right && bounds.bottom <= parent.bottom; });
    }), "narrow toolbars keep every control visible");
    if (process.env.PIORA_FILE_NAV_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PIORA_FILE_NAV_SCREENSHOT_DIR, "narrow.png") });
    await page.setViewportSize({ width: 1000, height: 760 });

    // The last change lies beyond the first progressive batch, and starts on a removed row.
    await activate("large.txt"); const large = file("large.txt");
    await large.getByRole("button", { name: "Diff", exact: true }).click();
    assert.ok(await large.locator("[data-diff-line]").count() < 1201);
    await next(large).click();
    await large.locator('[data-diff-line="3"][data-revealed="true"]').waitFor();
    await large.locator('.file-viewer-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('[data-file="large.txt"] [data-diff-line]').length > 400);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await large.locator('.file-viewer-content').evaluate(element => element.scrollTop > 1000), "loading further rows must not snap back to the last navigated change");
    assert.equal(await large.locator('[data-diff-line="3"]').getAttribute("data-revealed"), "true", "the target highlight survives progressive rendering");
    await prev(large).click();
    await large.locator('[data-diff-line="1201"][data-revealed="true"]').waitFor();
    assert.match(await large.locator('[data-revealed="true"]').textContent(), /old 1200/);
    await page.waitForFunction(() => {
      const bounds = document.querySelector('[data-file="large.txt"] [data-revealed="true"]')?.getBoundingClientRect();
      return bounds && bounds.top > 0 && bounds.bottom < innerHeight;
    });
    const target = await large.locator('[data-revealed="true"]').boundingBox();
    assert.ok(target.y > 0 && target.y + target.height < 760);
    await large.locator('button[title^="@@"]').click();
    assert.equal(await large.locator("[data-diff-line]").count(), 0);
    await next(large).click(); await large.locator('[data-diff-line="3"][data-revealed="true"]').waitFor();
    await activate("deleted.txt");
    await next(file("deleted.txt")).click();
    await file("deleted.txt").locator('[data-diff-line="1"][data-revealed="true"]').waitFor();
    assert.equal(await file("deleted.txt").locator(".cm-content").count(), 0);
    await page.evaluate(() => window.setLocale("en"));
    await file("deleted.txt").getByRole("button", { name: "Previous change", exact: true }).waitFor();
    assert.deepEqual(writes, [], "change navigation never saves the file");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
