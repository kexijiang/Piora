import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const fixture = {};
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

async function writeSidebarSession(directory, cwd, title, timestamp = new Date().toISOString()) {
  const id = randomUUID();
  await writeFile(join(directory, `${timestamp.replaceAll(":", "-")}_${id}.jsonl`), [
    { type: "session", version: 3, id, cwd, timestamp },
    { type: "message", id: "10000001", parentId: null, timestamp, message: { role: "user", content: title, timestamp: Date.parse(timestamp) } },
    { type: "session_info", id: "10000002", parentId: "10000001", timestamp, name: title },
  ].map(JSON.stringify).join("\n") + "\n");
  return id;
}

export const usageDashboard = {
  id: "usage-dashboard",
  scope: "real Electron settings UI and authenticated local usage API; synthetic on-disk session histories, no model calls",
  coverage: ["monthly totals and category sums", "calendar navigation and day drilldown", "local hourly buckets and zero-usage days", "date selection and range bounds", "refresh preserves selected date", "keyboard tabs", "light/dark themes and narrow renderer layout", "reload", "sidebar pinning and manual reorder", "newly discovered session below pins", "show more/show fewer cycle including an out-of-preview selection"],
  limits: ["real provider usage and billing", "native calendar picker dialogs", "packaged installer", "historical daylight-saving changes", "new chat prompt admission; new session discovery is prepared on disk"],
  async prepare({ paths, directory, report }) {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1, 1);
    const later = new Date(first.getFullYear(), first.getMonth(), 1, 9);
    const third = new Date(first.getFullYear(), first.getMonth(), 3, 5);
    const before = new Date(first.getFullYear(), first.getMonth(), 0, 20);
    fixture.month = dateKey(first).slice(0, 7);
    fixture.day = dateKey(first);
    fixture.emptyDay = dateKey(new Date(first.getFullYear(), first.getMonth(), 2));
    const cwd = join(directory, "project");
    const sessions = join(paths.agent, "sessions", "--usage-dashboard-fixture--");
    await mkdir(cwd);
    await mkdir(sessions, { recursive: true });
    const id = randomUUID();
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp: before.toISOString() },
      { type: "message", id: "10000000", parentId: null, timestamp: before.toISOString(), message: { role: "user", content: "Usage dashboard fixture", timestamp: before.getTime() } },
    ];
    for (const [index, [date, input, output, cacheRead, cacheWrite]] of [
      [before, 90, 0, 0, 0], [first, 60, 10, 20, 10], [later, 120, 40, 40, 0], [third, 200, 60, 120, 20],
    ].entries()) {
      entries.push({ type: "message", id: `2000000${index}`, parentId: index ? `2000000${index - 1}` : "10000000", timestamp: date.toISOString(), message: {
        role: "assistant", content: [{ type: "text", text: "Synthetic usage sample" }], timestamp: date.getTime(),
        usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", provider: "fixture", model: "local-usage-only", api: "openai-completions",
      } });
    }
    await writeFile(join(sessions, `${before.toISOString().replaceAll(":", "-")}_${id}.jsonl`), entries.map(JSON.stringify).join("\n") + "\n");
    fixture.cwd = cwd;
    fixture.sessions = sessions;
    for (let index = 0; index < 8; index++) await writeSidebarSession(sessions, cwd, `Sidebar fixture ${index + 1}`, new Date(first.getTime() + index * 1000).toISOString());
    report.fixture = { ...fixture, monthTokens: 700, dayTokens: 300, monthCalls: 3, dayCalls: 2, allTimeTokens: 790, source: "synthetic session file; usage API is not mocked" };
  },
  async run({ page, step, screenshot, reload, waitUntil, directory }) {
    let dialog;
    const openUsage = async () => {
      await page.getByRole("button", { name: /^(Settings|设置)$/ }).click();
      dialog = page.getByRole("dialog", { name: /^(Settings|设置)$/ });
      await dialog.getByRole("button", { name: /^(Usage|使用量)$/ }).click();
      await dialog.getByRole("tab", { name: /^(Monthly dashboard|月度看板)$/ }).waitFor();
    };
    const panel = () => dialog.getByRole("tabpanel");
    const metric = key => panel().locator(`[data-metric="${key}"] dd`);
    const assertMetric = async (key, expected) => assert.equal(await metric(key).innerText(), expected);
    const monthlyTab = () => dialog.getByRole("tab", { name: /^(Monthly dashboard|月度看板)$/ });
    const dailyTab = () => dialog.getByRole("tab", { name: /^(Daily dashboard|每日看板)$/ });
    const dateInput = () => dialog.getByLabel(/^(Select date|选择日期)$/);
    const monthInput = () => dialog.getByLabel(/^(Select month|选择月份)$/);
    const selectFixtureMonth = async () => {
      await monthlyTab().click();
      await monthInput().fill(fixture.month);
      await waitUntil(async () => await metric("tokens").innerText() === "700", "selected month tokens");
    };

    const verifySidebar = async () => {
    await step("sidebar-pins-manual-order-and-new-session", async () => {
      let project = page.locator("section[data-project-drag-root]").first();
      const rows = () => project.locator("[data-session-drag-id]");
      await rows().first().waitFor();
      assert.equal(await rows().count(), 5);
      const pinId = await rows().first().getAttribute("data-session-drag-id");
      await rows().first().click({ button: "right" });
      const pinned = page.waitForResponse(response => response.url().endsWith("/api/sessions/flags") && response.request().method() === "PATCH");
      await page.getByRole("menuitem", { name: /^(Pin task|置顶任务)$/ }).click();
      assert.equal((await pinned).ok(), true);
      await waitUntil(async () => await rows().first().getAttribute("data-session-drag-id") === pinId, "pinned task stays first");
      await project.getByRole("button", { name: /^(Show .* more|显示更多)/ }).click();
      await project.getByRole("button", { name: /^(Show fewer|收起会话)$/ }).waitFor();
      assert.equal(await rows().count(), 9);
      const source = await rows().nth(2).boundingBox(), target = await rows().nth(1).boundingBox();
      assert.ok(source && target);
      await page.mouse.move(source.x + 70, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(target.x + 70, target.y + 3, { steps: 8 });
      await page.mouse.up();
      await waitUntil(() => page.evaluate(() => JSON.parse(localStorage.getItem("piora:sidebar-session-order:v1") ?? "[]").length === 9), "manual session order persisted");
      const created = await writeSidebarSession(fixture.sessions, fixture.cwd, "New sidebar fixture");
      // On-disk fixture preparation bypasses prompt admission's normal catalog
      // invalidation. Wait for the real reader's cache to discover the file.
      await waitUntil(() => page.evaluate(async id => {
        const data = await (await fetch("/api/sessions")).json();
        return data.sessions.some(session => session.id === id);
      }, created), "synthetic new session indexed by the real catalog");
      await reload();
      project = page.locator("section[data-project-drag-root]").first();
      await waitUntil(async () => await rows().nth(1).getAttribute("data-session-drag-id") === created, "new session directly below pinned task");
      assert.equal(await rows().first().getAttribute("data-session-drag-id"), pinId);
      await screenshot("sidebar-new-session-below-pin.png");
    });
    await step("sidebar-show-more-and-show-fewer-cycle", async () => {
      const project = page.locator("section[data-project-drag-root]").first();
      const rows = project.locator("[data-session-drag-id]");
      const more = project.getByRole("button", { name: /^(Show .* more|显示更多)/ });
      const fewer = project.getByRole("button", { name: /^(Show fewer|收起会话)$/ });
      while (await more.isVisible()) await more.click();
      await fewer.waitFor();
      assert.equal(await rows.count(), 10);
      const selected = await rows.last().getAttribute("data-session-drag-id");
      const selectedTitle = await rows.last().getAttribute("aria-label");
      await rows.last().click();
      await waitUntil(async () => await project.locator(`[data-session-drag-id="${selected}"]`).getAttribute("aria-selected") === "true", "history selection committed");
      await page.locator(".message-row-user").filter({ hasText: selectedTitle }).first().waitFor();
      // The loaded history commits its project/cwd after the initial row click.
      // Establish the fully expanded precondition after that UI transition.
      while (await more.isVisible()) await more.click();
      await fewer.waitFor();
      assert.equal(await rows.count(), 10);
      await screenshot("sidebar-expanded-selected-history.png");
      await fewer.click();
      await waitUntil(async () => await rows.count() === 5, "collapse to exactly five tasks despite selected hidden task");
      await more.waitFor();
      await rows.first().click({ button: "right" });
      const unpinned = page.waitForResponse(response => response.url().endsWith("/api/sessions/flags") && response.request().method() === "PATCH");
      await page.getByRole("menuitem", { name: /^(Unpin task|取消置顶任务)$/ }).click();
      assert.equal((await unpinned).ok(), true);
      await waitUntil(async () => await rows.count() === 5, "catalog refresh preserves explicit five-row collapse");
      await more.click();
      await fewer.waitFor();
      assert.equal(await rows.count(), 10);
      await screenshot("sidebar-expanded-again.png");
      await fewer.click();
      assert.equal(await rows.count(), 5);
      await more.waitFor();
      await screenshot("sidebar-collapsed-five.png");
    });
    };

    await step("open-usage-and-empty-current-month", async () => {
      await openUsage();
      assert.equal(await monthlyTab().getAttribute("aria-selected"), "true");
      await assertMetric("tokens", "0");
      await panel().getByText(/^(No usage recorded in this period|此周期暂无使用记录)$/).waitFor();
      assert.equal(await dialog.getByRole("button", { name: /^(Next month|下个月)$/ }).isDisabled(), true);
    });
    await step("monthly-calendar-and-real-local-api", async () => {
      await dialog.getByRole("button", { name: /^(Previous month|上个月)$/ }).click();
      assert.equal(await monthInput().inputValue(), fixture.month);
      await assertMetric("tokens", "700");
      await assertMetric("turns", "3");
      await assertMetric("activeDays", "2");
      const breakdown = panel().getByRole("region", { name: /^(Token composition|Token 构成)$/ });
      assert.deepEqual(await breakdown.locator("dd").allTextContents(), ["380", "110", "180", "30"]);
      const data = await page.evaluate(async () => (await fetch(`/api/usage?timezoneOffset=${new Date().getTimezoneOffset()}&days=365`)).json());
      assert.equal(data.totals.tokens, 790);
      assert.equal(data.activity.daily.find(day => day.date === fixture.day).tokens, 300);
      await writeFile(join(directory, "usage-evidence.json"), JSON.stringify({ totals: data.totals, day: data.activity.daily.find(day => day.date === fixture.day) }, null, 2));
      await screenshot("usage-monthly-light.png");
    });
    await step("monthly-day-drilldown-and-hourly-chart", async () => {
      await panel().getByRole("button", { name: /300 (tokens|Token).*2 (calls|次调用)/ }).click();
      assert.equal(await dailyTab().getAttribute("aria-selected"), "true");
      assert.equal(await dateInput().inputValue(), fixture.day);
      await assertMetric("tokens", "300");
      await assertMetric("turns", "2");
      await assertMetric("peakHour", "09:00");
      assert.equal(await panel().getByRole("img").count(), 24);
      assert.equal(await panel().getByRole("img", { name: /01:00.*100 (tokens|Token)/ }).count(), 1);
      assert.equal(await panel().getByRole("img", { name: /09:00.*200 (tokens|Token)/ }).count(), 1);
      await screenshot("usage-daily-light.png");
    });
    await step("empty-day-date-picker-and-refresh", async () => {
      await dialog.getByRole("button", { name: /^(Next day|后一天)$/ }).click();
      assert.equal(await dateInput().inputValue(), fixture.emptyDay);
      await assertMetric("tokens", "0");
      await assertMetric("turns", "0");
      await assertMetric("peakHour", "—");
      await dateInput().fill(fixture.day);
      await dialog.getByRole("button", { name: /^(Refresh|刷新)$/ }).click();
      await dialog.getByRole("button", { name: /^(Refresh|刷新)$/ }).waitFor();
      assert.equal(await dateInput().inputValue(), fixture.day);
      await assertMetric("tokens", "300");
      await dialog.getByRole("button", { name: /^(Today|今天)$/ }).click();
      assert.equal(await dialog.getByRole("button", { name: /^(Next day|后一天)$/ }).isDisabled(), true);
      await dateInput().fill(await dateInput().getAttribute("min"));
      assert.equal(await dialog.getByRole("button", { name: /^(Previous day|前一天)$/ }).isDisabled(), true);
    });
    await step("keyboard-tabs-and-range-boundaries", async () => {
      await dailyTab().focus();
      await page.keyboard.press("Home");
      assert.equal(await monthlyTab().getAttribute("aria-selected"), "true");
      await page.keyboard.press("ArrowRight");
      assert.equal(await dailyTab().getAttribute("aria-selected"), "true");
      await monthlyTab().click();
      await monthInput().fill(await monthInput().getAttribute("min"));
      assert.equal(await dialog.getByRole("button", { name: /^(Previous month|上个月)$/ }).isDisabled(), true);
      await selectFixtureMonth();
    });
    await step("dark-theme-and-narrow-layout", async () => {
      await dialog.getByRole("button", { name: /^(Appearance & Language|外观与界面)$/ }).click();
      await dialog.locator('[role="radio"][data-theme-id="dark"]').click();
      await waitUntil(() => page.evaluate(() => document.documentElement.dataset.theme === "dark"), "dark theme applied");
      await dialog.getByRole("button", { name: /^(Usage|使用量)$/ }).click();
      await monthlyTab().waitFor();
      await selectFixtureMonth();
      await screenshot("usage-monthly-dark.png");
      await page.setViewportSize({ width: 760, height: 900 });
      await assertMetric("tokens", "700");
      const twoColumns = await panel().evaluate(element => {
        const cards = [...element.querySelector("dl").children].map(card => card.getBoundingClientRect());
        return Math.abs(cards[0].top - cards[1].top) < 1 && cards[2].top > cards[0].top;
      });
      assert.equal(twoColumns, true, "narrow metrics must reflow into two columns");
      const chartFits = await panel().getByRole("region", { name: /^(Daily usage trend|每日用量趋势)$/ }).evaluate(section => {
        const viewport = section.lastElementChild;
        return viewport.scrollHeight <= viewport.clientHeight + 1 && viewport.scrollWidth <= viewport.clientWidth + 1;
      });
      assert.equal(chartFits, true, "narrow trend must fit without clipped labels or nested scrolling");
      await screenshot("usage-monthly-narrow-dark.png");
      await page.setViewportSize({ width: 1280, height: 900 });
    });
    await step("reload-and-verify-daily-data", async () => {
      await reload();
      await openUsage();
      await dailyTab().click();
      await dateInput().fill(fixture.day);
      await assertMetric("tokens", "300");
      await assertMetric("turns", "2");
      await assertMetric("peakHour", "09:00");
      await screenshot("usage-daily-dark-restored.png");
    });
    await dialog.getByRole("button", { name: /^(Back to|返回) ?Piora$/ }).click();
    await verifySidebar();
  },
};
