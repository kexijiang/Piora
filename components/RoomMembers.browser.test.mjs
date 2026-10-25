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

test("group creation and member settings use custom identities without required workflow roles", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-room-members-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(directory, "entry.tsx"), `
import {useState} from "react";
import {createRoot} from "react-dom/client";
import {I18nProvider} from "@/hooks/useI18n";
import {RoomSidebarSection} from "@/components/RoomSidebarSection";
import {RoomSettingsDialog} from "@/components/RoomSettingsDialog";
import {createRoomChatProfile} from "@/lib/team-agent-templates";
const member={memberId:"member",profile:createRoomChatProfile({name:"小林",role:"coordinator"}),binding:{sessionId:"hidden",cwd:"F:/fixture",managedByPiora:true,status:"ready"}};
const room={id:"room",name:"写作群",projectRoot:"F:/fixture",workspace:{mode:"managed",path:"F:/fixture/shared",label:"共享"},coordination:{mode:"manual",coordinatorMemberId:"member",maxConcurrency:1,leaseDurationMs:60000},members:[member]};
window.requests=[];
window.fetch=async(url,options={})=>{
  const body=options.body ? JSON.parse(options.body) : null;
  if(body) window.requests.push({url,body});
  return new Response(JSON.stringify(options.method==="POST"?{room}:url==="/api/sessions"?{sessions:[]}:{rooms:[],audit:[]}),{headers:{"Content-Type":"application/json"}});
};
function App(){const[settings,setSettings]=useState(false);return <I18nProvider>{settings?<RoomSettingsDialog initialSection="agents" room={room} onClose={()=>setSettings(false)} onRoomChange={()=>{}} onRoomDeleted={()=>{}}/>:<RoomSidebarSection sessions={[]} selectedSessionId={null} selectedRoomId={null} activeProjectRoot="F:/fixture" onSelectRoom={()=>setSettings(true)}/>}</I18nProvider>}
createRoot(document.getElementById("root")).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "")
      + await readFile(path.join(repo, "components/RoomSidebarSection.module.css"), "utf8")
      + await readFile(path.join(repo, "components/RoomSettingsDialog.module.css"), "utf8");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("https://room-members.test/**", async route => {
      if (new URL(route.request().url()).pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, "bundle.js")) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
    });
    await page.goto("https://room-members.test/");
    await page.getByRole("button", { name: "新建群聊", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: /自由群聊/ }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByRole("combobox").count(), 0);
    await page.getByRole("textbox", { name: "成员名称 1", exact: true }).fill("小林");
    await page.getByRole("textbox", { name: "成员设定（可选） 1", exact: true }).fill("善于追问的写作搭档");
    await page.getByRole("button", { name: "创建群聊", exact: true }).click();
    await page.getByRole("heading", { name: "协作空间设置" }).waitFor();
    const created = await page.evaluate(() => window.requests[0].body);
    assert.equal(created.template, "custom");
    assert.equal(created.agents[0].roleDescription, "善于追问的写作搭档");
    assert.equal(created.agents[0].role, undefined);
    // Hidden managed sessions must still have a valid selection in advanced settings.
    await page.getByRole("button", { name: "显示高级设置" }).click();
    assert.equal(await page.getByLabel("绑定会话", { exact: true }).inputValue(), "hidden");
    await page.getByRole("button", { name: "收起高级设置" }).click();
    await page.getByLabel("显示名称", { exact: true }).last().fill("小周");
    await page.locator(".addAgent textarea").fill("提供不同观点");
    await page.getByRole("button", { name: "添加成员", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "成员已加入" }).waitFor();
    const added = await page.evaluate(() => window.requests.at(-1).body);
    assert.equal(added.role, "participant");
    assert.equal(added.roleDescription, "提供不同观点");
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-room-members-"));
    await rm(directory, { recursive: true, force: true });
  }
});
