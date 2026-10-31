import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
test("task timer keeps elapsed time across phase changes, refresh, completion and narrow themes", { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-task-duration-"));
  let browser, server;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {TaskDuration} from ${JSON.stringify(path.join(repo, "components/TaskDuration.tsx"))};
import {zhCNLocale} from ${JSON.stringify(path.join(repo, "lib/i18n/messages/zh-CN.ts"))};
function App(){
 const [timing,setTiming]=React.useState(()=>JSON.parse(localStorage.getItem('timing')||'null'));
 const [phase,setPhase]=React.useState('正在思考');
 const [rate,setRate]=React.useState(null);
 const [hideSettled,setHideSettled]=React.useState(false);
 const update=value=>{localStorage.setItem('timing',JSON.stringify(value));setTiming(value)};
 const start=()=>update({commandId:crypto.randomUUID(),sessionId:'fixture',startedAt:Date.now()});
 const finish=outcome=>update({...timing,outcome,...(outcome==='interrupted'?{}:{finishedAt:Date.now()})});
 const t=key=>zhCNLocale.messages[key]||key;
 return <><nav><b>Piora</b><span>任务用时</span><button onClick={()=>document.body.classList.toggle('dark')}>主题</button></nav>
 <main><div className="user">为 Piora 添加任务总用时</div><p>任务计时现在会贯穿整个执行过程。</p><div className="tool">正在检查任务状态与计时逻辑</div><div className="spacer"/>
 <TaskDuration timing={timing} busy={!!timing&&!timing.outcome} startedAt={timing?.startedAt??null} phase={phase} tokensPerSecond={rate} hideSettled={hideSettled} t={t}/>
 <button onClick={()=>setHideSettled(value=>!value)}>回复已有总用时</button>
 <aside><button onClick={()=>setRate(42.5)}>速度采样</button><button onClick={()=>setRate(7.2)}>速度变化</button><button onClick={()=>setRate(0)}>输出暂停</button><button onClick={()=>setRate(null)}>清除速度</button><button onClick={()=>setRate(NaN)}>无效速度</button><button onClick={()=>setRate(Infinity)}>无限速度</button><button onClick={()=>setRate(-1)}>负速度</button></aside>
 <div className="composer">继续这个任务…<footer>模型 · 默认 <span>↑</span></footer></div>
 <aside><button onClick={start}>开始</button><button onClick={()=>setPhase('正在执行工具：检查需要很长时间的命令输出与测试结果')}>工具</button><button onClick={()=>setPhase('正在重试 1/3')}>重试</button><button onClick={()=>setPhase('正在压缩上下文')}>压缩</button><button onClick={()=>finish('completed')}>完成</button><button onClick={()=>finish('cancelled')}>停止</button><button onClick={()=>finish('failed')}>失败</button><button onClick={()=>finish('interrupted')}>中断</button><button onClick={()=>update(null)}>切换空对话</button></aside></main></>;
}createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(root, "bundle.js"));
    const html = `<!doctype html><meta charset="utf-8"><style>
body{--bg:#fff;--bg-panel:#f7f7f8;--text:#18181b;--text-muted:#52525b;--accent:#2f6feb;--status-ready:#16a34a;--status-failed:#dc2626;--text-sm:13px;background:var(--bg);color:var(--text);margin:0;font-family:Inter,'Microsoft YaHei',sans-serif}body.dark{--bg:#18181b;--bg-panel:#27272a;--text:#f4f4f5;--text-muted:#a1a1aa;--accent:#6c9fff}nav{padding:22px 32px;border-bottom:1px solid #8883;display:flex;gap:24px;align-items:center}nav button{margin-left:auto}main{max-width:760px;margin:30px auto;padding:0 24px}.user{margin-left:auto;width:65%;background:var(--bg-panel);padding:16px;border-radius:12px}p{margin:30px 0}.tool{padding:18px;background:var(--bg-panel);border-radius:8px;color:var(--text-muted);font-size:14px}.spacer{height:140px}.composer{border:1px solid #8885;border-radius:16px;padding:20px;color:var(--text-muted)}footer{font-size:12px;display:flex;justify-content:space-between;margin-top:50px}button{border:1px solid #8884;background:var(--bg-panel);color:var(--text);border-radius:6px;padding:7px 10px;cursor:pointer}aside{display:flex;gap:6px;flex-wrap:wrap;margin-top:20px}body.capture aside{visibility:hidden}
</style><div id="root"></div><script src="/bundle.js"></script>`;
    server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/bundle.js" ? "text/javascript" : "text/html"); res.end(req.url === "/bundle.js" ? bundle : html); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1.5 });
    await page.clock.install({ time: new Date("2026-10-31T10:00:00Z") });
    // Only explicit runFor calls advance task time. Screenshots and slow CI
    // actions must not add real seconds between exact duration assertions.
    await page.clock.pauseAt(new Date("2026-10-31T10:05:00Z"));
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const value = page.locator("[data-task-duration-value]");
    assert.equal(await page.locator("[data-task-duration]").count(), 0);
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.clock.runFor(65000);
    assert.equal(await value.innerText(), "1:05");
    const speed = page.locator("[data-task-token-speed]");
    assert.equal(await speed.count(), 0, "no invented speed before a server sample");
    for (const [button, expected] of [["速度采样", "≈42.5 t/s"], ["速度变化", "≈7.2 t/s"], ["输出暂停", "≈0.0 t/s"]]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      assert.equal(await speed.innerText(), expected);
      assert.equal(await value.innerText(), "1:05", "speed updates preserve total elapsed time");
    }
    for (const button of ["清除速度", "无效速度", "无限速度", "负速度"]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      assert.equal(await speed.count(), 0);
    }
    for (const name of ["工具", "重试", "压缩"]) {
      await page.getByRole("button", { name, exact: true }).click();
      assert.equal(await value.innerText(), "1:05", `${name} preserves total elapsed`);
    }
    await page.reload(); await value.waitFor();
    assert.equal(await value.innerText(), "1:05");
    await page.clock.runFor(89000);
    assert.equal(await value.innerText(), "2:34");
    await page.getByRole("button", { name: "速度采样", exact: true }).click();
    assert.equal(await speed.innerText(), "≈42.5 t/s");
    const artifacts = path.join(repo, ".verification/task-duration"); await mkdir(artifacts, { recursive: true });
    await page.locator("body").evaluate(body => body.classList.add("capture"));
    await page.screenshot({ path: path.join(artifacts, "running-light.png") });
    await page.locator("body").evaluate(body => body.classList.remove("capture"));
    await page.getByRole("button", { name: "完成", exact: true }).click();
    await page.clock.runFor(60000);
    assert.equal(await value.innerText(), "2:34");
    assert.equal(await page.locator("[data-task-duration]").getAttribute("data-state"), "completed");
    assert.equal(await speed.count(), 0, "terminal tasks hide the last live estimate");
    await page.getByRole("button", { name: "回复已有总用时", exact: true }).click();
    assert.equal(await page.locator("[data-task-duration]").count(), 0, "completed timer moves out of the composer when the reply owns it");
    await page.getByRole("button", { name: "回复已有总用时", exact: true }).click();
    await page.reload(); await value.waitFor();
    assert.equal(await value.innerText(), "2:34");
    for (const [label, outcome] of [["停止", "cancelled"], ["失败", "failed"], ["中断", "interrupted"]]) {
      await page.getByRole("button", { name: "开始", exact: true }).click();
      await page.clock.runFor(4000);
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.clock.runFor(10000);
      assert.equal(await page.locator("[data-task-duration]").getAttribute("data-state"), outcome);
      assert.equal(await value.innerText(), outcome === "interrupted" ? "用时未记录" : "4s");
    }
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.clock.runFor(3723000);
    assert.equal(await value.innerText(), "1:02:03");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("button", { name: "主题", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 750 });
    await page.getByRole("button", { name: "速度采样", exact: true }).click();
    assert.equal(await speed.innerText(), "≈42.5 t/s");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator("[data-task-duration-phase]").evaluate(el => el.scrollWidth > el.clientWidth), "long phase is ellipsized");
    await page.locator("body").evaluate(body => body.classList.add("capture"));
    await page.screenshot({ path: path.join(artifacts, "running-dark-narrow.png") });
    await page.locator("body").evaluate(body => body.classList.remove("capture"));
    await page.setViewportSize({ width: 320, height: 750 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "speed wraps on small screens without overflow");
    await page.getByRole("button", { name: "切换空对话", exact: true }).click();
    assert.equal(await page.locator("[data-task-duration]").count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("piora-task-duration-"));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
