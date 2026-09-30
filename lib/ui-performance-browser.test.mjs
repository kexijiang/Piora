import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("stream updates spare the composer and unchanged Markdown while typing and final content stay correct", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-ui-performance-")); let browser;
  try {
    // Instrument actual component renders in the test bundle, not application code.
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(s){
      if(this.resourcePath.endsWith("ChatInput.tsx")){
        s=s.replace("}: Props, ref) {","}: Props, ref) { window.composerRenders=(window.composerRenders||0)+1;");
        s=s.replace("const [hydratedDraftKey, setHydratedDraftKey] = useState<string | undefined>(undefined);", "const [hydratedDraftKey, setHydratedDraftKey] = useState<string | undefined>(undefined); window.composerHydratedDraftKey=hydratedDraftKey;");
      }
      // Exercise storage initialization beyond the former fixed 200ms wait.
      if(this.resourcePath.endsWith("draft-store.ts"))s=s.replace("export async function hydrateDraft(key: string): Promise<ChatDraft | null> {", "export async function hydrateDraft(key: string): Promise<ChatDraft | null> { await new Promise(resolve=>setTimeout(resolve,650));");
      if(this.resourcePath.endsWith("MarkdownBody.tsx"))s=s.replace("const normalizedMarkdown = useMemo", "window.markdownRenders=(window.markdownRenders||0)+1; const normalizedMarkdown = useMemo");
      return ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;}`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "icons.tsx"), "export const ModelProviderIcon=()=>null;");
    await writeFile(path.join(directory, "entry.tsx"), `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {ChatInput} from ${JSON.stringify(path.join(repo, "components/ChatInput.tsx"))};
      import {MarkdownBody} from ${JSON.stringify(path.join(repo, "components/MarkdownBody.tsx"))};
      import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};
      const send=async()=>true, abort=()=>{}, context=<span>context</span>;
      function App(){
        const [tick,setTick]=React.useState(0), [text,setText]=React.useState('**unchanged**'), [streaming,setStreaming]=React.useState(true);
        window.setText=setText; window.finish=()=>setStreaming(false);
        window.burst=async()=>{for(let i=0;i<60;i++){setTick(i+1); await new Promise(requestAnimationFrame);}};
        return <><output>{tick}</output><ChatInput draftKey="perf-draft" isStreaming={false} onSend={send} onAbort={abort} contextControl={context}/>
          <section id="markdown"><MarkdownBody isStreaming={streaming}>{text}</MarkdownBody></section></>;
      }
      localStorage.setItem('pi-locale','zh-CN'); createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo, "./ModelProviderIcon": path.join(directory, "icons.tsx") } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage(); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://ui-performance.test/**", async route => {
      const name = path.basename(new URL(route.request().url()).pathname);
      if (name.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, name)) });
      if (name === "") return route.fulfill({ contentType: "text/html", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
      return route.fulfill({ json: {} });
    });
    await page.goto("http://ui-performance.test/");
    await page.locator("#markdown strong").waitFor();
    await page.waitForFunction(() => window.composerHydratedDraftKey === "perf-draft");
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const counts = await page.evaluate(async () => {
      const before = { composer: window.composerRenders, markdown: window.markdownRenders };
      await window.burst();
      return { composer: window.composerRenders - before.composer, markdown: window.markdownRenders - before.markdown };
    });
    assert.equal(counts.composer, 0, "60 unrelated updates must not render the composer");
    assert.equal(counts.markdown, 0, "unchanged Markdown must not be reparsed on parent renders");
    // Stream across separate frames while the user types, not a single batched render.
    await page.evaluate(() => {
      window.streamingBurst = (async () => {
        for (let i = 0; i < 60; i++) {
          window.setText("# 生成中\n\n" + "内容持续增加。".repeat(i + 1));
          await new Promise(requestAnimationFrame);
        }
      })();
    });
    await page.locator("textarea").pressSequentially("typing during streaming", { delay: 10 });
    await page.evaluate(() => window.streamingBurst);
    assert.equal(await page.locator("textarea").inputValue(), "typing during streaming");
    await page.locator("textarea").fill("输入依然及时，草稿不会丢失😀");
    const finalText = "# 最终回复\n\n| 功能 | 状态 |\n| --- | --- |\n| 输入 | 保留 |\n\n```js\nconst answer = 42;\n```\n\n结束";
    await page.evaluate(text => {
      for (let i = 1; i <= text.length; i++) window.setText(text.slice(0, i));
      window.finish();
    }, finalText);
    await page.locator("#markdown table").waitFor();
    await page.locator("#markdown").getByText("结束", { exact: true }).waitFor();
    assert.equal(await page.locator("textarea").inputValue(), "输入依然及时，草稿不会丢失😀");
    assert.equal(await page.locator("#markdown h1").innerText(), "最终回复");
    assert.ok((await page.locator("#markdown code").innerText()).includes("const answer = 42;"));
    assert.deepEqual(errors, []);
    console.log("60 stream/status parent updates: composer renders=0, unchanged Markdown renders=0; typing and final table/code preserved");
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
