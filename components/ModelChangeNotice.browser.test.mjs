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

test("model-change dividers render in real chat history with theme-aware, keyboard-accessible hints", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-model-change-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useRef,useState} from 'react'; import {createRoot} from 'react-dom/client';
import {I18nProvider} from '@/hooks/useI18n'; import {ChatHistory} from '@/components/ChatHistory';
import {AppTooltip} from '@/components/AppTooltip';
function App(){
 const [selected,setSelected]=useState(()=>localStorage.getItem('model')||'a');
 const scroll=useRef(null),lastUser=useRef(null),pending=useRef(false);
 const messages=[{role:'user',content:'帮我整理一下这次修改',timestamp:1793494800000},
  {role:'assistant',provider:'fixture',model:'a',content:[{type:'text',text:'## 修改已经完成\\n\\n模型切换后，会在对话中保留一条轻量提示，方便查看后续回复使用了哪个模型。\\n\\n继续提问时，新的模型会接着当前对话回答。'}],timestamp:1793494804000}];
 const notices=selected==='a'?[]:[{id:'switch',afterEntryId:'answer',from:{provider:'fixture',modelId:'a'},to:{provider:'fixture',modelId:selected}}];
 return <I18nProvider><main><header>Piora <span>模型切换提示</span></header><div id="scroll" ref={scroll}><div className="chat-column">
 <ChatHistory messages={messages} entryIds={['question','answer']} modelChanges={notices}
  modelNames={{'fixture:a':'Claude Sonnet 4.6','fixture:b':'GLM-5.3'}} busy={false} streaming={false} isNew={false}
  forkingEntryId={null} highlightedEntryId={null} lastUserMsgRef={lastUser} pendingScrollToUserRef={pending} scrollContainer={scroll}/>
 </div></div><footer><div>继续这个对话…</div><label>模型 <select aria-label="模型" value={selected} onChange={e=>{localStorage.setItem('model',e.target.value);setSelected(e.target.value)}}>
 <option value="a">Claude Sonnet 4.6</option><option value="b">GLM-5.3</option><option value="long-provider-model-name-for-small-screens">长模型名称</option></select></label></footer></main><AppTooltip/></I18nProvider>
}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1000, height: 700 } });
    await context.route("http://model-change.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
        body{height:100vh;overflow:hidden;font-family:var(--ui-font-family)}main{max-width:840px;margin:24px auto;height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--border);border-radius:14px}
        header{padding:16px 24px;border-bottom:1px solid var(--border);display:flex;gap:24px}header span{color:var(--text-muted)}
        #scroll{overflow:auto;flex:1;min-height:0;padding:24px}.chat-column{max-width:760px;margin:auto}footer{margin:16px;padding:16px;border:1px solid var(--border);border-radius:12px;color:var(--text-muted)}footer label{display:block;margin-top:28px}select{max-width:100%;background:var(--bg);color:var(--text);padding:6px}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://model-change.test/");
    const picker = page.getByRole("combobox", { name: "模型" });
    await picker.waitFor();
    const divider = page.locator("[data-model-change]");
    assert.equal(await divider.count(), 0);
    await picker.selectOption("b");
    await divider.waitFor();
    assert.equal(await divider.innerText(), "模型已从 Claude Sonnet 4.6 更改为 GLM-5.3");
    const bounds = await divider.boundingBox(), reply = await page.locator('[data-chat-entry-id="answer"]').boundingBox();
    assert.ok(bounds.y >= reply.y + reply.height, "divider follows the reply and its footer");
    const hintButton = page.getByRole("button", { name: "切换模型的影响" });
    await hintButton.hover();
    const hint = page.getByRole("tooltip");
    await page.locator('[role="tooltip"].is-visible').waitFor();
    assert.match(await hint.innerText(), /上下文缓存命中/);
    assert.match(await hint.innerText(), /可能自动压缩/);
    const output = path.join(repo, ".verification/model-change"); await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "light-with-hint.png"), animations: "disabled" });
    await page.mouse.move(0, 0);
    await page.reload(); await divider.waitFor();
    assert.equal(await divider.count(), 1, "rehydrated metadata produces one divider");
    await hintButton.focus();
    await page.locator('[role="tooltip"].is-visible').waitFor();
    assert.equal(await hintButton.getAttribute("aria-describedby"), await hint.getAttribute("id"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('[role="tooltip"]').classList.contains('is-visible'));
    await page.screenshot({ path: path.join(output, "light.png") });
    const font = await divider.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    await page.locator("html").evaluate(el => el.style.fontSize = "20px");
    assert.ok(await divider.evaluate(el => parseFloat(getComputedStyle(el).fontSize)) > font, "notice follows user font size");
    await page.locator("html").evaluate(el => { el.style.removeProperty("font-size"); el.setAttribute("data-theme", "midnight"); });
    await page.setViewportSize({ width: 360, height: 760 });
    await picker.focus();
    await picker.selectOption("long-provider-model-name-for-small-screens");
    await page.waitForFunction(() => document.querySelector('[data-model-change]').textContent.includes('long-provider'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await hintButton.focus();
    await page.locator('[role="tooltip"].is-visible').waitFor();
    const hintBounds = await hint.boundingBox();
    assert.ok(hintBounds.x >= 0 && hintBounds.x + hintBounds.width <= 360);
    await page.screenshot({ path: path.join(output, "dark-narrow.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-model-change-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
