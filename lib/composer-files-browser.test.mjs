import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createJiti } from "jiti";
import { chromium, _electron } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const jiti = createJiti(import.meta.url);
const { savePromptFiles } = await jiti.import("./prompt-files.ts");

for (const native of process.platform === "win32" ? [true, false] : [false]) {
test(`composer preserves pasted files and recovery in ${native ? "Electron" : "browser"}`, { timeout: 120000 }, async () => {
  const tempRoot = await realpath(tmpdir());
  const root = await mkdtemp(path.join(tempRoot, "piora-composer-files-"));
  let browser;
  let uploadServer;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "icons.tsx"), "export const ModelProviderIcon=()=>null;");
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";
      import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
      import {ChatInput} from ${JSON.stringify(path.join(repo, "components/ChatInput.tsx"))};
      import {getDraft,snapshotPersistedChatDrafts} from ${JSON.stringify(path.join(repo, "lib/draft-store.ts"))};
      import {buildLocalFilePrompt} from ${JSON.stringify(path.join(repo, "lib/file-attachments.ts"))};
      window.getDraft=getDraft;window.flushDrafts=snapshotPersistedChatDrafts;window.sends=[];window.acceptSend=false;
      function App(){const [scope,setScope]=React.useState('files');window.setScope=setScope;return <ChatInput draftKey={scope} isStreaming={false} onAbort={()=>{}} onSend={async(text,images,files,durable)=>{window.sends.push({text,images,files,prompt:buildLocalFilePrompt(text,files||[])});durable('send-'+window.sends.length);return window.acceptSend;}}/>}
      createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://composer-files.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "./ModelProviderIcon": path.join(root, "icons.tsx"), "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    let page;
    if (native) {
      await writeFile(path.join(root, "main.cjs"), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const window=new BrowserWindow({show:false,width:900,height:700,webPreferences:{preload:${JSON.stringify(path.join(repo, "desktop/dist/preload.js"))},contextIsolation:true,sandbox:true}});window.loadURL('about:blank')});`);
      const electronEnv = { ...process.env };
      delete electronEnv.ELECTRON_RUN_AS_NODE;
      browser = await _electron.launch({ executablePath: require("electron"), args: [path.join(root, "main.cjs"), `--user-data-dir=${path.join(root, "electron-profile")}`], env: electronEnv });
      page = await browser.firstWindow();
    } else {
      browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
      page = await browser.newPage();
    }
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    const uploads = [];
    let releaseUpload;
    let delayUpload = false;
    let failUpload = false;
    // CDP request interception omits disk-backed file bytes from postDataBuffer.
    // Receive the real multipart stream instead, in both desktop and browser runs.
    uploadServer = createServer((request, response) => {
      void (async () => {
        const body = await new Request("http://localhost/api/prompt-files", {
          method: "POST", headers: { "Content-Type": request.headers["content-type"] },
          body: Readable.toWeb(request), duplex: "half",
        }).formData();
        uploads.push(body.getAll("files"));
        if (delayUpload) await new Promise(resolve => { releaseUpload = resolve; });
        response.setHeader("Content-Type", "application/json");
        if (failUpload) { response.statusCode = 500; response.end(JSON.stringify({ error: "test storage unavailable" })); return; }
        response.end(JSON.stringify({ files: await savePromptFiles(body.getAll("files"), path.join(root, "stored")) }));
      })().catch(error => { errors.push(error.message); response.statusCode = 500; response.end(); });
    });
    await new Promise((resolve, reject) => { uploadServer.once("error", reject); uploadServer.listen(0, "127.0.0.1", resolve); });
    const origin = `http://127.0.0.1:${uploadServer.address().port}`;
    await page.route("http://composer-files.test/**", async route => {
      return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(new URL(route.request().url()).pathname))) });
    });
    await page.route(`${origin}/**`, async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/prompt-files") return route.continue();
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;background:#fff;color:#222}#root{max-width:700px;margin:30px auto}textarea{min-height:80px}</style><div id="root"></div><input id="paste-source" type="file" hidden multiple><script src="/bundle.js"></script>' });
    });
    await page.goto(origin);
    const input = page.locator("textarea");
    await input.fill("请分析附件");
    const diskFile = path.join(root, "报告 文档.pdf");
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 128]);
    await writeFile(diskFile, bytes);
    await page.locator("#paste-source").setInputFiles(diskFile);
    if (native) {
      assert.equal(await page.evaluate(() => window.piDesktop.files.getPathForFile(document.querySelector("#paste-source").files[0])),
        diskFile, "Electron reveals the path of the original disk-backed File");
    }
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(document.querySelector("#paste-source").files[0]);
      transfer.items.add(new File([Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), char => char.charCodeAt(0))], "screenshot.gif", { type: "image/gif" }));
      document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await page.getByText("报告 文档.pdf", { exact: true }).waitFor();
    await page.locator('img[src^="blob:"]').waitFor();
    await page.waitForFunction(() => window.getDraft("files")?.files.length === 1 && window.getDraft("files")?.images.length === 1);
    let files = await page.evaluate(() => window.getDraft("files").files);
    if (native && files[0].path === diskFile) {
      assert.equal(uploads.length, 0, "disk-backed files use their native path without uploading contents");
    } else {
      assert.deepEqual(await readFile(files[0].path), bytes, "pasted Files without a native path retain their bytes");
      assert.equal(uploads.length, 1, "a synthetic clipboard File is uploaded only when its native path is unavailable");
    }
    const send = page.getByRole("button", { name: "发送", exact: true });
    await send.click();
    await page.waitForFunction(() => window.sends.length === 1 && document.querySelector("textarea").value === "请分析附件" && window.getDraft("files")?.files.length === 1 && window.getDraft("files")?.images.length === 1);
    assert.deepEqual(await page.evaluate(() => window.getDraft("files").files), files, "rejected send restores file references");
    const sent = await page.evaluate(() => window.sends[0]);
    assert.ok(sent.prompt.includes(JSON.stringify(files[0].path)));
    assert.equal(sent.files[0].text, null);
    assert.equal(sent.images.length, 1, "mixed pastes still deliver image content to vision models");
    // Persisted composer drafts must keep the path across a real reload.
    await page.evaluate(() => window.flushDrafts());
    await page.reload();
    await page.getByText("报告 文档.pdf", { exact: true }).waitFor();
    await page.waitForFunction(() => window.getDraft("files")?.files.length === 1);
    assert.deepEqual(await page.evaluate(() => window.getDraft("files").files), files);
    await page.evaluate(() => { window.acceptSend=true; });
    await send.click();
    await page.waitForFunction(() => !window.getDraft("files"));
    // Constructed clipboard Files have no native path, so keep their bytes on disk.
    const pasteBinary = () => page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0x50,0x4b,0,255,128])], "压缩包.zip", {type:"application/zip"}));
      document.querySelector("textarea").dispatchEvent(new ClipboardEvent("paste", {bubbles:true,cancelable:true,clipboardData:transfer}));
    });
    delayUpload = true;
    await pasteBinary();
    await page.getByRole("status").filter({ hasText: "正在准备文件" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "正在准备文件…", exact: true }).isDisabled(), true);
    await page.evaluate(() => window.setScope("other"));
    while (!releaseUpload) await new Promise(resolve => setTimeout(resolve, 20));
    releaseUpload();
    await page.waitForFunction(() => Boolean(window.getDraft("files")?.files.length));
    assert.equal(await page.getByText("压缩包.zip", { exact: true }).count(), 0, "pending upload cannot attach to another conversation");
    await page.evaluate(() => window.setScope("files"));
    await page.getByText("压缩包.zip", { exact: true }).waitFor();
    files = await page.evaluate(() => window.getDraft("files").files);
    assert.deepEqual(await readFile(files[0].path), Buffer.from([0x50,0x4b,0,255,128]));
    await page.getByRole("button", { name: "移除附件", exact: true }).click();
    delayUpload = false; failUpload = true;
    await input.fill("不要丢失这段文字");
    await pasteBinary();
    await page.getByRole("alert").filter({ hasText: "test storage unavailable" }).waitFor();
    assert.equal(await input.inputValue(), "不要丢失这段文字");
    assert.equal(await page.getByText("压缩包.zip", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (uploadServer) {
      uploadServer.closeAllConnections();
      await new Promise(resolve => uploadServer.close(resolve));
    }
    assert.ok(root.startsWith(tempRoot + path.sep));
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
}
