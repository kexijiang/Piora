import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("message hover actions preserve deletion and command dialogs stay centered and dismissible", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-message-delete-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    // Keep real message action rows; only unrelated rich renderers are stubbed.
    await writeFile(path.join(directory, "message.tsx"), 'import React from "react";export function LazyMarkdownBody({children}){return <p>{children}</p>}export function DiffView(){return null}export function AutomationCard(){return null}');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{useAgentSession}from'@/hooks/useAgentSession';import{ChatHistory}from'@/components/ChatHistory';import{savePendingPrompt,readPendingPrompts}from'@/lib/prompt-recovery';import{CommandExecutionCard,CommandExecutionDialog}from'@/components/CommandExecutionView';
const session={id:'one',cwd:'C:/workspace/project',path:'C:/workspace/one.jsonl',created:new Date(),modified:new Date(),firstMessage:'正常消息',messageCount:2};
const execution={id:"command",toolName:"bash",command:"echo COMMAND_PROOF",output:"OUTPUT_PROOF",status:"failed",isStreaming:false,exitCode:1};
function CommandDemo(){const [opened,setOpened]=React.useState(false);return <aside data-testid="commands"><CommandExecutionCard data={execution} onOpen={()=>setOpened(true)}/>{opened&&<CommandExecutionDialog data={execution} onClose={()=>setOpened(false)}/>}</aside>}
function App(){const state=useAgentSession({session,onAgentEnd:()=>{}});const history=React.useRef(null);const [busy,setBusy]=React.useState(false);window.setBusy=setBusy;window.readPending=()=>readPendingPrompts('one');return <div ref={state.scrollContainerRef} style={{height:550,overflow:'auto'}}><ChatHistory messages={state.messages} entryIds={state.entryIds} busy={busy} streaming={false} isNew={false} forkingEntryId={null} highlightedEntryId={null} lastUserMsgRef={state.lastUserMsgRef} pendingScrollToUserRef={state.pendingScrollToUserRef} scrollContainer={state.scrollContainerRef} handleRef={history} onDeleteMessage={state.handleDeleteMessage} deleteDisabled={busy||state.deletingMessage}/></div>}
async function start(){localStorage.setItem('pi-locale','zh-CN');if(!sessionStorage.getItem('seeded')){await savePendingPrompt({id:'failed',scope:'one',message:{role:'user',content:'失败消息',timestamp:2},draft:{value:'失败消息原文',files:[{name:'a.txt',text:'attachment',size:10}],images:[]}});sessionStorage.setItem('seeded','1')}createRoot(document.getElementById('root')).render(<I18nProvider><App/><CommandDemo/></I18nProvider>)}void start();`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/(LazyMarkdownBody|DiffView|AutomationPanel)$/, path.join(directory, "message.tsx"))], module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const styles = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8")) + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    let rows = [{ id: "user", message: { role: "user", content: "正常消息", clientPromptId: "stored-user", timestamp: 1 } }, { id: "answer", message: { role: "assistant", content: [{ type: "text", text: "模型回复" }], timestamp: 3 } }];
    const receipts = ["stored-user"], requests = [];
    let failDelete = false;
    await page.route("http://delete.test/**", route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: readFileSync(path.join(directory, path.basename(url.pathname))) });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: '<html><meta charset="utf-8"><style>'+styles+'</style><div id="root"></div><script src="/bundle.js"></script></html>' });
      if (req.method() === "DELETE") {
        const id = url.pathname.split("/").at(-1); requests.push(id);
        if (failDelete) return route.fulfill({ status: 500, json: { error: "无法写入消息删除结果" } });
        rows = rows.filter(row => row.id !== id);
        return route.fulfill({ json: { success: true, deletedIds: [id] } });
      }
      if (url.pathname.startsWith("/api/sessions/one")) return route.fulfill({ json: { sessionId: "one", filePath: "C:/workspace/one.jsonl", tree: [], leafId: "answer", context: { messages: rows.map(row => row.message), entryIds: rows.map(row => row.id), model: null, thinkingLevel: "off" }, persistedPromptIds: receipts } });
      return route.fulfill({ json: { models: [], commands: [], state: { isStreaming: false, isBashRunning: false } } });
    });
    await page.goto("http://delete.test/");
    const row = text => page.locator(".chat-message-shell").filter({ hasText: text });
    await row("失败消息").waitFor();
    assert.equal(await page.getByRole("button", { name: "删除消息", exact: true }).count(), 3);
    assert.deepEqual(await page.locator(".chat-message-shell p").allTextContents(), ["正常消息", "失败消息", "模型回复"]);
    for (const text of ["正常消息", "模型回复"]) {
      const message = row(text);
      const copy = message.getByTitle("复制消息", {exact:true});
      const remove = message.getByRole("button", { name: "删除消息", exact: true });
      await page.mouse.move(999, 899);
      const effectiveOpacity = locator => locator.evaluate(element => { let opacity=1; for(let node=element;node;node=node.parentElement) opacity*=Number(getComputedStyle(node).opacity); return opacity; });
      await page.waitForTimeout(160);
      assert.equal(await effectiveOpacity(remove), 0);
      await message.hover();
      await page.waitForTimeout(160);
      assert.equal(await effectiveOpacity(remove), 1);
      const a = await copy.boundingBox(), b = await remove.boundingBox();
      assert.ok(b.x >= a.x+a.width && Math.abs(a.y-b.y)<2, "delete follows copy on the same hover row");
    }
    await page.evaluate(() => window.setBusy(true));
    assert.equal(await row("正常消息").getByRole("button", { name: "删除消息", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.setBusy(false));
    await row("失败消息").hover();
    await row("失败消息").getByRole("button", { name: "删除消息", exact: true }).click();
    await row("失败消息").waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.readPending()), []);
    assert.deepEqual(requests, [], "local recovery removal does not mutate another stored message");
    await page.reload();
    await row("正常消息").waitFor();
    assert.equal(await page.getByRole("button", { name: "删除消息", exact: true }).count(), 2);
    failDelete = true;
    await row("正常消息").hover();
    await row("正常消息").getByRole("button", { name: "删除消息", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "无法写入消息删除结果" }).waitFor();
    assert.equal(await row("正常消息").count(), 1);
    failDelete = false;
    await row("正常消息").hover();
    await row("正常消息").getByRole("button", { name: "删除消息", exact: true }).click();
    await row("正常消息").waitFor({ state: "hidden" });
    await row("模型回复").hover();
    await row("模型回复").getByRole("button", { name: "删除消息", exact: true }).click();
    await row("模型回复").waitFor({ state: "hidden" });
    assert.deepEqual(requests, ["user", "user", "answer"]);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.readPending));
    assert.equal(await page.locator(".chat-message-shell").count(), 0);
    const card = page.locator(".command-execution-card");
    assert.equal(await card.locator(".command-preview, .command-error-excerpt, .command-execution-details").count(), 0);
    await card.locator(".command-execution-toggle").click();
    await card.locator(".cm-content").waitFor();
    assert.match(await card.locator(".command-source-section pre").textContent(), /COMMAND_PROOF/);
    for (const selector of [".command-execution-details", ".command-source-section pre", ".cm-editor", ".cm-gutters"]) {
      assert.equal(await card.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor), "rgba(0, 0, 0, 0)");
    }
    for (const desktop of [false, true]) {
      await page.evaluate(desktop => { window.piDesktop = desktop ? {} : undefined; }, desktop);
      for (const size of [{width:1000,height:900},{width:390,height:700}]) {
        await page.setViewportSize(size);
        for (const method of ["button", "escape"]) {
          await card.getByRole("button", { name: "放大查看命令与输出", exact: true }).click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          const bounds = await dialog.boundingBox();
          assert.ok(Math.abs(bounds.x + bounds.width/2 - size.width/2)<2, "dialog is horizontally centered");
          assert.ok(Math.abs(bounds.y + bounds.height/2 - (size.height+(desktop?36:0))/2)<2, "dialog is vertically centered below desktop titlebar");
          if (method === "button") await dialog.getByRole("button", {name:"关闭",exact:true}).click();
          else await page.keyboard.press("Escape");
          await dialog.waitFor({state:"detached"});
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-message-delete-ui-"));
    await rm(directory, { recursive: true, force: true });
  }
});
