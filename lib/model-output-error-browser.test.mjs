import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const reported = '400: {"message":"This model\'s maximum context length is 300000 tokens. However, you requested 300000 output tokens and your prompt contains 18282 characters (more than 0 characters, which is the upper bound for 0 input tokens).","code":400}';

test("budget and watchdog errors show localized advice, raw diagnostics and an attachment-preserving retry", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-output-error-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=()=>"export default {}"');
    // Rich message bodies are unused; the error renderer and locale provider are real.
    await writeFile(path.join(directory, "body.tsx"), "export function LazyMarkdownBody(){return null}export function DiffView(){return null}export function AutomationCard(){return null}");
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{MessageView}from'@/components/MessageView';window.retries=[];const prompt={role:'user',content:[{type:'text',text:'original question'},{type:'image',data:'YWJj',mimeType:'image/png'}],clientPromptId:'original-id'};function App(){const[busy,setBusy]=React.useState(true);window.setBusy=setBusy;return <I18nProvider><MessageView message={{role:'assistant',content:[],stopReason:'error',errorMessage:window.reported,timestamp:1}} retryPrompt={{message:prompt,entryId:'original-entry'}} retryDisabled={busy} onRetry={(message,id)=>{window.retries.push({message,id});return new Promise(resolve=>{window.finishRetry=resolve})}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`);
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
    const css = await readFile(path.join(repo, "app/globals.css"), "utf8");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const cases = [
      [reported, "请检查模型配置中的最大输出 Token 设置", "Lower Max Output Tokens in model settings"],
      ["Model request timed out: the provider sent no response data within 120 seconds. The connection or provider may be stalled; the request can be retried.", "模型在 120 秒内未返回数据", "The model sent no response data within 120 seconds"],
      ["Model request timed out: the response stream stopped sending data for 300 seconds. The connection may have died silently; the request can be retried.", "模型连续 300 秒未返回新数据", "The model stopped sending data for 300 seconds"],
    ];
    for (const [raw, chinese, english] of cases) for (const [locale, advice] of [["zh-CN", chinese], ["en", english]]) {
      const page = await browser.newPage({ viewport: { width: 375, height: 700 } });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(value => localStorage.setItem("pi-locale", value), locale);
      await page.addInitScript(value => { window.reported = value; }, raw);
      await page.route("https://budget.test/**", route => route.request().url().endsWith("bundle.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: `<html><meta charset="utf-8"><style>${css}body{padding:16px;background:var(--bg);color:var(--text)}</style><div id="root"></div><script src="/bundle.js"></script></html>` }));
      await page.goto("https://budget.test/");
      await page.getByText(advice, { exact: false }).waitFor({ timeout: 10000 }).catch(async error => {
        assert.deepEqual(errors, [], "error renderer must not crash");
        throw new Error(`${error.message}\nRendered: ${await page.locator('body').innerText()}`);
      });
      assert.equal(await page.locator("details").getAttribute("open"), null);
      assert.equal(await page.locator("pre").isVisible(), false);
      await page.locator("summary").click();
      assert.equal(await page.locator("pre").innerText(), raw);
      assert.equal(await page.locator("pre").isVisible(), true);
      const retry = page.getByRole("button", { name: locale === "zh-CN" ? "重试" : "Retry", exact: true });
      assert.equal(await retry.isDisabled(), true);
      await page.evaluate(() => window.setBusy(false));
      await retry.click();
      assert.equal(await retry.isDisabled(), true);
      const retries = await page.evaluate(() => window.retries);
      assert.equal(retries.length, 1);
      assert.equal(retries[0].id, "original-entry");
      assert.equal(retries[0].message.clientPromptId, "original-id");
      assert.deepEqual(retries[0].message.content, [{ type: "text", text: "original question" }, { type: "image", data: "YWJj", mimeType: "image/png" }]);
      await page.evaluate(() => window.finishRetry());
      await page.waitForFunction(() => !document.querySelector('button[title]').disabled);
      if (locale === "zh-CN" && raw.includes("for 300 seconds")) {
        await page.locator("summary").click();
        await mkdir(path.join(repo, ".verification"), { recursive: true });
        await page.screenshot({ path: path.join(repo, ".verification/331-timeout-retry.png") });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
