import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("design components keep completion separate from execution and settings survive a failed save", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-shell-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `import {createRoot} from "react-dom/client";
      import {useState} from "react";
      import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
      import {ShellComposer} from ${JSON.stringify(path.join(repo, "components/workspace/ShellComposer.tsx"))};
      import {SmartShellSettings} from ${JSON.stringify(path.join(repo, "components/SmartShellSettings.tsx"))};
      import {useSmartShell} from ${JSON.stringify(path.join(repo, "hooks/useSmartShell.ts"))};
      import {ShellHistory} from ${JSON.stringify(path.join(repo, "components/workspace/ShellHistory.tsx"))};
      import {ShellFavoriteButton} from ${JSON.stringify(path.join(repo, "components/workspace/ShellFavoriteButton.tsx"))};
      function History(){return <section className="root" style={{height:'100vh'}}><ShellHistory terminalId="first" cwd="X:/workspace/sample" onChoose={value=>window.historyChoice=value}/></section>}
      function TransportPanel(){const shell=useSmartShell('X:/workspace/sample');window.shell=shell;return <div><p>{shell.activeId}</p><p>{shell.snapshot?.session.id}</p><p>{shell.sessions.map(s=>s.id).join(',')}</p></div>}
      function Transport(){const [visible,setVisible]=useState(true);window.showShell=setVisible;return visible?<TransportPanel/>:<div>Chat remains available</div>}
      const session={id:'test-terminal',cwd:'F:\\\\Piora',initialCwd:'F:\\\\Piora',draft:'',owner:'human',model:null};
      window.submissions=[];
      createRoot(document.getElementById('root')).render(<I18nProvider>{location.pathname==='/favorite'?<ShellFavoriteButton id="favorite-block" onError={error=>{window.uiError=error}}/>:location.pathname==='/history'?<History/>:location.pathname==='/transport'?<Transport/>:location.pathname==='/settings'?<SmartShellSettings cwd={session.cwd}/>:<section className="root" style={{height:'100vh'}}><div style={{flex:1,padding:16}}>智能 Shell · 组件验证场景</div><ShellComposer session={session} onSubmit={async(text,mode,references)=>{window.submissions.push({text,mode,references});return window.rejectSubmit?'failed':'accepted'}} onHistory={()=>{window.historyOpened=true}} onError={error=>{window.uiError=error}}/></section>}</I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const [bundle, css, globals] = await Promise.all([readFile(path.join(directory, "bundle.js")), readFile(path.join(repo, "components/workspace/SmartShell.module.css"), "utf8"), readFile(path.join(repo, "app/globals.css"), "utf8")]);
    const light = globals.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    const dark = globals.match(/html\.dark\s*\{([\s\S]*?)\n\}/)[1];
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.addInitScript(() => {
      window.streams = [];
      window.EventSource = class {
        constructor(url) {
          this.url = url; window.streams.push(this);
          // Reproduce a stalled event connection: startup must hydrate from
          // its HTTP response without waiting for SSE or the polling timer.
          if (location.pathname === "/transport") return;
          fetch(url.replace(/\/events$/, "")).then(response => response.json()).then(snapshot => this.onmessage?.({ data: JSON.stringify({ type: "snapshot", terminalId: snapshot.session.id, generation: snapshot.session.generation, sequence: snapshot.sequence, snapshot }) }));
        }
        close() { this.closed = true; }
      };
      const remove = IDBObjectStore.prototype.delete;
      IDBObjectStore.prototype.delete = function (...args) {
        if (window.failCleanup) throw new Error("TEST: local cleanup unavailable");
        return remove.apply(this, args);
      };
    });
    const terminal = id => ({ id, title: id, initialCwd: "X:/workspace/sample", cwd: "X:/workspace/sample", profile: { kind: "powershell", label: "PowerShell", integrated: true }, generation: 1, connected: true, integration: "ready", owner: "human", activeCommandId: null, activeRunId: null, draft: "", model: null });
    const snapshot = id => ({ session: terminal(id), commands: [], runs: [], sequence: 1, output: "" });
    let terminalList = [terminal("first"), terminal("second")], failTransport = true;
    let failInventory = true, failStart = true, starts = 0;
    const requestIds = [];
    const historyQueries = [];
    let releaseLiteral, releaseSemantic;
    let historyFavorite = true, failFavorite = false;
    const historyRecord = command => ({ id: command, command, source: "human", cwd: "X:/workspace/sample", executedAt: null, favorite: true });
    let settings = { executable: null, model: null, importSystemHistory: true, importPiHistory: true, sources: [] }, failSave = true, holdSave = false, releaseSave;
    await page.route("https://shell-ui.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.endsWith("bundle.js")) return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/shell/history/favorite-block") {
        if (request.method() === "PATCH") {
          if (failFavorite) return route.fulfill({ status: 503, json: { error: "Favorite write unavailable" } });
          historyFavorite = request.postDataJSON().favorite;
        }
        return route.fulfill({ json: { record: { id: "favorite-block", favorite: historyFavorite }, success: true } });
      }
      if (url.pathname === "/api/shell/history") {
        const query = url.searchParams.get("q"), offset = Number(url.searchParams.get("offset") || 0);
        if (query === "slow literal") await new Promise(resolve => { releaseLiteral = resolve; });
        return route.fulfill({ json: { records: [historyRecord(`literal:${query}:${offset}`)], hasMore: query === "page" && offset === 0 } }).catch(() => {});
      }
      if (url.pathname === "/api/shell/history/search") {
        const body = request.postDataJSON(); historyQueries.push(body);
        if (body.query === "old intent") await new Promise(resolve => { releaseSemantic = resolve; });
        return route.fulfill({ json: { records: [historyRecord(`semantic:${body.query}`)] } }).catch(() => {});
      }
      if (url.pathname === "/api/shell/sessions") {
        if (failInventory) { failInventory = false; return route.fulfill({ status: 503, json: { error: "Inventory temporarily unavailable" } }); }
        return route.fulfill({ json: { sessions: terminalList } });
      }
      const timelinePath = url.pathname.match(/^\/api\/shell\/sessions\/(first|second|background)\/timeline$/);
      if (timelinePath) {
        const older = url.searchParams.has("before");
        return route.fulfill({ json: { commands: [{ id: `${timelinePath[1]}-${older ? "old" : "recent"}`, command: "echo archive", status: "completed", startedAt: older ? 1 : 2 }], runs: [], nextCursor: older ? null : "100" } });
      }
      const sessionPath = url.pathname.match(/^\/api\/shell\/sessions\/(first|second|background)(\/actions)?$/);
      if (sessionPath) {
        if (sessionPath[2] && request.postDataJSON().action === "start") {
          starts++;
          if (failStart) { failStart = false; return route.fulfill({ status: 503, json: { error: "Start temporarily unavailable" } }); }
        }
        if (sessionPath[2] && request.postDataJSON().action === "submit") {
          requestIds.push(request.postDataJSON().clientRequestId);
          if (failTransport) { failTransport = false; return route.abort("connectionreset"); }
          return route.fulfill({ json: { accepted: true, durable: true } });
        }
        return route.fulfill({ json: snapshot(sessionPath[1]) });
      }
      if (url.pathname === "/api/models") return route.fulfill({ json: { modelList: [{ provider: "local", id: "test-model", name: "本地测试模型" }], thinkingLevels: { "local:test-model": ["off", "high"] } } });
      if (url.pathname.endsWith("/settings")) {
        if (request.method() === "POST") {
          if (failSave) return route.fulfill({ status: 500, json: { error: "保存失败，请重试" } });
          settings = request.postDataJSON();
          if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
        }
        if (url.pathname.startsWith("/api/")) return route.fulfill({ json: settings });
      }
      if (url.pathname.endsWith("/profiles")) return route.fulfill({ json: { profiles: [{ executable: "C:\\PowerShell\\pwsh.exe", label: "PowerShell 7", kind: "powershell" }] } });
      if (url.pathname.endsWith("/history/sources")) return route.fulfill({ json: { discovered: [{ id: "ps", kind: "powershell", enabled: true, path: "C:\\Users\\test\\ConsoleHost_history.txt" }], status: [] } });
      if (url.pathname.endsWith("/completions")) return route.fulfill({ json: { intent: "command", completions: [{ value: "npm run dev", label: "npm run dev", kind: "history", detail: "手动 · F:\\Piora" }] } });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><html class="dark"><meta charset="utf-8"><style>:root{${light}}:root.dark{${dark}}*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:var(--bg);color:var(--text)}${css}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    await page.goto("https://shell-ui.test/");
    const input = page.getByRole("combobox", { name: "输入命令，或描述你想做的事…" });
    await input.fill("npm");
    await page.getByRole("option", { name: "npm run dev 手动 · F:\\Piora" }).waitFor();
    await input.press("Tab");
    assert.equal(await input.inputValue(), "npm run dev");
    assert.deepEqual(await page.evaluate(() => window.submissions), [], "accepting a completion must not execute it");
    for (const composing of [{ isComposing: true, keyCode: 0 }, { isComposing: false, keyCode: 229 }]) {
      const accepted = await input.evaluate((element, properties) => element.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", bubbles: true, cancelable: true, ...properties,
      })), composing);
      assert.equal(accepted, false, "IME confirmation prevents the Enter default action");
      assert.equal(await input.inputValue(), "npm run dev", "IME confirmation retains the command draft");
      assert.deepEqual(await page.evaluate(() => window.submissions), [], "IME confirmation must not execute the draft");
    }
    await input.press("Enter");
    await page.waitForFunction(() => window.submissions.length === 1);
    assert.equal(await input.inputValue(), "");
    await page.evaluate(() => { window.rejectSubmit = true; });
    await input.fill("echo retained"); await input.press("Escape"); await input.press("Enter");
    await page.waitForFunction(() => window.submissions.length === 2);
    assert.equal(await input.inputValue(), "echo retained", "failed submission preserves the draft");
    await input.press("Control+r"); assert.equal(await page.evaluate(() => window.historyOpened), true);
    await page.getByRole("combobox", { name: "自动", exact: true }).selectOption("command");
    await page.evaluate(() => { const range = document.createRange(); range.selectNodeContents(document.querySelector("section > div")); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
    await page.getByRole("button", { name: "引用选中文字" }).focus();
    await page.keyboard.press("Enter");
    await page.getByTitle("移除引用").waitFor();
    await page.reload();
    await page.getByTitle("移除引用").waitFor();
    assert.equal(await input.inputValue(), "echo retained");
    assert.equal(await page.getByRole("combobox", { name: "自动", exact: true }).inputValue(), "command", "input mode survives remounting");
    await page.getByRole("button", { name: "执行", exact: true }).click();
    await page.waitForFunction(() => window.submissions.length === 1);
    assert.equal(await page.evaluate(() => window.submissions[0].references[0].kind), "message", "restored context is included in the actual submission");
    assert.equal(await page.getByTitle("移除引用").count(), 0, "accepted context is cleared with its originating draft");
    for (const width of [360, 480, 640]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `composer fits ${width}px`);
      const bounds = await page.getByRole("button", { name: "执行", exact: true }).boundingBox();
      assert.ok(bounds.y + bounds.height <= 800, "submit remains visible");
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("https://shell-ui.test/settings");
    const historySwitch = page.getByRole("switch", { name: "导入本机 Shell 历史" });
    await historySwitch.click();
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByRole("alert").filter({ hasText: "保存失败" }).waitFor();
    assert.equal(await historySwitch.isChecked(), false, "failed save retains the requested setting");
    failSave = false;
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    assert.equal(settings.importSystemHistory, false);
    await page.reload(); await historySwitch.waitFor(); assert.equal(await historySwitch.isChecked(), false);
    const modelSelect = page.getByRole("combobox", { name: "Shell 使用的模型" });
    await modelSelect.selectOption("local/test-model");
    const thinkingSelect = page.getByRole("combobox", { name: "思考级别" });
    assert.equal(await thinkingSelect.inputValue(), "", "model scope thinking is inherited unless explicitly overridden");
    await thinkingSelect.selectOption("high");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    assert.deepEqual(settings.model, { provider: "local", modelId: "test-model", thinkingLevel: "high" });
    await page.reload(); await thinkingSelect.waitFor(); assert.equal(await thinkingSelect.inputValue(), "high");
    holdSave = true;
    await page.getByRole("button", { name: "保存设置" }).click();
    for (let i = 0; i < 100 && !releaseSave; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(releaseSave);
    await historySwitch.click();
    releaseSave(); holdSave = false;
    await page.getByRole("button", { name: "保存设置" }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '保存设置').disabled);
    assert.equal(await historySwitch.isChecked(), true, "edits made during a save survive its older response");
    assert.equal(await page.getByRole("status").textContent(), "修改后点击保存");
    await page.getByRole("button", { name: "添加历史文件" }).click();
    await page.getByRole("textbox", { name: "历史文件的绝对路径" }).fill("F:/missing-history.txt");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByText("F:/missing-history.txt", { exact: true }).waitFor();
    await page.getByRole("button", { name: "移除来源", exact: true }).click();
    assert.equal(await page.getByText("F:/missing-history.txt", { exact: true }).count(), 0, "an invalid unsaved source can be removed without saving it first");
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    assert.deepEqual(settings.sources, []);
    settings.sources = [{ id: "custom:old", path: "F:/old-history.txt", kind: "bash", enabled: false }];
    await page.reload();
    await page.getByRole("button", { name: "移除来源", exact: true }).click();
    await page.getByRole("button", { name: "保存设置" }).click();
    await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
    await page.reload(); await historySwitch.waitFor();
    assert.equal(await page.getByRole("button", { name: "移除来源", exact: true }).count(), 0, "removed configured sources stay removed after reload; automatic sources retain their toggle");
    if (process.env.PIORA_SHELL_UI_SCREENSHOTS) {
      const target = path.resolve(process.env.PIORA_SHELL_UI_SCREENSHOTS); await mkdir(target, { recursive: true });
      await page.screenshot({ path: path.join(target, "settings-component-dark.png"), fullPage: true });
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.screenshot({ path: path.join(target, "settings-component-light.png"), fullPage: true });
    }
    await page.goto("https://shell-ui.test/transport");
    await page.waitForFunction(() => window.shell?.connectionError.includes("Inventory temporarily unavailable"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.shell?.connectionError.includes("Start temporarily unavailable"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.shell?.snapshot?.session.id === "first" && window.shell.connected, undefined, { timeout: 2000 });
    assert.equal(starts, 2, "retry actually starts the PTY instead of polling an unstarted session");
    assert.equal(await page.evaluate(() => window.shell.connectionError), "", "successful startup clears transport errors");
    await page.waitForFunction(() => window.streams.length > 0);
    await page.waitForFunction(() => window.streams[0].closed, undefined, { timeout: 15_000 });
    assert.equal(await page.evaluate(() => window.shell.connected), true, "stalled event connections are released while snapshots keep working");
    await page.waitForFunction(() => window.streams.length > 1);
    await page.evaluate(() => window.streams.at(-1).onerror());
    assert.equal(await page.evaluate(() => window.shell.connected), true, "a dropped SSE does not invalidate a usable HTTP snapshot");
    await page.waitForFunction(() => window.shell.hasOlder);
    await page.evaluate(() => Promise.all([window.shell.loadOlder(), window.shell.loadOlder()]));
    await page.waitForFunction(() => !window.shell.loadingOlder);
    assert.deepEqual(await page.evaluate(() => window.shell.snapshot.commands.map(item => item.id).sort()), ["first-old", "first-recent"]);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.shell.connected);
    assert.equal(await page.evaluate(() => window.shell.snapshot.commands.some(item => item.id === "first-old")), true, "reconnection retains already loaded history");
    assert.deepEqual(await page.evaluate(() => Promise.all([window.shell.submit("echo once", "command", []), window.shell.submit("echo once", "command", [])])), ["failed", "failed"]);
    assert.equal(requestIds.length, 1, "concurrent submissions share one durable request");
    assert.equal(await page.evaluate(() => window.shell.submit("echo once", "command", [])), "accepted");
    assert.equal(requestIds[0], requestIds[1], "retry after an ambiguous network failure keeps its original identity");
    await page.evaluate(() => { window.failCleanup = true; });
    assert.equal(await page.evaluate(() => window.shell.submit("echo once", "command", [])), "accepted", "cleanup failure cannot revoke a durable server receipt");
    assert.notEqual(requestIds[2], requestIds[1], "an intentionally repeated command after acceptance gets a new identity");
    await page.waitForFunction(() => window.shell.pending.length === 1);
    await page.evaluate(() => { window.failCleanup = false; });
    assert.equal(await page.evaluate(() => { const item = window.shell.pending[0]; return window.shell.submit(item.text, item.mode, item.references, item); }), "accepted");
    assert.equal(requestIds[2], requestIds[3], "archive retry cannot re-execute an already accepted command");
    terminalList = [...terminalList, { ...terminal("background"), cwd: "X:/workspace/sample/subdir" }];
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForFunction(() => window.shell.sessions.some(session => session.id === "background"));
    assert.equal(await page.evaluate(() => window.shell.activeId), "first", "background discovery preserves selection");
    await page.evaluate(() => window.shell.select("second"));
    await page.waitForFunction(() => window.shell.snapshot?.session.id === "second");
    await page.evaluate(() => window.shell.reconnect());
    await page.waitForFunction(() => window.shell.snapshot?.session.id === "second" && window.shell.connected);
    assert.equal(await page.evaluate(() => window.shell.activeId), "second", "manual reconnection preserves the selected terminal");
    assert.equal(await page.evaluate(() => window.shell.snapshot.commands.some(item => item.id.startsWith("first-"))), false, "the next terminal never inherits the previous archive");
    await page.evaluate(old => {
      const stream = window.streams.find(item => item.url.includes("/first/"));
      stream.onmessage({ data: JSON.stringify({ type: "snapshot", terminalId: "first", generation: 20, sequence: 100, snapshot: old }) });
    }, snapshot("first"));
    assert.equal(await page.evaluate(() => window.shell.snapshot.session.id), "second", "late events cannot replace the selected terminal");
    await page.evaluate(() => {
      const original = window.fetch;
      window.stalledShellRequests = [];
      window.fetch = (url, options) => {
        if (String(url).startsWith("/api/shell/") && ["POST", "DELETE"].includes(options?.method)) {
          window.stalledShellRequests.push(options.signal);
          return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
        }
        return original(url, options);
      };
      const shell = window.shell;
      window.pendingShellActions = Promise.allSettled([shell.action({ action: "restart" }), shell.create(), shell.close(shell.activeId), shell.submit("echo pending on close", "command", [])]);
    });
    await page.waitForFunction(() => window.stalledShellRequests.length === 4);
    await page.evaluate(() => window.showShell(false));
    await page.waitForFunction(() => window.stalledShellRequests.every(signal => signal.aborted) && window.streams.every(stream => stream.closed));
    await page.evaluate(() => window.pendingShellActions);
    assert.equal(await page.evaluate(async () => (await fetch('/api/sessions/chat-still-open')).ok), true, "closing a disconnected terminal leaves chat requests usable");
    await page.goto("https://shell-ui.test/history");
    const historyInput = page.getByRole("textbox", { name: "搜索历史命令…" });
    const until = async check => { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error("History request was not observed"); };
    await historyInput.fill("slow literal"); await until(() => Boolean(releaseLiteral));
    await historyInput.press("Enter"); await page.getByRole("button", { name: "semantic:slow literal", exact: true }).waitFor();
    releaseLiteral();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("button", { name: "literal:slow literal:0", exact: true }).count(), 0, "an older literal response cannot overwrite semantic results");
    await historyInput.fill("old intent"); await historyInput.press("Enter"); await until(() => Boolean(releaseSemantic));
    await historyInput.fill("new query"); await page.getByRole("button", { name: "literal:new query:0", exact: true }).waitFor();
    releaseSemantic();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByRole("button", { name: "semantic:old intent", exact: true }).count(), 0, "typing a new query cancels the old model request");
    await page.getByRole("combobox", { name: "历史来源" }).selectOption("human");
    await page.getByRole("button", { name: "所有项目", exact: true }).click();
    await page.getByRole("button", { name: "☆ 收藏", exact: true }).click();
    await historyInput.fill("filter intent"); await historyInput.press("Enter");
    await page.getByRole("button", { name: "semantic:filter intent", exact: true }).waitFor();
    assert.deepEqual(historyQueries.at(-1).filters, { source: "human", cwd: "X:/workspace/sample", favorite: true });
    const previousQueries = historyQueries.length;
    await historyInput.evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    assert.equal(historyQueries.length, previousQueries, "IME acceptance must not launch a model search");
    await historyInput.fill("page"); await page.getByRole("button", { name: "加载更早的记录" }).click();
    await page.getByRole("button", { name: "literal:page:1", exact: true }).waitFor();
    await page.getByRole("button", { name: "literal:page:0", exact: true }).click();
    assert.equal(await page.evaluate(() => window.historyChoice), "literal:page:0");
    assert.deepEqual(await page.evaluate(() => window.submissions), [], "selecting history fills the composer without execution");
    await page.goto("https://shell-ui.test/favorite");
    const favoriteButton = page.getByRole("button", { name: "收藏", exact: true });
    await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'true');
    await favoriteButton.click();
    await page.waitForFunction(() => document.querySelector('button')?.getAttribute('aria-pressed') === 'false');
    assert.equal(historyFavorite, false, "a restored favorite can be removed directly from its command card");
    await page.reload(); await favoriteButton.waitFor();
    await page.waitForFunction(() => document.querySelector('button')?.disabled === false);
    assert.equal(await favoriteButton.getAttribute("aria-pressed"), "false");
    failFavorite = true; await favoriteButton.click();
    await page.waitForFunction(() => window.uiError?.includes('Favorite write unavailable'));
    assert.equal(await favoriteButton.getAttribute("aria-pressed"), "false", "failed persistence never displays a saved favorite");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(resolved).startsWith("piora-shell-ui-")) throw new Error("Unexpected cleanup path");
    await rm(resolved, { recursive: true, force: true });
  }
});
