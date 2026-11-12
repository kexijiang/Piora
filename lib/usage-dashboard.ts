import type { UsageBreakdown, UsageStatistics } from "./usage-statistics";

export type UsagePeriod = "monthly" | "daily";

export interface UsageChartPoint {
  key: string;
  tokens: number;
  turns: number;
  /** Future days/hours are shown as unavailable rather than recorded zeros. */
  future: boolean;
}

export function shiftUsagePeriod(value: string, period: UsagePeriod, amount: number): string {
  const date = new Date(`${period === "monthly" ? `${value}-01` : value}T00:00:00Z`);
  if (period === "monthly") date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, period === "monthly" ? 7 : 10);
}

export function usagePeriodBounds(data: UsageStatistics, period: UsagePeriod) {
  if (period === "daily") return { min: data.activity.from, max: data.activity.to };
  // The annual heatmap can begin partway through a month. Offer complete
  // calendar months so its missing first days never look like zero usage.
  const firstMonth = data.activity.from.slice(0, 7);
  const max = data.activity.to.slice(0, 7);
  const min = data.activity.from.endsWith("-01") ? firstMonth : shiftUsagePeriod(firstMonth, "monthly", 1);
  return { min: min > max ? max : min, max };
}

export function buildUsageDashboard(data: UsageStatistics, period: UsagePeriod, requested: string) {
  const bounds = usagePeriodBounds(data, period);
  const valid = period === "monthly" ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const parsed = new Date(`${requested}${period === "monthly" ? "-01" : ""}T00:00:00Z`);
  const isValid = valid.test(requested) && Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(requested);
  const value = !isValid ? bounds.max : requested < bounds.min ? bounds.min : requested > bounds.max ? bounds.max : requested;
  const days = data.activity.daily.filter(day => period === "monthly" ? day.date.startsWith(`${value}-`) : day.date === value);
  const tokens = days.reduce((sum, day) => sum + day.tokens, 0);
  const turns = days.reduce((sum, day) => sum + day.turns, 0);
  const activeDays = days.filter(day => day.tokens > 0).length;
  const breakdown: UsageBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const day of days) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) breakdown[key] += day.breakdown[key];
  }

  let points: UsageChartPoint[];
  if (period === "monthly") {
    const monthStart = new Date(`${value}-01T00:00:00Z`);
    const count = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
    const byDate = new Map(days.map(day => [day.date, day]));
    points = Array.from({ length: count }, (_, index) => {
      const key = `${value}-${String(index + 1).padStart(2, "0")}`;
      const day = byDate.get(key);
      return { key, tokens: day?.tokens ?? 0, turns: day?.turns ?? 0, future: key > data.activity.to };
    });
  } else {
    const hours = new Map(days[0]?.hourly.map(hour => [hour.hour, hour]) ?? []);
    const currentHour = new Date(data.generatedAt - data.timezoneOffsetMinutes * 60_000).getUTCHours();
    points = Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour).padStart(2, "0"),
      tokens: hours.get(hour)?.tokens ?? 0,
      turns: hours.get(hour)?.turns ?? 0,
      future: value === data.activity.to && hour > currentHour,
    }));
  }

  const peak = points.reduce<UsageChartPoint | null>((best, point) => point.tokens > (best?.tokens ?? 0) ? point : best, null);
  return { value, bounds, tokens, turns, activeDays, breakdown, points, peak, averageDailyTokens: days.length ? tokens / days.length : 0 };
}
