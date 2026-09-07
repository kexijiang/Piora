// Uses an isolated, hidden Electron window and the production transparency guard.
// No packaged build or personal desktop profile is touched.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import ts from "typescript";
import sharp from "sharp";
const output = resolve(".verification/companion-transparency");
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), "piora-alpha-test-"));
const guardPath = join(output, "guard.cjs");
await writeFile(guardPath, ts.transpileModule(await readFile("desktop/src/transparent-companion.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText);
const mainPath = join(output, "main.cjs");
await writeFile(mainPath, `const { app, BrowserWindow } = require('electron');
const { protectTransparentCompanion } = require(${JSON.stringify(guardPath)});
app.setPath('userData', ${JSON.stringify(profile)});
app.whenReady().then(() => {
  const win = new BrowserWindow({width:156,height:184,show:false,frame:false,transparent:true,resizable:false,backgroundMaterial:'none',backgroundColor:'#00000000',hasShadow:false,webPreferences:{sandbox:true,backgroundThrottling:false}});
  protectTransparentCompanion(win);
  win.loadURL(${JSON.stringify((process.argv[2] || "http://127.0.0.1:30141") + "/desktop-pet")});
});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const require = createRequire(new URL("../desktop/package.json", import.meta.url));
const app = await electron.launch({ executablePath: require("electron"), args: [mainPath], env, timeout: 60000 });
try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 });
  // did-finish-load installs the same user-origin guard used by production.
  await page.waitForLoadState("load", { timeout: 60000 });
  // Windows does not reliably paint a never-shown native window. Show without
  // taking focus so this checks real compositor output rather than a blank bitmap.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  for (const theme of ["light", "dark", "wallpaper", "theme-override"]) {
    await page.evaluate((theme) => {
      const root = document.documentElement;
      root.dataset.theme = theme === "light" ? "light" : "dark";
      root.classList.toggle("dark", theme !== "light"); root.style.colorScheme = theme === "light" ? "light" : "dark";
      root.dataset.appBackgroundActive = String(theme === "wallpaper");
      if (theme === "theme-override") { const style = document.createElement("style"); style.textContent = "html body { background: black !important; color-scheme: dark !important } body::before {content:''!important;display:block!important;position:fixed;inset:0;background:black!important}"; document.head.append(style); }
      let marker = document.getElementById("alpha-marker");
      if (!marker) { marker = document.createElement("div"); marker.id = "alpha-marker"; document.body.append(marker); }
      marker.style.cssText = "position:fixed;left:70px;top:80px;width:8px;height:8px;background:rgb(255,0,0);z-index:2147483647";
    }, theme);
    await page.waitForTimeout(300);
    const base64 = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString("base64"));
    const buffer = Buffer.from(base64, "base64");
    await writeFile(join(output, `${theme}.png`), buffer);
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = (x, y) => data[(y * info.width + x) * 4 + 3];
    for (const [x, y] of [[0, 0], [info.width - 1, 0], [0, info.height - 1], [info.width - 1, info.height - 1]]) assert.equal(alpha(x, y), 0, `${theme}: native corner alpha must be zero`);
    assert.ok(data.some((value, index) => index % 4 === 3 && value === 255), `${theme}: capture must contain painted pixels`);
    console.log(`PASS: ${theme}, native Electron alpha=0 at all four corners`);
  }
} finally { await app.close(); }
