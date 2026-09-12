import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("rich Markdown edits tables, tasks, images and source without losing drafts or depending on a CDN", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-markdown-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=()=>""`);
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {MarkdownEditor} from ${JSON.stringify(path.join(repo, "components/MarkdownEditor.tsx"))};
const initial="# 测试文档\\n\\n正文第一段。\\n\\n| 项目 | 状态 |\\n| --- | --- |\\n| 表格内容 | 待完成 |\\n\\n- [ ] 待办内容\\n\\n末尾文字";window.initial=initial;window.value=initial;window.changes=[];
function App(){const [value,setValue]=React.useState(initial);const editor=React.useRef(null);window.editor=editor;return <div style={{height:640,width:900,margin:"30px auto",border:"1px solid #ddd"}}><MarkdownEditor ref={editor} value={value} onChange={v=>{window.value=v;window.changes.push(v);setValue(v)}} onSave={()=>{window.saved=window.value}} onImage={async file=>{await new Promise(r=>window.uploadDone=r);return '/api/companion/library/image?id='+file.name}}/></div>};createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [], external = []; page.on("pageerror", error => errors.push(error.message));
    const css = (await Promise.all(["node_modules/vditor/dist/index.css", "components/MarkdownEditor.css"].map(file => readFile(path.join(repo, file), "utf8")))).join("\n");
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname !== "markdown.test") { external.push(url.href); await route.abort(); return; }
      if (url.pathname.startsWith("/vendor/vditor/4.0.0/dist/")) {
        const file = path.join(repo, "node_modules/vditor/dist", url.pathname.slice("/vendor/vditor/4.0.0/dist/".length));
        await route.fulfill({ body: await readFile(file), contentType: file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "font/woff2" });
      } else if (url.pathname === "/bundle.js") await route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, "bundle.js")) });
      else if (url.pathname.startsWith("/api/companion/library/image")) await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240"><rect width="640" height="240" fill="#86aa94"/></svg>' });
      else await route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f5f6f7;--bg-selected:#e4eee6;--bg-hover:#eee;--text:#26332c;--text-muted:#68766e;--text-dim:#89948f;--accent:#587d65;--border:#dce3dd;--font-mono:monospace}*{box-sizing:border-box}body{margin:0;font:15px system-ui}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://markdown.test/");
    const body = page.locator('.vditor-wysiwyg [contenteditable="true"]');
    await body.waitFor();
    assert.equal(await page.evaluate(() => window.changes.length), 0, "opening does not rewrite Markdown");
    assert.deepEqual(errors, []);
    assert.equal(await body.locator("table td").count(), 2);
    await body.locator("td").first().click(); await page.keyboard.press("Home"); await page.keyboard.insertText("已编辑");
    await page.waitForFunction(() => window.value.includes("已编辑"));
    await body.locator("td").first().click();
    await page.getByRole("spinbutton",{name:"行",exact:true}).fill("3");
    await page.waitForFunction(()=>document.querySelectorAll('.vditor-wysiwyg table tr').length===3);
    await page.locator('.vditor-toolbar [data-type="undo"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.vditor-wysiwyg table tr').length===2);
    await page.locator('.vditor-toolbar [data-type="redo"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.vditor-wysiwyg table tr').length===3);
    await body.locator('input[type="checkbox"]').click();
    await page.waitForFunction(() => /\[x\]/i.test(window.value));
    await body.locator("p").last().click(); await page.keyboard.press("End");
    await page.evaluate(() => { const data = new DataTransfer(); data.items.add(new File(["image"], "demo.png", {type:"image/png"})); document.activeElement.dispatchEvent(new ClipboardEvent("paste", {clipboardData:data,bubbles:true,cancelable:true})); });
    await page.getByText("正在保存图片，完成后可继续编辑…").waitFor();
    await page.evaluate(() => { window.flushed=false; window.editor.current.flush().then(()=>window.flushed=true); });
    assert.equal(await page.evaluate(() => window.flushed), false, "close waits for image storage");
    await page.evaluate(() => window.uploadDone());
    await page.waitForFunction(() => window.flushed && window.value.includes("image?id=demo.png"));
    await body.locator("img").click();
    await page.getByLabel("图片宽度（像素）").fill("320"); await page.getByLabel("图片宽度（像素）").press("Tab");
    await page.waitForFunction(() => window.value.includes('width="320"'));
    assert.match(await page.evaluate(() => window.value), /末尾文字[\s\S]*demo\.png/);
    await page.evaluate(() => window.editor.current.search());
    await page.getByLabel("查找内容").fill("已编辑"); await page.getByLabel("替换为").fill("替换成功");
    await page.getByRole("button", {name:"全部替换",exact:true}).click();
    await page.waitForFunction(() => window.value.includes("替换成功"));
    await page.getByRole("button", {name:"关闭查找"}).click();
    await page.locator('[data-mode="wysiwyg"]').evaluate(button=>button.click());
    await body.waitFor();
    assert.equal(await body.locator('img[width="320"]').count(), 1, "image sizing survives source roundtrip");
    // Table / image controls stay inside narrow writing panes.
    await page.evaluate(()=>{document.getElementById('root').firstElementChild.style.width='420px';});
    await body.locator("img").click();
    const panel=page.locator('.vditor-wysiwyg .vditor-panel').first();
    const panelBounds=await panel.boundingBox(), editorBounds=await page.locator('.vditor-content').boundingBox();
    assert.ok(panelBounds.x>=editorBounds.x-1 && panelBounds.x+panelBounds.width<=editorBounds.x+editorBounds.width+1);
    assert.ok(panelBounds.y>=editorBounds.y-1 && panelBounds.y+panelBounds.height<=editorBounds.y+editorBounds.height+1);
    await page.evaluate(()=>{document.getElementById('root').firstElementChild.style.width='900px';});
    // Source limits refuse close/save until the oversized edit is corrected.
    const savedValue=await page.evaluate(()=>window.value);
    await page.evaluate(()=>window.editor.current.search());
    await page.getByLabel('Markdown 源码',{exact:true}).fill('x'.repeat(200001));
    await page.waitForFunction(()=>window.editor.current.isBusy());
    assert.equal(await page.evaluate(()=>window.editor.current.flush()),false);
    await page.getByLabel('Markdown 源码',{exact:true}).fill(savedValue);
    await page.waitForFunction(()=>!window.editor.current.isBusy());
    assert.equal(await page.evaluate(()=>window.editor.current.flush()),true);
    assert.equal(await page.getByRole('alert').count(),0);
    await page.getByRole('button',{name:'关闭查找'}).click();
    await page.locator('[data-mode="wysiwyg"]').evaluate(button=>button.click());
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    await mkdir(path.join(repo,".verification"),{recursive:true});
    await page.screenshot({path:path.join(repo,".verification/markdown-editor.png")});
  } finally { await browser?.close(); await rm(root,{recursive:true,force:true}); }
});
