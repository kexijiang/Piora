import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("native message content paints above theme wallpaper and stays readable and actionable", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-message-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "entry.tsx"), `import{createRoot}from'react-dom/client';import{DesktopMessageWindow}from'@/components/PioraMessage';import{useTheme}from'@/hooks/useTheme';function Fixture(){const{setTheme}=useTheme();window.changeTheme=setTheme;return <DesktopMessageWindow/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "") + await readFile(path.join(repo, "app/theme-backgrounds.css"), "utf8") + await readFile(path.join(repo, "app/character-themes.css"), "utf8") + await readFile(path.join(repo, "components/ConfirmDialog.module.css"), "utf8");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 430, height: 320 }, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.answers = [];
      window.piDesktop = { messages: { get: async () => ({ title: "连接详情", message: "HUAWEI Mate 60 (BRA-AL00)\n原生视频 · 独立解码\n1216 × 2688\n收流 / 解码 / 绘制：0.0 / 0.0 / 0.0 FPS\n主机接收至绘制 P95：0.0 ms\n此时间不包含手机采集和传输，不代表端到端延迟。\n恢复次数：51\nThe device stopped producing decoded video (0 submitted, 0 decoded)", actions: [{ id: "done", label: "确定", primary: true }] }), finish: async id => window.answers.push(id) } };
    });
    await page.route("https://message.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("skin.css")) return route.fulfill({ contentType: "text/css", body: await readFile(path.join(repo, "public/themes/codex-dream-skin/skin.css"), "utf8") });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://message.test/");
    const dialog = page.getByRole("dialog", { name: "连接详情" });
    await dialog.waitFor();
    const themes = ["light", "starlight", "dark", "dream"];
    for (const theme of themes) {
      await page.evaluate(theme => window.changeTheme(theme), theme);
      await page.waitForFunction(theme => (document.documentElement.dataset.theme ?? "light") === theme, theme);
      if (theme === "dream") await page.waitForFunction(() => document.querySelector("link[data-theme-pack]")?.sheet);
      for (const wallpaper of [false, true]) {
        await page.evaluate(wallpaper => {
          document.documentElement.dataset.appBackgroundActive = String(wallpaper);
          document.documentElement.style.setProperty("--app-background-image", "linear-gradient(#ff00ff,#ff00ff)");
          document.documentElement.style.setProperty("--app-background-overlay", "58%");
        }, wallpaper);
        const pixels = await page.screenshot();
        if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
          await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
          await writeFile(path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, `connection-${theme}-${wallpaper ? "wallpaper" : "plain"}.png`), pixels);
        }
        const { data, info } = await sharp(pixels).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const expected = await dialog.evaluate(el => getComputedStyle(el).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number));
        const offset = (10 * info.width + 10) * 4;
        assert.deepEqual([...data.subarray(offset, offset + 3)], expected, `${theme}/${wallpaper}: wallpaper cannot paint over native message content`);
        const contrast = (a, b) => {
          const luminance = values => values.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
          const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
        };
        const controls = await dialog.evaluate(el => [...el.querySelectorAll("h2,p,button")].map(node => {
          const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
          return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom, color: style.color.match(/[\d.]+/g).slice(0, 3).map(Number), background: getComputedStyle(node.tagName === "BUTTON" ? node : el).backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number) };
        }));
        for (const box of controls) {
          assert.ok(contrast(box.color, box.background) >= 4.5, "title, body and button have readable contrast");
          let ink = 0;
          for (let y = Math.max(0, Math.ceil(box.y)); y < Math.min(info.height, Math.floor(box.bottom)); y++) for (let x = Math.max(0, Math.ceil(box.x)); x < Math.min(info.width, Math.floor(box.right)); x++) {
            const index = (y * info.width + x) * 4;
            if (contrast([...data.subarray(index, index + 3)], box.background) >= 3) ink++;
          }
          assert.ok(ink > 8, `${theme}/${wallpaper}: each text control remains visibly painted`);
        }
        assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().bottom <= innerHeight), true, "dialog fits its native window");
        await page.getByRole("button", { name: "确定" }).click();
      }
    }
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(() => window.answers), [...Array(themes.length * 2).fill("done"), null]);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
