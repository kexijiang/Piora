import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("Markdown split preview follows editor scrolling, remounts and layout changes", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-split-preview-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "stubs.tsx"), 'export const useTheme=()=>({isDark:false});export const CodeBlock=()=>null;export const MermaidBlock=()=>null;');
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {FileViewer} from "@/components/FileViewer";import {I18nProvider} from "@/hooks/useI18n";
      createRoot(document.getElementById("root")).render(<I18nProvider><FileViewer filePath="/project/notes.md" cwd="/project"/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@/hooks/useTheme": path.join(root, "stubs.tsx"), "./MermaidBlock": path.join(root, "stubs.tsx"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const content = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\n${"Markdown paragraph with different rendered height. ".repeat(6)}\n`).join("\n");
    const css = (await Promise.all(["app/globals.css", "components/FileEditor.module.css", "components/FileCodeEditor.css", "components/EditorSearch.css"].map(file => readFile(path.join(repo, file), "utf8")))).join("\n").replace(/:global\(([^)]+)\)/g, "$1").replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => { localStorage.setItem("pi-locale", "zh-CN"); window.EventSource = class { addEventListener() {} close() {} }; });
    await page.route("http://split-preview.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname.startsWith("/api/files/")) return route.fulfill({ json: { content, language: "markdown", size: content.length, version: "v1", mtime: 1 } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { supported: false } });
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}</style><div id="root"></div><script src="/bundle.js"></script>` });
      return route.fulfill({ status: 404, body: "" });
    });
    await page.goto("http://split-preview.test/");
    await page.locator(".cm-scroller").waitFor();
    const split = () => page.getByRole("button", { name: "并排预览", exact: true }).click();
    const setScroll = progress => page.locator(".cm-scroller").evaluate((element, progress) => { element.scrollTop = progress * (element.scrollHeight - element.clientHeight); }, progress);
    const expectSync = (progress = null) => page.waitForFunction(progress => {
      const editor = document.querySelector(".cm-scroller"), preview = document.querySelector(".splitPreviewPane");
      const ratio = element => element.scrollTop / (element.scrollHeight - element.clientHeight);
      return editor && preview && (progress === null || Math.abs(ratio(editor) - progress) < 0.02) && Math.abs(ratio(preview) - ratio(editor)) < 0.01;
    }, progress).catch(async error => {
      console.error(await page.locator(".cm-scroller, .splitPreviewPane").evaluateAll(elements => elements.map(element => ({ className: element.className, top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }))));
      throw error;
    });
    await split();
    await page.locator(".splitPreviewPane").waitFor();
    for (const progress of [0.45, 1, 0]) { await setScroll(progress); await expectSync(progress); }
    await page.getByRole("button", { name: "直接编辑文件", exact: true }).click();
    await setScroll(0.4);
    await page.waitForFunction(() => document.querySelector(".cm-scroller").scrollTop > 100);
    await split();
    // CodeMirror restores the pixel offset; its measured scroll range may change on remount.
    await expectSync();
    assert.ok(await page.locator(".cm-scroller").evaluate(element => element.scrollTop > 100));
    await page.setViewportSize({ width: 800, height: 760 });
    await expectSync();
    // A late-loading image/diagram changes preview height without an editor scroll event.
    await page.locator(".markdown-file-preview").evaluate(element => { element.style.paddingBottom = "1000px"; });
    await expectSync();
    await page.setViewportSize({ width: 560, height: 760 });
    await page.locator('.file-viewer-mode-switch[aria-label="并排预览"]').getByRole("button", { name: "预览", exact: true }).click();
    await page.setViewportSize({ width: 1000, height: 760 });
    await expectSync();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("piora-split-preview-"));
    await rm(root, { recursive: true, force: true });
  }
});
