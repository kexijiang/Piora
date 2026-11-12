import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { calculateUsageStatistics } = await jiti.import("./usage-statistics.ts");
const { buildUsageDashboard, shiftUsagePeriod, usagePeriodBounds } = await jiti.import("./usage-dashboard.ts");

function statistics(samples = [], now = "2026-03-03T05:00:00Z", timezoneOffsetMinutes = 0) {
  return calculateUsageStatistics([{ startedAt: null, endedAt: null, samples: samples.map(([timestamp, input, output = 0, cacheRead = 0, cacheWrite = 0]) => ({
    timestamp: Date.parse(timestamp), input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite,
  })) }], { now: Date.parse(now), timezoneOffsetMinutes });
}

test("monthly dashboard sums only its calendar month and counts idle days in averages", () => {
  const data = statistics([
    ["2026-02-28T23:00:00Z", 999],
    ["2026-03-01T01:00:00Z", 30, 20, 40, 10],
    ["2026-03-03T01:00:00Z", 20, 10, 60, 10],
    ["2026-03-03T02:00:00Z", 50, 30, 20],
  ]);
  const monthly = buildUsageDashboard(data, "monthly", "2026-03");
  assert.equal(monthly.tokens, 300);
  assert.equal(monthly.turns, 3);
  assert.equal(monthly.activeDays, 2);
  assert.equal(monthly.averageDailyTokens, 100);
  assert.deepEqual(monthly.breakdown, { input: 100, output: 60, cacheRead: 120, cacheWrite: 20 });
  assert.equal(monthly.points.length, 31);
  assert.equal(monthly.points[1].tokens, 0);
  assert.equal(monthly.points[1].future, false);
  assert.equal(monthly.points[3].future, true);
  assert.equal(monthly.peak.key, "2026-03-03");
  assert.equal(data.totals.tokens, 1299, "all-time totals remain independent of selected period");
});

test("daily dashboard groups calls into local hours including a fractional timezone offset", () => {
  const data = statistics([
    ["2026-03-02T18:14:00Z", 99],
    ["2026-03-02T18:15:00Z", 20, 10],
    ["2026-03-02T18:30:00Z", 40],
    ["2026-03-03T03:20:00Z", 30],
  ], "2026-03-03T05:00:00Z", -345);
  const daily = buildUsageDashboard(data, "daily", "2026-03-03");
  assert.equal(daily.tokens, 100);
  assert.equal(daily.turns, 3);
  assert.equal(daily.points.length, 24);
  assert.deepEqual(daily.points[0], { key: "00", tokens: 70, turns: 2, future: false });
  assert.equal(daily.points[9].tokens, 30);
  assert.equal(daily.points[10].future, false);
  assert.equal(daily.points[11].future, true);
  assert.equal(daily.peak.key, "00");
});

test("calendar navigation handles leap days and year boundaries without local timezone arithmetic", () => {
  assert.equal(shiftUsagePeriod("2026-01", "monthly", -1), "2025-12");
  assert.equal(shiftUsagePeriod("2025-12", "monthly", 1), "2026-01");
  assert.equal(shiftUsagePeriod("2024-03-01", "daily", -1), "2024-02-29");
  assert.equal(shiftUsagePeriod("2026-03-01", "daily", -1), "2026-02-28");
  const leap = buildUsageDashboard(statistics([], "2024-03-01T00:00:00Z"), "monthly", "2024-02");
  assert.equal(leap.points.length, 29);
  assert.equal(leap.points.at(-1).future, false);
});

test("period bounds exclude incomplete oldest months and clamp missing or out-of-range selections", () => {
  const data = statistics();
  const bounds = usagePeriodBounds(data, "monthly");
  assert.ok(`${bounds.min}-01` >= data.activity.from);
  assert.equal(bounds.max, "2026-03");
  for (const invalid of ["", "bad", "2026-02-31", "2026-13-01"]) {
    assert.equal(buildUsageDashboard(data, "daily", invalid).value, "2026-03-03");
  }
  assert.equal(buildUsageDashboard(data, "monthly", "2000-01").value, bounds.min);
  assert.equal(buildUsageDashboard(data, "daily", "2030-01-01").value, "2026-03-03");
  assert.equal(buildUsageDashboard(data, "daily", "2000-01-01").value, data.activity.from);
});

test("empty days and total-only legacy usage remain honest zero/uncategorized values", () => {
  const data = statistics();
  const empty = buildUsageDashboard(data, "daily", "2026-03-02");
  assert.equal(empty.tokens, 0);
  assert.equal(empty.turns, 0);
  assert.equal(empty.peak, null);
  assert.ok(empty.points.every(point => point.tokens === 0 && !point.future));
  assert.deepEqual(empty.breakdown, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  const legacy = calculateUsageStatistics([{ startedAt: null, endedAt: null, samples: [
    { timestamp: Date.parse("2026-03-03T01:00:00Z"), total: 80, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ] }], { now: Date.parse("2026-03-03T05:00:00Z") });
  const daily = buildUsageDashboard(legacy, "daily", "");
  assert.equal(daily.tokens, 80);
  assert.equal(daily.points[1].tokens, 80);
  assert.equal(Object.values(daily.breakdown).reduce((sum, n) => sum + n, 0), 0);
});
