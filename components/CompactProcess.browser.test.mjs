import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("compact chat streams logs, preserves explicit expansion, and switches layouts durably", { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-compact-process-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatHistory} from "@/components/ChatHistory";
import {useCompactProcessPreference} from "@/hooks/useCompactProcessPreference";
function App(){
  const {enabled,setEnabled}=useCompactProcessPreference();
  const [done,finish]=useState(false), [output,setOutput]=useState("old line\\none\\ntwo\\nthree"), [attention,setAttention]=useState(false), [draft,setDraft]=useState(null);
  const scroll=useRef(null), lastUser=useRef(null), pending=useRef(false), history=useRef(null);
  const user={role:"user",content:"修复 Shell 实时输出的问题",timestamp:Date.now()-15000};
  const assistant={role:"assistant",content:[{type:"thinking",thinking:"检查事件传递与输出更新。"},{type:"toolCall",toolCallId:"shell",toolName:"bash",input:{command:"npm run test"}}],timestamp:user.timestamp+1000};
  const result={role:"toolResult",toolCallId:"shell",isStreaming:!done,content:[{type:"text",text:output}],timestamp:user.timestamp+12000};
  const messages=[user,assistant,result];
  if(attention) messages.push({role:"assistant",content:[{type:"toolCall",toolCallId:"wait",toolName:"browser",input:{action:"wait_for_user",reason:"请完成登录"}}]});
  if(done) messages.push({role:"assistant",content:[{type:"text",text:"## 已修复 Shell 实时输出\\n\\n执行日志现在会实时更新。\\n\\n- 运行时显示最新输出\\n- 支持展开查看完整日志"}],timestamp:user.timestamp+14000});
  window.advance=()=>setOutput("old line\\none\\ntwo\\nthree\\nfour\\nfive");
  window.advanceAgain=()=>setOutput("old line\\none\\ntwo\\nthree\\nfour\\nfive\\nsix");
  window.think=()=>setDraft({role:"assistant",content:[{type:"thinking",thinking:"正在验证新输出"},{type:"text",text:"正在流式生成的正式回复"}],timestamp:Date.now()});
  window.finish=()=>{setDraft(null);finish(true)}; window.waitForUser=()=>setAttention(true);
  window.setCompact=setEnabled;
  return <I18nProvider><main><header>Piora <button role="switch" aria-label="轻量过程展示" aria-checked={enabled} onClick={()=>setEnabled(!enabled)}>轻量过程展示</button></header>
    <div id="scroll" className="overflow-y-auto" ref={scroll}><div className="chat-column">
      <ChatHistory messages={messages} entryIds={["u","a","r",...(attention?["wait"]:[]),...(done?["answer"]:[])]} compactProcess={enabled}
        streamingMessage={enabled?draft:null} busy={!done} streaming={Boolean(draft)} isNew={false} forkingEntryId={null} highlightedEntryId={null} lastUserMsgRef={lastUser}
        pendingScrollToUserRef={pending} scrollContainer={scroll} handleRef={history} sessionId="fixture" />
    </div></div><footer>发送消息…</footer></main></I18nProvider>;
}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1200, height: 900 } });
    const errors = [];
    await context.route("http://compact.test/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { success: true, data: {} } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
        body{height:100vh;overflow:hidden;background:#faf6f3;font-family:var(--ui-font-family)}main{max-width:900px;margin:24px auto;height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:14px}
        header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between}header button{font-size:13px;color:var(--accent)}
        #scroll{overflow:auto;flex:1;min-height:0;padding:24px}.chat-column{max-width:760px;margin:auto}footer{margin:16px;padding:16px;border:1px solid var(--border);border-radius:12px;color:var(--text-muted)}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    const page = await context.newPage();
    const screenshot = async (name) => {
      if (!process.env.PIORA_COMPACT_SCREENSHOTS) return;
      const output = path.join(repo, "test-results", "compact-process");
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `${name}.png`) });
    };
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://compact.test/");
    const toggle = page.getByRole("switch", { name: "轻量过程展示" });
    await page.locator(".compact-command-tail").waitFor();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await page.locator(".compact-command-tail").innerText(), "one\ntwo\nthree");
    assert.equal(await page.locator(".command-execution-card").count(), 0);
    await screenshot("running");
    await page.evaluate(() => window.advance());
    await page.waitForFunction(() => document.querySelector(".compact-command-tail")?.textContent === "three\nfour\nfive");
    await page.locator(".compact-process-preview .compact-command-expand").click();
    await page.locator(".cm-content").waitFor();
    assert.match(await page.locator(".cm-content").innerText(), /four\nfive/);
    await page.evaluate(() => window.advanceAgain());
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent.includes("six"));
    await page.evaluate(() => window.finish());
    await page.locator(".markdown-assistant-message h2").waitFor();
    assert.equal(await page.locator(".compact-process-toggle").getAttribute("aria-expanded"), "true");
    await screenshot("expanded");
    await page.locator(".compact-process-toggle").click();
    assert.equal(await page.locator(".command-execution-card").count(), 0);
    assert.match(await page.locator(".markdown-assistant-message").innerText(), /已修复 Shell/);
    await screenshot("completed");
    await toggle.click();
    await page.locator(".command-execution-card").waitFor();
    assert.equal(await page.locator(".compact-process-group").count(), 0);
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
    assert.equal(await page.locator(".compact-process-group").count(), 0);
    await toggle.click();
    await page.locator(".compact-process-group").waitFor();
    // Another same-origin window receives the preference without reload.
    const second = await context.newPage();
    await second.goto("http://compact.test/");
    await second.locator(".compact-process-group").waitFor();
    await toggle.click();
    await second.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false");
    await toggle.click();
    await second.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await second.evaluate(() => window.think());
    await second.getByText("正在流式生成的正式回复", { exact: true }).waitFor();
    assert.equal(await second.locator(".compact-process-group").count(), 1);
    await second.evaluate(() => window.finish());
    await second.locator(".markdown-assistant-message h2").waitFor();
    assert.equal(await second.locator(".compact-process-toggle").getAttribute("aria-expanded"), "false");
    assert.equal(await second.getByText("正在流式生成的正式回复", { exact: true }).count(), 0);
    await page.evaluate(() => window.waitForUser());
    await page.getByText("请完成登录", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "我已完成，继续" }).count(), 1);
    assert.equal(await page.locator(".compact-process-toggle").getAttribute("aria-expanded"), "false");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await screenshot("mobile-attention");
    assert.deepEqual(errors, []);
    t.diagnostic("Verified live log preview and viewer, completion, layout rollback, persistence, cross-window sync and user handoff.");
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-compact-process-"));
    await rm(directory, { recursive: true, force: true });
  }
});
