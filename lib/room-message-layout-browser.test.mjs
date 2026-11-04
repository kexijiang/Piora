import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const markdown = [
  "## 交付结果", "", "正文与主对话保持一致，包含 **布局**、**交互** 和 **验证**。", "",
  "- 第一项：支持 `inlineCode` 与 *强调*", "- 第二项：多行内容自然换行", "  - 嵌套列表仍然清晰", "",
  "> 引用说明应保持相同的留白。", "", "- [x] 已完成检查", "- [ ] 待体验", "",
  "| 项目 | 结果 | 详细说明 |", "| --- | --- | --- |",
  `| 宽表格 | 正常 | ${"宽表格内容".repeat(25)} |`, "",
  "```typescript", `const longLine = "${"preserve_code_spacing_".repeat(12)}";`,
  ...Array.from({ length: 18 }, (_, i) => `const step${i} = ${i};`), "```", "", "后续段落完整显示。",
].join("\n");

test("room final and streaming replies match main-chat typography and contain wide content", { timeout: 180000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-room-message-layout-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `

import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {MessageView} from "@/components/MessageView";
import {RoomWorkspace} from "@/components/RoomWorkspace";
const text=${JSON.stringify(markdown)};

const thinking="**检查排版**\\n\\n- 比较正文样式\\n- 验证代码与表格";
const initialMessages=[
  {id:"user",createdAt:1,author:{id:"user",kind:"user",name:"我"},content:"请检查群聊的回复排版。",payload:{truncated:false,lineCount:1,byteLength:36}},
  {id:"final",createdAt:2,author:{id:"final-agent",kind:"agent",name:"设计师"},content:text},
];
const room={id:"11111111-1111-4111-8111-111111111111",name:"群聊",projectRoot:${JSON.stringify(directory)},coordination:{mode:"manual",coordinatorMemberId:"m",maxConcurrency:1},members:[{memberId:"m",profile:{name:"执行者",role:"worker",modelPolicy:{mode:"session"}},binding:{sessionId:"live",status:"ready"}}]};
let completed=false;const sources=[];
const activity=()=>({sessionId:"live",runId:"run",status:completed?"ended":"working",phase:"正在回复",text,thinking,tools:[{id:"read",name:"read",status:"completed",input:'{"path":"README.md"}',output:"已读取内容"}],browser:false,startedAt:3,updatedAt:4});
const messages=()=>[...initialMessages,...(completed?[{id:"live-final",createdAt:5,seq:3,promptRunId:"run",author:{id:"live",kind:"session",name:"执行者"},content:text}]:[])].map((message,index)=>({...message,seq:index+1}));
const snapshot=()=>({type:"snapshot",room,messages:messages(),tasks:[],artifacts:[],runs:[],submissions:[]});
window.EventSource=class{constructor(){sources.push(this);setTimeout(()=>{this.onopen?.();this.onmessage?.({data:JSON.stringify(snapshot())});this.onmessage?.({data:JSON.stringify({type:"activity",activities:[activity()]})});},0)}addEventListener(){}close(){}};
window.fetch=async()=>new Response(JSON.stringify(snapshot()),{headers:{"Content-Type":"application/json"}});
window.finishRoomReply=()=>{completed=true;for(const source of sources){source.onmessage?.({data:JSON.stringify(snapshot())});source.onmessage?.({data:JSON.stringify({type:"activity",activities:[activity()]})});}};
function App(){return <I18nProvider><div id="comparison">
<section><header>主对话</header><div id="main"><MessageView message={{role:"assistant",content:[{type:"thinking",thinking},{type:"text",text}],timestamp:2}}/></div></section>
<section className="workspace"><RoomWorkspace initialRoom={room} onRoomDeleted={()=>{}} onOpenBrowser={()=>{}}/></section>
</div></I18nProvider>;}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8"))
      + (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "")
      + (await readFile(path.join(repo, "components/RoomWorkspace.module.css"), "utf8").then(css => css.replace(/:global\(([^)]+)\)/gu,"$1")));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => { errors.push(error.message); t.diagnostic(error.stack); });
    await page.route("http://room-layout.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      if (pathname.startsWith("/fonts/")) return route.fulfill({ body: await readFile(path.join(repo, "public", pathname.slice(1))) });
      if (pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}
        #comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
        section{min-width:0}section>header{padding:12px 28px;color:var(--text-muted);border-bottom:1px solid var(--border)}
        #main{padding:22px 28px}.messages{overflow:visible;flex:none}body{overflow:auto}
        @media(max-width:820px){#comparison{grid-template-columns:minmax(0,1fr)}#main{padding:22px 14px}}
        </style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    const finalBody = "[data-room-author=assistant] .markdown-assistant-message";
    const liveBody = "[data-room-activity] .markdown-assistant-message";
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto("http://room-layout.test/");
        await page.locator('[data-room-message="user"] strong').filter({ hasText: "我" }).waitFor();
        await page.evaluate(theme => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.classList.toggle("dark", theme === "dark");
        }, theme);
        await page.locator(`${liveBody} .markdown-code-action`).waitFor({ state: "attached" });
        await page.waitForFunction(() => [...document.querySelectorAll(".markdown-assistant-message")].length === 3
          && [...document.querySelectorAll(".markdown-assistant-message")].every(body => body.querySelector("pre code .token")));
        await page.locator(liveBody).scrollIntoViewIfNeeded();
        const main = page.locator("#main .markdown-assistant-message");
        const final = page.locator(finalBody);
        const live = page.locator(liveBody);
        const snapshot = locator => locator.evaluate(root => {
          const properties = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "marginTop", "marginBottom", "paddingLeft", "whiteSpace", "wordBreak", "overflowWrap", "maxHeight"];
          return Object.fromEntries(["", "h2", "p", "strong", "em", "ul", "li", "blockquote", "th", "td", ".markdown-inline-code", ".markdown-code-block pre"].map(selector => {
            const node = selector ? root.querySelector(selector) : root;
            const style = getComputedStyle(node);
            // Outer spacing depends on a preceding disclosure; paragraph/list spacing must match exactly.
            return [selector, Object.fromEntries(properties.filter(key => selector || !key.startsWith("margin")).map(key => [key, style[key]]))];
          }));
        });
        assert.deepEqual(await snapshot(final), await snapshot(main), `${theme}/${width}: final reply matches main`);
        assert.deepEqual(await snapshot(live), await snapshot(main), `${theme}/${width}: streaming reply matches main`);

        assert.equal(await final.evaluate(node => getComputedStyle(node).marginTop), "0px", "standalone replies have no disclosure gap");
        assert.deepEqual(await final.locator("[data-emphasis-color]").evaluateAll(nodes => nodes.map(node => node.dataset.emphasisColor)), ["0", "1", "2"]);
        assert.equal(await page.locator("[data-room-author=assistant] .bubble").count(), 0);
        assert.equal(await page.locator("[data-room-author=user] .bubble").count(), 1);
        for (const locator of [final, live]) {
          await locator.scrollIntoViewIfNeeded();
          const dimensions = await locator.evaluate(root => {
            const row = root.closest("article"), column = root.closest(".messageColumn,.activityBody");
            const pre = root.querySelector("pre"), table = root.querySelector(".markdown-table-wrap");
            return { row: row.clientWidth, rowScroll: row.scrollWidth, column: column.getBoundingClientRect().width, expectedColumn: row.getBoundingClientRect().width - row.firstElementChild.getBoundingClientRect().width - parseFloat(getComputedStyle(row).columnGap),
              pre: pre.clientWidth, preScroll: pre.scrollWidth, preHeight: pre.clientHeight, table: table.clientWidth, tableScroll: table.scrollWidth };
          });
          assert.ok(dimensions.rowScroll <= dimensions.row + 1, "wide content must not widen the message row");
          assert.ok(Math.abs(dimensions.column - dimensions.expectedColumn) < 2, "replies use all available width after the avatar");
          assert.ok(dimensions.preScroll > dimensions.pre, "long code lines scroll horizontally");
          assert.ok(dimensions.tableScroll > dimensions.table, "wide tables scroll inside their wrapper");
          assert.ok(dimensions.preHeight > 320, "reply code is not clamped by tool-output styling");
        }
        await page.locator("[data-room-activity] > .activityBody > details > summary").click();
        await page.locator("[data-room-activity] .toolDisclosure").first().locator("summary").click();
        await page.locator("#main .thinking-block-trigger").click();
        await page.locator("[data-room-activity] .markdown-thinking strong").waitFor();
        assert.equal(await page.locator("[data-room-activity] .markdown-thinking").innerHTML(), await page.locator("#main .markdown-thinking").innerHTML());
        for (const size of [14, 20]) {
          await page.evaluate(size => document.documentElement.style.setProperty("--ui-font-size", `${size}px`), size);
          for (const selector of ["#main .markdown-thinking", "[data-room-activity] .markdown-thinking"]) {
            const thinkingSize = parseFloat(await page.locator(selector).evaluate(node => getComputedStyle(node).fontSize));
            const bodySize = parseFloat(await main.evaluate(node => getComputedStyle(node).fontSize));
            assert.ok(Math.abs(thinkingSize / bodySize - 0.893) < 0.002, "thinking text stays one size below the configured body text");
          }
        }
        await page.evaluate(() => document.documentElement.style.removeProperty("--ui-font-size"));
        const tool = page.locator("[data-room-activity] .liveTool > summary");
        await tool.focus();
        await page.keyboard.press("Enter");
        await page.getByText("已读取内容", { exact: true }).waitFor();
        assert.equal(await tool.evaluate(node => String(node.parentElement.open)), "true");
        if (process.env.PIORA_ROOM_LAYOUT_SCREENSHOTS) {
          const output = path.join(repo, "test-results", "room-layout");
          await mkdir(output, { recursive: true });
          await page.screenshot({ path: path.join(output, `${theme}-${width}.png`), fullPage: true });
        }
        await page.evaluate(() => window.finishRoomReply());
        await page.locator("[data-room-author=assistant]").nth(1).waitFor();
        assert.equal(await page.locator(liveBody).count(), 0, "the live reply is replaced by its saved final reply without duplication");
        assert.deepEqual(await snapshot(page.locator(finalBody).nth(1)), await snapshot(main));
        assert.equal(await tool.evaluate(node => String(node.parentElement.open)), "true", "tool expansion survives finalization");
        t.diagnostic(`${theme}/${width}: typography, overflow, disclosures and finalization passed`);
      }
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-room-message-layout-"));
    await rm(directory, { recursive: true, force: true });
  }
});
