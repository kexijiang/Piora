import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("composer clears before a delayed recovery commit and retains drafts through failures and reload", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-composer-send-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "icons.tsx"), "export const ModelProviderIcon=()=>null;");
    await writeFile(path.join(directory, "entry.tsx"), `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
      import {ChatInput} from ${JSON.stringify(path.join(repo, "components/ChatInput.tsx"))};
      import {readComposerRecord} from ${JSON.stringify(path.join(repo, "lib/reply-storage.ts"))};
      import {savePendingPrompt,readPendingPrompts} from ${JSON.stringify(path.join(repo, "lib/prompt-recovery.ts"))};
      window.readDraft=()=>readComposerRecord('drafts','send-test');
      window.readRecovery=()=>readPendingPrompts('send-test');
      window.sends=[];
      function App(){
        const [messages,setMessages]=React.useState([]);
        return <><output>{messages.join('|')}</output><ChatInput draftKey="send-test" isStreaming={false} onAbort={()=>{}}
          onSend={async(value,images,files,onDurable)=>{
            window.sends.push({value,images,files});
            setMessages(current=>[...current,value]);
            try {
              await new Promise((resolve,reject)=>{window.commit=resolve;window.fail=()=>reject(new Error('storage failed'));});
              const id='send-'+window.sends.length;
              await savePendingPrompt({id,scope:'send-test',message:{role:'user',content:value},draft:{value,images:images??[],files:files??[]}});
              onDurable(id);
              return await new Promise(resolve=>{window.accept=()=>resolve(true);window.rejectSend=()=>resolve(false);});
            } catch { return false; }
            finally { window.settled=true; }
          }}/></>;
      }
      localStorage.setItem('pi-locale','zh-CN');
      createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
    `);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "./ModelProviderIcon": path.join(directory, "icons.tsx"), "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://composer-send.test/**", route => {
      const { pathname } = new URL(route.request().url());
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { available: false } });
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("http://composer-send.test/");
    const input = page.locator("textarea");
    const send = page.getByRole("button", { name: "发送", exact: true });
    await input.fill("原始消息");
    await page.waitForFunction(async () => (await window.readDraft())?.value === "原始消息");
    await send.click();
    await page.waitForFunction(() => Boolean(window.commit));
    assert.equal(await input.inputValue(), "", "visible draft clears while recovery is still blocked");
    assert.equal(await page.locator("output").textContent(), "原始消息");
    assert.equal(await page.evaluate(async () => (await window.readDraft()).value), "原始消息");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "原始消息");

    // Keyboard sends have the same immediate feedback and cannot double-submit.
    await input.press("Enter");
    await page.waitForFunction(() => Boolean(window.commit));
    assert.equal(await input.inputValue(), "");
    await input.press("Enter");
    assert.equal(await page.evaluate(() => window.sends.length), 1);
    await page.evaluate(() => window.fail());
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "原始消息");
    await page.waitForFunction(async () => (await window.readDraft())?.value === "原始消息");

    await send.click();
    await input.fill("下一条草稿");
    assert.equal(await page.evaluate(async () => (await window.readDraft()).value), "原始消息", "new typing cannot replace the disk fallback before recovery commits");
    await page.evaluate(() => window.commit());
    await page.waitForFunction(() => Boolean(window.rejectSend));
    await page.waitForFunction(async () => (await window.readDraft())?.value === "下一条草稿");
    assert.equal(await input.inputValue(), "下一条草稿", "late receipt cannot clear newer typing");
    await page.evaluate(() => { window.settled = false; window.rejectSend(); });
    await page.waitForFunction(() => window.settled);
    assert.equal(await input.inputValue(), "下一条草稿");
    assert.equal(await page.evaluate(async () => (await window.readRecovery())[0].draft.value), "原始消息");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "下一条草稿");
    assert.equal(await page.evaluate(async () => (await window.readRecovery())[0].draft.value), "原始消息");

    await send.click();
    await page.waitForFunction(() => Boolean(window.commit));
    await page.evaluate(() => window.commit());
    await page.waitForFunction(() => Boolean(window.accept));
    await page.evaluate(() => window.accept());
    await page.waitForFunction(async () => (await window.readDraft()) === undefined);
    assert.equal(await input.inputValue(), "");
    await page.reload();
    await input.waitFor();
    assert.equal(await input.inputValue(), "");
    assert.equal((await page.evaluate(() => window.readRecovery())).length, 2);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    // mkdtemp created this exact absolute directory under the system temp root.
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-composer-send-"));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a narrow desktop composer keeps model, send and stop controls clickable", { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-composer-layout-"));
  const origin = "http://localhost:38371";
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
      import {ChatInput} from ${JSON.stringify(path.join(repo, "components/ChatInput.tsx"))};
      import {SystemPromptSelector} from ${JSON.stringify(path.join(repo, "components/SystemPromptSelector.tsx"))};
      window.sends=[];
      window.stops=0;
      function App(){
        const [width,setWidth]=React.useState(440);
        const [running,setRunning]=React.useState(false);
        window.resizeComposer=setWidth;
        window.startRun=()=>setRunning(true);
        return <div id="chat-pane" style={{width}}><ChatInput draftKey="layout-test" variant="conversation"
          isStreaming={running} model={{provider:'deepseek',modelId:'deepseek-v4-flash'}}
          modelList={[{provider:'deepseek',id:'deepseek-v4-flash',name:'DeepSeek V4 Flash'}]}
          onModelChange={async()=>true} thinkingLevel="high" onThinkingLevelChange={()=>{}}
          extensionStatuses={[{key:'layout-tools',text:'Tools ready'}]}
          contextControl={<SystemPromptSelector selection={{mode:'default'}} onChange={()=>{}}/>}
          onSend={(text,images,files,onDurable)=>{window.sends.push(text);onDurable?.('layout-send');return true;}}
          onAbort={()=>{window.stops++;setRunning(false);}}/></div>;
      }
      localStorage.setItem('pi-locale','zh-CN');
      createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
    `);
    const compiler = webpack({
      mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"),
      output: { path: directory, filename: "bundle.js", publicPath: `${origin}/` },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const globals = await readFile(path.join(repo, "app/globals.css"), "utf8");
    const preflight = await readFile(require.resolve("tailwindcss/preflight.css"), "utf8");
    const selectorCss = await readFile(path.join(repo, "components/SystemPromptSelector.module.css"), "utf8");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`${origin}/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/speech/transcribe") return route.fulfill({ json: { available: true } });
      if (pathname === "/api/system-prompt") return route.fulfill({ json: { selectorVisible: true, templates: [], defaultTemplateId: null } });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: { available: false } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: await readFile(path.join(directory, path.basename(pathname))) });
      if (/^\/fonts\/inter\/inter-latin-(400-normal|400-italic|500-normal|600-normal)\.woff2$/.test(pathname)) {
        return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(repo, "public", pathname)) });
      }
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><style>${preflight}\n${globals}\n${selectorCss}\n#root{position:absolute;left:272px;bottom:24px}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto(origin);
    const input = page.locator("textarea");
    const model = page.locator(".model-settings-trigger");
    const send = page.getByRole("button", { name: "发送", exact: true });
    await page.locator(".voice-input-button").waitFor();
    await page.waitForFunction(() => {
      const selector = document.querySelector(".control");
      return selector && !selector.disabled;
    });
    await page.evaluate(() => document.fonts.ready);
    await input.fill("窄区布局验收");
    assert.equal(await model.locator(".model-settings-trigger-label").textContent(), "DeepSeek V4 Flash");
    await model.click();
    assert.equal(await model.getAttribute("aria-expanded"), "true");
    await model.click();
    assert.equal(await model.getAttribute("aria-expanded"), "false");

    const bounds = await send.evaluate((button) => {
      const modelButton = document.querySelector(".model-settings-trigger");
      const surface = button.closest(".chat-composer-surface");
      const footer = surface.lastElementChild;
      const rect = element => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const buttonRect = button.getBoundingClientRect();
      return { send: rect(button), model: rect(modelButton), footer: rect(footer), surface: rect(surface),
        hit: button.contains(document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)) };
    });
    t.diagnostic(`440px composer / 1440px viewport: ${JSON.stringify(bounds)}`);
    // Use the same ordinary click as the desktop. Old CSS lets the model label
    // cover this button, so this must fail rather than bypassing hit testing.
    await send.click({ timeout: 3000 });
    await page.waitForFunction(() => window.sends.length === 1);
    assert.deepEqual(await page.evaluate(() => window.sends), ["窄区布局验收"]);
    assert.equal(bounds.hit, true, "the send button owns its center hit target");
    assert.ok(bounds.model.x + bounds.model.width <= bounds.send.x, "model and send do not overlap");
    assert.ok(bounds.send.x + bounds.send.width <= bounds.surface.x + bounds.surface.width, "send stays inside the composer");
    assert.ok(Math.abs(bounds.send.x + bounds.send.width - bounds.footer.x - bounds.footer.width) <= 1, "send stays right aligned after wrapping");
    await page.waitForFunction(() => document.querySelector("textarea").value === "");

    await page.evaluate(() => window.startRun());
    const stop = page.getByRole("button", { name: "停止智能体", exact: true });
    await stop.waitFor();
    assert.equal(await stop.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, "the stop button is also reachable in the narrow pane");
    const stopBounds = await stop.boundingBox();
    const runningModelBounds = await model.boundingBox();
    assert.ok(runningModelBounds.x + runningModelBounds.width <= stopBounds.x, "model and stop do not overlap");
    await stop.click();
    assert.equal(await page.evaluate(() => window.stops), 1);
    await send.waitFor();

    await page.evaluate(() => window.resizeComposer(900));
    await page.waitForFunction(() => document.getElementById("chat-pane").getBoundingClientRect().width === 900);
    const centers = await page.locator(".composer-add-trigger, .control, .voice-input-button, .prompt-optimize-button, .extension-status-control, .session-stats-trigger, .context-usage-ring, .model-settings-trigger").evaluateAll((elements) => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return rect.y + rect.height / 2;
    }));
    const wideSend = await send.boundingBox();
    centers.push(wideSend.y + wideSend.height / 2);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, "a wide composer retains one footer row");
    assert.equal(await page.locator(".voice-input-button").isVisible(), true);
    assert.equal(await page.locator(".extension-status-control").isVisible(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-composer-layout-"));
    await rm(directory, { recursive: true, force: true });
  }
});
