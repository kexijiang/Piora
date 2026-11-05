import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("compact command results and optional composer actions support keyboard, IME, follow-ups and narrow themes", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-command-browser-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=function(s){const prefix=require('path').basename(this.resourcePath).replace(/\\W/g,'')+'_';const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,name)=>'.'+names[name]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useRef,useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {ChatInput} from "@/components/ChatInput";
import {ChatCommandCard,ChatCommandQueue} from "@/components/ChatCommandCard";
import {AppTooltip} from "@/components/AppTooltip";
import {createChatCommandCatalog,parseChatInput,createChatCommandOperation} from "@/lib/chat-command-input";
const catalog=createChatCommandCatalog([{name:"deploy",source:"extension"},{name:"review",source:"prompt",usesTemplateArguments:true}]);
function App(){
 const input=useRef(null),[record,setRecord]=useState(null),[busy,setBusy]=useState(false);
 const [queueMode,setQueueMode]=useState("queue");
 window.setQueueMode=setQueueMode;
 const queued={commandId:"queue-fixture",status:"queued",preview:"检查 Windows 状态",acceptedAt:0};
 const changeQueue=async mode=>{window.queueActions.push(mode);await new Promise(resolve=>setTimeout(resolve,30));if(window.failQueue)throw new Error("切换失败");setQueueMode(mode);};
 const queueActions={cancel:async()=>{},steer:()=>changeQueue("steer"),edit:async()=>"",save:async()=>{},resume:async()=>{}};
 const pendingMessages=queueMode==="queue"?null:{steering:queueMode==="steer"?["检查 Windows 状态"]:[],followUp:queueMode==="followUp"?["检查 Windows 状态"]:[],pendingInputs:[{id:"pending-fixture",commandId:"queue-fixture",text:"检查 Windows 状态",kind:queueMode}]};
 window.setBusy=setBusy;
 window.restoreDraft=draft=>input.current.restoreCommandDraft(draft);
 const send=async(text,images,files,onDurable,...rest)=>{
  const options=rest.find(value=>value && !Array.isArray(value))??{};
  window.submissions.push({text,options});onDurable?.("fixture");
  const parsed=parseChatInput(text,catalog,options);
  if(parsed.kind==="command"){
   const operation=createChatCommandOperation(text,catalog,parsed);operation.steps[0].status="completed";
   operation.result={title:"chatCommands.reloadCompleted",resources:{extensions:3,skills:4,prompts:2,commands:8}};
   if(operation.steps[1])operation.steps[1].status="blocked";
   setRecord({commandId:"fixture-command",idempotencyKey:"fixture",targetSessionId:"session",acceptedAt:Date.now(),status:operation.afterPrompt?"failed":"completed",operation});
  }return true;
 };
 const actions={retry:async()=>{},restore:async()=>{window.restored=true;},cancel:async()=>{},copy:async()=>{}};
 return <I18nProvider><AppTooltip/><main><ChatCommandQueue records={queueMode==="queue"?[queued]:[]} actions={queueActions} pendingMessages={pendingMessages} onPendingAction={()=>changeQueue("queue")}/>{record&&<ChatCommandCard record={record} actions={actions}/>}<ChatInput ref={input} onSend={send} onQueueInput={send} onAbort={()=>{}} isStreaming={busy} commandCatalog={catalog} model={{provider:"fixture",modelId:"model"}} placeholder="测试命令输入" /></main></I18nProvider>;
}
window.submissions=[];window.queueActions=[];createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8")) + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1060, height: 900 } });
    const errors = [];
    await context.route("http://commands.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { success: true, data: {} } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}body{background:var(--bg);color:var(--text)}main{max-width:760px;margin:auto;padding:16px}textarea{max-width:100%}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("http://commands.test/");
    // Actual queue UI + global tooltip; only backend delivery is a fixture.
    const toggle = page.locator('[data-live-tooltip="queue-fixture"]');
    const tooltip = page.locator("#pi-app-tooltip");
    await toggle.hover();
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent.includes("当前：排队中"));
    assert.equal(await page.getByText("排队中", { exact: true }).count(), 0);
    // Keep the mouse stationary through both row replacements.
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent.includes("当前：引导中"));
    assert.match(await toggle.textContent(), /恢复排队/);
    await page.mouse.down(); await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent.includes("当前：排队中"));
    assert.match(await toggle.textContent(), /切换引导/);
    assert.deepEqual(await page.evaluate(() => window.queueActions), ["steer", "queue"]);
    await page.evaluate(() => { window.failQueue=true; });
    await page.mouse.down(); await page.mouse.up();
    await page.getByText("切换失败", { exact: true }).waitFor();
    assert.match(await tooltip.textContent(), /当前：排队中/);
    assert.match(await toggle.textContent(), /切换引导/);
    await page.evaluate(() => { window.failQueue=false; });
    await page.mouse.move(5, 5);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent.includes("当前：引导中"));
    assert.equal(await toggle.evaluate(el => el === document.activeElement), true);
    // Same DOM node, different pending kind: refresh its title without re-hover.
    await page.evaluate(() => window.setQueueMode("followUp"));
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent.includes("当前：等待后续处理"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[role="tooltip"]').textContent === "");
    const composer = page.getByPlaceholder("测试命令输入");
    await composer.fill("/reload");
    await composer.press("Escape");
    await composer.press("Enter");
    const result = page.locator('[data-command-id="fixture-command"]');
    await result.waitFor();
    assert.equal(await result.locator("pre").count(), 0);
    await result.getByRole("button", { name: "查看详情", exact: true }).click();
    await page.getByText("会话资源已重载", { exact: true }).waitFor();
    await result.getByRole("button", { name: "收起详情", exact: true }).click();
    assert.equal(await page.evaluate(() => window.submissions.length), 1);
    await composer.fill("/reload 检查当前项目");
    await composer.press("Escape");
    await page.getByText("发送后续问题", { exact: false }).waitFor();
    await composer.press("Enter");
    await page.getByText("检查当前项目", { exact: true }).waitFor();
    await page.getByRole("button", { name: "编辑后续问题", exact: true }).click();
    assert.equal(await page.evaluate(() => window.restored), true);
    await composer.fill("/deploy staging");
    await composer.press("Escape");
    await page.locator("summary").click();
    await page.getByRole("button", { name: "完成后再提问", exact: true }).click();
    await page.getByRole("textbox", { name: "后续提问" }).fill("检查部署结果");
    await composer.press("Enter");
    assert.equal(await page.evaluate(() => window.submissions.at(-1).options.afterPrompt), "检查部署结果");
    await composer.fill("/reload");
    await composer.press("Escape");
    await composer.dispatchEvent("compositionstart");
    await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, bubbles: true });
    await composer.dispatchEvent("compositionend");
    assert.equal(await page.evaluate(() => window.submissions.length), 3);
    await composer.fill("/deploy staging");
    await composer.press("Escape");
    await page.locator("summary").click();
    await page.getByRole("button", { name: "完成后再提问", exact: true }).click();
    await page.getByRole("textbox", { name: "后续提问" }).fill("保留独立问题");
    await page.locator("summary").click();
    await page.getByRole("button", { name: "作为普通消息发送", exact: true }).click();
    assert.equal(await composer.inputValue(), "/deploy staging\n\n保留独立问题");
    await composer.press("Enter");
    assert.equal(await page.evaluate(() => window.submissions.at(-1).options.inputMode), "text");
    await composer.fill("/deploy staging");
    await composer.press("Escape");
    await page.locator("summary").click();
    await page.getByRole("button", { name: "完成后再提问", exact: true }).click();
    await page.getByRole("textbox", { name: "后续提问" }).fill("改为文本仍保留");
    await composer.fill("普通问题");
    assert.equal(await composer.inputValue(), "普通问题\n\n改为文本仍保留");
    await page.evaluate(() => window.setBusy(true));
    await composer.fill("/deploy staging");
    await composer.press("Escape");
    await page.locator("summary").click();
    await page.getByRole("combobox", { name: "命令交付方式" }).selectOption("next_turn");
    await page.getByRole("button", { name: "执行", exact: true }).click();
    assert.equal(await page.evaluate(() => window.submissions.at(-1).options.delivery), "next_turn");
    await composer.fill("/review API");
    await composer.press("Escape");
    await page.locator("summary").click();
    await page.getByRole("combobox", { name: "命令交付方式" }).selectOption("steer");
    await page.getByRole("button", { name: "执行", exact: true }).click();
    assert.equal(await page.evaluate(() => window.submissions.at(-1).options.delivery), "steer");
    await page.evaluate(() => window.setBusy(false));
    await composer.fill("/unknown-command 中文参数");
    await composer.press("Escape");
    await page.getByRole("button", { name: "作为普通消息发送", exact: true }).click();
    await page.getByRole("button", { name: "发送", exact: true }).click();
    assert.equal(await page.evaluate(() => window.submissions.at(-1).options.inputMode), "text");
    await composer.fill("已有新输入");
    assert.equal(await page.evaluate(() => window.restoreDraft({ value: "/reload", images: [], files: [] })), false);
    assert.equal(await composer.inputValue(), "已有新输入");
    for (const scheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [340, 390, 768, 1060]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => [...document.querySelectorAll("main *")].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).map(element => ({ tag: element.tagName, class: element.className, width: element.getBoundingClientRect().width, text: element.textContent?.slice(0, 60) })));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${scheme}/${width} overflow: ${JSON.stringify(overflow)}`);
        if (process.env.PIORA_TEST_ARTIFACTS_DIR && (width === 340 || width === 1060)) {
          await mkdir(process.env.PIORA_TEST_ARTIFACTS_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.PIORA_TEST_ARTIFACTS_DIR, `commands-${scheme}-${width}.png`), fullPage: true });
        }
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
