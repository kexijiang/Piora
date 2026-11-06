import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const reported = '400: {"message":"This model\'s maximum context length is 300000 tokens. However, you requested 300000 output tokens and your prompt contains 18282 characters (more than 0 characters, which is the upper bound for 0 input tokens).","code":400}';

test("output budget errors show localized advice and retain raw diagnostics in the disclosure", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-output-error-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=()=>"export default {}"');
    // Rich message bodies are unused; the error renderer and locale provider are real.
    await writeFile(path.join(directory, "body.tsx"), "export function LazyMarkdownBody(){return null}export function DiffView(){return null}export function AutomationCard(){return null}");
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{MessageView}from'@/components/MessageView';createRoot(document.getElementById('root')).render(<I18nProvider><MessageView message={{role:'assistant',content:[],stopReason:'error',errorMessage:${JSON.stringify(reported)},timestamp:1}}/></I18nProvider>);`);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/(LazyMarkdownBody|DiffView|AutomationPanel)$/, path.join(directory, "body.tsx"))],
      module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [
        { test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") },
        { test: /\.css$/, use: path.join(directory, "css.cjs") },
      ] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    for (const [locale, advice] of [["zh-CN", "请检查模型配置中的最大输出 Token 设置"], ["en", "Lower Max Output Tokens in model settings"]]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(value => localStorage.setItem("pi-locale", value), locale);
      await page.route("https://budget.test/**", route => route.request().url().endsWith("bundle.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: '<html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script></html>' }));
      await page.goto("https://budget.test/");
      await page.getByText(advice, { exact: false }).waitFor();
      assert.equal(await page.locator("details").getAttribute("open"), null);
      assert.equal(await page.locator("pre").isVisible(), false);
      await page.locator("summary").click();
      assert.equal(await page.locator("pre").innerText(), reported);
      assert.equal(await page.locator("pre").isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
