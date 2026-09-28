import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("Harmony workspace supports direct input, a unified responsive drawer and fenced control", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-harmony-panel-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "stubs.tsx"), `import {useEffect,useMemo,useState} from "react";export const useI18n=()=>({locale:"zh-CN"});export const useHarmonyLiveFrame=options=>{const[geometryId,setGeometryId]=useState("geometry");window.setFixtureGeometry=setGeometryId;useEffect(()=>{if(!options.enabled)return;const canvas=options.canvasRef.current;if(!canvas)return;canvas.width=1080;canvas.height=2400;const context=canvas.getContext("2d");context.fillStyle="#f7f8fa";context.fillRect(0,0,1080,2400);context.fillStyle="#15181d";context.font="600 92px sans-serif";context.fillText("设置",80,230);context.fillStyle="#e8ebef";for(let y=340;y<2100;y+=250)context.fillRect(65,y,950,180);context.fillStyle="#333942";context.font="48px sans-serif";["无线网络","蓝牙","移动网络","显示和亮度","声音和振动","通知和状态栏","应用和服务"].forEach((text,index)=>context.fillText(text,105,445+index*250));},[options.canvasRef,options.enabled,options.serial]);return useMemo(()=>({status:"live",mode:"video",frame:{width:1080,height:2400,serial:options.serial,generation:options.generation,geometryId},refresh:()=>{}}),[options.serial,options.generation,geometryId])};export const AliIcon=({name})=><span aria-hidden="true" style={{display:"inline-block",fontSize:10,lineHeight:1}}>{name==="mobile"?"▯":"◆"}</span>;export const HarmonyLogViewer=()=>null;export const HarmonyCheckPanel=()=>null;`);
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {SafeHarmonyPanel as HarmonyPanel} from "@/components/workspace/HarmonyPanel";function Fixture(){const[maximized,setMaximized]=useState(false);const[active,setActive]=useState(true);window.setFixtureActive=setActive;window.maximized=maximized;return <HarmonyPanel active={active} maximized={maximized} onMaximizedChange={setMaximized}/>};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const aliases = Object.fromEntries(["@/hooks/useI18n", "@/hooks/useHarmonyLiveFrame", "./HarmonyLogViewer", "./HarmonyCheckPanel"].map(name => [name, path.join(root, "stubs.tsx")]));
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { ...aliases, "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [], requests = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      window.copies = [];
      window.piDesktop = { clipboard: {
        copyHarmonyMedia: async media => { if (window.failMedia) throw Error("clipboard busy"); window.copies.push(media); },
        writeText: async text => { if (window.failPath) throw Error("clipboard busy"); window.copiedPath = text; },
      } };
      window.EventSource = class { close() {} };
    });
    let recording = null, holder = null, delayAcquire = null, rejectAcquire = false, delayTemplate = null;
    let controls = [], rejectedControlStatus = null;
    let phoneName = "HUAWEI Mate 70 Pro";
    const templates = await Promise.all(["launch-and-verify", "chinese-input", "push-to-talk", "long-list", "orientation", "safe-recovery"].map(async id => JSON.parse(await readFile(path.join(repo, "lib/harmony/scenario/templates", `${id}.json`), "utf8"))));
    const screenshot = { kind: "screenshot", path: "C:\\保存目录\\手机截图.png", filename: "手机截图.png", size: 123 };
    const video = { kind: "recording", path: "C:\\保存目录\\手机录屏.mp4", filename: "手机录屏.mp4", size: 456 };
    const bundle = await readFile(path.join(root, "bundle.js"));
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    await page.route("https://harmony-panel.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#f0f0f1;--border:#e4e4e7;--border-soft:#ececef;--text:#18181b;--text-muted:#52525b;--text-dim:#71717a;--accent:#2563eb;--surface-raised:#fafafa;--surface-muted:#f4f4f5;--btn-primary-bg:#18181b;--btn-primary-fg:#fff;--status-ready:#16a34a;--status-attention:#d97706;--status-failed:#dc2626;--control-height:34px;--control-height-compact:30px;--radius-control:8px;--radius-surface:12px;--focus-ring:#93b4ff;--shadow-popover:0 8px 24px rgba(0,0,0,.1);--text-xs:11.5px;--text-sm:12.5px;--text-base:14px;--font-mono:Consolas,monospace}html,body,#root{height:100%;margin:0}body{font:14px system-ui,sans-serif}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      let data = {};
      const input = request.postDataJSON();
      if (input) requests.push({ ...input, endpoint: url.pathname });
      if (url.pathname.endsWith("/profile")) data = { profile: "normal" };
      if (url.pathname.endsWith("/devices")) data = { devices: ["phone", "phone2"].map(serial => ({ serial, name: serial === "phone" ? phoneName : "Second phone", state: "online", generation: 1, capabilities: { screenshot: true, tap: true, swipe: true, keys: true, inputText: true, launchApp: true } })), state: { runtime: { status: "ready" }, leases: holder ? [holder] : [], controls } };
      if (url.pathname.endsWith("/templates") && input && delayTemplate) await delayTemplate;
      if (url.pathname.endsWith("/templates")) data = input ? { steps: [{ action: "launch_app", bundleName: input.parameters.bundleName, abilityName: "EntryAbility" }, { action: "checkpoint", name: "launched" }] } : { templates };
      if (url.pathname.endsWith("/apps")) data = { applications: [{ bundleName: "dev.piora.audio.fixture", label: "Harmony 测试 App", abilities: ["EntryAbility"], source: "bm-label" }] };
      if (url.pathname.endsWith("/scenario")) data = input ? { result: { status: "passed", steps: [{ action: "launch_app", status: "passed" }] } } : { executions: [] };
      if (url.pathname.endsWith("/audio")) data = { outputs: [] };
      if (url.pathname.endsWith("/manual")) {
        if (input?.action === "acquire" && rejectedControlStatus) {
          controls = [{ serial: input.serial, status: rejectedControlStatus }];
          return route.fulfill({ status: 409, json: { error: { code: "DEVICE_BUSY", message: "Device dispatch is blocked while stopping or awaiting cleanup confirmation", details: { state: rejectedControlStatus } } } });
        }
        if (input?.action === "acquire" && rejectAcquire) return route.fulfill({ status: 409, json: { error: { message: "设备忙，请稍后重试" } } });
        if (input?.action === "acquire" && delayAcquire) await delayAcquire;
        if (["acquire", "takeover"].includes(input?.action)) {
          holder = { serial: input.serial, owner: { id: input.ownerId, kind: "manual" }, expiresAt: "2099-01-01T00:00:00Z" };
          data = { lease: { token: "lease", serial: input.serial, expiresAt: "2099-01-01T00:00:00Z" } };
        } else if (input?.action === "release") holder = null;
      }
      if (input?.action === "stop_device") holder = null;
      if (input?.action === "confirm_cleanup") { controls = []; data = { cleanup: "manual-confirmed" }; }
      if (url.pathname.endsWith("/media")) {
        if (input?.action === "capture_screenshot") data = { artifact: screenshot };
        else if (input?.action === "start_recording") { recording = { recordingId: "rec", serial: "phone", ownerId: input.ownerId, startedAt: new Date().toISOString() }; data = { recording }; }
        else if (input?.action === "stop_recording") { recording = null; data = { artifact: video }; }
        else data = { recording };
      }
      return route.fulfill({ json: data });
    });
    await page.goto("https://harmony-panel.test/");
    await page.getByText("可直接点击、滑动", { exact: true }).waitFor();
    const fontBefore = await page.locator(".deviceIdentity select").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => document.documentElement.style.setProperty("--text-base", "20px"));
    const fontAfter = await page.locator(".deviceIdentity select").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(fontAfter > fontBefore * 1.4, "device text follows the configured font scale");
    await page.evaluate(() => document.documentElement.style.removeProperty("--text-base"));
    assert.equal(await page.locator(".toolDrawer").isVisible(), false, "tools start closed");
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/manual").length, 0, "mounting a mirror does not acquire control");
    assert.equal(await page.getByRole("button", { name: /^(手动控制|控制设备|结束控制)$/ }).count(), 0);
    await page.evaluate(() => window.setFixtureGeometry(undefined));
    await page.getByText("正在自动校准点击位置", { exact: true }).waitFor();
    await page.locator("canvas").click();
    assert.equal(requests.some(request => request.action === "tap" || request.action === "acquire"), false, "calibration does not dispatch guessed coordinates or acquire control");
    await page.evaluate(() => window.setFixtureGeometry("geometry"));
    await page.getByText("可直接点击、滑动", { exact: true }).waitFor();
    assert.equal(requests.some(request => request.endpoint === "/api/harmony/approval"), false, "connected phones never poll for Piora approval");
    const beforeTools = await page.locator("canvas").boundingBox();
    assert.ok(beforeTools.height > 600, "the default screen uses the available vertical space");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) { await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true }); await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "default.png") }); }
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("combobox", { name: "测试应用", exact: true }).selectOption("dev.piora.audio.fixture");
    await page.getByRole("button", { name: "运行测试", exact: true }).click();
    await page.getByText("测试通过", { exact: true }).waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "tests.png") });
    const scenario = requests.find(r => r.endpoint === "/api/harmony/scenario");
    assert.equal(scenario.leaseToken, "lease");
    assert.equal(scenario.steps[0].bundleName, "dev.piora.audio.fixture");
    assert.equal(scenario.steps[0].abilityName, "EntryAbility");
    const wideDrawer = await page.locator(".toolDrawer").boundingBox();
    const wideScreen = await page.locator(".screenPane").boundingBox();
    assert.ok(wideDrawer.x >= wideScreen.x + wideScreen.width - 1, "wide panels put the drawer beside the mirror");
    await page.getByRole("button", { name: "关闭工具" }).click();
    assert.equal(await page.locator(".toolDrawer").isVisible(), false);
    await page.getByRole("button", { name: "截图", exact: true }).click();
    await page.getByText("截图已保存并复制到剪贴板", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.copies), [{ kind: "screenshot", path: screenshot.path }]);
    assert.equal(await page.locator(".mediaPath code").textContent(), screenshot.path);
    const fitViewport = await page.locator(".frameViewport").boundingBox();
    const fitCanvas = await page.locator("canvas").boundingBox();
    assert.ok(fitViewport && fitCanvas);
    assert.ok(fitCanvas.width <= fitViewport.width + 1 && fitCanvas.height <= fitViewport.height + 1, "fit mode keeps the whole device screen visible");
    assert.ok(Math.abs(fitCanvas.width / fitCanvas.height - 1080 / 2400) < 0.01, "fit mode preserves the device aspect ratio");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "workspace.png") });
    }
    await page.getByRole("button", { name: "复制路径", exact: true }).click();
    await page.getByRole("button", { name: "路径已复制", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.copiedPath), screenshot.path);
    await page.evaluate(() => { window.failPath = true; });
    await page.getByRole("button", { name: "路径已复制", exact: true }).click();
    await page.getByText("路径复制失败，请重试", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("button", { name: "停止当前设备操作", exact: true }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    rejectAcquire = true;
    await page.locator("canvas").click();
    await page.getByRole("alert").filter({ hasText: "设备忙" }).waitFor();
    assert.equal(requests.some(request => request.action === "tap"), false, "a failed acquisition never dispatches input");
    phoneName = "HUAWEI Mate 70 Pro 已刷新";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.deviceIdentity select').selectedOptions[0].textContent.includes("已刷新"));
    assert.match(await page.getByRole("alert").textContent(), /设备忙/, "a successful device refresh must preserve the operation error until it is dismissed or retried");
    rejectAcquire = false;
    await page.getByRole("button", { name: "关闭提示" }).click();
    const inputCanvas = await page.locator("canvas").boundingBox();
    const [tapRequest] = await Promise.all([page.waitForRequest(request => request.url().endsWith("/action")), page.mouse.click(inputCanvas.x + inputCanvas.width / 2, inputCanvas.y + inputCanvas.height / 2)]);
    const tap = tapRequest.postDataJSON();
    assert.ok(tap); assert.equal(tap.geometryId, "geometry"); assert.equal(tap.coordinateSpace, "frame");
    assert.ok(Math.abs(tap.x - 540) < 2 && Math.abs(tap.y - 1200) < 2);
    await (await tapRequest.response()).finished();
    await page.locator('.frame[data-enabled="true"]').waitFor();
    const swipeRequest = page.waitForRequest(request => request.url().endsWith("/action") && request.postDataJSON()?.action === "swipe");
    await page.mouse.move(inputCanvas.x + inputCanvas.width / 2, inputCanvas.y + inputCanvas.height * .7);
    await page.mouse.down(); await page.mouse.move(inputCanvas.x + inputCanvas.width / 2, inputCanvas.y + inputCanvas.height * .3, { steps: 6 }); await page.mouse.up();
    const swipe = (await swipeRequest).postDataJSON();
    assert.equal(swipe.leaseToken, "lease"); assert.ok(swipe.fromY > swipe.toY);
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.getByRole("button", { name: /停止录屏/ }).click();
    await page.getByText("录屏文件已保存并复制到剪贴板", { exact: true }).waitFor();
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.evaluate(() => { window.failMedia = true; });
    await page.getByRole("button", { name: /停止录屏/ }).click();
    await page.getByText("录屏文件已保存，但复制失败，可重试或复制路径。", { exact: true }).waitFor();
    const mediaRequests = requests.filter(request => ["capture_screenshot", "start_recording", "stop_recording"].includes(request.action));
    assert.ok(mediaRequests.filter(request => request.action === "capture_screenshot").every(request => request.leaseToken === undefined), "passive screenshots do not require control");
    assert.ok(mediaRequests.filter(request => request.action === "start_recording").every(request => request.leaseToken === "lease"), "recording requires the current control lease");
    assert.equal(await page.locator(".mediaPath code").textContent(), video.path);
    await page.evaluate(() => { window.failMedia = false; });
    await page.getByRole("button", { name: "重新复制", exact: true }).click();
    await page.getByText("录屏文件已保存并复制到剪贴板", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.copies.length), 3);
    await page.getByRole("combobox", { name: "画面缩放" }).selectOption("150");
    assert.equal(await page.getByRole("combobox", { name: "画面缩放" }).inputValue(), "150");
    assert.equal(await page.locator("canvas").evaluate(canvas => canvas.style.width), "1620px");
    await page.getByRole("button", { name: "专注投屏" }).click();
    assert.equal(await page.evaluate(() => window.maximized), true);
    await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("combobox", { name: "画面缩放" }).selectOption("fit");
    await page.getByRole("button", { name: "输入文字", exact: true }).click();
    await page.getByRole("textbox", { name: "输入到手机" }).fill("你好，鸿蒙");
    await page.getByRole("button", { name: "发送到手机" }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="输入到手机"]').value === "");
    assert.ok(requests.some(r => r.action === "input_text" && r.text === "你好，鸿蒙" && r.leaseToken === "lease"));
    await page.getByRole("button", { name: "关闭输入" }).click();
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("tab", { name: "语音", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "在所选输出预览语料", exact: true }).isEnabled(), false);
    await page.getByRole("tab", { name: "测试", exact: true }).click();
    await page.getByText("测试通过", { exact: true }).waitFor();
    // Stop fences old async preparation too: it cannot acquire a new lease after compilation completes.
    let resolveTemplate;
    delayTemplate = new Promise(resolve => { resolveTemplate = resolve; });
    const scenarioCount = requests.filter(r => r.endpoint === "/api/harmony/scenario").length;
    const compileRequest = page.waitForRequest(request => request.url().endsWith("/templates") && request.method() === "POST");
    await page.getByRole("button", { name: "运行测试", exact: true }).click(); await compileRequest;
    await page.getByRole("button", { name: "停止设备任务", exact: true }).click();
    resolveTemplate(); delayTemplate = null;
    await page.getByRole("alert").filter({ hasText: "设备状态已改变" }).waitFor();
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/scenario").length, scenarioCount);
    await page.getByRole("tab", { name: "测试", exact: true }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "语音", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "语音", exact: true }).press("Escape");
    assert.equal(await page.getByRole("button", { name: "工具", exact: true }).evaluate(button => button === document.activeElement), true);
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await page.getByRole("button", { name: "按键与触摸校准", exact: true }).click();
    await page.getByRole("combobox", { name: "按键", exact: true }).selectOption("power");
    await page.getByText("将本次校准保存为助手入口（可选）", { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.locator("#root").evaluate(root => root.scrollWidth > root.clientWidth), false);
    const bottomDrawer = await page.locator(".toolDrawer").boundingBox();
    assert.ok(bottomDrawer.width <= 360 && bottomDrawer.y > 300, "narrow panels show a bottom drawer with the mirror still visible");
    await page.getByRole("button", { name: "返回测试", exact: true }).click();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "workspace-narrow.png") });
    await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    // Cleanup state belongs to the selected phone; normal completion restores controls automatically.
    controls = [{ serial: "phone2", status: "recovering" }];
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), true);
    controls = [{ serial: "phone", status: "stopping" }];
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("正在停止设备操作，请稍候…", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), false);
    assert.equal(await page.locator(".frame").getAttribute("data-enabled"), "false");
    controls = [];
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("可直接点击、滑动", { exact: true }).waitFor();
    assert.equal(requests.some(r => r.action === "confirm_cleanup"), false, "completed cleanup needs no human confirmation");
    // A server-side state change between polls receives a readable error and refreshes admission.
    rejectedControlStatus = "recovering";
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "上次设备操作的清理尚未确认" }).waitFor();
    await page.getByText("设备清理尚未确认，暂不能操作或开始录屏", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), false);
    rejectedControlStatus = null;
    await page.getByRole("button", { name: "检查并恢复", exact: true }).click();
    await page.getByText("恢复清理不确定的设备", { exact: true }).click();
    assert.equal(requests.some(r => r.action === "confirm_cleanup"), false, "opening diagnostics never confirms physical release");
    await page.getByRole("button", { name: "已检查手机并确认释放", exact: true }).click();
    await page.getByText("设备已恢复，可重新操作或录屏。", { exact: true }).waitFor();
    await page.getByText("可直接点击、滑动", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "关闭工具" }).click();
    // An Agent holder requires deliberate takeover, never a side effect of displaying the screen.
    holder = { serial: "phone", owner: { id: "agent:one", kind: "agent" }, expiresAt: "2099-01-01T00:00:00Z" };
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("AI 正在操作", { exact: true }).waitFor();
    const previousActions = requests.filter(r => r.action === "tap").length;
    await page.locator("canvas").click();
    assert.equal(requests.filter(r => r.action === "tap").length, previousActions);
    await page.getByRole("button", { name: "停止并接管", exact: true }).click();
    await page.waitForFunction(() => !document.body.innerText.includes("AI 正在操作"));
    assert.ok(requests.some(r => r.action === "takeover" && r.confirmed === true && r.serial === "phone"));
    await page.getByRole("button", { name: "停止当前设备操作", exact: true }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    // Changing phones while control acquisition is pending must release the old lease and drop the tap.
    let resolveAcquire;
    delayAcquire = new Promise(resolve => { resolveAcquire = resolve; });
    const pendingRequest = page.waitForRequest(request => request.url().endsWith("/manual") && request.postDataJSON()?.action === "acquire");
    await page.locator("canvas").click(); await pendingRequest;
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone2");
    const released = page.waitForRequest(request => request.url().endsWith("/manual") && request.postDataJSON()?.action === "release");
    resolveAcquire(); delayAcquire = null; await released;
    await page.getByRole("alert").filter({ hasText: "设备状态已改变" }).waitFor();
    assert.equal(requests.filter(r => r.action === "tap").length, previousActions);
    assert.equal(requests.some(r => /unlock|wake|initialize_mirror/.test(r.action ?? "")), false, "neither passive viewing nor direct-input setup wakes, unlocks or initializes the phone");
    await page.getByRole("button", { name: "关闭提示" }).click();
    // Hiding the panel while a request is in flight also drops the input, even on the same phone.
    delayAcquire = new Promise(resolve => { resolveAcquire = resolve; });
    const hiddenRequest = page.waitForRequest(request => request.url().endsWith("/manual") && request.postDataJSON()?.action === "acquire");
    await page.locator("canvas").click(); await hiddenRequest;
    await page.evaluate(() => window.setFixtureActive(false));
    const hiddenRelease = page.waitForRequest(request => request.url().endsWith("/manual") && request.postDataJSON()?.action === "release");
    resolveAcquire(); delayAcquire = null; await hiddenRelease;
    await page.getByRole("alert").filter({ hasText: "设备状态已改变" }).waitFor();
    assert.equal(requests.filter(r => r.action === "tap").length, previousActions);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
