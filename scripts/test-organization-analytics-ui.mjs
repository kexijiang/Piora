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
      id: "data-diagnostics",
      scope: "Real Electron development UI with an isolated Windows telemetry directory",
      coverage: ["Data settings navigation", "removed settings cards", "unconfigured status API", "reload", "renderer errors"],
      limits: ["production backend enrollment", "real model usage", "packaged Windows app"],
      async run({ page, reload, screenshot, step }) {
        async function open() {
          await page.getByRole("button", { name: /^(Settings|设置)$/ }).click();
          const dialog = page.getByRole("dialog", { name: /^(Settings|设置)$/ });
          await dialog.getByRole("button", { name: /^(Data & Diagnostics|数据与诊断)$/ }).click();
          await dialog.getByRole("heading", { name: /^(Data & Diagnostics|数据与诊断)$/ }).waitFor();
          await dialog.locator('[data-settings-id="general.runtimeLog"]').waitFor();
          assert.equal(await dialog.locator('[data-settings-id="general.organizationAnalytics"], [data-settings-id="general.portability"]').count(), 0);
          for (const name of [/^(Full backup and migration|完整备份与迁移)$/, /^(Interface preferences \(legacy JSON\)|界面偏好（兼容旧版 JSON）)$/, /^(Local credential vault|本地凭据库)$/, /^(Organization usage analytics|组织使用统计)$/]) {
            assert.equal(await dialog.getByText(name).count(), 0);
          }
          return dialog;
        }
        await step("data-settings-without-removed-cards", async () => {
          await open();
          const status = await page.evaluate(async () => {
            const response = await fetch("/api/analytics/status");
            return { status: response.status, body: await response.json() };
          });
          assert.equal(status.status, 200);
          assert.deepEqual(status.body, { supported: true, configured: false, enabled: false });
          await screenshot("data-diagnostics.png");
        });
        await step("reload-preserves-simplified-settings", async () => {
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
