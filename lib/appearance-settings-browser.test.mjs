import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("appearance tabs preserve drafts, reveal search targets and preview transparency during dragging", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-appearance-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "ts.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `const path=require('node:path');module.exports=function(s){const prefix=path.basename(this.resourcePath).replace(/\\W/g,'')+'_';const names={};const css=s.replace(/:global\\(([^)]+)\\)|\\.([a-zA-Z][\\w-]*)/g,(m,g,n)=>g||'.'+(names[n]=prefix+n));return 'const el=document.createElement("style");el.textContent='+JSON.stringify(css)+';document.head.append(el);export default '+JSON.stringify(names)}`);
    await writeFile(path.join(root, "markdown.tsx"), `export const LazyMarkdownBody=({children})=><div>{children}</div>;`);
    await writeFile(path.join(root, "entry.tsx"), `import React from 'react';import {createRoot} from 'react-dom/client';import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {SettingsDialog} from ${JSON.stringify(path.join(repo, "components/SettingsDialog.tsx"))};import {AppearanceSettings} from ${JSON.stringify(path.join(repo, "components/AppearanceSettings.tsx"))};function App(){const [active,setActive]=React.useState('appearance');return <I18nProvider><SettingsDialog open onClose={()=>{}} activeKey={active} onActiveKeyChange={setActive} sections={{appearance:<AppearanceSettings/>}} conversation={{systemPrompt:null,onSystemPromptSaved(){},notificationEnabled:false,notificationCapability:'unsupported',onNotificationToggle(){}}} desktop={{available:false,globalShortcutEnabled:false,onGlobalShortcutToggle(){}}}/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://appearance-ui.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, plugins: [new webpack.NormalModuleReplacementPlugin(/^\.\/LazyMarkdownBody$/, path.join(root, "markdown.tsx"))], module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "ts.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ ...(process.platform === "win32" ? { channel: "msedge" } : {}), headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: "zh-CN", reducedMotion: "reduce" });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const globals = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace('@import "tailwindcss";', "") + await readFile(path.join(repo, "app/theme-backgrounds.css"), "utf8") + await readFile(path.join(repo, "app/character-themes.css"), "utf8");
    await page.route("http://appearance-ui.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) await route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      else if (url.pathname.startsWith("/api/")) await route.fulfill({ json: {} });
      else if (url.pathname === "/") await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${globals}*{box-sizing:border-box}body{margin:0;font-family:system-ui}</style><div id="root"></div><script src="/bundle.js"></script></html>` });
      else { try { await route.fulfill({ body: await readFile(path.join(repo, "public", url.pathname.slice(1))) }); } catch { await route.fulfill({ status: 404 }); } }
    });
    await page.goto("http://appearance-ui.test/");
    const tab = name => page.getByRole("tab", { name, exact: true });
    await tab("主题与配色").waitFor();
    assert.equal(await page.getByRole("tabpanel").count(), 1);
    // Exercise the actual settings component, palette CSS and shared background store.
    const { createJiti } = await import("jiti");
    const { CHARACTER_THEMES } = await createJiti(import.meta.url).import("./character-themes.ts");
    assert.equal(await page.locator('[data-appearance-look^="character-"]').count(), 21);
    assert.equal(await page.getByRole("heading", { name: "角色主题 21", exact: true }).count(), 1);
    for (const look of CHARACTER_THEMES) {
      const card = page.locator(`[data-appearance-look="${look.id}"]`);
      await card.click();
      await page.waitForFunction(id => document.documentElement.dataset.theme === id && document.documentElement.dataset.appBackgroundPreset === id, look.id);
      assert.equal(await card.getAttribute("aria-pressed"), "true");
      await card.locator("img").evaluate(img => img.decode());
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("dark")), look.isDark);
      assert.deepEqual(await page.evaluate(() => {
        const saved = JSON.parse(localStorage.getItem("pi-background:v1"));
        return [saved.sidebarOverlay, saved.filePanelOverlay];
      }), [36, 42]);
      const color = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text").trim());
      assert.equal(color, look.colors.text);
      const readingSurfaces = await page.evaluate(() => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = '<div class="message-answer-block"><div class="markdown-assistant-message">正文</div></div><div class="message-assistant-blocks"><div class="markdown-assistant-message">流式正文</div></div>';
        document.body.append(wrapper);
        const actual = [...wrapper.querySelectorAll('.markdown-assistant-message')].map(answer => {
          const style = getComputedStyle(answer);
          return { background: style.backgroundColor, paddingLeft: style.paddingLeft, paddingTop: style.paddingTop };
        });
        wrapper.remove();
        return actual;
      });
      assert.deepEqual(readingSurfaces, Array(2).fill({ background: 'rgba(0, 0, 0, 0)', paddingLeft: '0px', paddingTop: '8px' }), `${look.id} keeps wallpaper visible with the standard answer spacing`);
      const glassAlpha = await page.evaluate(() => {
        const panel = document.createElement('span');
        panel.className = 'app-floating-panel';
        document.body.append(panel);
        const value = getComputedStyle(panel).backgroundColor;
        panel.remove();
        // CSS color-mix serializes as color(srgb ... / alpha) in Chromium.
        return Number(value.match(/\/\s*([\d.]+)\)/)?.[1] ?? 1);
      });
      assert.ok(glassAlpha > 0 && glassAlpha < .9, `${look.id} floating panels transmit the wallpaper`);
    }
    await page.locator('[data-character-group="seed"]').click();
    assert.equal(await page.locator('[data-appearance-look^="character-"]').count(), 2);
    await page.locator('[data-appearance-look="character-seed-scarf"]').click();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "character-seed-scarf" && document.documentElement.dataset.appBackgroundPreset === "character-seed-scarf");
    await page.locator('[data-character-group="seed"]').click();
    await page.locator('[data-appearance-look="character-seed-scarf"] img').evaluate(img => img.decode());
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    assert.equal(await page.locator('[data-character-group="seed"]').getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: path.join(repo, ".verification/doubao-theme-integrated.png"), animations: "disabled" });
    await page.locator('[data-character-group="whale"]').click();
    assert.equal(await page.locator('[data-appearance-look^="character-"]').count(), 3);
    await page.locator('[data-appearance-look="character-whale-abyss"]').click();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "character-whale-abyss" && document.documentElement.dataset.appBackgroundPreset === "character-whale-abyss");
    await page.getByRole("button", { name: "恢复切换前外观", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === "light" && document.documentElement.dataset.appBackgroundActive !== "true");
    // A prior built-in look, including all manual tuning values, survives variant browsing.
    await page.locator('[data-appearance-look="ivory"]').click();
    const prior = await page.evaluate(() => ({ theme: localStorage.getItem("pi-theme:v1"), background: localStorage.getItem("pi-background:v1") }));
    await page.locator('[data-character-group="gpt"]').click();
    await page.locator('[data-appearance-look="character-gpt-ivory"]').click();
    await page.locator('[data-appearance-look="character-gpt-orbit"]').click();
    await page.getByRole("button", { name: "恢复切换前外观", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => ({ theme: localStorage.getItem("pi-theme:v1"), background: localStorage.getItem("pi-background:v1") })), prior);
    await page.locator('[data-appearance-look="character-gpt-ivory"]').click();
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.locator('[data-character-group="gpt"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(repo, ".verification/character-themes-integrated.png") });
    await page.setViewportSize({ width: 700, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.getByRole("button", { name: "恢复切换前外观", exact: true }).click();
    await page.locator("summary").filter({ hasText: "自定义" }).click();
    await page.locator('.appearance-custom-details input[type="file"]').setInputFiles(path.join(repo, "public/themes/character-backgrounds/whale-tide.webp"));
    await page.waitForFunction(() => document.documentElement.dataset.appBackgroundSource === "custom");
    const customPrior = await page.evaluate(() => localStorage.getItem("pi-background:v1"));
    await page.locator('[data-appearance-look="character-gpt-orbit"]').click();
    await page.getByRole("button", { name: "恢复切换前外观", exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.appBackgroundSource === "custom");
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-background:v1")), customPrior, "character themes retain the custom image and its tuning");
    const customName = page.getByRole("textbox", { name: "风格名称", exact: true });
    await customName.fill("保留我的草稿");
    await tab("字体").click();
    await tab("字体").press("End");
    assert.equal(await tab("透明度").getAttribute("aria-selected"), "true");
    const slider = page.getByRole("slider", { name: "界面透明度", exact: true });
    const number = page.getByRole("spinbutton", { name: "透明度百分比", exact: true });
    assert.equal(await number.inputValue(), "0", "a fresh installation starts opaque");
    const composer = page.locator('[class*="_previewComposer"]');
    const search = page.locator('[class*="_previewSearch"]');
    const surfaces = async () => Promise.all([composer, search].map(locator => locator.evaluate(el => getComputedStyle(el).backgroundImage)));
    await number.fill("0");
    const opaque = await surfaces();
    const opaqueImage = await composer.screenshot();
    const bounds = await slider.boundingBox();
    await page.mouse.move(bounds.x + 8, bounds.y + bounds.height / 2); await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height / 2, { steps: 8 });
    assert.ok(Number(await slider.inputValue()) > 60, "the slider updates before releasing the pointer");
    const translucent = await surfaces();
    assert.notEqual(translucent[0], opaque[0]); assert.notEqual(translucent[1], opaque[1]);
    assert.equal(await composer.evaluate(el => getComputedStyle(el).opacity), "1", "text remains fully opaque");
    await page.mouse.up();
    assert.notDeepEqual(await composer.screenshot(), opaqueImage, "the rendered preview visibly changes");
    await number.fill("100");
    assert.notDeepEqual(await surfaces(), translucent);
    await number.fill("70");
    assert.ok(await page.getByRole("tabpanel").evaluate(el => el.scrollHeight <= el.clientHeight + 2), "preview and slider fit together at desktop size");
    await mkdir(path.join(repo, ".verification"), { recursive: true });
    await page.screenshot({ path: path.join(repo, ".verification/appearance-transparency.png") });
    await tab("主题与配色").click();
    assert.equal(await customName.inputValue(), "保留我的草稿");
    const searchSettings = page.getByRole("textbox", { name: "搜索设置…", exact: true });
    await searchSettings.fill("透明度");
    await page.getByRole("region", { name: "设置搜索结果" }).getByRole("button").filter({ hasText: "界面透明度" }).click();
    await slider.waitFor();
    assert.equal(await tab("透明度").getAttribute("aria-selected"), "true");
    assert.equal(await number.inputValue(), "70");
    await page.reload(); await tab("透明度").click();
    await page.waitForFunction(() => document.documentElement.dataset.interfaceTransparency === "70");
    await tab("主题与配色").click();
    await page.locator('[data-theme-id="dark"]').click();
    await tab("透明度").click();
    await number.fill("0"); const darkOpaque = await surfaces();
    assert.notDeepEqual(darkOpaque, opaque, "dark theme uses its own surface tint");
    await number.fill("70"); assert.notDeepEqual(await surfaces(), darkOpaque);
    await page.screenshot({ path: path.join(repo, ".verification/appearance-transparency-dark.png") });
    await page.setViewportSize({ width: 700, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(repo, ".verification/appearance-transparency-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.getByRole("tabpanel").getByRole("button", { name: "恢复默认", exact: true }).click();
    // The root attribute changes synchronously; the controlled number draft
    // catches up in a React effect. Wait for both before reading the UI.
    await page.waitForFunction(input => document.documentElement.dataset.interfaceTransparency === "0" && input.value === "0", await number.elementHandle());
    assert.equal(await number.inputValue(), "0");
    assert.equal(await slider.inputValue(), "0");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("pi-interface-transparency:v1")).transparency), 0);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-transparency", value: "reduce" }] });
    assert.notEqual((await surfaces())[0], "none", "a saved manual choice takes precedence over the system preference");
    await page.evaluate(() => localStorage.removeItem("pi-interface-transparency:v1"));
    await page.reload(); await tab("透明度").click();
    await page.getByText(/系统已启用“减少透明效果”/).waitFor();
    assert.equal((await surfaces())[0], "none");
    await number.fill("40");
    assert.notEqual((await surfaces())[0], "none", "moving the control explicitly enables transparency");
    assert.equal(await page.getByText(/系统已启用“减少透明效果”/).isVisible(), false);
    // Prepare a saved beta.69 preference, then let the real background hook
    // hydrate it on reload. No theme card is clicked to trigger this upgrade.
    await page.evaluate(() => {
      localStorage.setItem('pi-background:v1', JSON.stringify({ schemaVersion: 1, source: 'builtin', presetId: 'character-whale-tide', overlay: 64, blur: 0, sidebarOverlay: 82, filePanelOverlay: 86 }));
      localStorage.removeItem('pi-background:character-overlay-v2');
    });
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.appBackgroundPreset === 'character-whale-tide'
      && document.documentElement.style.getPropertyValue('--app-background-sidebar-overlay') === '36%');
    assert.deepEqual(await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('pi-background:v1'));
      return [saved.sidebarOverlay, saved.filePanelOverlay, localStorage.getItem('pi-background:character-overlay-v2')];
    }), [36, 42, '1']);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
