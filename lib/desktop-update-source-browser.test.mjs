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

test("update settings use fixed GitHub, support beta and retain scheduled installation without overlapping text", { timeout: 120000 }, async () => {
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
    // The IPC bridge is a fixture. Checks and schedule changes use real UI controls.
    await page.addInitScript(() => {
      const query = new URL(location.href).searchParams;
      localStorage.setItem("pi-locale", query.get("locale") || "zh-CN");
      const edition = query.get("edition");
      const unsupportedReason = ["alpha", "development"].includes(edition) ? "non-stable" : edition === "portable" ? "installer-required" : undefined;
      let state = { status: unsupportedReason ? "unsupported" : "idle", unsupportedReason, currentVersion: edition === "alpha" ? "0.5.10-alpha.1" : edition === "beta" ? "0.5.10-beta.25" : "0.5.10", audience: "preview", source: "github" };
      let schedule = { enabled: false, time: "03:00", supported: !unsupportedReason, unsupportedReason };
      let listener;
      window.fixtureCheckFails = false;
      window.fixtureChecks = 0;
      window.fixtureSaves = 0;
      window.piDesktop = {
        getUpdateSchedule: async () => schedule,
        setUpdateSchedule: async value => { window.fixtureSaves++; schedule = { ...schedule, ...value }; return schedule; },
        getUpdateState: async () => state,
        onUpdateState: next => { listener = next; return () => { listener = undefined; }; },
        checkForUpdates: async () => {
          window.fixtureChecks++;
          state = { ...state, status: "checking" }; listener?.(state);
          state = window.fixtureCheckFails ? { ...state, status: "error", error: "Network unavailable" } : { ...state, status: "up-to-date", latestVersion: "0.5.10", error: undefined };
          listener?.(state); return state;
        },
      };
    });
    const globals = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace('@import "tailwindcss";', "");
    await page.route("http://source.test/**", route => route.fulfill(new URL(route.request().url()).pathname.endsWith("bundle.js") ? { contentType: "text/javascript", body: bundle } : { contentType: "text/html", body: `<!doctype html><html><meta charset="utf-8"><style>${globals}*{box-sizing:border-box}body{margin:0;font-family:system-ui}p{margin:0}#root{padding:20px;max-width:1200px;margin:auto}</style><div id="root"></div><script src="/bundle.js"></script></html>` }));
    await page.goto("http://source.test/");
    await page.getByText("GitHub 开源渠道", { exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox").count(), 0, "the source selector is removed");
    assert.equal(await page.getByText(/内源渠道|切换到另一来源/).count(), 0);
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByText("此渠道没有更高版本，不会降级。").waitFor();
    assert.match(await page.locator('body').innerText(), /GitHub 最新版本：0.5.10/);
    await page.evaluate(() => { window.fixtureCheckFails = true; });
    await page.getByRole("button", { name: "检查更新", exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.evaluate(() => { window.fixtureCheckFails = false; });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.getByText("此渠道没有更高版本，不会降级。").waitFor();
    assert.equal(await page.evaluate(() => window.fixtureChecks), 3);
    await page.getByRole("switch", { name: "定时静默更新" }).click();
    assert.equal(await page.getByRole("switch").getAttribute("aria-checked"), "true");
    for (const locale of ["zh-CN", "en"]) {
      await page.goto(`http://source.test/?edition=beta&locale=${locale}`);
      const check = page.getByRole("button", { name: locale === "zh-CN" ? "检查更新" : "Check for updates", exact: true });
      await check.waitFor();
      assert.equal(await check.isEnabled(), true, "beta installers can check for updates");
      assert.equal(await page.getByRole("switch").isEnabled(), true, "beta installers retain scheduled installation");
      assert.equal(await page.getByRole("combobox").count(), 0);
    }
    for (const locale of ["zh-CN", "en"]) for (const edition of ["alpha", "development", "portable"]) {
      await page.goto(`http://source.test/?edition=${edition}&locale=${locale}`);
      await page.waitForFunction(locale => document.documentElement.lang === locale && document.querySelector('[role="switch"]')?.disabled, locale);
      const hint = edition !== "portable" ? /Beta|beta/ : locale === "zh-CN" ? /仅 Windows 安装版/ : /Windows installer/;
      const source = page.locator('[data-settings-id="general.updateSource"]');
      const schedule = page.locator('[data-settings-id="general.updateSchedule"]');
      assert.match(await source.innerText(), hint);
      assert.match(await schedule.innerText(), hint);
      assert.equal(await page.getByRole("switch").isDisabled(), true);
      const disabledStyle = await page.getByRole('switch').evaluate(el => ({ opacity: Number(getComputedStyle(el).opacity), cursor: getComputedStyle(el).cursor, hint: el.getAttribute('aria-describedby')?.split(' ').map(id => document.getElementById(id)?.textContent).join(' ') }));
      assert.ok(disabledStyle.opacity <= .5, "unsupported scheduled installation must visibly appear disabled");
      assert.equal(disabledStyle.cursor, "not-allowed", JSON.stringify({ locale, edition, disabledStyle }));
      assert.match(disabledStyle.hint, hint, "disabled reason must be linked to the schedule switch");
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
      await page.getByRole('switch').click({ force: true });
      assert.equal(await page.evaluate(() => window.fixtureSaves), 0, "unsupported editions must never save or enable updates");
    }
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
