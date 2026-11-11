import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const chatWindow = await readFile(path.join(repo, "components/ChatWindow.tsx"), "utf8");
const dropCallback = chatWindow.slice(chatWindow.indexOf("const onDrop = useCallback("), chatWindow.indexOf("const { isDragOver, handleDragEnter"));

test("images preview and copy before sending, then queue or steer durably while a task runs", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-composer-images-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useCallback,useRef,useState} from "react";import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";import {ChatInput} from "@/components/ChatInput";
import {useChatCommandOperations} from "@/hooks/useChatCommandOperations";
import {ChatCommandQueue} from "@/components/ChatCommandCard";
import {createChatCommandCatalog} from "@/lib/chat-command-input";
import {readPendingPrompts} from "@/lib/prompt-recovery";
import {useDragDrop} from "@/hooks/useDragDrop";
const catalog=createChatCommandCatalog([]);
function App(){const [draft,setDraft]=useState("image-draft-a"),[sessionBusy,setBusy]=useState(false),chatInputRef=useRef(null);
  window.switchDraft=setDraft;window.setBusy=setBusy;window.pending=()=>readPendingPrompts(draft);
  const commands=useChatCommandOperations({conversationKey:draft,sessionId:draft,scope:draft,catalog,
    ensureSession:async()=>draft,loadCatalog:async()=>catalog,connectModelEvents:async()=>{},uploadFiles:async()=>[],onAccepted:()=>{},onFinished:()=>{}});
  ${dropCallback}
  const {handleDragEnter,handleDragOver,handleDragLeave,handleDrop}=useDragDrop(onDrop);
  return <main onDrop={handleDrop} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave}>
    <ChatInput ref={chatInputRef} draftKey={draft} variant="launcher" cwd="C:/fixture" isStreaming={sessionBusy} onQueueInput={commands.submit}
      queueContent={<ChatCommandQueue records={commands.records} actions={{cancel:async()=>{},steer:async()=>{},edit:async()=>"",save:async()=>{},resume:async()=>{}}}/>}
      onSend={(message,images,files,onDurable)=>{window.sent.push({message,images});onDurable?.("fixture-prompt");return true;}} onAbort={()=>{window.aborted=true;}} />
  </main>;
}createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    const png = await sharp({ create: { width: 640, height: 360, channels: 4, background: "#4869bc" } }).png().toBuffer();
    const second = await sharp({ create: { width: 300, height: 600, channels: 4, background: "#ca7946" } }).png().toBuffer();
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    const errors = [];
    const queueRequests = [], queueRecords = [];
    page.on("pageerror", error => errors.push(error.stack || error.message));
    // Clipboard writes are captured rather than replacing the user's clipboard.
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");window.sent=[];window.copied=[];
      window.EventSource=class { close(){} };
      window.pendingImageReads=[];
      const read=FileReader.prototype.readAsDataURL;
      FileReader.prototype.readAsDataURL=function(file){if(window.holdImageRead)window.pendingImageReads.push(()=>read.call(this,file));else read.call(this,file);};
      window.piDesktop={clipboard:{writeImage:async data=>{window.copied.push(data);}}};
    });
    await page.route("http://127.0.0.1:38203/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/api/agent/") && route.request().method() === "POST") {
        const body = route.request().postDataJSON();
        const pending = await page.evaluate(() => window.pending());
        queueRequests.push({ body, recovery: pending.find(record => record.id === body.idempotencyKey) });
        const record = { commandId: `queued-image-${queueRequests.length}`, idempotencyKey: body.idempotencyKey,
          targetSessionId: pathname.split("/").at(-1), acceptedAt: Date.now(), status: body.delivery === "steer" ? "delivered" : "queued",
          preview: body.message, attachments: body.images?.length ?? 0 };
        queueRecords.push(record);
        return route.fulfill({ json: { success: true, data: { commandId: record.commandId, status: record.status } } });
      }
      if (pathname.endsWith("/submissions")) return route.fulfill({ json: { items: queueRecords.filter(record => pathname.includes(record.targetSessionId)), nextOffset: null } });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { files: [], available: false, enabled: false, items: [], commands: [] } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}
        body{background:var(--bg);color:var(--text)}main{max-width:760px;margin:24px auto;padding:16px;border:1px solid var(--border)}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    await page.goto("http://127.0.0.1:38203/");
    const input = page.locator("textarea");
    await input.fill("尚未发送的图片说明");
    await page.locator('input[type="file"]').first().setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: png },
      { name: "second.png", mimeType: "image/png", buffer: second },
    ]);
    const thumbnails = page.locator(".composer-image-thumbnail");
    await thumbnails.nth(1).waitFor();
    assert.equal(await page.getByText(/图片仅随本轮任务发送/).count(), 0);
    const dialog = page.getByRole("dialog", { name: "图片查看器", exact: true });
    for (const [index, source] of [png, second].entries()) {
      await thumbnails.nth(index).click();
      await dialog.waitFor();
      await page.waitForFunction(() => document.querySelector("dialog img")?.naturalWidth > 0);
      assert.equal(await page.evaluate(() => window.sent.length), 0, "preview must never send the draft");
      assert.equal(await dialog.locator("img").getAttribute("src"), `data:image/png;base64,${source.toString("base64")}`);
      await dialog.getByRole("button", { name: "复制图片", exact: true }).click();
      await dialog.getByRole("status").filter({ hasText: "已复制" }).waitFor();
      assert.equal(await page.evaluate(() => window.copied.at(-1)), `data:image/png;base64,${source.toString("base64")}`,
        "desktop bridge receives the original attachment, not its thumbnail");
      await page.keyboard.press("Escape");
      assert.equal(await dialog.count(), 0);
      assert.equal(await thumbnails.nth(index).evaluate(element => element === document.activeElement), true);
      assert.equal(await input.inputValue(), "尚未发送的图片说明");
    }
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.setViewportSize({ width: 390, height: 700 });
    await thumbnails.first().press("Enter");
    await dialog.waitFor();
    const output = path.join(repo, ".verification/composer-images-20261111");
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "dark-unsent-preview.png") });
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 700,
      "attachment preview fits a narrow viewport");
    await page.evaluate(() => window.switchDraft("image-draft-b"));
    await dialog.waitFor({ state: "detached" });
    assert.equal(await thumbnails.count(), 0, "switching chats closes the old attachment preview");
    await page.evaluate(() => window.switchDraft("image-draft-a"));
    await thumbnails.nth(1).waitFor();
    assert.equal(await input.inputValue(), "尚未发送的图片说明", "switching back restores the untouched draft");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.waitForFunction(() => window.sent.length === 1);
    assert.equal(await thumbnails.count(), 0);
    assert.deepEqual(await page.evaluate(() => window.sent.map(message => ({ message: message.message, count: message.images.length }))),
      [{ message: "尚未发送的图片说明", count: 2 }]);
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.evaluate(() => window.setBusy(true));
    assert.equal(await page.getByRole("button", { name: "添加", exact: true }).isEnabled(), true, "running chats keep the attachment picker available");
    const pasteOrDrop = async (kind, source) => {
      const dataTransfer = await page.evaluateHandle(base64 => {
        const bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0)),data=new DataTransfer();
        data.items.add(new File([bytes],"running.png",{type:"image/png"}));return data;
      }, source.toString("base64"));
      if (kind === "drop") await page.locator("main").dispatchEvent("drop", { dataTransfer });
      else await input.evaluate((element,data) => element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:data})), dataTransfer);
      await dataTransfer.dispose();
    };
    const scenarios = [
      { delivery: "next_turn", text: "排队中的两张图片", source: "picker", images: [png, second] },
      { delivery: "steer", text: "", source: "paste", images: [second] },
      { delivery: "steer", text: "参照这张图继续处理", source: "drop", images: [png] },
      { delivery: "next_turn", text: "", source: "paste", images: [png] },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await input.fill(scenario.text);
      if (scenario.source === "picker") {
        await page.evaluate(() => window.holdImageRead=true);
        await page.getByRole("button", { name: "添加", exact: true }).click();
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("menuitem", { name: /文件和图片/ }).click();
        await (await chooser).setFiles(scenario.images.map((buffer,i) => ({ name: `running-${i}.png`, mimeType: "image/png", buffer })));
        await page.waitForFunction(() => window.pendingImageReads.length === 2);
        await input.press("Enter");
        assert.equal(queueRequests.length, 0, "a running submission cannot omit images that are still being read");
        await page.evaluate(() => {window.holdImageRead=false;window.pendingImageReads.splice(0).forEach(read=>read());});
      } else await pasteOrDrop(scenario.source, scenario.images[0]);
      await thumbnails.nth(scenario.images.length - 1).waitFor();
      const receipt = page.waitForResponse(response => response.url().includes("/api/agent/") && response.request().method() === "POST");
      if (scenario.source === "drop") await input.press("Enter");
      else {
        await page.locator(".streaming-mode-picker").focus();
        await page.locator(".streaming-mode-picker").press("ArrowUp");
        await page.locator(`.streaming-mode-menu [data-mode="${scenario.delivery}"]`).click();
      }
      await receipt;
      await page.waitForFunction(count => window.pending().then(records => records.length >= count), index + 1);
      await page.waitForFunction(() => !document.querySelector(".composer-image-thumbnail"));
      assert.equal(queueRequests.length, index + 1);
      const { body, recovery } = queueRequests[index];
      assert.equal(body.type, "submit_input");assert.equal(body.delivery, scenario.delivery);assert.equal(body.message, scenario.text);
      assert.deepEqual(body.images, scenario.images.map(buffer => ({ type: "image", mimeType: "image/png", data: buffer.toString("base64") })));
      assert.deepEqual(recovery.draft.images, scenario.images.map(buffer => ({ mimeType: "image/png", data: buffer.toString("base64") })),
        "every image is durable before its HTTP request starts");
      assert.equal(recovery.draft.commandInput.delivery, scenario.delivery);
      assert.equal(await page.evaluate(() => Boolean(window.aborted)), false, "adding and queueing images never stops the running task");
    }
    await page.getByText("排队中的两张图片 · 2 个附件", { exact: true }).waitFor();
    await page.getByText("1 个附件", { exact: true }).waitFor();
    await writeFile(path.join(output, "queued-image-submissions.json"), JSON.stringify(queueRequests.map(({ body, recovery }) => ({
      delivery: body.delivery, message: body.message, imageCount: body.images.length,
      recoverySavedBeforeRequest: Boolean(recovery), recoveryImageCount: recovery.draft.images.length,
      recoveryDelivery: recovery.draft.commandInput.delivery,
    })), null, 2));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-composer-images-"));
    await rm(directory, { recursive: true, force: true });
  }
});
