import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { extendMemePanel } = await createJiti(import.meta.url).import("../desktop/src/dsh-meme-panel.ts");

test("chat settings keep editable status libraries, searchable prompts and themed keyboard pickers", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-chat-ui-")); let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `const path=require('path');module.exports=function(s){const prefix=path.basename(this.resourcePath,'.module.css')+'_';return 'export default '+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]])));}`);
    await writeFile(path.join(directory, "icons.tsx"), "export const ModelProviderIcon=()=>null;");
    await writeFile(path.join(directory, "entry.tsx"), `
      import React,{useEffect,useRef,useState} from 'react';import{createRoot}from'react-dom/client';
      import{I18nProvider}from'@/hooks/useI18n';import{useFocusTrap}from'@/hooks/useFocusTrap';
      import{registerAbortHandler,useGlobalKeyboardShortcuts}from'@/hooks/useKeyboardShortcuts';
      import{RunningStatusSettings}from'@/components/RunningStatusSettings';import{SystemPromptSelector}from'@/components/SystemPromptSelector';import{ArchivedChatsSettings}from'@/components/ArchivedChatsSettings';import{ChatInput}from'@/components/ChatInput';
      function Picker(){const ref=useRef(null);const[closed,setClosed]=useState(0);const[value,setValue]=useState('all');useFocusTrap(ref,true,{onEscape:()=>setClosed(n=>n+1)});return <div ref={ref} role="dialog" aria-label="下拉菜单测试"><label>项目<select aria-label="项目选择" value={value} onChange={e=>setValue(e.target.value)}><optgroup label="项目"><option value="all">所有项目</option><option value="piora">Piora</option><option value="disabled" disabled>不可用项目</option>{Array.from({length:35},(_,i)=><option key={i} value={'item-'+i}>{i===3?'很长的项目名称'.repeat(10):'项目 '+i}</option>)}</optgroup></select></label><select aria-label="禁用选择" disabled><option>禁用</option></select><select aria-label="多选列表" multiple><option>A</option><option>B</option></select><output data-testid="selection">{value}</output><output data-testid="closed">{closed}</output></div>}
      function App(){const[selection,setSelection]=useState({mode:'default'});const[aborts,setAborts]=useState(0);useGlobalKeyboardShortcuts();useEffect(()=>{registerAbortHandler(()=>setAborts(n=>n+1));return()=>registerAbortHandler(null)},[]);return <><output data-testid="aborts">{aborts}</output>{location.pathname==='/selects'?<Picker/>:location.pathname==='/archived'?<ArchivedChatsSettings onChanged={()=>{}}/>:<><RunningStatusSettings cwd="C:/fixture/project"/><ChatInput cwd="C:/fixture/project" isStreaming={false} onSend={()=>true} onAbort={()=>setAborts(n=>n+1)} toolbarControl={<SystemPromptSelector selection={selection} onChange={setSelection}/>}/><output data-testid="prompt">{selection.mode==='template'?selection.templateId:'default'}</output></>}</>}
      createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
    `);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "http://chat-ui.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo, "./ModelProviderIcon": path.join(directory, "icons.tsx") } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    let css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    for (const name of ["ModelRetrySettings", "RunningStatusSettings", "SystemPromptSelector", "ArchivedChatsSettings"]) {
      css += (await readFile(path.join(repo, "components", `${name}.module.css`), "utf8")).replace(/\.([a-zA-Z][\w-]*)/g, (_, value) => `.${name}_${value}`);
    }
    const artifacts = path.join(repo, ".verification", "chat-ui-20261114"); await mkdir(artifacts, { recursive: true });
    const generated = Array.from({ length: 50 }, (_, index) => `模型文案 ${index + 1}`);
    let mode = "fail", generateCalls = 0; const releaseGeneration = Promise.withResolvers();
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 950 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://chat-ui.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/api/system-prompt") return route.fulfill({ json: { selectorVisible: true, defaultTemplateId: null, templates: [{ id: "review", name: "严格代码审查", prompt: "审查准则：检查问题原因。\n解释修改的实际影响。" }, { id: "coding", name: "编程助手", prompt: "编写清晰、可维护的代码。" }] } });
      if (pathname === "/api/models") return route.fulfill({ json: { modelList: [{ id: "model", provider: "fixture", name: "Fixture Model" }], defaultModel: { provider: "fixture", modelId: "model" } } });
      if (pathname === "/api/running-status/generate") {
        generateCalls++; assert.deepEqual(route.request().postDataJSON(), { locale: "zh-CN", cwd: "C:/fixture/project" });
        if (mode === "fail") return route.fulfill({ status: 502, json: { error: "generation_failed" } });
        if (mode === "invalid") return route.fulfill({ json: { labels: generated.slice(1), model: "Fixture" } });
        await releaseGeneration.promise; return route.fulfill({ json: { labels: generated, model: "Fixture" } });
      }
      if (pathname === "/api/sessions") return route.fulfill({ json: [] });
      if (pathname === "/api/sessions/flags") return route.fulfill({ json: {} });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { available: false } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      if (pathname === "/meme-panel") return route.fulfill({ contentType: "text/html", body: extendMemePanel('<!doctype html><html><body><h1>表情包</h1><script>async function apiPost(){return {ok:true,sendGear:"auto",sendMode:"auto",packId:"fixture",packs:[{id:"fixture",name:"测试图库"}],enabledPacks:["fixture"]}}async function load(){}function notice(){}</script></body></html>') });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0;padding:24px}footer.chat-composer-footer{margin-top:18px;display:flex;justify-content:flex-start}select{padding:8px 12px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg);color:var(--text)}[data-testid]{display:none}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://chat-ui.test/");
    const library = page.getByRole("textbox", { name: "文案列表（每行一条）" }); await library.waitFor();
    assert.equal((await library.inputValue()).split("\n").length, 50);
    const manual = "手动第一条\n手动修改的第二条";
    await library.fill(manual); await page.getByRole("button", { name: "保存文案库", exact: true }).click();
    await page.getByText("文案库已保存，将从下一轮对话开始使用。", { exact: true }).waitFor();
    await page.reload(); await page.waitForFunction(value => document.querySelector("textarea")?.value === value, manual);
    const generate = page.getByRole("button", { name: "用模型生成并替换 50 条", exact: true });
    await generate.click(); await page.getByRole("alert").waitFor(); assert.equal(await library.inputValue(), manual);
    mode = "invalid"; await generate.click(); await page.getByRole("alert").waitFor(); assert.equal(await library.inputValue(), manual);
    mode = "valid"; await generate.click(); await page.getByRole("button", { name: "正在生成 50 条…", exact: true }).waitFor();
    assert.equal(await library.isDisabled(), true, "manual changes cannot be overwritten by a pending generation");
    releaseGeneration.resolve(); await page.getByText("已用 Fixture 生成并保存 50 条文案，将从下一轮开始使用。", { exact: true }).waitFor();
    assert.deepEqual((await library.inputValue()).split("\n"), generated); assert.equal(generateCalls, 3);
    await library.fill([...generated, "手动追加的第 51 条"].join("\n")); await page.getByRole("button", { name: "保存文案库", exact: true }).click();
    await page.reload(); await page.waitForFunction(() => document.querySelector("textarea")?.value.includes("手动追加的第 51 条"));
    assert.equal((await library.inputValue()).split("\n").length, 51);

    const trigger = page.getByRole("button", { name: "系统提示词模板", exact: true }); await trigger.waitFor();
    assert.equal(await trigger.evaluate(element => Boolean(element.closest(".chat-composer-footer"))), true);
    await trigger.click(); const search = page.getByRole("searchbox", { name: "搜索提示词名称或内容…" }); await search.fill("审查");
    const list = page.getByRole("listbox", { name: "系统提示词模板", exact: true });
    assert.equal(await list.getByRole("option").count(), 1);
    await list.getByRole("option").first().hover(); await page.getByText("预览完整提示词", { exact: true }).click();
    assert.match(await list.locator("..").locator("pre").innerText(), /审查准则/);
    await page.screenshot({ path: path.join(artifacts, "status-and-prompt.png"), fullPage: true });
    await list.getByRole("option").first().click(); assert.equal(await page.getByTestId("prompt").textContent(), "review");
    await trigger.click(); await search.waitFor(); await page.keyboard.press("Escape");
    assert.equal(await list.count(), 0); assert.equal(await page.getByTestId("aborts").textContent(), "0");

    await page.goto("http://chat-ui.test/selects");
    const select = page.getByRole("combobox", { name: "项目选择", exact: true }); await select.waitFor();
    assert.equal(await select.evaluate(element => getComputedStyle(element).appearance), "base-select");
    assert.notEqual(await page.getByRole("listbox", { name: "多选列表" }).evaluate(element => getComputedStyle(element).appearance), "base-select");
    assert.equal(await page.getByRole("combobox", { name: "禁用选择" }).isDisabled(), true);
    await select.click(); await page.waitForFunction(() => document.querySelector('select[aria-label="项目选择"]').matches(":open"));
    const appearance = await select.evaluate(element => { const style = getComputedStyle(element, "::picker(select)"); return { radius: parseFloat(style.borderRadius), shadow: style.boxShadow }; });
    assert.ok(appearance.radius >= 8); assert.notEqual(appearance.shadow, "none");
    await page.screenshot({ path: path.join(artifacts, "select-light.png") });
    await page.getByRole("option", { name: "Piora", exact: true }).click(); assert.equal(await select.inputValue(), "piora");
    await select.press("Alt+ArrowDown"); await page.waitForFunction(() => document.querySelector('select[aria-label="项目选择"]').matches(":open"));
    await page.keyboard.press("Escape");
    assert.equal(await select.evaluate(element => element.matches(":open")), false);
    assert.equal(await page.getByTestId("closed").textContent(), "0", "Escape closes the picker before its enclosing dialog");
    assert.equal(await page.getByTestId("aborts").textContent(), "0", "Escape in a select must not stop a running agent");
    await select.press("Alt+ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.notEqual(await select.inputValue(), "disabled", "keyboard selection skips disabled options");
    await page.locator("html").evaluate(element => element.classList.add("dark")); await select.click();
    await page.screenshot({ path: path.join(artifacts, "select-dark.png") }); await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 360, height: 700 }); await select.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, "select-narrow.png") });
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    assert.equal(await page.getByTestId("closed").textContent(), "1", "a subsequent Escape can close the enclosing dialog");
    await page.goto("http://chat-ui.test/archived");
    const archive = page.getByRole("combobox"); await archive.waitFor();
    assert.equal(await archive.evaluate(element => getComputedStyle(element).appearance), "base-select");
    await archive.click(); await page.screenshot({ path: path.join(artifacts, "archived-select.png") });
    await page.goto("http://chat-ui.test/meme-panel");
    await page.locator("#piora-pack option").waitFor({ state: "attached" });
    assert.equal(await page.locator("select").count(), 3);
    assert.deepEqual(await page.locator("select").evaluateAll(elements => elements.map(element => getComputedStyle(element).appearance)), ["base-select", "base-select", "base-select"]);
    await page.locator("#piora-gear").click(); await page.screenshot({ path: path.join(artifacts, "meme-select.png") });
    await page.goto("http://chat-ui.test/");
    await page.evaluate(() => { localStorage.removeItem("piora-running-status-labels:v2"); localStorage.setItem("piora-running-status-label:v1", "之前保存的文案"); });
    await page.reload(); await page.waitForFunction(() => document.querySelector("textarea")?.value === "之前保存的文案");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-chat-ui-")); await rm(directory, { recursive: true, force: true });
  }
});
