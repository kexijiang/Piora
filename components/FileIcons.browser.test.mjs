import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { BROWSER_LOGIN_STATE_SCRIPT } = await createJiti(import.meta.url).import("../desktop/src/browser-login.ts");

test("Material icons render distinct file/folder silhouettes in both app themes; login probe ignores hidden remnants", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-file-icons-"));
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "entry.tsx"), `import {createRoot} from 'react-dom/client';import {FolderIcon,getFileIcon} from '@/components/FileIcons';
      const files=['index.ts','App.tsx','main.js','package.json','README.md','style.css','index.html','worker.py','config.yml','run.ps1','main.rs','main.go','schema.sql','logo.svg','guide.pdf','.gitignore','Cargo.toml','unknown.xyz'];
      const folders=['workspace','src','lib','app','node_modules','__tests__','.git','.github','config','dist','components','docs','public','assets'];
      createRoot(document.getElementById('root')).render(<main><h1>文件</h1><section>{files.map(name=><div className="row" key={name}>{getFileIcon(name,16)}<span>{name}</span></div>)}</section><section>{folders.map(name=><div className="row" key={name}><FolderIcon name={name} size={16}/><span>{name}</span><FolderIcon name={name} size={16} open/></div>)}</section></main>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 760, height: 800 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://icons.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, "bundle.js")) });
      if (pathname === "/file-icons/material.svg") return route.fulfill({ contentType: "image/svg+xml", body: await readFile(path.join(repo, "public", pathname)) });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}body{margin:0;background:var(--bg-panel);color:var(--text);font-family:Arial,sans-serif}main{margin:30px auto;padding:24px;width:620px;background:var(--bg);border:1px solid var(--border);border-radius:12px;display:grid;grid-template-columns:1fr 1fr;gap:0 24px}h1{grid-column:span 2;font-size:20px;margin:0 0 18px}.row{display:flex;align-items:center;gap:10px;height:30px;font-size:14px}.row span{flex:1}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    const spriteResponse = page.waitForResponse(response => response.url().endsWith("/file-icons/material.svg"));
    await page.goto("http://icons.test/");
    assert.equal((await spriteResponse).status(), 200);
    await page.locator('[data-file-icon="typescript"]').waitFor();
    for (const icon of ["typescript", "react_ts", "javascript", "markdown", "image", "pdf", "git", "folder-src", "folder-src-open", "folder-node", "folder-test", "folder-git", "folder-config", "folder-dist"]) assert.ok(await page.locator(`[data-file-icon="${icon}"]`).count(), icon);
    assert.equal(await page.locator(".material-file-icon").evaluateAll(icons => icons.every(icon => icon.getBoundingClientRect().width === 16 && icon.getAttribute("aria-hidden") === "true")), true);
    const output = path.join(repo, ".verification/file-icons"); await mkdir(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "light.png") });
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    assert.equal(await page.locator('[data-file-icon="toml"] .material-icon-light').isVisible(), false);
    assert.equal(await page.locator('[data-file-icon="toml"] .material-icon-dark').isVisible(), true);
    await page.screenshot({ path: path.join(output, "dark.png") });
    assert.deepEqual(errors, []);

    await page.setContent('<form><input autocomplete="username"><input type="password"><button>Sign in</button></form><div hidden><button>Log out</button><input type="password"><div>安全验证 captcha</div></div>');
    let probe = await page.evaluate(BROWSER_LOGIN_STATE_SCRIPT);
    assert.equal(probe.loginVisible, true); assert.equal(probe.authenticated, false);
    await page.locator('form').evaluate(form => form.remove());
    probe = await page.evaluate(BROWSER_LOGIN_STATE_SCRIPT);
    assert.equal(probe.loginVisible, false); assert.equal(probe.authenticated, false, "hidden legacy controls cannot assert sign-in");
    await page.evaluate(() => { const button = document.createElement('button'); button.textContent = 'Log out'; document.body.append(button); });
    probe = await page.evaluate(BROWSER_LOGIN_STATE_SCRIPT);
    assert.equal(probe.authenticated, true);
    assert.deepEqual(Object.keys(probe).sort(), ["authenticated", "loginVisible", "ready", "url"]);
  } finally { await browser?.close(); await rm(directory, { recursive: true, force: true }); }
});
