import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";

export const companionPanel = {
  id: "companion-panel",
  scope: "real development Electron companion panel and Turbopack clipboard route",
  coverage: ["open companion panel using keyboard shortcut", "open clipboard tab", "reload clipboard without module format errors"],
  limits: ["release packages", "model calls", "physical display hotplug", "native restart menu"],
  async prepare({ paths, report }) {
    const { ClipboardDatabase } = await createJiti(import.meta.url).import("../../../desktop/src/clipboard-database.ts");
    const database = new ClipboardDatabase(join(paths.profile, "clipboard"));
    try {
      database.mutate({ type: "settings", value: { enabled: false } });
      database.capture({ text: "Piora companion compilation fixture" });
    } finally { database.close(); }
    report.clipboardFixture = "synthetic record; system clipboard capture disabled in isolated profile";
  },
  async run({ page, getBrowser, waitUntil, step, directory }) {
    let panel;
    const errors = [];
    await step("open-companion-panel", async () => {
      await page.keyboard.press("Control+Space");
      panel = await waitUntil(() => getBrowser().contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().includes("/desktop-companion-panel")), "companion panel window");
      panel.on("pageerror", error => errors.push(error.message));
      await panel.getByRole("tab", { name: "剪贴板", exact: true }).waitFor({ timeout: 90_000 });
    });
    await step("open-clipboard", async () => {
      await panel.getByRole("tab", { name: "剪贴板", exact: true }).click();
      await panel.getByRole("textbox", { name: "搜索剪贴板", exact: true }).waitFor({ timeout: 90_000 });
      assert.equal(await panel.getByText("Build Error", { exact: true }).count(), 0);
      await panel.screenshot({ path: join(directory, "companion-clipboard.png") });
    });
    await step("reload-clipboard", async () => {
      await panel.reload({ waitUntil: "domcontentloaded" });
      await panel.getByRole("tab", { name: "剪贴板", exact: true }).click();
      await panel.getByRole("textbox", { name: "搜索剪贴板", exact: true }).waitFor({ timeout: 90_000 });
      assert.deepEqual(errors, []);
    });
  },
};
