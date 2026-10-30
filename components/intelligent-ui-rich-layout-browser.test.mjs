import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url), repo = path.resolve(import.meta.dirname, "..");
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const surface = {
  version: 2, id: "outings", revision: 1, title: "周末方案比较",
  nodes: [
    { id: "people", type: "number", label: "人数", value: 2, min: 1, max: 10 },
    { id: "category", type: "select", label: "去哪里", value: "全部", options: ["全部", "市内", "户外"] },
    { id: "ceiling", type: "number", label: "最高费用", value: 100, min: 0 },
    { id: "note", type: "text", text: "费用随人数变化。<script>window.bad=true</script>" },
    { id: "summary", type: "dynamicText", parts: ["当前 ", { ref: "people" }, " 人，方案一 ", { op: "multiply", args: [{ ref: "people" }, 10] }, " 元。<script>window.bad=true</script>"] },
    { id: "first", type: "metric", label: "方案一总价", value: { op: "multiply", args: [{ ref: "people" }, 10] } },
    { id: "second", type: "metric", label: "方案二总价", value: { op: "multiply", args: [{ ref: "people" }, 20] } },
    { id: "places", type: "table", columns: ["地点", "类型", "费用"], rows: [["公园", "户外", 30], ["博物馆", "市内", 50], ["城市游", "市内", 120]] },
  ],
  layout: [
    { id: "settings", type: "group", title: "调整条件", columns: 3, nodeIds: ["people", "category", "ceiling", "note", "summary"] },
    { id: "choices", type: "comparison", title: "两个方案", cards: [{ id: "one", title: "方案一", nodeIds: ["first"] }, { id: "two", title: "方案二", nodeIds: ["second"] }] },
    { id: "matching", type: "filteredTable", title: "可选地点", tableId: "places", filters: [{ column: 1, controlId: "category", operator: "equals", inactiveValue: "全部" }, { column: 2, controlId: "ceiling", operator: "lte" }] },
  ],
};

async function buildFixture(directory) {
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `
import React,{useState} from "react";import{createRoot}from"react-dom/client";
import{SurfaceContents}from ${JSON.stringify(path.join(repo, "components/intelligent-ui/SurfaceContents.tsx"))};
import styles from ${JSON.stringify(path.join(repo, "components/intelligent-ui/IntelligentUiSurface.module.css"))};
import{richInitialState}from ${JSON.stringify(path.join(repo, "lib/intelligent-ui/rich-protocol.ts"))};
const initial=${JSON.stringify(surface)},root=createRoot(document.getElementById("root"));
function App({surface=initial,disabled=false}){
const[state,setState]=useState(()=>richInitialState(initial));
const change=(id,value)=>setState(old=>({...old,[id]:value}));
return <main><section className={styles.surface} aria-label={surface.title}><header className={styles.header}><h3>{surface.title}</h3></header><SurfaceContents surface={surface} state={state} locale="zh-CN" disabled={disabled} change={change} copy={{calculation:"当前参数无法计算",chart:"图表"}}/><footer className={styles.footer}>已保存</footer></section></main>}
window.renderRich=(surface=initial,disabled=false)=>root.render(<App surface={surface} disabled={disabled}/>);window.renderRich();`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")] }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const globals = await readFile(path.join(repo, "app/globals.css"), "utf8");
  const light = globals.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  const dark = globals.match(/html\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(light && dark);
  return { bundle: await readFile(path.join(directory, "bundle.js")), css: `:root{${light}}:root.dark{${dark}}html{font-size:var(--ui-font-size)}body{background:var(--bg);color:var(--text);font-size:var(--text-base)}`
    + await readFile(path.join(repo, "components/intelligent-ui/IntelligentUiSurface.module.css"), "utf8")
    + await readFile(path.join(repo, "components/intelligent-ui/RichSurfaceLayout.module.css"), "utf8") };
}

test("rich layout preserves controlled input focus, filters by current values, and stacks groups on narrow panels", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-rich-layout-"));
  let browser;
  try {
    const { bundle, css } = await buildFixture(directory);
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("https://rich-ui.test/**", route => route.request().url().endsWith("/bundle.js")
      ? route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle })
      : route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}main{padding:16px;max-width:900px;margin:auto}${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>` }));
    await page.goto("https://rich-ui.test/");
    try { await page.getByRole("heading", { name: "两个方案" }).waitFor({ timeout: 5000 }); }
    catch (error) { throw new Error(`${error.message}\nBrowser errors: ${JSON.stringify(errors)}\n${await page.locator("body").innerText()}`); }
    async function assertContentGutters(label) {
      const heading = await page.getByRole("heading", { name: surface.title, exact: true }).boundingBox();
      const host = await page.getByRole("region", { name: surface.title, exact: true }).boundingBox();
      const content = await page.locator(".layout").boundingBox();
      assert.ok(heading && host && content);
      assert.ok(content.x > host.x + 1, `${label}: content must not touch the card border`);
      assert.ok(Math.abs(content.x - heading.x) < 1, `${label}: content must align with the title`);
      assert.ok(Math.abs(content.x - host.x - (host.x + host.width - content.x - content.width)) < 1, `${label}: both content gutters must match`);
    }
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/intelligent-ui-rich-spacing-narrow.png"), fullPage: true });
    await assertContentGutters("narrow panel");
    assert.equal(await page.locator("tbody tr").count(), 2);
    assert.equal(await page.getByRole("article").count(), 2);
    assert.equal(await page.locator(".groupGrid").evaluate(node => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await page.evaluate(() => window.bad), undefined);
    const prose=page.locator('[data-ui-dynamic-text="summary"]');
    assert.equal(await prose.textContent(), "当前 2 人，方案一 20 元。<script>window.bad=true</script>");
    const people = page.getByRole("spinbutton", { name: "人数" });
    await people.fill("3");
    assert.equal(await people.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.getByLabel("方案一总价").textContent(), "30");
    assert.equal(await page.getByLabel("方案二总价").textContent(), "60");
    assert.equal(await prose.textContent(), "当前 3 人，方案一 30 元。<script>window.bad=true</script>");
    assert.equal(await page.evaluate(() => window.bad), undefined);
    await page.getByRole("combobox", { name: "去哪里" }).selectOption("市内");
    assert.equal(await page.locator("tbody tr").count(), 1);
    assert.match(await page.locator("tbody").innerText(), /博物馆/);
    await page.getByRole("spinbutton", { name: "最高费用" }).fill("200");
    assert.equal(await page.locator("tbody tr").count(), 2);
    await page.getByRole("spinbutton", { name: "最高费用" }).fill("20");
    await page.getByText("没有符合当前筛选条件的记录。").waitFor();
    assert.equal(await page.locator("tbody tr").count(), 0);
    await page.getByRole("combobox", { name: "去哪里" }).selectOption("全部");
    await page.getByRole("spinbutton", { name: "最高费用" }).fill("100");
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/intelligent-ui-dynamic-text-browser.png"), fullPage: true });
    await page.setViewportSize({ width: 1000, height: 1000 });
    assert.equal(await page.locator(".groupGrid").evaluate(node => getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/).length), 3);
    await assertContentGutters("wide panel");
    await page.screenshot({ path: path.join(repo, ".verification/intelligent-ui-rich-spacing-wide.png"), fullPage: true });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await assertContentGutters("dark theme");
    await page.screenshot({ path: path.join(repo, ".verification/intelligent-ui-rich-spacing-dark.png"), fullPage: true });
    await page.evaluate(payload => window.renderRich(payload, true), surface);
    assert.equal(await people.isDisabled(), true);
    assert.equal(await people.inputValue(), "3", "changing preview editability preserves the input state");
    const calculationFailure = structuredClone(surface);
    calculationFailure.nodes.find(node => node.id === "places").rows[0][2] = { op: "divide", args: [1, 0] };
    calculationFailure.nodes.find(node => node.id === "summary").parts = ["每人：", { op: "divide", args: [1, 0] }];
    await page.evaluate(payload => window.renderRich(payload), calculationFailure);
    await page.getByText("1 条记录暂时无法判断是否符合筛选条件，仍保留显示。").waitFor();
    assert.match(await page.locator("tbody").innerText(), /公园/);
    assert.equal(await prose.textContent(), "每人：当前参数无法计算");
    await page.evaluate(payload => window.renderRich({ ...payload, layout: [] }), surface);
    await page.getByRole("alert").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
