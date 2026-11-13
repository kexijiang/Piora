import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runDesktopScenario } from "./desktop-e2e/harness.mjs";

const root = resolve(import.meta.dirname, "..");
await mkdir(join(root, ".verification"), { recursive: true });
const profile = await mkdtemp(join(root, ".verification", "analytics-ui-profile-"));
const previous = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = profile;
const controller = new AbortController();
const stop = () => controller.abort(new Error("Analytics UI test interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const result = await runDesktopScenario({
    root,
    signal: controller.signal,
    timeoutMs: 600000,
    stepTimeoutMs: 60000,
    scenario: {
      id: "organization-analytics",
      scope: "Real Electron development UI with an isolated Windows telemetry directory",
      coverage: ["Data settings navigation", "unconfigured status API", "refresh and reload", "renderer errors"],
      limits: ["production backend enrollment", "real model usage", "packaged Windows app"],
      async run({ page, reload, screenshot, step, waitUntil }) {
        async function open() {
          await page.getByRole("button", { name: /^(Settings|设置)$/ }).click();
          const dialog = page.getByRole("dialog", { name: /^(Settings|设置)$/ });
          await dialog.getByRole("button", { name: /^(Data & Diagnostics|数据与诊断)$/ }).click();
          const section = dialog.locator('[data-settings-id="general.organizationAnalytics"]');
          await waitUntil(async () => /Not configured|未配置组织统计/.test(await section.innerText()), "unconfigured organization status");
          return section;
        }
        await step("read-status-through-settings", async () => {
          const section = await open();
          const response = page.waitForResponse(r => r.url().endsWith("/api/analytics/status"));
          await section.getByRole("button", { name: /^(Refresh status|刷新状态)$/ }).click();
          const res = await response;
          assert.equal(res.status(), 200);
          assert.deepEqual(await res.json(), { supported: true, configured: false, enabled: false });
          await screenshot("organization-statistics-disabled.png");
        });
        await step("reload-and-read-status", async () => {
          await reload();
          await open();
        });
      },
    },
  });
  console.log(JSON.stringify({ status: result.report.status, directory: result.directory, error: result.report.error }));
  process.exitCode = result.report.status === "passed" ? 0 : 1;
} finally {
  if (previous === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previous;
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
