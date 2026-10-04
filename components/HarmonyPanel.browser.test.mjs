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

test("Harmony workspace keeps the mirror view-only with a responsive drawer and fenced tool control", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-harmony-panel-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(root, "stubs.tsx"), `import {useEffect,useMemo,useState} from "react";import {zhCNLocale} from "@/lib/i18n/messages/zh-CN";import {interpolateMessage} from "@/lib/i18n/format";export const useI18n=()=>({locale:"zh-CN",t:(key,params)=>interpolateMessage(zhCNLocale.messages[key]??key,params)});export const useHarmonyLiveFrame=options=>{const[geometryId,setGeometryId]=useState("geometry");window.setFixtureGeometry=setGeometryId;const[frameMode,setFrameMode]=useState("video");window.setFixtureFrameMode=setFrameMode;useEffect(()=>{if(!options.enabled)return;const canvas=options.canvasRef.current;if(!canvas)return;canvas.width=1080;canvas.height=2400;const context=canvas.getContext("2d");context.fillStyle="#f7f8fa";context.fillRect(0,0,1080,2400);context.fillStyle="#15181d";context.font="600 92px sans-serif";context.fillText("设置",80,230);context.fillStyle="#e8ebef";for(let y=340;y<2100;y+=250)context.fillRect(65,y,950,180);context.fillStyle="#333942";context.font="48px sans-serif";["无线网络","蓝牙","移动网络","显示和亮度","声音和振动","通知和状态栏","应用和服务"].forEach((text,index)=>context.fillText(text,105,445+index*250));},[options.canvasRef,options.enabled,options.serial]);return useMemo(()=>({status:"live",mode:frameMode,frame:{width:1080,height:2400,serial:options.serial,generation:options.generation,geometryId},refresh:()=>{}}),[options.serial,options.generation,geometryId,frameMode])};export const AliIcon=({name})=><span aria-hidden="true" style={{display:"inline-block",fontSize:10,lineHeight:1}}>{name==="mobile"?"▯":"◆"}</span>;export const HarmonyLogViewer=()=>null;export const HarmonyCheckPanel=()=>null;`);
    await writeFile(path.join(root, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {flushSync} from "react-dom";import {AppTooltip} from "@/components/AppTooltip";import {ShortcutSettings} from "@/components/ShortcutSettings";import {SafeHarmonyPanel as HarmonyPanel} from "@/components/workspace/HarmonyPanel";function Fixture(){const[maximized,setMaximized]=useState(false);const[active,setActive]=useState(true);const[tooltips,setTooltips]=useState(false);const[shortcuts,setShortcuts]=useState(false);window.setFixtureShortcuts=setShortcuts;window.setFixtureTooltips=setTooltips;window.setFixtureActive=value=>flushSync(()=>setActive(value));window.maximized=maximized;return <>{shortcuts?<div role="dialog" aria-modal="true" style={{position:"fixed",inset:0,zIndex:2000,overflow:"auto",background:"white"}}><ShortcutSettings/></div>:null}{tooltips?<AppTooltip/>:null}<HarmonyPanel active={active} maximized={maximized} onMaximizedChange={setMaximized}/></>};createRoot(document.getElementById("root")).render(<Fixture/>);`);
    const aliases = Object.fromEntries(["@/hooks/useI18n", "@/hooks/useHarmonyLiveFrame", "./HarmonyLogViewer", "./HarmonyCheckPanel"].map(name => [name, path.join(root, "stubs.tsx")]));
    const compiler = webpack({ mode: "development", target: "web", devtool: false,
      entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { ...aliases, "@": repo } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }, { test: /\.css$/, use: path.join(root, "css.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const errors = [], requests = [], nativeDialogs = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("dialog", async dialog => { nativeDialogs.push(dialog.type()); await dialog.dismiss(); });
    await page.addInitScript(() => {
      window.copies = [];
      window.piDesktop = { files: { getPathForFile: file => file.name === "dragged.txt" ? "C:\\workspace\\dragged.txt" : "" }, clipboard: {
        copyHarmonyMedia: async media => { if (window.failMedia) throw Error("clipboard busy"); window.copies.push(media); },
        writeText: async text => { if (window.failPath) throw Error("clipboard busy"); window.copiedPath = text; },
      } };
      window.EventSource = class { close() {} };
    });
    let recording = null, holder = null, delayTemplate = null, rejectRecording = false, textPreviewReads = 0;
    const recordingPairs = [];
    let largeFileParent = false, delayedTextPreview = null, releaseTextPreview, databaseReadDelay = null;
    let controls = [], rejectedControlStatus = null;
    let phoneName = "HUAWEI Mate 70 Pro";
    let connectionSample = { durationMs: 17.4, sampledAt: new Date().toISOString() }, phoneTransport = "usb", phoneState = "online", phoneIssue;
    const templates = await Promise.all(["launch-and-verify", "chinese-input", "push-to-talk", "long-list", "orientation", "safe-recovery"].map(async id => JSON.parse(await readFile(path.join(repo, "lib/harmony/scenario/templates", `${id}.json`), "utf8"))));
    const screenshot = { kind: "screenshot", path: "C:\\保存目录\\phone-20260929-094112.png", filename: "phone-20260929-094112.png", size: 123, width: 1080, height: 2400 };
    const video = { kind: "recording", path: "C:\\保存目录\\手机录屏.mp4", filename: "手机录屏.mp4", size: 456 };
    const bundle = await readFile(path.join(root, "bundle.js"));
    let screenshotPreview = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64");
    const exportJobs = [];
    const css = await readFile(path.join(repo, "components/workspace/HarmonyPanel.module.css"), "utf8");
    await page.route("https://harmony-panel.test/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname === "/api/harmony/media/preview") return route.fulfill({ contentType: "image/png", body: screenshotPreview });
      if (url.pathname === "/api/harmony/media/history") return route.fulfill({ json: { artifacts: url.searchParams.get("serial") === "phone" ? [
        { ...screenshot, serial: "phone", createdAt: "2026-09-29T09:41:12.000Z", mimeType: "image/png" },
        { ...video, serial: "phone", createdAt: "2026-09-29T09:40:00.000Z", mimeType: "video/mp4" },
      ] : [], truncated: false } });
      if (url.pathname === "/api/harmony/tasks") {
        const tasks = [
          { id: "transfer-1", kind: "transfer", category: "active", status: "running", title: "#transfer", completedItems: 1, totalItems: 2, completedBytes: 12, createdAt: "2026-09-29T09:40:00Z" },
          { id: "scenario-1", kind: "scenario", category: "attention", status: "failed", title: "#scenario", passedSteps: 0, totalSteps: 2, createdAt: "2026-09-29T09:39:00Z" },
          { id: screenshot.filename, kind: "media", category: "completed", status: "completed", title: screenshot.filename, mediaKind: "screenshot", bytes: 123, createdAt: "2026-09-29T09:41:12Z" },
          { id: "install-1", kind: "installation", category: "attention", status: "failed", title: "invalid-signature.hap", createdAt: "2026-09-29T09:40:00Z", error: "Signature rejected", operation: {
            id: "install-1", kind: "installation", serial: "phone", title: "invalid-signature.hap", target: "C:/workspace/invalid-signature.hap", status: "failed", signatureRejected: true, deviceErrorCode: "9568257",
            createdAt: "2026-09-29T09:40:00Z", updatedAt: "2026-09-29T09:40:05Z" } },
          { id: "capture-1", kind: "snapshot", category: "completed", status: "completed", title: "Notes / notes.db", bytes: 8192, createdAt: "2026-09-29T09:41:00Z", operation: {
            id: "capture-1", kind: "snapshot", serial: "phone", title: "Notes / notes.db", target: "Notes / notes.db", status: "completed", verification: "double-copy-sha256", bytes: 8192,
            createdAt: "2026-09-29T09:41:00Z", updatedAt: "2026-09-29T09:41:01Z", capturedAt: "2026-09-29T09:41:01Z" } },
          ...exportJobs.map(job => ({ id: job.id, kind: "database", category: "completed", status: "completed", title: job.source, format: "csv", rows: 1, createdAt: job.createdAt })),
        ];
        const filter = url.searchParams.get("filter") ?? "all";
        return route.fulfill({ json: { tasks: filter === "all" ? tasks : tasks.filter(task => task.category === filter),
          counts: { all: tasks.length, active: 1, completed: 2 + exportJobs.length, attention: 2 }, truncated: false } });
      }
      if (url.pathname === "/api/harmony/files/preview") return route.fulfill({ contentType: "image/png", body: screenshotPreview });
      if (url.pathname === "/api/harmony/files/hex") return route.fulfill({ json: { preview: { size: 24, shown: 24, truncated: false,
        sha256: "a".repeat(64), text: "00000000  00 41 0a 7f ff                                   |.A...|" } } });
      if (!url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "text/html", body: `<meta charset="utf-8"><style>:root{--bg:#fff;--bg-panel:#f7f7f8;--bg-hover:#f0f0f1;--border:#e4e4e7;--border-soft:#ececef;--text:#18181b;--text-muted:#52525b;--text-dim:#71717a;--accent:#2563eb;--surface-raised:#fafafa;--surface-muted:#f4f4f5;--btn-primary-bg:#18181b;--btn-primary-fg:#fff;--status-ready:#16a34a;--status-attention:#d97706;--status-failed:#dc2626;--control-height:34px;--control-height-compact:30px;--radius-control:8px;--radius-surface:12px;--focus-ring:#93b4ff;--shadow-popover:0 8px 24px rgba(0,0,0,.1);--text-xs:11.5px;--text-sm:12.5px;--text-base:14px;--font-mono:Consolas,monospace}html,body,#root{height:100%;margin:0}body{font:14px system-ui,sans-serif}${css}</style><div id="root"></div><script src="/bundle.js"></script>` });
      let data = {};
      const input = request.postDataJSON();
      if (input) requests.push({ ...input, endpoint: url.pathname });
      const requiresAdmission = (url.pathname === "/api/harmony/manual" && input?.action === "acquire")
        || (url.pathname === "/api/harmony/media" && input?.action === "start_recording");
      if (requiresAdmission && rejectedControlStatus) {
        controls = [{ serial: input.serial, status: rejectedControlStatus }];
        return route.fulfill({ status: 409, json: { error: { code: "DEVICE_BUSY", message: "Device dispatch is blocked while stopping or awaiting cleanup confirmation", details: { state: rejectedControlStatus } } } });
      }
      if (url.pathname === "/api/harmony/media" && input?.action === "start_recording" && rejectRecording) return route.fulfill({ status: 501,
        json: { error: { code: "CAPABILITY_UNAVAILABLE", message: "录屏不可用：设备缺少有效的视频组件。" } } });
      if (url.pathname === "/api/harmony/action" && input?.action === "install_app") return route.fulfill({ status: 502,
        json: { error: { code: "COMMAND_FAILED", message: "Signature rejected", details: { reason: "signature-rejected", deviceErrorCode: "9568257" } } } });
      if (url.pathname === "/api/harmony/packages") data = { preview: { filename: "test.hap", size: 123, sha256: "a".repeat(64), bundleName: "dev.piora.audio.fixture", versionName: "1.0", abilities: [], deviceTypes: ["phone"], permissions: [], signature: "unverified" } };
      if (url.pathname.endsWith("/profile")) data = { profile: "normal" };
      if (url.pathname.endsWith("/devices")) data = { devices: ["phone", "phone2"].map(serial => ({ serial, name: serial === "phone" ? phoneName : "Second phone", state: serial === "phone" ? phoneState : "online", connectionIssue: serial === "phone" ? phoneIssue : undefined, transport: serial === "phone" ? phoneTransport : "tcp", transportEvidence: "hdc", responseSample: serial === "phone" ? connectionSample : undefined, generation: 1, capabilities: { screenshot: true, tap: true, swipe: true, keys: true, inputText: true, launchApp: true } })), state: { runtime: { status: "ready" }, leases: holder ? [holder] : [], controls } };
      if (url.pathname.endsWith("/geometry")) data = { geometry: { geometryId: "geometry", deviceEpoch: 1, frameWidth: 1080, frameHeight: 2400 } };
      if (url.pathname.endsWith("/templates") && input && delayTemplate) await delayTemplate;
      if (url.pathname.endsWith("/templates")) data = input ? { steps: [{ action: "launch_app", bundleName: input.parameters.bundleName, abilityName: "EntryAbility" }, { action: "checkpoint", name: "launched" }] } : { templates };
      if (url.pathname.endsWith("/apps")) data = { applications: [{ bundleName: "dev.piora.audio.fixture", label: "Harmony 测试 App", abilities: ["EntryAbility"], source: "bm-label" }] };
      if (url.pathname === "/api/harmony/databases" && request.method() === "POST" && input?.action === "read" && databaseReadDelay) await databaseReadDelay;
      if (url.pathname === "/api/harmony/databases") data = request.method() === "GET"
        ? { scanning: false, startedAt: "2026-09-29T00:00:00Z", applications: [
          { bundleName: "dev.piora.audio.fixture", label: "Harmony 测试 App", status: "ready", databases: [{ id: "db-1", name: "notes.db" }] },
          { bundleName: "com.example.empty", label: "空数据应用", status: "empty", databases: [] },
          { bundleName: "com.example.locked", label: "无法访问应用", status: "inaccessible", reason: "应用未运行；不会自动启动", databases: [] },
        ] } : input?.action === "open" ? { id: "snapshot-fixture", capturedAt: "2026-09-29T00:01:00Z", database: { size: 8192, verification: "double-copy-sha256" }, result: { tables: ["notes"], views: [], indexes: [{ name: "idx_notes_body", table: "notes", unique: false, columns: ["body"] }] } }
          : { result: { tables: ["notes"], views: [], table: "notes", columns: ["id", "body"], rows: [[1, "Hello Harmony"]], fields: [], indexes: [{ name: "idx_notes_body", table: "notes", unique: false, columns: ["body"] }], offset: 0, hasMore: false } };
      if (url.pathname === "/api/harmony/database-exports") {
        if (input?.action === "create") {
          const job = { id: "12345678-1234-1234-1234-123456789abc", serial: "phone", source: input.source, format: input.format,
            range: input.options.range, offset: input.options.offset, encoding: input.options.encoding, status: "completed", rows: 1, bytes: 24,
            createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" };
          exportJobs.unshift(job); data = { job };
        } else data = { jobs: exportJobs };
      }
      if (url.pathname === "/api/harmony/files" && request.method() === "GET") {
        const devicePath = url.searchParams.get("path");
        if (url.searchParams.get("stat") === "1") return route.fulfill({ json: { file: {
          path: devicePath, name: devicePath.split("/").at(-1), kind: ["/data/local/tmp", "/data/local/tmp/projects", "/data/local", "/data", "data/storage/el2/base"].includes(devicePath) ? "directory" : "file", size: 24, modifiedAt: Date.now(),
        } } });
        if (devicePath?.endsWith("notes.txt")) return route.fulfill({ status: 400, json: { error: { message: "Not a directory" } } });
        data = { files: largeFileParent && devicePath === "/data/local/tmp/projects" ? Array.from({ length: 350 }, (_, index) => ({
          path: `/data/local/tmp/projects/item-${index}.bin`, name: `item-${index}.bin`, kind: "file", size: 20,
        })) : devicePath === "/data/local/tmp" ? [
          { path: "/data/local/tmp/report.log", name: "report.log", kind: "file", size: 152, modifiedAt: Date.now() },
        ] : [], truncated: ["/data/local/tmp", "/data/local/tmp/projects"].includes(devicePath) };
      }
      if (url.pathname === "/api/harmony/files/text") {
        textPreviewReads++;
        if (delayedTextPreview) await delayedTextPreview;
        data = { result: { text: "Hello Harmony", hash: "fixture", size: 13, encoding: "utf-8", newline: "lf" } };
      }
      if (url.pathname.endsWith("/scenario")) data = input ? { result: { status: "passed", steps: [{ action: "launch_app", status: "passed" }] } }
        : { executions: [{ id: "scenario-1", status: "failed", startedAt: "2026-09-29T09:39:00Z", steps: [] }] };
      if (url.pathname.endsWith("/audio")) data = { outputs: [] };
      if (url.pathname.endsWith("/transfers")) data = { jobs: [] };
      if (url.pathname.endsWith("/manual")) {
        if (["acquire", "takeover"].includes(input?.action)) {
          holder = { serial: input.serial, owner: { id: input.ownerId, kind: "manual" }, expiresAt: "2099-01-01T00:00:00Z" };
          data = { lease: { token: "lease", serial: input.serial, expiresAt: "2099-01-01T00:00:00Z" } };
        } else if (input?.action === "release") holder = null;
      }
      if (input?.action === "stop_device") holder = null;
      if (input?.action === "confirm_cleanup") { controls = []; data = { cleanup: "manual-confirmed" }; }
      if (input?.action === "copy_path" || input?.action === "move_path") data = { result: { receipt: { verification: "passed", effect: "applied" } } };
      if (url.pathname.endsWith("/media")) {
        if (input?.action === "capture_screenshot") data = { artifact: screenshot };
        else if (input?.action === "start_recording") {
          recording = { recordingId: `rec-${recordingPairs.length + 1}`, serial: "phone", ownerId: input.ownerId, startedAt: new Date().toISOString() };
          recordingPairs.push({ started: { ...recording } }); data = { recording };
        }
        else if (input?.action === "stop_recording") { recordingPairs.at(-1).stopped = input; recording = null; data = { artifact: video }; }
        else data = { recording };
      }
      return route.fulfill({ json: data });
    });
    await page.goto("https://harmony-panel.test/");
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    screenshotPreview = await page.locator("canvas").screenshot();
    screenshot.size = screenshotPreview.length;
    const fontBefore = await page.locator(".deviceIdentity select").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    await page.evaluate(() => document.documentElement.style.setProperty("--text-base", "20px"));
    const fontAfter = await page.locator(".deviceIdentity select").evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(fontAfter > fontBefore * 1.4, "device text follows the configured font scale");
    await page.evaluate(() => document.documentElement.style.removeProperty("--text-base"));
    assert.equal(await page.locator(".toolDrawer").isVisible(), false, "tools start closed");
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/manual").length, 0, "mounting a mirror does not acquire control");
    await page.getByText("响应 17 ms", { exact: true }).waitFor();
    assert.match(await page.getByText("响应 17 ms", { exact: true }).getAttribute("title"), /包含主机 HDC 耗时.*不代表视频延迟/);
    assert.match(await page.getByRole("combobox", { name: "选择设备", exact: true }).inputValue(), /phone/);
    assert.match(await page.locator('.deviceIdentity select option[value="phone"]').textContent(), / · phone$/);
    assert.equal(await page.locator(".deviceConnection").getByText("USB", { exact: true }).count(), 1);
    assert.equal(await page.locator('.deviceConnection [title="设备序列号：phone"]').textContent(), "phone", "the serial remains visible outside the possibly clipped device selector");
    connectionSample = { durationMs: 90, sampledAt: "2000-01-01T00:00:00.000Z" };
    phoneTransport = "unknown";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("响应未确认", { exact: true }).waitFor();
    assert.equal(await page.getByText("响应 90 ms", { exact: true }).count(), 0, "old latency cannot masquerade as a current sample");
    assert.equal(await page.locator(".deviceConnection").getByText("连接方式未知", { exact: true }).count(), 1);
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone2");
    await page.locator(".deviceConnection").getByText("TCP/Wi-Fi", { exact: true }).waitFor();
    assert.equal(await page.getByText("响应 17 ms", { exact: true }).count(), 0, "switching phones never inherits another phone's response");
    connectionSample = { durationMs: 23, sampledAt: new Date().toISOString() };
    phoneTransport = "usb";
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone");
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("响应 23 ms", { exact: true }).waitFor();
    phoneState = "offline";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("设备已离线", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "截图", exact: true }).isDisabled(), true);
    assert.equal(await page.getByText("响应 23 ms", { exact: true }).count(), 0);
    await page.getByText("重新连接 USB 并确认手机调试授权，恢复后自动显示画面。", { exact: true }).waitFor();
    phoneState = "unauthorized";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.locator(".frameEmpty").getByText("等待手机授权", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "截图", exact: true }).isDisabled(), true);
    phoneState = "unknown";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.locator(".deviceConnection").getByText("连接未确认", { exact: true }).waitFor();
    await page.locator(".frameEmpty").getByText("连接状态未确认", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "截图", exact: true }).isDisabled(), true);
    phoneIssue = "hdc-channel-not-ready";
    connectionSample = undefined;
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.locator(".frameEmpty").getByText("调试通信未就绪", { exact: true }).waitFor();
    await page.getByText("等待调试通信", { exact: true }).waitFor();
    await page.locator(".frameEmpty").getByText(/检测到 USB.*重新插拔 USB/).waitFor();
    assert.equal(await page.getByRole("button", { name: "截图", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("canvas").count(), 0, "an unconfirmed channel must not display a previous device frame");
    const capturesBeforeChannelShortcut = requests.filter(r => r.action === "capture_screenshot").length;
    await page.locator(".frameEmpty").click();
    await page.keyboard.press("Alt+Shift+S");
    await page.waitForTimeout(100);
    assert.equal(requests.filter(r => r.action === "capture_screenshot").length, capturesBeforeChannelShortcut, "channel failures disable keyboard capture too");
    phoneIssue = undefined;
    phoneState = "online";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    const captureCount = () => requests.filter(r => r.action === "capture_screenshot").length;
    const captureShortcut = async (binding) => {
      const response = page.waitForResponse(response => response.url().endsWith("/media") && response.request().postDataJSON()?.action === "capture_screenshot");
      await page.getByRole("button", { name: "截图", exact: true }).focus();
      await page.keyboard.press(binding);
      assert.equal((await response).status(), 200);
      await page.getByRole("button", { name: "截图", exact: true }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.actionBar button')?.disabled);
    };
    await captureShortcut("Alt+Shift+S");
    // Configure through the real Settings component rather than injecting an override.
    await page.evaluate(() => window.setFixtureShortcuts(true));
    const recorder = page.getByRole("button", { name: "录制“鸿蒙设备截图”的快捷键", exact: true });
    const countBeforeSettings = captureCount();
    await recorder.click(); await recorder.press("Alt+Shift+S");
    assert.equal(captureCount(), countBeforeSettings, "recording the existing hotkey must not capture the phone");
    await recorder.click(); await recorder.press("Control+p");
    await page.getByRole("status").filter({ hasText: /这个键位已分配给/ }).waitFor();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("piora-keyboard-shortcuts:v1")).overrides["harmony.screenshot"]), "Alt+Shift+S", "a conflicting assignment is not persisted");
    await recorder.press("Control+Alt+s");
    await page.evaluate(() => window.setFixtureShortcuts(false));
    await page.waitForFunction(() => document.querySelector('.actionBar button')?.title === "截图 · Ctrl+Alt+S");
    await page.locator("canvas").click(); await page.keyboard.press("Alt+Shift+S");
    await page.waitForTimeout(100);
    assert.equal(captureCount(), countBeforeSettings, "the old binding stops immediately after customization");
    await captureShortcut("Control+Alt+s");
    await page.reload();
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.actionBar button')?.title === "截图 · Ctrl+Alt+S");
    await captureShortcut("Control+Alt+s");
    const protectedCount = captureCount();
    const protectedEvents = await page.evaluate(() => {
      const outcomes = [];
      const dispatch = (target, extra = {}) => {
        const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, altKey: true, bubbles: true, cancelable: true, ...extra });
        target.dispatchEvent(event); outcomes.push(event.defaultPrevented);
      };
      for (const html of ['<input>', '<textarea>', '<select>', '<div contenteditable="true"></div>', '<div contenteditable></div>', '<div contenteditable="plaintext-only"></div>', '<div role="textbox"></div>', '<div class="xterm"></div>', '<button data-app-shortcuts="preserve"></button>']) {
        const container = document.createElement("div"); container.innerHTML = html; document.body.append(container);
        dispatch(container.firstElementChild); container.remove();
      }
      dispatch(document.body, { repeat: true }); dispatch(document.body, { isComposing: true });
      const dialog = document.createElement("div"); dialog.setAttribute("aria-modal", "true"); dialog.textContent = "Modal"; document.body.append(dialog);
      dispatch(document.body); dialog.remove();
      const panel = document.querySelector('.actionBar').closest('.root'); panel.style.display = "none"; dispatch(document.body); panel.style.display = "";
      const prevented = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, altKey: true, bubbles: true, cancelable: true }); prevented.preventDefault(); document.body.dispatchEvent(prevented);
      return outcomes;
    });
    assert.deepEqual(protectedEvents, Array(13).fill(false), "protected contexts retain their keys");
    await page.waitForTimeout(100);
    assert.equal(captureCount(), protectedCount, "protected contexts never call the media API");
    await page.evaluate(() => window.setFixtureShortcuts(true));
    await recorder.click(); await recorder.press("Backspace");
    await page.evaluate(() => window.setFixtureShortcuts(false));
    await page.waitForFunction(() => document.querySelector('.actionBar button')?.title === "截图");
    await page.locator("canvas").click(); await page.keyboard.press("Control+Alt+s");
    await page.waitForTimeout(100);
    assert.equal(captureCount(), protectedCount, "a cleared binding stays disabled");
    await page.evaluate(() => window.setFixtureShortcuts(true));
    await page.getByRole("button", { name: "恢复“鸿蒙设备截图”的默认快捷键", exact: true }).click();
    await page.evaluate(() => window.setFixtureShortcuts(false));
    await page.waitForFunction(() => document.querySelector('.actionBar button')?.title === "截图 · Alt+Shift+S");
    assert.ok(requests.filter(r => r.action === "capture_screenshot").every(r => r.leaseToken === undefined));
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/manual").length, 0, "keyboard screenshots never acquire or take over the device");
    await page.reload();
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^(手动控制|控制设备|结束控制)$/ }).count(), 0);
    const actionsBeforeMirrorClick = requests.filter(request => request.endpoint === "/api/harmony/action").length;
    await page.locator("canvas").click();
    await page.waitForTimeout(100);
    assert.equal(requests.filter(request => request.endpoint === "/api/harmony/action").length, actionsBeforeMirrorClick, "clicking the view-only mirror must not send a device action");
    assert.equal(await page.getByRole("button", { name: "输入文字" }).count(), 0);
    assert.equal(requests.some(request => request.endpoint === "/api/harmony/approval"), false, "connected phones never poll for Piora approval");
    const beforeTools = await page.locator("canvas").boundingBox();
    assert.ok(beforeTools.height > 600, "the default screen uses the available vertical space");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) { await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true }); await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "default.png") }); }
    await page.getByRole("button", { name: "工具", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "文件", exact: true }).getAttribute("aria-selected"), "true", "the tool drawer opens on the high-frequency file workspace");
    await page.getByRole("tab", { name: "应用", exact: true }).click();
    const applications = page.getByRole("region", { name: "应用管理", exact: true });
    const beforeSandbox = requests.filter(request => /\/(action|manual)$/.test(request.endpoint)).length;
    await applications.getByRole("list", { name: "应用列表", exact: true }).getByRole("button").click();
    await applications.getByRole("button", { name: "打开应用沙箱", exact: true }).click();
    const files = page.getByRole("region", { name: "设备文件", exact: true });
    await files.waitFor();
    assert.equal(await files.getByRole("combobox", { name: "文件范围" }).inputValue(), "sandbox");
    assert.equal(await files.getByLabel("选择应用（名称或包名）", { exact: true }).inputValue(), "dev.piora.audio.fixture");
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]').value === "data/storage/el2/base" && !document.querySelector('[aria-label="设备文件或文件夹路径"]').disabled);
    assert.equal(requests.filter(request => /\/(action|manual)$/.test(request.endpoint)).length, beforeSandbox, "cross-tab sandbox navigation must stay read-only");
    await files.getByRole("combobox", { name: "文件范围" }).selectOption("shared");
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]').value === "/data/local/tmp" && !document.querySelector('[aria-label="设备文件或文件夹路径"]').disabled);
    await page.getByRole("tab", { name: "应用", exact: true }).click();
    await applications.getByRole("textbox", { name: "HAP 完整路径" }).fill("C:\\workspace\\test.hap");
    await applications.getByRole("button", { name: "预览安装包", exact: true }).click();
    await applications.getByText("签名尚未验证，最终由设备安装时校验。", { exact: true }).waitFor();
    assert.deepEqual(nativeDialogs, [], "package preview opens no native confirmation");
    const beforeInstallClick = requests.filter(request => request.action === "install_app").length;
    await applications.getByRole("button", { name: "安装", exact: true }).evaluate(button => { button.click(); button.click(); });
    await applications.getByRole("alert").filter({ hasText: "HAP 签名校验未通过" }).waitFor();
    assert.deepEqual(nativeDialogs, [], "an explicit install click never opens a native confirmation");
    assert.equal(requests.filter(request => request.action === "install_app").length, beforeInstallClick + 1,
      "rapid repeated install clicks still dispatch exactly once");
    assert.match(await applications.getByRole("alert").innerText(), /9568257/);
    assert.equal(await applications.getByRole("status").filter({ hasText: "设备已验证操作结果" }).count(), 0, "failed installation cannot announce a successful receipt");
    rejectRecording = true;
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "录屏不可用" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /停止录屏/ }).count(), 0);
    const screenshotAfterError = page.waitForResponse(response => response.url().endsWith("/media") && response.request().postDataJSON()?.action === "capture_screenshot");
    await page.getByRole("button", { name: "截图", exact: true }).click();
    assert.equal((await screenshotAfterError).status(), 200, "error feedback must not cover or block screenshot actions");
    await page.locator(".captureNotice").getByText("截图已保存并复制到剪贴板", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.copies), [{ kind: "screenshot", path: screenshot.path }]);
    await page.evaluate(() => { window.copies = []; });
    rejectRecording = false;
    if (!await page.locator(".toolDrawer").isVisible()) await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("tab", { name: "测试", exact: true }).click();
    await page.getByRole("combobox", { name: "测试应用", exact: true }).selectOption("dev.piora.audio.fixture");
    await page.getByRole("button", { name: "运行测试", exact: true }).click();
    await page.getByText("测试通过", { exact: true }).waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "tests.png") });
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    largeFileParent = true;
    delayedTextPreview = new Promise(resolve => { releaseTextPreview = resolve; });
    const previewRequested = page.waitForRequest(request => request.method() === "GET" && new URL(request.url()).pathname === "/api/harmony/files/text");
    await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).fill("/data/local/tmp/projects/notes.txt");
    await page.getByRole("button", { name: "前往", exact: true }).click();
    await previewRequested;
    await page.getByText("文件预览与下载: notes.txt", { exact: true }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true }).count(), 0,
      "the file metadata commits while the text response is still pending");
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.disabled === false);
    assert.equal(await page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true }).count(), 0,
      "finishing the path jump must not consume the pending reveal before its separate delayed text read settles");
    releaseTextPreview(); delayedTextPreview = null;
    await page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true }).waitFor();
    const revealedEditorActions = await page.getByRole("button", { name: "核对原内容并保存", exact: true }).evaluate(button => {
      const rect = button.getBoundingClientRect(), body = button.closest('[role="tabpanel"]').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, bodyTop: body.top, bodyBottom: body.bottom,
        exposed: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)) };
    });
    assert.ok(revealedEditorActions.top >= revealedEditorActions.bodyTop && revealedEditorActions.bottom <= revealedEditorActions.bodyBottom && revealedEditorActions.exposed,
      `a narrow workspace must expose its primary actions after a delayed preview under a large directory: ${JSON.stringify(revealedEditorActions)}`);
    assert.ok(await page.locator(".drawerBody").evaluate(element => element.scrollTop) > 0);
    largeFileParent = false;
    await page.locator(".drawerHeading").getByRole("button", { name: "展开设备工作台" }).click();
    assert.equal(await page.evaluate(() => window.maximized), true, "file management can expand into the full workspace");
    await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).fill("/data/local/tmp/projects/notes.txt");
    await page.getByRole("button", { name: "前往", exact: true }).click();
    await page.getByText("文件预览与下载: notes.txt").waitFor();
    // Selecting the row happens before its text read settles; compare the ready
    // preview, not the metadata-only intermediate layout.
    await page.getByRole("textbox", { name: "设备文件采集时原文", exact: true }).waitFor();
    const panes = await page.evaluate(() => [".fileTreePane", ".fileListing", ".fileDetails"].map(selector => {
      const { x, y, width } = document.querySelector(selector).getBoundingClientRect(); return { x, y, width };
    }));
    assert.ok(panes[0].x < panes[1].x && panes[1].x < panes[2].x
      && panes[1].width >= 160 && panes[2].width >= 400,
      `expanded file management uses three readable panes instead of retaining the narrow drawer: ${JSON.stringify(panes)}`);
    const listControls = await page.locator(".fileListToolbar").evaluate(toolbar => {
      const bounds = toolbar.getBoundingClientRect();
      return [...toolbar.children].map(child => { const rect = child.getBoundingClientRect(); return { left: rect.left, right: rect.right, min: bounds.left, max: bounds.right }; });
    });
    assert.ok(listControls.every(control => control.left >= control.min - 1 && control.right <= control.max + 1),
      `sorting and hidden-file controls fit the narrowed list: ${JSON.stringify(listControls)}`);
    const pathActions = await page.evaluate(() => {
      const main = document.querySelector(".fileMain").getBoundingClientRect();
      return [...document.querySelectorAll(".fileAddress button")].map(button => ({ name: button.textContent, right: button.getBoundingClientRect().right, max: main.right }));
    });
    assert.ok(pathActions.every(action => action.right <= action.max + 1), `path actions must stay visible in the expanded explorer: ${JSON.stringify(pathActions)}`);
    const addressLayout = await page.evaluate(() => {
      const address = document.querySelector('[aria-label="设备文件或文件夹路径"]').getBoundingClientRect();
      const main = document.querySelector(".fileMain").getBoundingClientRect();
      const tools = document.querySelector(".fileAddressTools").getBoundingClientRect();
      return { inputWidth: address.width, available: main.width, addressBottom: address.bottom, toolsTop: tools.top };
    });
    assert.ok(addressLayout.inputWidth >= addressLayout.available * .75 && addressLayout.toolsTop >= addressLayout.addressBottom,
      `path editing must keep its own full-width row: ${JSON.stringify(addressLayout)}`);
    await page.getByRole("button", { name: "前往", exact: true }).focus();
    await page.keyboard.press("Control+l");
    assert.equal(await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).evaluate(element => document.activeElement === element
      && element.selectionStart === 0 && element.selectionEnd === element.value.length), true, "Ctrl+L focuses and selects the complete device path");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "files-three-pane.png") });
    await page.locator(".drawerHeading").getByRole("button", { name: "返回双栏" }).click();
    assert.equal(await page.evaluate(() => window.maximized), false);
    const locatedFile = page.getByRole("button", { name: /notes\.txt · 路径直达/ });
    await locatedFile.waitFor();
    const fileDraft = page.getByRole("textbox", { name: "设备文件编辑草稿", exact: true });
    await fileDraft.fill("Local unsaved draft");
    await page.evaluate(() => window.setFixtureTooltips(true));
    await locatedFile.hover();
    await page.waitForFunction(element => !element.hasAttribute("title"), await locatedFile.elementHandle());
    const textReadsBeforeContext = textPreviewReads;
    await locatedFile.click({ button: "right" });
    const fileMenu = page.getByRole("menu", { name: "notes.txt 的操作" });
    await fileMenu.waitFor();
    await page.locator(".fileDetails").evaluate(element => element.dispatchEvent(new Event("scroll", { bubbles: true })));
    assert.equal(await fileMenu.count(), 1, "programmatic detail scrolling does not dismiss a freshly opened context menu");
    await page.keyboard.press("Escape");
    assert.equal(await fileMenu.count(), 0);
    assert.equal(await locatedFile.evaluate(element => document.activeElement === element), true,
      "the mouse menu returns to its file even while the app tooltip replaces native title attributes");
    await locatedFile.click({ button: "right" });
    await fileMenu.waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "file-context-menu.png") });
    await fileMenu.getByRole("menuitem", { name: "复制设备路径" }).click();
    await page.waitForFunction(() => window.copiedPath === "/data/local/tmp/projects/notes.txt");
    assert.equal(await fileDraft.inputValue(), "Local unsaved draft", "copying a path from the selected item's menu must keep unsaved text");
    await locatedFile.focus();
    await locatedFile.press("Shift+F10");
    await fileMenu.waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await fileMenu.count(), 0, "the keyboard context menu closes without closing the file drawer");
    await page.waitForFunction(element => document.activeElement === element, await locatedFile.elementHandle());
    assert.equal(await locatedFile.evaluate(element => document.activeElement === element), true, "Escape returns focus to the file");
    assert.equal(await fileDraft.inputValue(), "Local unsaved draft", "keyboard context menus also preserve the editor draft");
    assert.equal(textPreviewReads, textReadsBeforeContext,
      "opening the selected item's context menu must not trigger another preview read");
    await page.getByRole("button", { name: "查看十六进制" }).click();
    await page.getByText("00000000  00 41 0a 7f ff", { exact: false }).waitFor();
    assert.equal(await page.getByText("只读显示前 24 / 24 字节", { exact: false }).count(), 1);
    assert.equal(await page.locator('.fileTreePane').getByRole('button', { name: 'projects', exact: true }).count(), 1, 'jump reveals the parent folder in the tree');
    await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).fill("/data/local/tmp/projects/photo.png");
    await page.getByRole("button", { name: "前往", exact: true }).click();
    await page.getByRole("img", { name: "photo.png 的设备图片预览" }).waitFor();
    await page.getByRole("img", { name: "photo.png 的设备图片预览" }).evaluate(image => new Promise((resolve, reject) => {
      if (image.complete) return image.naturalWidth > 100 ? resolve() : reject(new Error('Device image preview is blank'));
      image.addEventListener('load', () => image.naturalWidth > 100 ? resolve() : reject(new Error('Device image preview is blank')), { once: true });
      image.addEventListener('error', () => reject(new Error('Device image preview failed to load')), { once: true });
    }));
    assert.equal(await page.getByRole("combobox", { name: "最近访问的设备路径" }).locator('option[value="/data/local/tmp/projects/notes.txt"]').count(), 1, "recent paths keep direct file locations");
    await page.getByText("复制、移动、重命名与删除").click();
    await page.getByRole("textbox", { name: "复制或移动到设备路径（不覆盖）" }).fill("/data/local/tmp/projects/photo-copy.png");
    await page.getByRole("button", { name: "复制文件" }).click();
    await page.getByText("已校验并复制到 /data/local/tmp/projects/photo-copy.png").waitFor();
    assert.equal(requests.find(request => request.action === "copy_path")?.newPath, "/data/local/tmp/projects/photo-copy.png");
    await page.evaluate(() => {
      const files = new DataTransfer(); files.items.add(new File(["dragged"], "dragged.txt"));
      const list = document.querySelector('[aria-label="当前目录文件"]');
      list.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: files }));
      list.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: files }));
    });
    await page.getByText("已选择 1 个本地文件；请核对设备目标目录后点击“上传这一批”。").waitFor();
    assert.equal(await page.getByRole("textbox", { name: "上传的本地文件路径（每行一个）" }).inputValue(), "C:\\workspace\\dragged.txt");
    assert.equal(await page.getByRole("textbox", { name: "设备目标目录" }).inputValue(), "/data/local/tmp/projects");
    assert.equal(requests.some(request => request.endpoint === "/api/harmony/transfers"), false, "dropping only prepares a reviewed upload");
    await page.evaluate(() => {
      const files = new DataTransfer(); files.items.add(new File(["unknown"], "untrusted.txt"));
      document.querySelector('[aria-label="当前目录文件"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: files }));
    });
    await page.getByRole("alert").filter({ hasText: "无法取得本地文件路径" }).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "上传的本地文件路径（每行一个）" }).inputValue(), "C:\\workspace\\dragged.txt");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "files.png") });
    await page.locator(".drawerBody").evaluate(element => { element.scrollTop = element.scrollHeight; });
    assert.ok(await page.locator(".drawerBody").evaluate(element => element.scrollTop) > 0, "file details make the tool panel scrollable");
    await page.getByRole("tab", { name: "数据库", exact: true }).click();
    await page.locator(".dbHeader").waitFor();
    await page.waitForFunction(() => document.querySelector(".drawerBody")?.scrollTop === 0);
    await page.setViewportSize({ width: 720, height: 900 });
    const initialTree = await page.locator(".dbObjects").boundingBox();
    const initialBody = await page.locator(".drawerBody").boundingBox();
    assert.ok(initialTree.height > 350 && initialTree.y + initialTree.height <= initialBody.y + initialBody.height,
      `before opening a database, the app tree should use the visible drawer instead of leaving space for an empty result pane: ${JSON.stringify({initialTree,initialBody})}`);
    await page.getByRole("button", { name: "Harmony 测试 App" }).click();
    await page.getByRole("button", { name: "notes.db" }).click();
    await page.getByText("双份 SHA-256 校验一致", { exact: false }).waitFor();
    assert.equal(await page.locator('.dbDatabaseNode').getByRole('button', { name: 'notes', exact: true }).count(), 1, 'tables belong to their database node');
    let releaseDatabaseRead;
    databaseReadDelay = new Promise(resolve => { releaseDatabaseRead = resolve; });
    const tableReadStarted = page.waitForRequest(request => request.method() === "POST"
      && new URL(request.url()).pathname === "/api/harmony/databases"
      && request.postDataJSON()?.action === "read");
    const tableRead = page.waitForResponse(response => response.request().method() === "POST"
      && new URL(response.url()).pathname === "/api/harmony/databases"
      && response.request().postDataJSON()?.action === "read");
    await page.getByRole("button", { name: "notes", exact: true }).click();
    await tableReadStarted;
    const databaseBody = await page.locator(".drawerBody").boundingBox();
    const sqlEditorsWhileLoading = await page.getByRole("textbox", { name: "只读 SQL 查询" }).count();
    releaseDatabaseRead();
    databaseReadDelay = null;
    await tableRead;
    assert.equal(sqlEditorsWhileLoading, 0,
      "selecting a table gives the data view space immediately instead of keeping the SQL editor expanded during the read");
    const gridBox = await page.getByRole("region", { name: "查询结果表格" }).boundingBox();
    const headerHeight = await page.getByRole("region", { name: "查询结果表格" }).locator("thead").evaluate(element => element.getBoundingClientRect().height);
    assert.ok(headerHeight <= 32, `sortable column headers must not inherit tall tool-button spacing: ${headerHeight}`);
    assert.ok(gridBox.y >= databaseBody.y && gridBox.y + Math.min(60, gridBox.height) <= databaseBody.y + databaseBody.height,
      `result headers and the first rows should be visible alongside the object tree: ${JSON.stringify({ databaseBody, gridBox })}`);
    assert.equal(await page.locator(".drawerBody").evaluate(element => element.scrollHeight > element.clientHeight + 1), false,
      "database navigation and query results should scroll independently inside the available drawer height");
    await page.getByRole("tab", { name: "SQL 控制台", exact: true }).click();
    const queryBox = await page.getByRole("textbox", { name: "只读 SQL 查询" }).boundingBox();
    assert.ok(queryBox.y >= databaseBody.y && queryBox.y + queryBox.height <= databaseBody.y + databaseBody.height,
      "the SQL console should be visible when explicitly selected");
    await page.getByRole("tab", { name: "notes", exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.getByRole("button", { name: "导出 CSV" }).click();
    await page.getByRole("button", { name: "开始导出任务" }).click();
    const scenarioHistory = page.waitForResponse(response => new URL(response.url()).pathname === "/api/harmony/scenario" && response.request().method() === "GET");
    await page.getByRole("button", { name: "查看任务" }).click();
    await scenarioHistory;
    await page.getByText("无检查点", { exact: false }).waitFor();
    const taskOverview = page.getByRole("region", { name: "任务总览" });
    const attentionTasks = page.waitForResponse(response => new URL(response.url()).pathname === "/api/harmony/tasks" && new URL(response.url()).searchParams.get("filter") === "attention");
    await taskOverview.getByRole("button", { name: "失败/待核对 2" }).click();
    await attentionTasks;
    assert.equal(await taskOverview.getByRole("article").count(), 2, "status filters include failed installs");
    const installTask = taskOverview.getByRole("article").filter({ hasText: "invalid-signature.hap" });
    await installTask.getByText("查看任务详情", { exact: true }).click();
    await installTask.getByText("C:/workspace/invalid-signature.hap", { exact: true }).waitFor();
    assert.match(await installTask.getByRole("alert").innerText(), /HAP 签名校验未通过.*9568257/);
    const allTasks = page.waitForResponse(response => new URL(response.url()).pathname === "/api/harmony/tasks" && new URL(response.url()).searchParams.get("filter") === "all");
    await taskOverview.getByRole("button", { name: "全部 6" }).click();
    await allTasks;
    await taskOverview.getByRole("article").filter({ hasText: "Harmony 测试 App / notes.db / notes" }).waitFor();
    assert.equal(await taskOverview.getByRole("article").count(), 6);
    const captureTask = taskOverview.getByRole("article").filter({ hasText: "Notes / notes.db" });
    await captureTask.getByText("查看任务详情", { exact: true }).click();
    await captureTask.getByText("这里只保留采集记录。查看当前数据请回到数据库页重新取得快照。", { exact: true }).waitFor();
    assert.match(await captureTask.innerText(), /采集时间/);
    await taskOverview.getByRole("article").filter({ hasText: "Harmony 测试 App / notes.db / notes" }).getByRole("button", { name: "查看分类记录" }).click();
    await page.getByRole("group", { name: "数据库导出任务" }).getByText("Harmony 测试 App / notes.db / notes", { exact: false }).waitFor();
    await page.getByRole("tab", { name: "数据库", exact: true }).click();
    await page.getByRole('button', { name: 'idx_notes_body', exact: true }).click();
    await page.getByRole("article", { name: "索引 idx_notes_body", exact: true }).getByText("当前索引", { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'SQL 控制台', exact: true }).click();
    const sqlEditor = page.getByRole('textbox', { name: '只读 SQL 查询' });
    await sqlEditor.fill('SELECT 1\nSELECT 2');
    await page.evaluate(() => {
      const observe = event => { if (event.ctrlKey && event.key.toLowerCase() === "l") {
        window.hiddenFileChordPrevented = event.defaultPrevented; document.removeEventListener("keydown", observe);
      } };
      document.addEventListener("keydown", observe);
    });
    await sqlEditor.press("Control+l");
    assert.equal(await page.evaluate(() => window.hiddenFileChordPrevented), false, "a hidden file panel does not swallow the current view's address shortcut");
    await sqlEditor.evaluate(element => element.setSelectionRange(0, 8));
    const selectedQuery = page.waitForRequest(request => request.url().endsWith('/databases') && request.postDataJSON()?.action === 'read' && request.postDataJSON()?.sql);
    await sqlEditor.press('Control+Enter');
    assert.equal((await selectedQuery).postDataJSON().sql, 'SELECT 1', 'Ctrl+Enter runs the selected statement');
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-results.png") });
    await page.getByRole('button', { name: '刷新快照' }).click();
    assert.equal(await sqlEditor.inputValue(), 'SELECT 1\nSELECT 2', 'refresh preserves the SQL draft');
    assert.equal(await page.getByRole('tab', { name: 'notes', exact: true }).count(), 1, 'previously opened tables retain a tab');
    await page.locator(".drawerHeading").getByRole("button", { name: "展开设备工作台", exact: true }).click();
    await page.waitForFunction(() => window.maximized === true);
    const expandedDatabase = await page.evaluate(() => {
      const root = document.querySelector(".root").getBoundingClientRect();
      const drawer = document.querySelector('.toolDrawer[data-tab="databases"]').getBoundingClientRect();
      return { rootWidth: root.width, drawerWidth: drawer.width, rootRight: root.right, drawerRight: drawer.right };
    });
    assert.ok(expandedDatabase.drawerWidth >= expandedDatabase.rootWidth * .95 && expandedDatabase.drawerRight <= expandedDatabase.rootRight + 1,
      `expanded databases use the full available workspace: ${JSON.stringify(expandedDatabase)}`);
    assert.equal(await sqlEditor.inputValue(), 'SELECT 1\nSELECT 2', 'expanding keeps the SQL draft');
    await page.locator(".drawerHeading").getByRole("button", { name: "返回双栏", exact: true }).click();
    await page.waitForFunction(() => window.maximized === false);
    assert.equal(await sqlEditor.inputValue(), 'SELECT 1\nSELECT 2', 'restoring split view keeps the SQL draft');
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "database-workspace.png") });
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector(".drawerBody")?.scrollTop ?? 0) > 0);
    assert.equal(await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).inputValue(), "/data/local/tmp/projects/photo.png", "returning from the database keeps the file address");
    await page.getByRole("img", { name: "photo.png 的设备图片预览" }).waitFor();
    const moveCountBefore = requests.filter(request => request.action === "move_path").length;
    await page.getByRole("button", { name: "移动文件" }).click();
    await page.getByText("已校验并移动到 /data/local/tmp/projects/photo-copy.png").waitFor();
    assert.equal(requests.filter(request => request.action === "move_path").length, moveCountBefore + 1, "an explicit move click sends exactly one move");
    assert.deepEqual(nativeDialogs, [], "moving a file opens no native confirmation");
    assert.equal(requests.find(request => request.action === "move_path")?.path, "/data/local/tmp/projects/photo.png");
    await page.getByRole("tab", { name: "数据库", exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: '只读 SQL 查询' }).inputValue(), 'SELECT 1\nSELECT 2', 'returning to the database keeps the SQL draft');
    await page.getByRole("button", { name: "重新扫描" }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="只读 SQL 查询"]')?.value === "SELECT 1\nSELECT 2");
    assert.equal(await page.getByRole('tab', { name: 'notes', exact: true }).count(), 1, 'rescan restores object tabs after a new catalog is available');
    await page.getByRole("tab", { name: "命令", exact: true }).click();
    const commandPanel = page.getByRole("region", { name: "设备命令", exact: true });
    await commandPanel.getByLabel("范围", { exact: true }).selectOption("sandbox");
    await commandPanel.getByRole("textbox", { name: "应用包名", exact: true }).fill("dev.piora.audio.fixture");
    await page.locator(".drawerHeading").getByRole("button", { name: "展开设备工作台", exact: true }).click();
    const expandedCommands = await page.evaluate(() => ({
      root: document.querySelector(".root").getBoundingClientRect().width,
      drawer: document.querySelector('.toolDrawer[data-tab="commands"]').getBoundingClientRect().width,
    }));
    assert.ok(expandedCommands.drawer >= expandedCommands.root * .95, "expanded device commands receive the full workspace width");
    const captureControl = page.getByRole("button", { name: "截图", exact: true });
    await captureControl.click({ trial: true });
    assert.equal(await captureControl.evaluate(button => {
      const box = button.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("button") === button;
    }), true, "capturing remains reachable while device commands use the full workspace");
    await page.locator(".drawerHeading").getByRole("button", { name: "返回双栏", exact: true }).click();
    await commandPanel.getByLabel("范围", { exact: true }).selectOption("shared");
    await page.getByRole("tab", { name: "测试", exact: true }).click();
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
    await page.locator(".captureNotice").getByText("截图已保存并复制到剪贴板", { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.copies), [{ kind: "screenshot", path: screenshot.path }]);
    assert.equal(await page.locator(".toolDrawer").isVisible(), false, "capturing does not interrupt the mirror with a drawer");
    await page.keyboard.press("Alt+Shift+s");
    await page.waitForFunction(() => window.copies.length === 2);
    await page.getByRole("button", { name: "查看路径" }).click();
    const mediaHistory = page.getByRole("group", { name: "截图与录屏历史" });
    await mediaHistory.getByRole("article").first().locator("small").filter({ hasText: screenshot.filename }).waitFor();
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await mediaHistory.screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "media-history.png") });
    }
    assert.equal(await mediaHistory.getByRole("article").count(), 2, "saved screenshots and recordings remain listed in Tasks");
    await mediaHistory.getByRole("combobox", { name: "显示" }).selectOption("recording");
    assert.equal(await mediaHistory.getByRole("article").count(), 1);
    await mediaHistory.getByRole("combobox", { name: "显示" }).selectOption("all");
    await mediaHistory.getByRole("button", { name: "复制路径" }).first().click();
    await page.waitForFunction(expected => window.copiedPath === expected, screenshot.path);
    assert.equal(await page.locator(".mediaPath code").textContent(), screenshot.path);
    await page.locator('.mediaThumbnail').evaluate(image => new Promise((resolve, reject) => {
      if (image.complete) return image.naturalWidth > 100 ? resolve() : reject(new Error('Screenshot preview is blank'));
      image.addEventListener('load', () => image.naturalWidth > 100 ? resolve() : reject(new Error('Screenshot preview is blank')), { once: true });
      image.addEventListener('error', () => reject(new Error('Screenshot preview failed to load')), { once: true });
    }));
    const fitViewport = await page.locator(".frameViewport").boundingBox();
    const fitCanvas = await page.locator("canvas").boundingBox();
    assert.ok(fitViewport && fitCanvas);
    assert.ok(fitCanvas.width <= fitViewport.width + 1 && fitCanvas.height <= fitViewport.height + 1, "fit mode keeps the whole device screen visible");
    assert.ok(Math.abs(fitCanvas.width / fitCanvas.height - 1080 / 2400) < 0.01, "fit mode preserves the device aspect ratio");
    if (process.env.PIORA_HARMONY_SCREENSHOT_DIR) {
      await mkdir(process.env.PIORA_HARMONY_SCREENSHOT_DIR, { recursive: true });
      await page.locator("#root").screenshot({ path: path.join(process.env.PIORA_HARMONY_SCREENSHOT_DIR, "workspace.png") });
    }
    await page.locator(".mediaNoticeActions").getByRole("button", { name: "复制路径", exact: true }).click();
    await page.locator(".mediaNoticeActions").getByRole("button", { name: "路径已复制", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.copiedPath), screenshot.path);
    await page.evaluate(() => { window.failPath = true; });
    await page.locator(".mediaNoticeActions").getByRole("button", { name: "路径已复制", exact: true }).click();
    await page.getByText("路径复制失败，请重试", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("button", { name: "停止当前设备操作", exact: true }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    phoneName = "HUAWEI Mate 70 Pro 已刷新";
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.deviceIdentity select').selectedOptions[0].textContent.includes("已刷新"));
    const controlsBeforeRecording = requests.filter(request => request.endpoint === "/api/harmony/manual").length;
    const recordingRequestStart = requests.length, recordingPairStart = recordingPairs.length;
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.getByRole("button", { name: /停止录屏/ }).click();
    await page.locator(".captureNotice").getByText("录屏文件已保存并复制到剪贴板", { exact: true }).waitFor();
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.evaluate(() => { window.failMedia = true; });
    await page.getByRole("button", { name: /停止录屏/ }).click();
    await page.locator(".captureNotice").getByText("录屏文件已保存，但复制失败，可重试或复制路径。", { exact: true }).waitFor();
    const mediaRequests = requests.filter(request => ["capture_screenshot", "start_recording", "stop_recording"].includes(request.action));
    assert.ok(mediaRequests.filter(request => request.action === "capture_screenshot").every(request => request.leaseToken === undefined), "passive screenshots do not require control");
    const recordingRequests = requests.slice(recordingRequestStart).filter(request => ["start_recording", "stop_recording"].includes(request.action));
    assert.ok(recordingRequests.some(request => request.action === "start_recording") && recordingRequests.some(request => request.action === "stop_recording"));
    assert.ok(recordingRequests.every(request => request.leaseToken === undefined && typeof request.ownerId === "string" && request.ownerId.length > 0),
      "independent read-only recording uses its owner identity and never borrows a device control lease");
    assert.equal(new Set(recordingRequests.map(request => request.ownerId)).size, 1, "one recording interval keeps its owner identity");
    for (const pair of recordingPairs.slice(recordingPairStart)) {
      assert.equal(pair.stopped?.ownerId, pair.started.ownerId, "stop uses the owner from its successful start response");
      assert.equal(pair.stopped?.recordingId, pair.started.recordingId, "stop targets its own recording, including after a previous recording ends");
    }
    assert.equal(requests.filter(request => request.endpoint === "/api/harmony/manual").length, controlsBeforeRecording,
      "starting and stopping recording must not acquire or take over device control");
    assert.equal(await page.locator(".mediaPath code").textContent(), video.path);
    await page.evaluate(() => { window.failMedia = false; });
    await page.getByRole("button", { name: "重新复制", exact: true }).click();
    await page.locator(".captureNotice").getByText("录屏文件已保存并复制到剪贴板", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.copies.length), 4);
    await page.getByRole("combobox", { name: "画面缩放" }).selectOption("150");
    assert.equal(await page.getByRole("combobox", { name: "画面缩放" }).inputValue(), "150");
    assert.equal(await page.locator("canvas").evaluate(canvas => canvas.style.width), "1620px");
    await page.getByRole("button", { name: "专注投屏" }).click();
    assert.equal(await page.evaluate(() => window.maximized), true);
    if (await page.locator(".toolDrawer").isVisible()) await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("combobox", { name: "画面缩放" }).selectOption("fit");
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("tab", { name: "语音", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "在所选输出预览语料", exact: true }).isEnabled(), false);
    await page.getByRole("tab", { name: "测试", exact: true }).click();
    await page.getByText("测试通过", { exact: true }).waitFor();
    // Recording is passive. Establish an actual tool session explicitly before
    // testing the global stop fence against a later, still-compiling scenario.
    const toolSessionReady = page.waitForResponse(response => new URL(response.url()).pathname === "/api/harmony/scenario"
      && response.request().method() === "POST");
    await page.getByRole("button", { name: "运行测试", exact: true }).click();
    assert.equal((await toolSessionReady).status(), 200);
    await page.getByText("测试通过", { exact: true }).waitFor();
    await page.getByRole("button", { name: "停止设备任务", exact: true }).waitFor();
    // Stop fences old async preparation too: it cannot acquire a new lease after compilation completes.
    let resolveTemplate;
    delayTemplate = new Promise(resolve => { resolveTemplate = resolve; });
    const scenarioCount = requests.filter(r => r.endpoint === "/api/harmony/scenario").length;
    const compileRequest = page.waitForRequest(request => request.url().endsWith("/templates") && request.method() === "POST");
    await page.getByRole("button", { name: "运行测试", exact: true }).click(); await compileRequest;
    await captureShortcut("Alt+Shift+S");
    assert.equal(await page.getByRole("button", { name: "停止设备任务", exact: true }).isVisible(), true, "capture does not settle or cancel the pending tool");
    await page.getByRole("button", { name: "停止设备任务", exact: true }).click();
    resolveTemplate(); delayTemplate = null;
    await page.getByRole("alert").filter({ hasText: "设备状态已改变" }).waitFor();
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/scenario").length, scenarioCount);
    await page.getByRole("tab", { name: "测试", exact: true }).press("ArrowRight");
    assert.equal(await page.getByRole("tab", { name: "语音", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "语音", exact: true }).press("Escape");
    assert.equal(await page.getByRole("button", { name: "工具", exact: true }).evaluate(button => button === document.activeElement), true);
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await page.getByRole("button", { name: "连接诊断", exact: true }).click();
    const initializationsBeforeExplicitRequest = requests.filter(r => r.action === "initialize_mirror").length;
    assert.equal(initializationsBeforeExplicitRequest, 0, "viewing has not initialized the phone automatically");
    await page.evaluate(() => window.setFixtureFrameMode("frames"));
    await page.getByRole("button", { name: "初始化投屏服务", exact: true }).evaluate(button => { button.click(); button.click(); });
    const initializationNotice = page.locator(".captureNotice");
    await initializationNotice.getByText(/投屏组件已启动。请在手机点击/).waitFor();
    assert.equal(requests.filter(r => r.action === "initialize_mirror").length, initializationsBeforeExplicitRequest + 1,
      "rapid repeated initialization clicks still dispatch exactly once");
    assert.deepEqual(nativeDialogs, [], "mirror initialization never opens a native replacement confirmation");
    assert.equal(await initializationNotice.getByRole("button", { name: "查看路径", exact: true }).count(), 0,
      "initialization guidance has no saved media file to open");
    await page.getByRole("tab", { name: "应用", exact: true }).click();
    assert.equal(await initializationNotice.isVisible(), true, "compatible frames keep phone authorization guidance visible outside the media page");
    await page.evaluate(() => window.setFixtureFrameMode("video"));
    await initializationNotice.waitFor({ state: "hidden" });
    assert.equal(requests.filter(r => r.action === "initialize_mirror").length, 1, "receiving native video never reinitializes the phone");
    await page.getByRole("button", { name: "停止设备任务", exact: true }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByRole("button", { name: "设备设置", exact: true }).click();
    await page.getByRole("button", { name: "按键与触摸校准", exact: true }).click();
    await page.getByRole("combobox", { name: "按键", exact: true }).selectOption("power");
    await page.getByText("将本次校准保存为助手入口（可选）", { exact: true }).waitFor();
    await page.setViewportSize({ width: 360, height: 900 });
    assert.equal(await page.locator("#root").evaluate(root => root.scrollWidth > root.clientWidth), false);
    const focusedNarrowDrawer = await page.locator(".toolDrawer").boundingBox();
    assert.ok(focusedNarrowDrawer.width <= 360 && focusedNarrowDrawer.y < 200 && focusedNarrowDrawer.height > 500,
      "an explicitly expanded workbench keeps the full usable height in a narrow window");
    await page.locator(".drawerHeading").getByRole("button", { name: "返回双栏", exact: true }).click();
    await page.waitForFunction(() => window.maximized === false);
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
    assert.equal(await page.locator(".frame canvas").evaluate(canvas => getComputedStyle(canvas).cursor), "default");
    controls = [];
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    assert.equal(requests.some(r => r.action === "confirm_cleanup"), false, "completed cleanup needs no human confirmation");
    // A server-side state change between polls receives a readable error and refreshes admission.
    const successfulRecordingsBeforeRejection = recordingPairs.length;
    const manualRequestsBeforeRejection = requests.filter(r => r.endpoint === "/api/harmony/manual").length;
    rejectedControlStatus = "recovering";
    await page.getByRole("button", { name: "开始录屏", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "上次设备操作的清理尚未确认" }).waitFor();
    await page.getByText("设备清理尚未确认，暂不能操作或开始录屏", { exact: true }).waitFor();
    assert.equal(recordingPairs.length, successfulRecordingsBeforeRejection, "unconfirmed cleanup cannot start a recording");
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/manual").length, manualRequestsBeforeRejection,
      "recording admission failures do not acquire a manual session");
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), false);
    rejectedControlStatus = null;
    await page.getByRole("button", { name: "检查并恢复", exact: true }).click();
    await page.getByText("恢复清理不确定的设备", { exact: true }).click();
    assert.equal(requests.some(r => r.action === "confirm_cleanup"), false, "opening diagnostics never confirms physical release");
    await page.getByRole("button", { name: "已检查手机并确认释放", exact: true }).click();
    await page.getByText("设备已恢复，可重新操作或录屏。", { exact: true }).waitFor();
    await page.getByText("投屏只读 · 已连接", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "开始录屏", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "关闭工具" }).click();
    // The view-only mirror never interrupts an Agent action or acquires a manual lease.
    holder = { serial: "phone", owner: { id: "agent:one", kind: "agent" }, expiresAt: "2099-01-01T00:00:00Z" };
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    const actionsBeforeAgentMirrorClick = requests.filter(r => ["tap", "swipe", "long_press", "takeover"].includes(r.action)).length;
    await page.locator("canvas").click();
    const manualBeforeAgentCapture = requests.filter(r => r.endpoint === "/api/harmony/manual").length;
    await captureShortcut("Alt+Shift+S");
    assert.equal(requests.filter(r => r.endpoint === "/api/harmony/manual").length, manualBeforeAgentCapture, "capturing during AI ownership never acquires control");
    assert.equal(holder.owner.kind, "agent", "capture keeps the AI holder unchanged");
    await page.waitForTimeout(100);
    assert.equal(requests.filter(r => ["tap", "swipe", "long_press", "takeover"].includes(r.action)).length, actionsBeforeAgentMirrorClick);
    holder = null;
    await page.getByRole("button", { name: "停止当前设备操作", exact: true }).click();
    await page.getByRole("button", { name: "刷新设备", exact: true }).click();
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone2");
    assert.equal(requests.some(r => /unlock|wake/.test(r.action ?? "")), false, "passive viewing never wakes or unlocks the phone");
    assert.equal(requests.filter(r => r.action === "initialize_mirror").length, initializationsBeforeExplicitRequest + 1,
      "only the explicit initialization button deploys the component; changing devices does not");
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone");
    if (!await page.locator(".toolDrawer").isVisible()) await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("tab", { name: "文件", exact: true }).click();
    await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="设备文件或文件夹路径"]')?.value === "/data/local/tmp/projects/photo-copy.png");
    assert.equal(await page.getByRole("textbox", { name: "设备文件或文件夹路径" }).inputValue(), "/data/local/tmp/projects/photo-copy.png", "switching back to a phone restores the moved file's destination");
    await page.getByRole("tab", { name: "数据库", exact: true }).click();
    await page.getByRole("textbox", { name: "只读 SQL 查询" }).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="只读 SQL 查询"]')?.value === "SELECT 1\nSELECT 2");
    assert.equal(await page.getByRole('tab', { name: 'notes', exact: true }).count(), 1, 'switching back restores open database object tabs');
    await page.getByRole("button", { name: "关闭工具" }).click();
    await page.getByRole("combobox", { name: "选择设备", exact: true }).selectOption("phone2");
    const actionsBeforeHidden = requests.filter(r => ["tap", "swipe", "long_press", "takeover"].includes(r.action)).length;
    await page.locator("canvas").click();
    await page.evaluate(() => window.setFixtureActive(false));
    const capturesBeforeHiddenShortcut = captureCount();
    await page.keyboard.press("Alt+Shift+S"); await page.waitForTimeout(100);
    assert.equal(captureCount(), capturesBeforeHiddenShortcut, "inactive Harmony panels do not handle capture shortcuts");
    assert.equal(requests.filter(r => ["tap", "swipe", "long_press", "takeover"].includes(r.action)).length, actionsBeforeHidden);
    assert.deepEqual(errors, []);
    assert.deepEqual(nativeDialogs, [], "the continuous workspace flow opens no native confirmation");
  } finally {
    await browser?.close();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
