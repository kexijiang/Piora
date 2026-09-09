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

test("background mode defaults off, hides the native view, runs directly and persists selection", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-browser-mode-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "entry.tsx"), `import {createRoot} from "react-dom/client";import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {BrowserPanel} from ${JSON.stringify(path.join(repo, "components/workspace/BrowserPanel.tsx"))};createRoot(document.getElementById("root")).render(<I18nProvider><BrowserPanel active={true} maximized={false} sessionId="test-session"/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://browser-mode.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = await readFile(path.join(repo, "components/workspace/WorkspacePanel.module.css"), "utf8");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 600, height: 750 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      localStorage.setItem("piora-desktop-browser-onboarding-v1", "done");
      window.nativeViewports = [];
      const state = { sessionId: "test-session", activeTabId: "native-tab", url: "https://native.test/", title: "Native", tabs: [{ id: "native-tab", title: "Native", url: "https://native.test/" }], canGoBack: false, canGoForward: false, loading: false };
      window.piDesktop = { browser: {
        setViewport: async (bounds, visible) => { window.nativeViewports.push({ ...bounds, visible }); },
        action: async () => state, getState: async () => state,
        onState: () => () => {}, onDownload: () => () => {},
        importChromeBookmarks: async () => ({ bookmarkCount: 0, profiles: [] }),
      } };
    });
    let mode = "builtin", connects = 0;
    const actions = [];
    const state = { ready: true, revision: 1, title: "Chrome signed-in page", url: "https://chrome.test/account", viewport: { width: 1280, height: 800 }, cursor: "default", activeTabIndex: 0, tabs: [{ index: 0, title: "Chrome signed-in page", url: "https://chrome.test/account" }] };
    await page.route("http://browser-mode.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/browser/settings") {
        if (route.request().method() === "PUT") mode = route.request().postDataJSON().mode;
        if (route.request().method() === "POST") { connects++; return route.fulfill({ status: 405 }); }
        return route.fulfill({ json: { mode } });
      }
      if (url.pathname === "/api/browser") { if (route.request().method() === "POST") actions.push(route.request().postDataJSON()); return route.fulfill({ json: state }); }
      if (url.pathname === "/api/browser/screenshot") return route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64") });
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><style>:root{--text-xs:11px;--text-sm:13px;--text-base:14px;--radius-control:6px}*{box-sizing:border-box}body{margin:0;font:14px system-ui}#root{height:100vh}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("http://browser-mode.test/");
    await page.locator('[data-native-browser="true"]').waitFor();
    const toggle = page.getByRole("switch", { name: "使用后台浏览器" });
    assert.equal(await toggle.isChecked(), false);
    await toggle.click(); // The controlled switch settles after its save request.
    await page.getByText("Chrome signed-in page", { exact: true }).waitFor();
    assert.equal(mode, "background");
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.locator('[data-native-browser="true"]').count(), 0);
    await page.waitForFunction(() => window.nativeViewports.some((viewport) => viewport.visible === false));
    assert.equal(connects, 0, "background mode runs directly without a connection prompt");
    await page.waitForTimeout(200);
    assert.equal(actions.some((action) => action.action === "resize"), true, "background viewport follows the panel size");
    await page.reload();
    await page.getByText("Chrome signed-in page", { exact: true }).waitFor();
    assert.equal(await toggle.isChecked(), true);
    assert.equal(connects, 0);
    await toggle.click();
    await page.locator('[data-native-browser="true"]').waitFor();
    assert.equal(mode, "builtin");
    assert.equal(await toggle.isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(root, { recursive: true, force: true }); }
});
