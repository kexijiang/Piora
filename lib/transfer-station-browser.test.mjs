import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("maximized transfer workspace resizes, remembers size and deletes files without discarding failed drafts", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-transfer-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "editor.tsx"), `import React from "react";export const MarkdownEditor=React.forwardRef(({value,onChange},ref)=><textarea aria-label="正文" value={value} onChange={e=>onChange(e.target.value)} style={{width:"100%",height:240}}/>);`);
    await writeFile(path.join(root, "body.tsx"), `export const MarkdownBody=({children})=><div>{children}</div>;`);
    await writeFile(path.join(root, "storage.tsx"), `export const CompanionStorageSettings=()=>null;`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {CompanionTransferStation} from ${JSON.stringify(path.join(repo, "components/CompanionTransferStation.tsx"))};
const initial=[{id:"a",kind:"note",title:"文档 A",content:"原始内容",updatedAt:1},{id:"b",kind:"note",title:"文档 B",content:"另一份内容",updatedAt:1},{id:"image",kind:"image",title:"图片",content:"data:image/png;base64,iVBORw0KGgo=",updatedAt:1}];
window.records=initial;window.writes=[];function App(){const [items,setItems]=React.useState(initial);return <main className="content" data-tool="library" style={{padding:24}}><CompanionTransferStation items={items} loaded loading={false} pending={false} error="" refresh={async()=>{}} write={async(method,input)=>{window.writes.push(input);if(window.failSave&&input.content!==undefined)throw new Error("保存失败测试");if(window.failDelete&&input.remove)throw new Error("删除失败测试");window.records=input.remove?window.records.filter(x=>x.id!==input.id):window.records.map(x=>x.id===input.id?{...x,...input,updatedAt:x.updatedAt+1}:x);setItems(window.records);return window.records;}}/></main>};createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://transfer-ui.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/MarkdownEditor$/, path.join(root, "editor.tsx")), new webpack.NormalModuleReplacementPlugin(/^\.\/MarkdownBody$/, path.join(root, "body.tsx")), new webpack.NormalModuleReplacementPlugin(/^\.\/CompanionStorageSettings$/, path.join(root, "storage.tsx"))], module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    const css = (await readFile(path.join(repo, "components/CompanionTransferStation.module.css"), "utf8")).replace(/:global\(([^)]+)\)/g, "$1");
    // Only include the parent's width constraints: other CSS module class names
    // are scoped in production and must not collide with this fixture's map.
    const panelCss = (await readFile(path.join(repo, "components/CompanionPanel.module.css"), "utf8")).split("\n").filter((line) => line.startsWith(".content >") || line.startsWith('.content[data-tool="library"]')).join("\n");
    await page.route("http://transfer-ui.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) await route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      else await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>:root{--text:#ddd;--text-muted:#aaa;--text-dim:#888;--bg:#171b22;--bg-panel:#202630;--bg-hover:#303945;--bg-selected:#334151;--border:#39434f;--accent:#a8c3aa;--ui-font-size:14px;--text-xs:12px;--text-sm:13px;--text-base:14px;--text-lg:18px;--text-xl:20px}*{box-sizing:border-box}body{margin:0;background:var(--bg);font:14px system-ui}${panelCss}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://transfer-ui.test/");
    const frame = page.locator(".workspaceFrame");
    await frame.waitFor();
    const initialBounds = await frame.boundingBox(); assert.ok(initialBounds.width > 1000, "maximization removes the old 880px cap");
    assert.deepEqual(errors, []);
    const right = page.getByRole("separator", { name: "从右侧调整中转站宽度" });
    const bounds = await right.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 50); await page.mouse.down(); await page.mouse.move(bounds.x - 180, bounds.y + 50, { steps: 10 }); await page.mouse.up();
    const narrower = await frame.boundingBox(); assert.ok(narrower.width < initialBounds.width - 250);
    const bottom = page.getByRole("separator", { name: "调整中转站高度" });
    await bottom.focus(); await bottom.press("ArrowDown");
    const bottomBounds = await bottom.boundingBox();
    await page.mouse.move(bottomBounds.x + bottomBounds.width / 2, bottomBounds.y + 6); await page.mouse.down();
    await page.mouse.move(bottomBounds.x + bottomBounds.width / 2, bottomBounds.y + 46, { steps: 8 }); await page.mouse.up();
    const beforeCorner = await frame.boundingBox();
    const corner = await page.getByRole("button", { name: "调整中转站宽度和高度", exact: true }).boundingBox();
    await page.mouse.move(corner.x + 10, corner.y + 10); await page.mouse.down();
    await page.mouse.move(corner.x + 30, corner.y + 30, { steps: 8 }); await page.mouse.up();
    const taller = await frame.boundingBox(); assert.ok(taller.height > initialBounds.height);
    assert.ok(taller.width > beforeCorner.width && taller.height > beforeCorner.height);
    await page.reload(); await frame.waitFor();
    await page.waitForFunction((width) => Math.abs(document.querySelector(".workspaceFrame").getBoundingClientRect().width - width) < 2, taller.width);
    assert.ok(Math.abs((await frame.boundingBox()).height - taller.height) < 2);
    await page.getByRole("button", { name: "版式", exact: true }).click();
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    assert.ok((await frame.boundingBox()).width > 1000);
    // Delete an unopened file without disturbing the active document.
    await page.getByRole("button", { name: "删除 文档 B", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "删除 文档 B", exact: true }).count(), 1);
    await page.getByRole("button", { name: "删除 文档 B", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.waitForFunction(() => !window.records.some(x => x.id === "b"));
    assert.equal(await page.getByRole("tab", { name: "文档 A", exact: true }).count(), 1);
    // Refuse deletion if an open editor cannot save its draft.
    await page.getByLabel("正文", { exact: true }).fill("不能丢的草稿");
    await page.evaluate(() => { window.failSave = true; });
    await page.getByRole("button", { name: "删除 文档 A", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.getByText("文档尚未保存，未删除文件。请先保存或另存副本。", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("正文", { exact: true }).inputValue(), "不能丢的草稿");
    assert.ok(await page.evaluate(() => window.records.some(x => x.id === "a")));
    await page.evaluate(() => { window.failSave = false; window.failDelete = true; });
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.getByText("删除失败测试", { exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "文档 A", exact: true }).count(), 1);
    await page.evaluate(() => { window.failDelete = false; });
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await page.waitForFunction(() => !window.records.some(x => x.id === "a"));
    assert.equal(await page.getByRole("tab", { name: "文档 A", exact: true }).count(), 0);
    assert.ok(await page.evaluate(() => window.writes.some(x => x.id === "a" && x.content === "不能丢的草稿")), "draft saved before deletion");
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/transfer-workspace.png") });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
