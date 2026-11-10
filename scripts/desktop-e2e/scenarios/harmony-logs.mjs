import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";

const fixture = { a: randomUUID(), b: randomUUID(), serial: "LOG-FIXTURE-ONLY" };
export const harmonyLogs = {
  id: "harmony-logs",
  scope: "real Electron and authenticated Next log API, real indexing/search workers; synthetic files and device stream",
  coverage: ["text/ZIP/GZ import through UI", "paging", "cross-file search and original-line navigation", "live capture/save", "editable draft preserving text", "session isolation", "persistence", "desktop authentication"],
  limits: ["real HDC/HiLog device capture", "official hilogtool/dictionary", "packaged installer", "large-file and sustained performance"],
  async prepare({ paths, directory, report }) {
    const cwd = join(directory, "project");
    const sessionDirectory = join(paths.agent, "sessions", "--log-workbench-fixture--");
    await mkdir(cwd); await mkdir(sessionDirectory, { recursive: true });
    for (const [label, id] of [["A", fixture.a], ["B", fixture.b]]) {
      const timestamp = new Date().toISOString();
      await writeFile(join(sessionDirectory, `2026-11-10T00-00-00-000Z_${id}.jsonl`), [
        { type: "session", version: 3, id, cwd, timestamp },
        { type: "message", id: "10000001", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: "Log test fixture " + label }], timestamp: Date.now() } },
        { type: "session_info", id: "10000002", parentId: "10000001", name: "日志工作台夹具 " + label, timestamp },
      ].map(JSON.stringify).join("\n") + "\n");
    }
    const rows = Array.from({ length: 520 }, (_, index) => `11-10 12:00:00.000 123 124 ${index % 100 === 0 ? "E" : "I"} C0D001 Test: ${index % 100 === 0 ? "needle" : "normal"} line-${index + 1}`);
    await writeFile(join(directory, "primary.log"), rows.join("\n") + "\n");
    const zip = new JSZip(); zip.file("sub/archived.log", "11-10 12:01:00.000 123 124 E C0D001 Zip: needle zip\n");
    await writeFile(join(directory, "bundle.zip"), await zip.generateAsync({ type: "nodebuffer" }));
    await writeFile(join(directory, "second.log.gz"), gzipSync(Buffer.from("11-10 12:02:00.000 123 124 E C0D001 Gzip: needle gz\n")));
    report.fixture = { sessions: fixture, sourceLines: 522, expectedCrossFileHits: 8, device: "synthetic; no physical device requests" };
  },
  async run({ page, directory, step, screenshot, reload, waitUntil }) {
    const agentPosts = [];
    page.on("request", request => { if (request.method() === "POST" && /\/api\/agent\//.test(request.url())) agentPosts.push(request.url()); });
    await page.route("**/api/harmony/devices", route => route.fulfill({ json: { devices: [{ serial: fixture.serial, name: "Log fixture", state: "online", generation: 1, capabilities: {} }], state: { runtime: { status: "ready" }, leases: [], snapshots: [], controls: [] } } }));
    await page.route("**/api/harmony/apps?*", route => route.fulfill({ json: { applications: [{ bundleName: "dev.piora.logs", label: "Log fixture" }] } }));
    await page.route("**/api/harmony/logs?*", route => route.fulfill({ json: { processes: [{ pid: 123, name: "dev.piora.logs" }] } }));
    await page.context().addInitScript(() => {
      const native = window.EventSource;
      window.logFixtureStreams = 0;
      window.EventSource = function (url, options) {
        if (!String(url).includes("/api/harmony/logs/events?")) return new native(url, options);
        window.logFixtureStreams++;
        const source = new EventTarget();
        const emit = () => source.dispatchEvent(new MessageEvent("logs", { data: JSON.stringify({ entries: [{ timestamp: "11-10 12:03:00.000", pid: 123, tid: 124, level: "error", domain: "C0D001", tag: "Live", message: "live fixture needle", raw: "11-10 12:03:00.000 123 124 E C0D001 Live: live fixture needle" }] }) }));
        const timer = setInterval(emit, 1000);
        setTimeout(() => { source.dispatchEvent(new MessageEvent("connected", { data: "{}" })); emit(); }, 50);
        source.close = () => clearInterval(timer);
        return source;
      };
      window.EventSource.CONNECTING = 0; window.EventSource.OPEN = 1; window.EventSource.CLOSED = 2;
    });
    const openLogs = async () => {
      const toggle = page.locator(".right-panel-toggle");
      if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
      await page.getByRole("button", { name: /^(Harmony device|鸿蒙设备)$/ }).click();
      await page.getByRole("button", { name: /^(Log workbench|日志工作台)$/, exact: true }).click();
      await page.getByRole("tab", { name: /^(Session logs|会话日志)$/ }).click();
    };
    const logs = page.locator(".piora-log-workbench");
    let imported;
    await step("open-session-log-workbench", async () => {
      await page.goto(new URL(`/?session=${fixture.a}`, page.url()).href, { timeout: 120000 });
      await page.locator(".app-shell").waitFor(); await openLogs();
      await logs.getByRole("button", { name: "导入日志", exact: true }).waitFor();
    });
    await step("import-text-zip-gzip", async () => {
      await logs.locator('input[type="file"]').setInputFiles(["primary.log", "bundle.zip", "second.log.gz"].map(name => join(directory, name)));
      await waitUntil(async () => { const items = await logs.locator(".queue-item").allTextContents(); return items.length === 3 && items.every(text => text.includes("完成")); }, "three UI imports completed");
      await logs.getByRole("button", { name: "打开 primary.log", exact: true }).click();
      await logs.locator('tr[data-source-line="1"]').waitFor();
      assert.equal(await logs.locator(".log-message-preview").filter({ hasText: "line-1" }).count() > 0, true);
      await logs.getByRole("button", { name: "下一页", exact: true }).last().click();
      await logs.locator('tr[data-source-line="501"]').waitFor();
      imported = await page.evaluate(async sessionId => (await fetch("/api/harmony/log-library/list?" + new URLSearchParams({ sessionId, limit: "20" }))).json(), fixture.a);
      assert.equal(imported.total, 5);
      await screenshot("session-files.png");
    });
    await step("search-all-files-and-jump", async () => {
      await logs.getByRole("button", { name: "跨文件查找", exact: true }).click();
      await logs.getByRole("textbox", { name: "跨文件查找目标" }).fill("needle");
      await logs.getByRole("button", { name: "查找全部", exact: true }).click();
      await waitUntil(async () => (await logs.locator(".session-search-batch-label").textContent()).includes("匹配 8 次"), "eight hits across three files");
      await logs.locator(".session-search-hit").first().dblclick();
      await logs.getByText(/原文件第 \d+ 行及前后 8 行/).waitFor();
      assert.equal(await logs.locator("tr.source-focus").count(), 1);
      await screenshot("cross-file-search.png");
    });
    await step("live-save-and-open-session-file", async () => {
      await page.getByRole("tab", { name: /^(Live logs|实时日志)$/ }).click();
      await page.locator('[role="log"]').getByText("live fixture needle", { exact: true }).first().waitFor();
      const streams = await page.evaluate(() => window.logFixtureStreams);
      await page.getByRole("button", { name: /^(Save to session|保存到当前会话)$/ }).click();
      await page.getByRole("button", { name: /^(View file|查看文件)$/ }).click();
      assert.equal(await page.evaluate(() => window.logFixtureStreams), streams, "switching internal tabs must keep the capture");
      await logs.locator(".library-document-name").getByText(/\.log/).waitFor();
    });
    await step("add-editable-draft-preserving-text", async () => {
      const composer = page.locator('textarea[aria-autocomplete="list"]');
      await composer.fill("保留的草稿");
      await logs.getByRole("button", { name: "加入对话", exact: true }).click();
      await waitUntil(async () => (await composer.inputValue()).includes("路径："), "analysis paths inserted");
      const draft = await composer.inputValue();
      assert.ok(draft.includes("保留的草稿")); assert.ok(draft.includes("问题："));
      const analysis = draft.match(/路径：([^\n]+)/)?.[1]; assert.ok(analysis);
      assert.ok((await readFile(analysis, "utf8")).includes("live fixture needle"));
      assert.deepEqual(agentPosts, [], "adding a draft must not send it");
      await screenshot("analysis-draft.png");
    });
    await step("reject-cross-session-and-unauthenticated-access", async () => {
      const id = imported.files.find(file => file.name === "primary.log").id;
      const isolated = await page.evaluate(async ({ id, sessionId }) => {
        const response = await fetch("/api/harmony/log-library/logs?" + new URLSearchParams({ id, sessionId })); return { status: response.status, body: await response.json() };
      }, { id, sessionId: fixture.b });
      assert.equal(isolated.status, 400); assert.ok(isolated.body.error);
      const response = await fetch(new URL("/api/harmony/log-library/list?sessionId=" + fixture.a, page.url()));
      assert.equal(response.status, 403);
    });
    await step("reload-retains-session-files", async () => {
      await reload(); await openLogs();
      await logs.getByRole("button", { name: "打开 primary.log", exact: true }).waitFor();
      const restored = await page.locator('textarea[aria-autocomplete="list"]').inputValue();
      assert.ok(restored.includes("保留的草稿"));
      assert.deepEqual(agentPosts, []);
      await screenshot("restored.png");
    });
  },
};
