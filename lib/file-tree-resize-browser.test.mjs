import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("first opening Files observes its lazy tree and supports resizing", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-file-tree-resize-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    // Keep the real panel lifecycle/layout; replace unrelated tool implementations.
    await writeFile(path.join(root, "tools.tsx"), `import React from "react";
export const useI18n=()=>({t:key=>key});
export const FileExplorer=React.forwardRef(()=> <button>fixture.txt</button>);
export const FileViewer=()=>null,TabBar=()=>null,ReviewPanel=()=>null,CommandPanel=()=>null,BrowserPanel=()=>null,SafeHarmonyPanel=()=>null,AliIcon=()=>null,AutomationPanel=()=>null,SSHPanel=()=>null,DesignToHarmonyPanel=()=>null;
export default ()=>()=>null;`);
    const aliases = Object.fromEntries([
      "@/hooks/useI18n", "../FileExplorer", "../FileViewer", "../TabBar", "./ReviewPanel", "./CommandPanel", "./BrowserPanel", "./HarmonyPanel", "../AliIcon", "./AliIcon", "../AutomationPanel", "./SSHPanel", "./design-to-harmony/DesignToHarmonyPanel", "next/dynamic",
    ].map(name => [name, path.join(root, "tools.tsx")]));
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";
import {RightPanel} from "@/components/workspace/RightPanel";
function App(){const [tab,setTab]=React.useState("home"),[width,setWidth]=React.useState(1000);window.setWidth=setWidth;window.setTab=setTab;
return <div id="fixture" style={{width,height:650}}><RightPanel activeTab={tab} onActiveTabChange={setTab} cwd="/fixture" refreshKey={0} active maximized={false} fileTabs={[]} activeFileTabId={null} sessionId={null} capabilities={null}/></div>}
createRoot(document.getElementById("root")).render(<React.StrictMode><App/></React.StrictMode>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { ...aliases, "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors()
      ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const css = await readFile(path.join(repo, "components/workspace/WorkspacePanel.module.css"), "utf8");
    await page.route("https://file-tree.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><style>body{margin:0} [hidden]{display:none!important} ${css}</style><div id="root"></div>` }));
    await page.goto("https://file-tree.test");
    await page.addScriptTag({ content: await readFile(path.join(root, "bundle.js"), "utf8") });
    await page.getByRole("button", { name: /^workspace\.files/ }).click();
    const separator = page.getByRole("separator", { name: "files.resizeTree" });
    const tree = page.locator("#piora-file-explorer");
    const waitTreeWidth = value => page.waitForFunction(value => Math.abs(document.getElementById("piora-file-explorer").getBoundingClientRect().width - value) < 1, value);
    // The first activation starts at Home, before the lazy files subtree exists.
    await page.waitForFunction(() => document.querySelector('[aria-label="files.resizeTree"]')?.getAttribute("aria-valuemax") === "550", null, { timeout: 5000 });
    const before = (await tree.boundingBox()).width;
    const handle = await separator.boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + 80);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + 80, { steps: 5 });
    await page.mouse.up();
    await waitTreeWidth(before + 80);
    await separator.focus();
    await page.keyboard.press("ArrowLeft");
    await waitTreeWidth(before + 68);
    const savedShare = await page.evaluate(() => localStorage.getItem("piora-file-tree-share"));
    assert.ok(Number(savedShare) > 0.28);
    await page.getByRole("button", { name: "fixture.txt", exact: true }).click();
    await page.evaluate(() => window.setTab("home"));
    await page.getByRole("button", { name: /^workspace\.files/ }).click();
    await waitTreeWidth(before + 68);
    await page.evaluate(() => window.setWidth(500));
    await page.getByRole("button", { name: "files.explorer", exact: true }).waitFor();
    assert.equal(await separator.count(), 0, "narrow panels use the file tree drawer");
    await page.getByRole("button", { name: "files.explorer", exact: true }).click();
    await page.getByRole("button", { name: "fixture.txt", exact: true }).waitFor();
    await page.evaluate(() => window.setWidth(1000));
    await waitTreeWidth(before + 68);
    assert.equal(await page.evaluate(() => localStorage.getItem("piora-file-tree-share")), savedShare);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
