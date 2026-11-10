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

async function verifyHiddenPolling(page, requests) {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Allow already-dispatched responses/images to settle before counting.
  await page.waitForTimeout(200);
  const hiddenCount = requests.length;
  await page.waitForTimeout(1900);
  assert.equal(requests.length, hiddenCount, "hidden previews must stop state and screenshot requests");
  const resumed = page.waitForRequest(request => new URL(request.url()).pathname === "/api/browser");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await resumed;
}

test("browser switch follows the selected Agent read-only and preserves independent browsing", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-browser-isolation-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
    await writeFile(path.join(root, "entry.tsx"), `import {useState} from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {BrowserPanel} from ${JSON.stringify(path.join(repo, "components/workspace/BrowserPanel.tsx"))};function Harness(){const [sessionId,setSessionId]=useState("test-session");window.selectBrowserSession=setSessionId;return <I18nProvider><div id="browser-panel" style={{height:500}}><BrowserPanel active={true} maximized={false} sessionId={sessionId}/></div></I18nProvider>}createRoot(document.getElementById("root")).render(<Harness/>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js", publicPath: "http://browser-isolation.test/" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = await readFile(path.join(repo, "components/workspace/WorkspacePanel.module.css"), "utf8");
    const documentBody = `<!doctype html><style>:root{--text-xs:11px;--text-sm:13px;--text-base:14px;--radius-control:6px}*{box-sizing:border-box}body{margin:0;font:14px system-ui}#root{height:100vh}${css}</style><div id="root"></div><script src="/bundle.js"></script>`;
    const state = { ready: true, revision: 1, title: "Independent browser page", url: "https://manual.test/account", viewport: { width: 1280, height: 800 }, cursor: "default", activeTabIndex: 0, tabs: [{ index: 0, title: "Independent browser page", url: "https://manual.test/account" }] };
    const agentState = { ...state, title: "Agent working page", url: "https://agent.test/research", tabs: [{ index: 0, title: "Agent working page", url: "https://agent.test/research" }] };
    const otherAgentState = { ...state, title: "Another Agent page", url: "https://other-agent.test/", tabs: [{ index: 0, title: "Another Agent page", url: "https://other-agent.test/" }] };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
    const serveBundle = async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: documentBody });
    };

    browser = await chromium.launch({ channel: "msedge", headless: true });
    const desktopPage = await browser.newPage({ viewport: { width: 600, height: 750 } });
    const desktopErrors = [];
    const desktopApiRequests = [];
    desktopPage.on("pageerror", (error) => desktopErrors.push(error.message));
    desktopPage.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith("/api/browser")) desktopApiRequests.push(request.url());
    });
    await desktopPage.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      localStorage.setItem("piora-desktop-browser-onboarding-v1", "done");
      window.nativeActions = [];
      window.nativeViewports = [];
      const nativeState = { sessionId: "test-session", activeTabId: "native-tab", url: "https://native.test/", title: "Native", tabs: [{ id: "native-tab", title: "Native", url: "https://native.test/" }], canGoBack: false, canGoForward: false, loading: false };
      window.setNativeCapacity = (patch) => { Object.assign(nativeState, patch); window.nativeStateListener?.({ ...nativeState }); };
      window.piDesktop = { browser: {
        setViewport: async (bounds, visible) => { window.nativeViewports.push({ ...bounds, visible }); },
        action: async (input) => { window.nativeActions.push(input); if (input.action === "close_idle_tabs") Object.assign(nativeState, { tabCount: 19, idleTabCount: 0 }); return { ...nativeState }; },
        getState: async () => nativeState,
        onState: (listener) => { window.nativeStateListener = listener; return () => { window.nativeStateListener = null; }; }, onDownload: () => () => {},
        importChromeBookmarks: async () => ({ bookmarkCount: 0, profiles: [] }),
        showBookmarkMenu: async () => null,
      } };
    });
    await desktopPage.route("http://browser-isolation.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/browser" && url.searchParams.get("sessionId") === "test-session") return route.fulfill({ json: agentState });
      if (url.pathname === "/api/browser" && url.searchParams.get("sessionId") === "other-session") return route.fulfill({ json: otherAgentState });
      if (url.pathname === "/api/browser/screenshot" && url.searchParams.get("sessionId") === "test-session") return route.fulfill({ contentType: "image/png", body: png });
      if (url.pathname === "/api/browser/screenshot" && url.searchParams.get("sessionId") === "other-session") return route.fulfill({ contentType: "image/png", body: png });
      return serveBundle(route);
    });
    await desktopPage.goto("http://browser-isolation.test/");
    await desktopPage.locator('[data-native-browser="true"]').waitFor();
    assert.equal(await desktopPage.getByRole("switch", { name: "跟随 Agent 浏览器" }).getAttribute("aria-checked"), "false");
    assert.equal(desktopApiRequests.length, 0, "the desktop panel must not call the background-browser API");
    assert.deepEqual(await desktopPage.evaluate(() => window.nativeActions), [{ action: "set_session", sessionId: "test-session" }]);
    await desktopPage.evaluate(() => window.setNativeCapacity({ tabCount: 20, tabLimit: 20, idleTabCount: 0 }));
    await desktopPage.getByText(/所有会话共用的 20 个标签页已满/).waitFor();
    assert.equal(await desktopPage.getByRole("button", { name: "新建标签页", exact: true }).isEnabled(), false);
    await desktopPage.evaluate(() => window.setNativeCapacity({ idleTabCount: 1 }));
    assert.equal(await desktopPage.getByRole("button", { name: "新建标签页", exact: true }).isEnabled(), true);
    await desktopPage.getByRole("button", { name: "清理闲置智能体标签", exact: true }).click();
    await desktopPage.waitForFunction(() => !document.querySelector('button[aria-label="新建标签页"]').disabled);
    assert.equal(await desktopPage.getByText(/所有会话共用的 20 个标签页已满/).count(), 0);
    assert.equal(await desktopPage.getByRole("button", { name: "清理闲置智能体标签", exact: true }).isEnabled(), false);
    assert.deepEqual(await desktopPage.evaluate(() => window.nativeActions.at(-1)), { action: "close_idle_tabs" });
    await desktopPage.getByRole("switch", { name: "跟随 Agent 浏览器" }).click();
    await desktopPage.getByText("Agent working page", { exact: true }).waitFor();
    assert.equal(await desktopPage.locator('[data-native-browser="true"]').count(), 0, "the native view unmounts while following the Agent");
    await desktopPage.waitForFunction(() => window.nativeViewports.at(-1)?.visible === false);
    assert.equal(await desktopPage.getByRole("textbox").count(), 0, "Agent pages are view-only");
    assert.ok(desktopApiRequests.every((url) => new URL(url).searchParams.get("sessionId") === "test-session"));
    await verifyHiddenPolling(desktopPage, desktopApiRequests);
    await desktopPage.evaluate(() => window.selectBrowserSession("other-session"));
    await desktopPage.getByText("Another Agent page", { exact: true }).waitFor();
    assert.equal(await desktopPage.getByText("Agent working page", { exact: true }).count(), 0, "the old task is never shown after switching tasks");
    await desktopPage.reload();
    await desktopPage.getByText("Agent working page", { exact: true }).waitFor();
    assert.equal(await desktopPage.getByRole("switch").getAttribute("aria-checked"), "true", "the switch survives a reload");
    await desktopPage.getByRole("switch").click();
    await desktopPage.locator('[data-native-browser="true"]').waitFor();
    assert.equal(await desktopPage.getByRole("switch").getAttribute("aria-checked"), "false");

    const fallbackPage = await browser.newPage({ viewport: { width: 600, height: 750 } });
    const fallbackErrors = [];
    const fallbackRequests = [];
    let agentReady = false;
    fallbackPage.on("pageerror", (error) => fallbackErrors.push(error.message));
    await fallbackPage.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    await fallbackPage.route("http://browser-isolation.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/browser") {
        fallbackRequests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postDataJSON?.() });
        return route.fulfill({ json: url.searchParams.get("sessionId") === "test-session" ? (agentReady ? agentState : null) : state });
      }
      if (url.pathname === "/api/browser/screenshot") {
        fallbackRequests.push({ url: route.request().url(), method: route.request().method() });
        return route.fulfill({ contentType: "image/png", body: png });
      }
      return serveBundle(route);
    });
    await fallbackPage.goto("http://browser-isolation.test/");
    await fallbackPage.getByText("Independent browser page", { exact: true }).waitFor();
    await fallbackPage.waitForTimeout(200);
    assert.equal(await fallbackPage.locator('[data-native-browser="true"]').count(), 0);
    assert.equal(await fallbackPage.getByRole("switch").getAttribute("aria-checked"), "false");
    assert.ok(fallbackRequests.length > 0);
    assert.equal(fallbackRequests.some((request) => request.url.includes("sessionId=") || request.body?.sessionId), false, "independent mode never reuses an Agent session");
    await verifyHiddenPolling(fallbackPage, fallbackRequests);
    await fallbackPage.getByRole("switch").click();
    await fallbackPage.getByText("Agent 尚未打开浏览器页面").waitFor();
    agentReady = true;
    await fallbackPage.getByText("Agent working page", { exact: true }).waitFor();
    assert.equal(await fallbackPage.getByRole("textbox").count(), 0);
    assert.ok(fallbackRequests.some((request) => new URL(request.url).searchParams.get("sessionId") === "test-session"));
    assert.equal(fallbackRequests.filter((request) => new URL(request.url).searchParams.has("sessionId")).every((request) => request.method === "GET"), true, "Agent mode only reads browser state and screenshots");
    await fallbackPage.getByRole("switch").click();
    await fallbackPage.getByText("Independent browser page", { exact: true }).waitFor();
    assert.deepEqual(desktopErrors, []);
    assert.deepEqual(fallbackErrors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
