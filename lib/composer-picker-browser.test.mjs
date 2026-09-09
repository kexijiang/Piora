import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { Script } from "node:vm";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("file mentions escape clipped panes and template optimization uses the displayed model", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-composer-picker-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "icons.tsx"), `export const ModelProviderIcon=()=>null;`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {ChatInput} from ${JSON.stringify(path.join(repo, "components/ChatInput.tsx"))};import {SystemPromptEditor} from ${JSON.stringify(path.join(repo, "components/SystemPromptEditor.tsx"))};function App(){return location.pathname==="/editor"?<SystemPromptEditor effectivePrompt={null}/>:<div id="clipped" style={{position:"absolute",bottom:20,left:24,width:"min(650px, calc(100vw - 48px))",height:150,overflow:"hidden",transform:"translateZ(0)"}}><ChatInput variant="launcher" cwd="C:/Workspace/sample" isStreaming={false} onSend={()=>{window.sends=(window.sends||0)+1}} onAbort={()=>{}}/></div>};createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://composer-picker.test/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "./ModelProviderIcon": path.join(root, "icons.tsx"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    new Script(await readFile(path.join(root, "bundle.js"), "utf8"), { filename: "composer-test-bundle.js" });
    const globals = await readFile(path.join(repo, "app/globals.css"), "utf8");
    const css = globals.slice(globals.indexOf("/* Viewport-aware file mention picker. */")) + await readFile(path.join(repo, "components/SystemPromptEditor.module.css"), "utf8");
    const files = Array.from({ length: 45 }, (_, i) => `file-${String(i).padStart(2, "0")}.ts`);
    const longName = "very-long-descriptive-file-name-".repeat(4) + ".tsx";
    files.push(`components/deep/nested/${longName}`, "my folder/example.md");
    const optimizeRequests = [];
    let modelList = [{ provider: "provider-a", id: "default-model", name: "Default Model" }, { provider: "provider-b", id: "editor-model", name: "Editor Model" }];
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, hasTouch: true });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://composer-picker.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/file-index") return route.fulfill({ json: { files } });
      if (url.pathname === "/api/models") return route.fulfill({ json: { modelList, defaultModel: { provider: "provider-a", modelId: "default-model" } } });
      if (url.pathname === "/api/system-prompt") return route.fulfill({ json: { templates: [{ id: "template-1", name: "代码审查", prompt: "请仔细检查代码并给出修改建议" }], defaultTemplateId: "template-1", selectorVisible: true, maxPromptLength: 100000, maxNameLength: 80 } });
      if (url.pathname === "/api/prompts/optimize") { optimizeRequests.push(route.request().postDataJSON()); return route.fulfill({ json: { optimizedPrompt: "优化后的模板草稿" } }); }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { available: false } });
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><style>:root{--text:#172033;--text-muted:#556070;--text-dim:#667080;--bg:#fff;--bg-panel:#fff;--bg-selected:#e4f0ff;--border:#cbd2dc;--text-xs:11px;--text-sm:13px;--text-base:14px;--radius-panel:12px;--radius-control:6px;--radius-surface:12px;--chat-font-size:14px;--chat-line-height:1.5;--font-mono:Consolas,monospace}*{box-sizing:border-box}body{margin:0;background:#e8edf3;font:14px system-ui}#root{padding:20px}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://composer-picker.test/");
    await page.waitForFunction(() => Boolean(document.querySelector("textarea")), undefined, { timeout: 5000 }).catch((cause) => {
      throw new Error(`Composer failed to mount: ${errors.join("; ") || cause.message}`);
    });
    const input = page.locator("textarea");
    const menu = page.getByTestId("file-mention-menu");
    await input.fill("看看 @");
    await menu.getByRole("option").first().waitFor();
    const assertInViewport = async () => {
      const bounds = await menu.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(bounds.x >= 7 && bounds.y >= 7 && bounds.x + bounds.width <= viewport.width - 7 && bounds.y + bounds.height <= viewport.height - 7, JSON.stringify(bounds));
      assert.equal(await menu.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.left + 15, rect.top + 15));
      }), true, "popup is painted above the clipping ancestor");
      return bounds;
    };
    const bounds = await assertInViewport();
    const clipped = await page.locator("#clipped").boundingBox();
    assert.ok(bounds.y < clipped.y, "picker extends outside the chat pane");
    for (let i = 0; i < 20; i++) await input.press("ArrowDown");
    assert.ok(await menu.getByRole("listbox").evaluate((element) => element.scrollTop) > 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
    const selectedPath = await menu.getByRole("option", { selected: true }).getAttribute("aria-label");
    await input.press("Enter");
    assert.equal(await input.inputValue(), `看看 @${selectedPath} `);
    await menu.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.sends || 0), 0);
    await page.setViewportSize({ width: 360, height: 420 });
    await input.fill("@very-long");
    await menu.getByRole("option").first().waitFor();
    await assertInViewport();
    assert.equal(await menu.locator(".file-mention-name").innerText(), longName);
    assert.equal(await menu.locator(".file-mention-name").evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/file-mention-picker.png") });
    await menu.getByRole("option").tap();
    assert.equal(await input.inputValue(), `@components/deep/nested/${longName} `);
    await page.evaluate(() => { const pane = document.getElementById("clipped"); pane.style.top = "20px"; pane.style.bottom = "auto"; window.dispatchEvent(new Event("resize")); });
    await input.fill("@");
    await menu.waitFor();
    const below = await assertInViewport();
    const anchor = await page.locator(".chat-composer-surface").boundingBox();
    assert.ok(below.y >= anchor.y + anchor.height, "picker flips below an input near the top");
    await input.press("Escape");
    await menu.waitFor({ state: "detached" });
    await input.fill("@file");
    await menu.waitFor();
    await page.mouse.click(350, 410);
    await menu.waitFor({ state: "detached" });

    await page.setViewportSize({ width: 900, height: 850 });
    await page.goto("http://composer-picker.test/editor");
    const chooser = page.getByLabel("文案优化模型", { exact: true });
    await chooser.waitFor({ timeout: 5000 }).catch(async (cause) => {
      throw new Error(`Template editor failed: ${errors.join("; ")} ${await page.locator("body").innerText()} ${cause.message}`);
    });
    await page.getByText("本次优化使用：provider-a/default-model", { exact: true }).waitFor();
    await chooser.selectOption(JSON.stringify({ provider: "provider-b", modelId: "editor-model" }));
    await page.getByText("本次优化使用：provider-b/editor-model", { exact: true }).waitFor();
    await page.getByRole("button", { name: "AI 优化", exact: true }).click();
    await page.getByText("优化后的模板草稿", { exact: true }).waitFor();
    assert.equal(optimizeRequests.length, 1);
    assert.equal(optimizeRequests[0].provider, "provider-b");
    assert.equal(optimizeRequests[0].modelId, "editor-model");
    assert.equal(await page.locator("textarea").inputValue(), "请仔细检查代码并给出修改建议", "optimization remains a preview");
    await page.reload();
    await page.getByText("本次优化使用：provider-b/editor-model", { exact: true }).waitFor();
    modelList = modelList.slice(0, 1);
    await page.reload();
    await page.getByText(/当前优化模型不可用/).waitFor();
    assert.equal(await page.getByRole("button", { name: "AI 优化", exact: true }).isDisabled(), true, "a missing configured model never silently falls back");
    await chooser.selectOption("");
    await page.getByText("本次优化使用：provider-a/default-model", { exact: true }).waitFor();
    await page.getByRole("button", { name: "AI 优化", exact: true }).click();
    await page.getByText("优化后的模板草稿", { exact: true }).waitFor();
    assert.equal(optimizeRequests[1].modelId, "default-model");
    await page.screenshot({ path: path.join(repo, ".verification/template-optimizer-model.png") });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
