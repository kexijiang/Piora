import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createJiti } from "jiti";
import { buildHistoryUI } from "./history-ui-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { buildHistoryIndex, historyPath, historyMarkdown, searchHistory } = await jiti.import("./session-history.ts");
const { readHistoryDetails } = await jiti.import("./session-history-store.ts");
const timestamp = "2026-09-12T03:00:00.000Z";
const row = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message });
const text = text => ({ type: "text", text });
const entries = [
  row("q1", null, { role: "user", content: "检查 MessageView.tsx 的布局" }),
  row("call", "q1", { role: "assistant", content: [{ type: "thinking", thinking: "寻找横向偏移的原因" }, { type: "toolCall", id: "tool", name: "read", arguments: { path: "components/MessageView.tsx" } }] }),
  row("result", "call", { role: "toolResult", toolName: "read", toolCallId: "tool", content: [text("已读取卡片布局代码")], isError: false }),
  row("a1", "result", { role: "assistant", content: [text("已修复卡片的滚动条占位。\n\n正文保持居中，展开时不再移动。")] }),
  { type: "compaction", id: "compact", parentId: "a1", timestamp, summary: "完成布局修复", firstKeptEntryId: "a1", tokensBefore: 1000 },
  row("q2", "compact", { role: "user", content: "验证完整历史里的搜索和分支" }),
  row("a2", "q2", { role: "assistant", content: [text("搜索和分支可以分别查看。\n\n- 搜索保留当前阅读位置。\n- 预览分支不会改变主对话。\n- 使用返回按钮继续工作。")] }),
  row("branch-result", "call", { role: "toolResult", toolName: "read", toolCallId: "tool", content: [text("备用分支读取失败")], isError: true }),
  row("branch-answer", "branch-result", { role: "assistant", content: [text("备用分支保留错误信息。")] }),
];
const header = { type: "session", version: 3, id: "fixture", cwd: "/workspace/piora", timestamp };
const index = buildHistoryIndex(entries, header, "a2", "v1");
const snapshot = { entries, header, index };

test("native history searches saved branches, preserves reading state and fits narrow windows", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-history-ui-"));
  const output = path.resolve(".verification/history-workbench");
  let browser;
  try {
    await mkdir(output, { recursive: true });
    const { bundle, css } = await buildHistoryUI(directory);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("https://history.test/**", async route => {
      const url = new URL(route.request().url()), query = url.searchParams;
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (url.pathname.endsWith("/history")) return route.fulfill({ json: query.has("versionOnly") ? { version: index.version } : index });
      if (url.pathname.endsWith("/entries")) return route.fulfill({ json: { entries: readHistoryDetails(snapshot, query.get("leafId"), query.getAll("entryId"), query.get("original") === "1") } });
      if (url.pathname.endsWith("/search")) return route.fulfill({ json: searchHistory(entries, index, { query: query.get("q") || "", leafId: query.get("scope") === "branch" ? query.get("leafId") : undefined, category: query.get("category") || undefined, failedOnly: query.has("failed"), includeThinking: query.has("thinking") }) });
      if (url.pathname.endsWith("/content")) return route.fulfill({ json: { thinking: "寻找横向偏移的原因" } });
      if (url.pathname.endsWith("/export")) return route.fulfill({ contentType: query.get("format") === "json" ? "application/json" : "text/markdown", body: query.get("format") === "json" ? JSON.stringify({ header, entries }) : historyMarkdown(historyPath(entries, query.get("leafId")), "历史验证") });
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: {} });
      if (url.pathname !== "/") return route.fulfill({ status: 404 });
      return route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="utf-8"><style>${css}html,body,#root{height:100%;margin:0}#root{position:relative}body{font-family:'Microsoft YaHei UI',sans-serif}</style><div id="root"></div><script src="/bundle.js"></script>` });
    });
    await page.goto("https://history.test/");
    await page.locator('[data-history-entry="q2"]').getByText("验证完整历史里的搜索和分支", { exact: true }).waitFor();
    await page.locator('[data-history-entry="a2"]').getByText("搜索和分支可以分别查看。", { exact: false }).waitFor();
    await page.screenshot({ path: path.join(output, "light.png") });
    await page.keyboard.press("Control+f");
    const input = page.getByRole("textbox", { name: "搜索消息、文件或工具输出…" });
    await input.fill("备用分支读取失败");
    const hit = page.locator(".history-nav-item").filter({ hasText: "备用分支读取失败" });
    await hit.click();
    await page.locator('[data-history-entry="branch-result"]').getByText("备用分支读取失败", { exact: true }).waitFor();
    assert.equal(await page.locator(".history-reader-toolbar small").textContent(), "当前对话： 分支 1");
    assert.equal(await page.getByRole("button", { name: "切换到此分支并返回" }).isEnabled(), true);
    await page.getByRole("button", { name: "返回对话", exact: true }).click();
    assert.equal(await page.getByRole("textbox", { name: "主对话草稿" }).inputValue(), "尚未发送的草稿");
    await page.getByRole("button", { name: "完整历史", exact: true }).click();
    await page.locator('[data-history-entry="branch-result"]').getByText("备用分支读取失败", { exact: true }).waitFor();
    assert.equal(await input.inputValue(), "备用分支读取失败");
    await input.fill("");
    await page.getByRole("combobox", { name: "阅读方式" }).selectOption("events");
    await page.locator('[data-history-entry="q1"]').getByText("检查 MessageView.tsx 的布局", { exact: true }).waitFor();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await page.screenshot({ path: path.join(output, "dark.png") });
    await page.setViewportSize({ width: 480, height: 760 });
    const reader = page.locator(".history-reading-column");
    const before = await reader.boundingBox();
    await page.getByRole("button", { name: "导航", exact: true }).click();
    await page.locator(".history-navigation.is-open").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".history-navigation.is-open").waitFor({ state: "hidden" });
    const after = await reader.boundingBox();
    assert.equal(before.x, after.x); assert.equal(before.width, after.width);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, "narrow.png") });
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByRole("button", { name: "完整会话原始 JSON", exact: true }).click();
    const download = await downloaded;
    assert.equal(JSON.parse(await readFile(await download.path(), "utf8")).entries.length, entries.length);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(tmpdir())}${path.sep}piora-history-ui-`));
    await rm(directory, { recursive: true, force: true });
  }
});
