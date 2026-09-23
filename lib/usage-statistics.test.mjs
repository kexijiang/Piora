import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  calculateUsageStatistics,
  readSessionUsageRecord,
} = await jiti.import("./usage-statistics.ts");

function sample(timestamp, total, breakdown = {}) {
  return {
    timestamp,
    input: breakdown.input ?? total,
    output: breakdown.output ?? 0,
    cacheRead: breakdown.cacheRead ?? 0,
    cacheWrite: breakdown.cacheWrite ?? 0,
    total,
  };
}

test("calculates all-time token totals, daily peaks, duration, and streaks", () => {
  const day = (date, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  const stats = calculateUsageStatistics([
    {
      startedAt: day("2026-08-27", 10),
      endedAt: day("2026-08-29", 11),
      samples: [
        sample(day("2026-08-27"), 100, { input: 60, output: 40 }),
        sample(day("2026-08-28"), 200, { input: 80, output: 20, cacheRead: 100 }),
        sample(day("2026-08-29"), 300, { input: 100, output: 50, cacheRead: 140, cacheWrite: 10 }),
      ],
    },
    {
      startedAt: day("2026-08-20", 9),
      endedAt: day("2026-08-20", 10),
      samples: [sample(day("2026-08-20"), 500)],
    },
  ], { timezoneOffsetMinutes: 0, now: day("2026-08-29") });

  assert.equal(stats.totals.tokens, 1_100);
  assert.equal(stats.totals.peakDailyTokens, 500);
  assert.equal(stats.totals.longestSessionMs, 49 * 60 * 60 * 1_000);
  assert.equal(stats.totals.currentStreakDays, 3);
  assert.equal(stats.totals.longestStreakDays, 3);
  assert.equal(stats.totals.activeDays, 4);
  assert.equal(stats.totals.sessions, 2);
  assert.deepEqual(stats.breakdown, { input: 740, output: 110, cacheRead: 240, cacheWrite: 10 });
  assert.equal(stats.activity.to, "2026-08-29");
  assert.equal(stats.activity.daily.find((entry) => entry.date === "2026-08-28")?.tokens, 200);
});

test("uses the browser timezone offset when assigning activity days", () => {
  const timestamp = Date.parse("2026-08-29T17:30:00.000Z");
  const stats = calculateUsageStatistics([
    { startedAt: timestamp, endedAt: timestamp, samples: [sample(timestamp, 42)] },
  ], { timezoneOffsetMinutes: -480, now: Date.parse("2026-08-30T02:00:00.000Z") });
  assert.equal(stats.activity.daily.find((entry) => entry.date === "2026-08-30")?.tokens, 42);
  assert.equal(stats.totals.currentStreakDays, 1);
});

test("reads usage without retaining message content and tolerates malformed entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "piora-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "session.jsonl");
  await writeFile(path, [
    JSON.stringify({ type: "session", id: "s", timestamp: "2026-08-29T01:00:00.000Z", cwd: root }),
    JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "2026-08-29T01:01:00.000Z", message: { role: "user", content: "private" } }),
    "{malformed",
    JSON.stringify({ type: "message", id: "a", parentId: "u", timestamp: "2026-08-29T01:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "private response" }], usage: { input: 12, output: 3, cacheRead: 5, cacheWrite: 0, totalTokens: 20 } } }),
  ].join("\n"), "utf8");

  const record = await readSessionUsageRecord(path);
  assert.equal(record.samples.length, 1);
  assert.deepEqual(record.samples[0], { timestamp: Date.parse("2026-08-29T01:03:00.000Z"), input: 12, output: 3, cacheRead: 5, cacheWrite: 0, total: 20 });
  assert.equal(record.endedAt - record.startedAt, 2 * 60_000);
});

test("usage dashboard is wired into settings and protects its local API", async () => {
  const [settings, shell, panel, route] = await Promise.all([
    readFile(new URL("./settings-search.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/AppShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/UsageStatsPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/usage/route.ts", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /key: "usage"/);
  assert.match(settings, /key: "archived"/);
  assert.match(shell, /<UsageStatsPanel \/>/);
  assert.match(panel, /usage\.totalTokens/);
  assert.match(panel, /DailyHeatmap/);
  assert.match(panel, /WeeklyBars/);
  assert.match(panel, /CumulativeChart/);
  assert.match(route, /isApiRequestAllowed\(request\)/);
  assert.match(route, /Cache-Control": "no-store"/);
});
