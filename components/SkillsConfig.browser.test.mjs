import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("skill settings browse partial sources, ignore old searches, install globally and manage sources in both languages", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-skills-browser-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), `import React from "react";import {createRoot} from "react-dom/client";import {SkillsConfig} from "@/components/SkillsConfig";import {I18nProvider,useI18n} from "@/hooks/useI18n";function App(){const {setLocale}=useI18n();window.setLocale=setLocale;return <SkillsConfig cwd="" onClose={()=>{}} embedded/>}createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "components/skills/Skills.module.css"), "utf8"));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1120, height: 820 } });
    const errors = [], installs = [], sourceWrites = [], searches = [];
    page.on("pageerror", error => errors.push(error.message));
    const sources = [
      { id: "skills-sh", name: "skills.sh", kind: "skills-sh", url: "https://skills.sh", builtin: true, enabled: true },
      { id: "clawhub", name: "ClawHub", kind: "clawhub", url: "https://clawhub.ai", builtin: true, enabled: true },
      { id: "skillhub", name: "腾讯 SkillHub", kind: "skillhub", url: "https://api.skillhub.cn", builtin: true, enabled: false },
    ];
    const skill = { sourceId: "clawhub", id: "@alice/demo", name: "Demo", description: "A reusable skill with complete reference files.", publisher: "alice", version: "1.0.0" };
    let installed = false;
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await page.route("http://skills.test/**", async route => {
      const url = new URL(route.request().url()), data = route.request().postDataJSON();
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      if (url.pathname === "/api/skills/sources") {
        if (data) { sourceWrites.push(data); if (data.action !== "test") sources.push({ ...data, id: "custom", hasCredential: Boolean(data.credential), credential: undefined }); }
        return route.fulfill({ json: { sources, success: true } });
      }
      if (url.pathname === "/api/skills") return route.fulfill({ json: { skills: installed ? [{ name: "demo", description: skill.description, filePath: "/home/agent/skills/demo/SKILL.md", disableModelInvocation: false, sourceInfo: { scope: "user" }, install: { sourceId: "clawhub", skillId: skill.id, scope: "global", source: "ClawHub", package: "piora:id", versionHash: "1.0.0" } }] : [], projectResourcesLoaded: false } });
      if (url.pathname === "/api/skills/search") {
        searches.push(data);
        if (data.query === "old") await new Promise(r => setTimeout(r, 300));
        const items = data.sourceId === "clawhub" ? [{ ...skill, name: data.query || skill.name, id: data.cursor ? "@alice/second" : skill.id }] : [];
        const result = { sourceId: data.sourceId, state: data.sourceId === "skills-sh" ? "error" : data.sourceId === "skillhub" ? "auth-required" : "ready", items, nextCursor: data.cursor ? undefined : "next", fetchedAt: new Date().toISOString(), error: data.sourceId === "skills-sh" ? "offline" : undefined };
        try { await route.fulfill({ json: { pages: [result] } }); } catch { /* aborted old query */ } return;
      }
      if (url.pathname === "/api/skills/detail") return route.fulfill({ json: { detail: { ...skill, readme: "---\nname: demo\ndescription: Demo\n---\n# Demo\nUse the reference files.", files: ["SKILL.md", "references/a.txt"], requirements: "Python 3" } } });
      if (url.pathname === "/api/skills/install") { installs.push(data); installed = true; return route.fulfill({ json: { success: true } }); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>:root{--bg:#111318;--bg-panel:#191c23;--bg-hover:#252a34;--bg-selected:#233344;--border:#343943;--text:#e7e9ed;--text-muted:#a1a8b4;--accent:#7db6f6;--text-xs:12px;--text-sm:13px;--text-md:15px;--text-lg:21px;--font-mono:monospace}*{box-sizing:border-box}body{margin:0;font:14px system-ui}#root{height:100vh}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      return route.fulfill({ json: {} });
    });
    await page.goto("http://skills.test/");
    await page.getByRole("button", { name: /Demo A reusable/ }).waitFor();
    assert.match(await page.getByRole("region", { name: "skills.sh", exact: true }).textContent(), /连接失败/);
    await page.getByRole("region", { name: "腾讯 SkillHub", exact: true }).getByRole("button", { name: "需要配置凭据" }).click();
    assert.equal(await page.getByRole("tab", { name: "来源管理" }).getAttribute("aria-selected"), "true");
    assert.equal(await page.getByLabel("名称", { exact: true }).inputValue(), "腾讯 SkillHub");
    assert.equal(await page.getByLabel("来源类型").inputValue(), "skillhub");
    assert.equal(await page.getByLabel("仓库或服务地址").isDisabled(), true);
    await page.waitForFunction(() => document.activeElement?.getAttribute("type") === "password");
    await page.getByLabel("API Key / Bearer Token", { exact: true }).fill("unsaved-key");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(sourceWrites.length, 0);
    await page.getByRole("tab", { name: "发现", exact: true }).click();
    await page.getByRole("tab", { name: "来源管理" }).click();
    assert.equal(await page.getByLabel("API Key / Bearer Token", { exact: true }).count(), 0);
    await page.getByRole("tab", { name: "发现", exact: true }).click();
    await page.getByRole("region", { name: "skills.sh", exact: true }).getByRole("button", { name: "配置", exact: true }).click();
    assert.equal(await page.getByLabel("名称", { exact: true }).inputValue(), "skills.sh");
    await page.getByRole("tab", { name: "发现", exact: true }).click();
    await page.getByRole("button", { name: /Demo A reusable/ }).waitFor();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith("/search") && response.request().postDataJSON().refresh === true),
      page.getByRole("button", { name: "刷新", exact: true }).click(),
    ]);
    assert.ok(searches.some(search => search.refresh === true));
    await page.getByRole("textbox", { name: "搜索技能" }).fill("old"); await page.getByRole("button", { name: "搜索技能", exact: true }).click();
    await page.getByRole("textbox", { name: "搜索技能" }).fill("new"); await page.getByRole("button", { name: "搜索技能", exact: true }).click();
    await page.getByRole("button", { name: /new A reusable/ }).waitFor();
    await page.waitForTimeout(350); assert.equal(await page.getByRole("button", { name: /old A reusable/ }).count(), 0);
    assert.ok(searches.filter(search => search.query === "new").every(search => search.refresh === false));
    const group = page.getByRole("region", { name: "ClawHub", exact: true });
    await group.getByRole("button", { name: "加载更多" }).click(); await page.waitForFunction(() => document.querySelectorAll('section[aria-label="ClawHub"] strong').length === 2);
    if (process.env.PIORA_SKILLS_SCREENSHOT_DIR) { await mkdir(process.env.PIORA_SKILLS_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PIORA_SKILLS_SCREENSHOT_DIR, "skills-discover.png") }); }
    await page.getByRole("button", { name: /new A reusable/ }).first().click();
    await page.getByRole("button", { name: "安装技能" }).waitFor();
    assert.equal(await page.getByRole("option", { name: "当前项目" }).isDisabled(), true);
    await page.getByRole("button", { name: "安装技能" }).click(); await page.getByText(/已有会话请在空闲后执行/).waitFor();
    assert.equal(installs[0].scope, "global"); assert.equal(installs[0].version, "1.0.0");
    await page.getByRole("tab", { name: "已安装", exact: true }).click(); await page.getByRole("heading", { name: "demo", exact: true }).waitFor();
    await page.getByRole("tab", { name: "发现", exact: true }).click(); await page.getByRole("button", { name: "添加来源" }).click();
    assert.equal(await page.getByLabel("名称", { exact: true }).inputValue(), "");
    assert.equal(await page.getByLabel("来源类型").isDisabled(), false);
    await page.getByLabel("名称", { exact: true }).fill("Team Hub"); await page.getByLabel("来源类型").selectOption("skillhub"); await page.getByLabel("仓库或服务地址").fill("https://team.example"); await page.getByLabel("API Key / Bearer Token", { exact: true }).fill("secret-input");
    await page.getByRole("button", { name: "保存", exact: true }).click(); await page.getByRole("heading", { name: "Team Hub" }).waitFor();
    assert.equal(sourceWrites.at(-1).kind, "skillhub"); assert.equal(sourceWrites.at(-1).credential, "secret-input");
    assert.equal(await page.getByText("secret-input", { exact: true }).count(), 0);
    await page.evaluate(() => window.setLocale("en")); await page.getByRole("tab", { name: "Sources", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Discover", exact: true }).click();
    await page.getByRole("region", { name: "腾讯 SkillHub", exact: true }).getByRole("button", { name: "Configure credentials", exact: true }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "腾讯 SkillHub");
    assert.equal(await page.getByLabel("API key / bearer token", { exact: true }).inputValue(), "");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 820 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    if (process.env.PIORA_SKILLS_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PIORA_SKILLS_SCREENSHOT_DIR, "skills-sources-mobile.png") });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
