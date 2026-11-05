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

test("update settings preserve source operations and explain disabled editions without overlapping text", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-update-source-ui-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), `const path=require('node:path');module.exports=function(s){const prefix=path.basename(this.resourcePath).replace(/\\W/g,'')+'_';const names={};const css=s.replace(/:global\\(([^)]+)\\)|\\.([a-zA-Z][\\w-]*)/g,(m,g,n)=>g||'.'+(names[n]=prefix+n));return 'const el=document.createElement("style");el.textContent='+JSON.stringify(css)+';document.head.append(el);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{DesktopUpdateSourceSetting}from'@/components/DesktopUpdateSourceSetting';import{DesktopUpdateScheduleSetting}from'@/components/DesktopUpdateScheduleSetting';createRoot(document.getElementById('root')).render(<I18nProvider><DesktopUpdateSourceSetting/><DesktopUpdateScheduleSetting/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    // The IPC bridge is a fixture. All selections and checks below use UI controls.
    await page.addInitScript(() => {
      const query = new URL(location.href).searchParams;
      localStorage.setItem("pi-locale", query.get("locale") || "zh-CN");
      const edition = query.get("edition");
      const unsupportedReason = edition === "alpha" ? "alpha" : edition === "portable" ? "installer-required" : undefined;
      let state = { status: unsupportedReason ? "unsupported" : "idle", unsupportedReason, currentVersion: edition === "alpha" ? "0.5.10-alpha.1" : "0.5.10-beta.3", audience: "preview", source: localStorage.getItem("fixture-source") || "github" };
      let schedule = { enabled: false, time: "03:00", supported: !unsupportedReason, unsupportedReason };
      let listener;
      window.fixtureFailSave = false;
      window.fixtureSaves = 0;
      window.piDesktop = {
        getUpdateSchedule: async () => schedule,
        setUpdateSchedule: async value => { window.fixtureSaves++; schedule = { ...schedule, ...value }; return schedule; },
        getUpdateState: async () => state,
        onUpdateState: next => { listener = next; return () => { listener = undefined; }; },
        setUpdateSource: async source => {
          window.fixtureSaves++;
          if (window.fixtureFailSave) throw new Error("fixture persistence failed");
          state = { ...state, source, status: "idle", error: undefined, latestVersion: undefined };
          localStorage.setItem("fixture-source", source); listener?.(state); return state;
        },
        checkForUpdates: async () => {
          state = { ...state, status: "checking" }; listener?.(state);
          state = state.source === "internal" ? { ...state, status: "error", error: "内源更新地址未配置" } : { ...state, status: "up-to-date", latestVersion: "0.9.0", error: undefined };
          listener?.(state); return state;
        },
      };
    });
    const globals = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace('@import "tailwindcss";', "");
    await page.route("http://source.test/**", route => route.fulfill(new URL(route.request().url()).pathname.endsWith("bundle.js") ? { contentType: "text/javascript", body: bundle } : { contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${globals}*{box-sizing:border-box}body{margin:0;font-family:system-ui}p{margin:0}#root{padding:20px;max-width:1200px;margin:auto}</style><div id="root"></div><script src="/bundle.js"></script></html>` }));
    await page.goto("http://source.test/");
    const select = page.getByLabel("更新来源", { exact: true });
    await select.selectOption("internal");
    await page.waitForFunction(() => localStorage.getItem("fixture-source") === "internal");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('select')?.value === "internal" && !document.querySelector('select')?.disabled);
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("内源渠道 检查失败。 内源更新地址未配置").waitFor();
    await page.getByRole("button", { name: "切换到另一来源并重试" }).click();
    await page.getByText("此渠道没有更高版本，不会降级。").waitFor();
    assert.equal(await select.inputValue(), "github");
    assert.match(await page.locator('body').innerText(), /渠道最新版本：0.9.0/);
    await page.evaluate(() => { window.fixtureFailSave = true; });
    await select.selectOption("internal");
    await page.getByRole("alert").waitFor();
    assert.equal(await select.inputValue(), "github");
    assert.equal(await page.evaluate(() => localStorage.getItem("fixture-source")), "github");
    await page.evaluate(() => { window.fixtureFailSave = false; });
    await select.focus(); await select.press("ArrowDown"); await select.press("Enter");
    await page.waitForFunction(() => localStorage.getItem("fixture-source") === "internal");
    await page.getByRole("switch", { name: "定时静默更新" }).click();
    assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "true");
    for (const locale of ["zh-CN", "en"]) for (const edition of ["alpha", "portable"]) {
      await page.goto(`http://source.test/?edition=${edition}&locale=${locale}`);
      await page.waitForFunction(locale => document.documentElement.lang === locale && document.querySelector('select')?.disabled, locale);
      const hint = edition === "alpha" ? /Alpha/ : locale === "zh-CN" ? /仅 Windows 安装版/ : /Windows installer/;
      const source = page.locator('[data-settings-id="general.updateSource"]');
      const schedule = page.locator('[data-settings-id="general.updateSchedule"]');
      assert.match(await source.innerText(), hint);
      assert.match(await schedule.innerText(), hint);
      assert.equal(await page.getByRole("switch").isDisabled(), true);
      const disabledStyle = await page.locator('select').evaluate(el => ({ opacity: Number(getComputedStyle(el).opacity), cursor: getComputedStyle(el).cursor, hint: el.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)?.textContent).join(' ') }));
      assert.ok(disabledStyle.opacity <= .5, "unsupported source selector must visibly appear disabled");
      assert.equal(disabledStyle.cursor, "not-allowed", JSON.stringify({ locale, edition, disabledStyle }));
      assert.match(disabledStyle.hint, hint, "disabled reason must be linked to the source selector");
      for (const width of [2276, 840, 390]) {
        await page.setViewportSize({ width, height: 850 });
        await page.evaluate(() => { document.documentElement.style.setProperty('--text-xs', '18px'); document.documentElement.style.setProperty('--text-sm', '20px'); });
        const geometry = await page.evaluate(() => {
          const sections = [...document.querySelectorAll('[data-settings-id]')];
          return sections.map(section => {
            const descriptionElement = section.querySelector('[id$="-description"]');
            const noteElement = section.querySelector('[role="note"]');
            if (!descriptionElement || !noteElement) return { missing: section.outerHTML };
            const description = descriptionElement.getBoundingClientRect();
            const note = noteElement.getBoundingClientRect();
            const bounds = section.getBoundingClientRect();
            return { gap: note.top-description.bottom, contained: note.bottom <= bounds.bottom, overflow: section.scrollWidth-section.clientWidth };
          });
        });
        assert.ok(geometry.every(row => row.gap >= 8 && row.contained && row.overflow <= 1), JSON.stringify({ width, locale, edition, geometry }));
        const sourceBox = await source.boundingBox(); const scheduleBox = await schedule.boundingBox();
        assert.ok(scheduleBox.y >= sourceBox.y + sourceBox.height, "update settings must not overlap each other");
        if (process.env.PIORA_VERIFICATION_DIR && edition === "alpha" && locale === "zh-CN") {
          await mkdir(process.env.PIORA_VERIFICATION_DIR, { recursive: true });
          await page.screenshot({ path: path.join(process.env.PIORA_VERIFICATION_DIR, `update-settings-alpha-${width}.png`), fullPage: true });
        }
      }
      await page.locator('select').click({ force: true });
      assert.equal(await page.evaluate(() => window.fixtureSaves), 0, "unsupported editions must never save or enable updates");
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
