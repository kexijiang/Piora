// Run against an existing dev server. All personal-data APIs use an isolated fixture.
// node scripts/verify-companion-panel.mjs [http://127.0.0.1:30141]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright-core";

const baseURL = process.argv[2] || "http://127.0.0.1:30141";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 920, height: 760 }, locale: "zh-CN", serviceWorkers: "block" });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("requestfailed", (request) => console.error("Request failed:", request.url(), request.failure()?.errorText));
let state = {
  version: 3, updatedAt: 1, migratedFromLocalStorage: true,
  settings: { interactionModel: null, shareWorkContext: true, autonomyLevel: "balanced", autonomyPaused: false, personality: "温暖、克制", quietHours: { enabled: false, start: "22:30", end: "08:00" }, allowMovement: true, allowProactiveSpeech: true, autoCaptureSessions: true },
  todos: [], taskRecords: [], library: [], memories: [],
  focusTimer: { phase: "focus", status: "idle", durations: { focus: 1500, "short-break": 300, "long-break": 900 }, longBreakEvery: 4, autoStartNextPhase: false, petReminderEnabled: true, durationSeconds: 1500, remainingSeconds: 1500, startedAt: null, endsAt: null, linkedTodoId: null, completedFocusSessions: 0 },
  mind: { mood: "calm", lastDecision: null, decisionHistory: [], nextWakeAt: null },
};
let transferItems = [];
let workspace = { revision: 0, workbench: null };
const directories = { library: "D:\\Piora\\transfer", json: "D:\\Piora\\json" };
await context.route("**/api/**", async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === "/api/companion/json-workspace") {
    if (route.request().method() === "PUT") {
      const input = route.request().postDataJSON();
      if (input.revision !== workspace.revision) return route.fulfill({ status: 409, json: { error: "revision conflict" } });
      workspace = { revision: workspace.revision + 1, workbench: input.workbench };
      return route.fulfill({ json: { revision: workspace.revision } });
    }
    return route.fulfill({ json: workspace });
  }
  if (path === "/api/companion/storage") {
    const scope = new URL(route.request().url()).searchParams.get("scope") || "library";
    if (route.request().method() === "PUT") directories[scope] = route.request().postDataJSON().directory;
    return route.fulfill({ json: { storage: { directory: directories[scope], defaultDirectory: "D:\\default", dataFile: directories[scope] + "\\data.json", configFile: "D:\\config.json", customized: true } } });
  }
  if (path === "/api/companion/library") {
    if (route.request().method() === "POST") {
      const input = route.request().postDataJSON();
      transferItems.unshift({ id: crypto.randomUUID(), ...input, title: input.title || (input.kind === "image" ? "暂存图片" : input.content.split("\n")[0]), pinned: false, createdAt: Date.now(), updatedAt: Date.now() });
    } else if (route.request().method() === "PATCH") {
      const input = route.request().postDataJSON();
      transferItems = input.remove ? transferItems.filter((item) => item.id !== input.id) : transferItems.map((item) => item.id === input.id ? { ...item, ...input } : item);
    }
    return route.fulfill({ json: { items: transferItems } });
  }
  if (path === "/api/companion/state") {
    if (route.request().method() === "PUT") state = { ...route.request().postDataJSON().state, updatedAt: Date.now() };
    return route.fulfill({ json: state });
  }
  if (path === "/api/models") return route.fulfill({ json: { modelList: [] } });
  if (path === "/api/agent/running") return route.fulfill({ json: { runningSessions: [] } });
  return route.fulfill({ json: {} });
});
const tab = (name) => page.getByRole("tab", { name: name === "待办" ? /^待办(?:\s+\d+)?$/ : name, exact: true });
const button = (name) => page.getByRole("button", { name, exact: true });
const editor = () => page.getByRole("textbox", { name: "JSON 编辑器，带行号和折叠功能" });
const editorText = () => editor().innerText();
const assertEventually = async (check) => {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    try { await check(); return; } catch (error) { if (Date.now() + 100 >= until) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
try {
  const hydrated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/companion/state", { timeout: 60000 });
  await page.bringToFront();
  await Promise.all([page.goto(`${baseURL}/desktop-companion-panel`, { waitUntil: "domcontentloaded", timeout: 60000 }), hydrated]);
  console.log("Loaded and hydrated companion panel");
  await page.getByRole("textbox", { name: "搜索工具", exact: true }).fill("json");
  await page.keyboard.press("Enter");
  await assertEventually(async () => assert.equal(await tab("JSON").getAttribute("aria-selected"), "true"));
  await button("试试示例 →").click();
  await button("压缩").click();
  console.log("Testing JSON editing and undo");
  await assertEventually(async () => assert.equal(JSON.parse(await editorText()).hello, "Piora"));
  assert.equal((await editorText()).trim().split("\n").length, 1);
  await editor().click();
  await page.keyboard.press("Control+z");
  await assertEventually(async () => { assert.ok((await editorText()).trim().includes("\n"), "minify is undoable"); assert.equal(JSON.parse(await editorText()).hello, "Piora"); });
  const original = await editorText();
  await button("新建标签").click();
  await editor().fill('{"second":true}');
  await tab("临时").click();
  assert.equal(await editorText(), original);
  await tab("标签 1").click();
  assert.deepEqual(JSON.parse(await editorText()), { second: true });
  await tab("待办").click();
  await tab("JSON").click();
  assert.deepEqual(JSON.parse(await editorText()), { second: true });
  await tab("临时").click();
  await assertEventually(async () => assert.equal(workspace.workbench?.temporaryContent, original));
  const rehydrated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/companion/state", { timeout: 60000 });
  await Promise.all([page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }), rehydrated]);
  await tab("JSON").click();
  await assertEventually(async () => assert.equal(await editorText(), original, "scratch survives reload"));
  await editor().fill('{"broken":}');
  await button("格式化").click();
  await page.getByRole("alert").filter({ hasText: "第 1 行" }).waitFor();
  await editor().fill('{"id":9223372036854775807}');
  await button("格式化").click();
  assert.match(await editorText(), /9223372036854775807/);
  await editor().fill('"%E4%BD%A0%E5%A5%BD"');
  await button("URL").click();
  assert.match(await editorText(), /你好/);
  await button("导入文件").click();
  // The chooser is dismissed by setting the input directly in this isolated context.
  await page.locator('input[type="file"]').setInputFiles({ name: "imported.json", mimeType: "application/json", buffer: Buffer.from('{"imported":true}') });
  await assertEventually(async () => assert.deepEqual(JSON.parse(await editorText()), { imported: true }));
  const downloadPromise = page.waitForEvent("download");
  await button("导出文件").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "imported.json");
  await button("暂存到中转站").click();
  await assertEventually(async () => assert.equal(transferItems.length, 1));
  await tab("中转站").click();
  await button("置顶 imported").click();
  await assertEventually(async () => assert.equal(transferItems[0].pinned, true));
  await page.getByRole("textbox", { name: "搜索暂存内容" }).fill("no-match");
  await page.getByText("没有找到相关内容").waitFor();
  await page.getByRole("textbox", { name: "搜索暂存内容" }).fill("");
  const station = page.getByRole("region", { name: "中转站", exact: true });
  assert.equal(await station.locator('input[type="file"]').count(), 0, "transfer station must have no file picker");
  await page.evaluate(() => { const data = new DataTransfer(); data.setData("text/plain", "随手粘贴的文字"); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); });
  await assertEventually(async () => assert.ok(transferItems.some((item) => item.content === "随手粘贴的文字")));
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6EAAAAABJRU5ErkJggg==";
  await page.evaluate((pixel) => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(pixel), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" })); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, pixel);
  await assertEventually(async () => assert.equal(transferItems.filter((item) => item.kind === "image").length, 1));
  await station.evaluate((element, pixel) => { const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(pixel), (c) => c.charCodeAt(0))], "dropped.png", { type: "image/png" })); element.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })); }, pixel);
  await assertEventually(async () => assert.equal(transferItems.filter((item) => item.kind === "image").length, 2));
  await button("预览 dropped.png").click();
  await page.getByRole("dialog").waitFor();
  await button("关闭预览").click();
  await button("中转站存储位置").click();
  const storage = page.getByRole("region", { name: "中转站存储位置", exact: true });
  await storage.getByRole("button", { name: "更改", exact: true }).click();
  await storage.getByLabel("数据文件夹").fill("D:\\MyPocket");
  await storage.getByRole("button", { name: "迁移并应用", exact: true }).click();
  await assertEventually(async () => assert.equal(directories.library, "D:\\MyPocket"));
  await button("中转站存储位置").click();
  console.log("Verified image paste/drop, quick text capture, preview and configurable transfer path");
  await tab("待办").click();
  await page.getByPlaceholder("添加一个待办任务").fill("验收待办");
  await button("添加").click();
  await button("完成：验收待办").click();
  await assertEventually(async () => assert.equal(state.todos[0].completed, true));
  await button("查看已完成").click();
  await button("标为未完成：验收待办").click();
  await assertEventually(async () => assert.equal(state.todos[0].completed, false));
  await tab("专注").click();
  await button("开始").click();
  await button("暂停").click();
  await assertEventually(async () => assert.equal(state.focusTimer.status, "paused"));
  await button("重置").click();
  await assertEventually(async () => assert.equal(state.focusTimer.status, "idle"));
  await mkdir(".verification/companion-panel", { recursive: true });
  for (const width of [420, 620, 1280]) {
    await page.setViewportSize({ width, height: 760 });
    for (const name of ["工具台", "JSON", "待办", "专注", "中转站", "陪伴", "记忆", "设置"]) {
      await tab(name).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: no page overflow at ${width}px`);
    }
    await tab("JSON").click();
    await page.mouse.move(width - 2, 2);
    await page.screenshot({ path: `.verification/companion-panel/json-${width}.png` });
    await tab("工具台").click();
    await page.mouse.move(width - 2, 2);
    await page.screenshot({ path: `.verification/companion-panel/home-${width}.png` });
    await tab("中转站").click();
    await page.mouse.move(width - 2, 2);
    await page.screenshot({ path: `.verification/companion-panel/transfer-${width}.png` });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.classList.add("dark"); document.documentElement.style.colorScheme = "dark"; });
  await tab("JSON").click();
  await page.screenshot({ path: ".verification/companion-panel/json-dark.png" });
  assert.deepEqual(errors, [], "no browser errors");
  console.log("PASS: navigation, JSON format/minify/undo, independent tabs, scratch restore, syntax errors, large integers, URL decoding, import/export, library save/search/pin, todo completion, focus controls, responsive layouts, dark theme.");
} catch (error) {
  await mkdir(".verification/companion-panel", { recursive: true });
  await page.screenshot({ path: ".verification/companion-panel/failure.png" }).catch(() => {});
  console.error((await page.locator("body").innerText({ timeout: 2000 }).catch(() => "Page body unavailable")).slice(0, 1800));
  throw error;
} finally {
  await browser.close();
}
