import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import sharp from "sharp";
import { buildClipboardUI } from "./clipboard-ui-fixture.mjs";
import { setup } from "./clipboard-test-data.mjs";

test("standalone clipboard text, images and actions retain their painted colors above wallpaper", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clipboard-background-"));
  const repo = path.resolve(import.meta.dirname, "..");
  const output = path.join(repo, ".verification/clipboard-background");
  let browser;
  try {
    await mkdir(output, { recursive: true });
    const { bundle, css } = await buildClipboardUI(directory);
    const globalCss = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    const backgroundCss = await readFile(path.join(repo, "app/theme-backgrounds.css"), "utf8");
    const sample = await sharp({ create: { width: 120, height: 84, channels: 3, background: "#b6315f" } }).png().toBuffer();
    const fixture = `${setup};window.entries=window.entries.slice(0,2);window.entries.forEach((entry,i)=>entry.shelfOrder=i);Object.assign(window.entries[1],{kind:'image',title:'剪贴板图片',preview:'PNG 图片',image:{width:120,height:84}});`;
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 760, height: 540 } });
    await page.route("https://clipboard-background.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (pathname === "/sample.png") return route.fulfill({ contentType: "image/png", body: sample });
      if (pathname.startsWith("/fonts/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(repo, "public", pathname)) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${globalCss}${backgroundCss}${css}body{margin:0}</style><div id="root"></div><script>${fixture}</script><script src="/bundle.js"></script>` });
    });
    for (const surface of ["quick", "shelf"]) {
      await page.goto(`https://clipboard-background.test/?surface=${surface}`);
      const list = page.getByRole("listbox");
      const textRow = list.getByRole("option").filter({ hasText: "产品说明" });
      const imageRow = list.getByRole("option").filter({ hasText: "剪贴板图片" });
      await textRow.waitFor();
      await imageRow.locator("img").evaluate(img => img.decode());
      await page.evaluate(() => document.fonts.ready);
      const regions = [textRow.locator("strong"), textRow.locator("small"), imageRow.locator("img"), page.getByRole("button", { name: "复制", exact: true })];
      for (const theme of ["light", "cloud-bear", "dark"]) {
        await page.evaluate(theme => {
          const root = document.documentElement;
          root.classList.toggle("dark", theme === "dark");
          root.dataset.theme = theme;
          root.dataset.appBackgroundActive = "false";
          root.style.setProperty("--app-background-image", "linear-gradient(#ff00ff,#ff00ff)");
          root.style.setProperty("--app-background-overlay", "58%");
        }, theme);
        const colors = async () => {
          const captures = [];
          for (const [index, region] of regions.entries()) {
            let pixels = sharp(await region.screenshot({ animations: "disabled" }));
            if (index === 2) {
              // Rounded corners contain compositor-dependent antialiasing;
              // object-fit:contain also adds letterboxing on the shelf. Sample
              // the opaque image interior against baseline and source RGB.
              const { width, height } = await pixels.metadata();
              const scale = Math.min(width / 120, height / 84);
              pixels = pixels.extract({ left: Math.ceil((width - 120 * scale) / 2) + 8, top: Math.ceil((height - 84 * scale) / 2) + 8, width: Math.floor(120 * scale) - 16, height: Math.floor(84 * scale) - 16 });
            }
            captures.push(await pixels.removeAlpha().raw().toBuffer());
          }
          return captures;
        };
        const baseline = await colors();
        await page.evaluate(() => { document.documentElement.dataset.appBackgroundActive = "true"; });
        const wallpaper = await colors();
        for (let i = 0; i < baseline.length; i++) assert.equal(Buffer.compare(wallpaper[i], baseline[i]), 0, `${surface}/${theme}: region ${i} must not be washed out by wallpaper`);
        for (const pixels of [baseline[2], wallpaper[2]]) {
          assert.equal(pixels.findIndex((value, index) => value !== [182, 49, 95][index % 3]), -1, `${surface}/${theme}: opaque thumbnail pixels must retain the exact source RGB`);
        }
        if (theme === "light") {
          // Negative control: the former stacking order must reproduce the
          // regression, so successful comparisons cannot hide a broken fixture.
          await page.locator('.workspace').evaluate(element => { element.style.zIndex = "auto"; });
          const covered = await colors();
          assert.notEqual(Buffer.compare(covered[0], baseline[0]), 0, `${surface}: the old stacking order must cover text`);
          assert.notEqual(Buffer.compare(covered[2], baseline[2]), 0, `${surface}: the old stacking order must cover images`);
          await page.locator('.workspace').evaluate(element => { element.style.zIndex = ""; });
        }
        await page.screenshot({ path: path.join(output, `${surface}-${theme}.png`) });
      }
      await page.getByRole("button", { name: "复制", exact: true }).click();
      await page.waitForFunction(() => window.commands.some(command => command.type === "copy" && command.ids[0] === "row-0"));
    }
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
