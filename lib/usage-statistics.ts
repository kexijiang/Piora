import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ACTIVITY_DAYS = 365;
const MAX_ACTIVITY_DAYS = 730;
const FILE_READ_CONCURRENCY = 4;

export interface UsageSample {
  timestamp: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionUsageRecord {
  startedAt: number | null;
  endedAt: number | null;
  samples: UsageSample[];
}

export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface HourlyUsage {
  hour: number;
  tokens: number;
  turns: number;
}

export interface DailyUsage {
  date: string;
  tokens: number;
  turns: number;
  breakdown: UsageBreakdown;
  /** Only hours with recorded usage are serialized. Missing hours are zero. */
  hourly: HourlyUsage[];
}

export interface UsageStatistics {
  generatedAt: number;
  timezoneOffsetMinutes: number;
  totals: {
    tokens: number;
    peakDailyTokens: number;
    longestSessionMs: number;
    currentStreakDays: number;
    longestStreakDays: number;
    activeDays: number;
    sessions: number;
  };
  breakdown: UsageBreakdown;
  activity: {
    from: string;
    to: string;
    daily: DailyUsage[];
  };
}

interface MutableDayUsage {
  tokens: number;
  turns: number;
  breakdown: UsageBreakdown;
  hourly: Map<number, HourlyUsage>;
}

function emptyBreakdown(): UsageBreakdown {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function timestampValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usageSample(value: unknown, timestamp: number | null): UsageSample | null {
  if (!value || typeof value !== "object" || timestamp === null) return null;
  const usage = value as Record<string, unknown>;
  const input = nonNegativeNumber(usage.input);
  const output = nonNegativeNumber(usage.output);
  const cacheRead = nonNegativeNumber(usage.cacheRead);
  const cacheWrite = nonNegativeNumber(usage.cacheWrite);
  const summed = input + output + cacheRead + cacheWrite;
  const total = summed > 0 ? summed : nonNegativeNumber(usage.totalTokens);
  if (total <= 0) return null;
  return { timestamp, input, output, cacheRead, cacheWrite, total };
}

function localDayIndex(timestamp: number, timezoneOffsetMinutes: number): number {
  return Math.floor((timestamp - timezoneOffsetMinutes * 60_000) / DAY_MS);
}

function dayKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function startOfActivityRange(todayIndex: number, activityDays: number): number {
  const unalignedStart = todayIndex - activityDays + 1;
  const weekday = new Date(unalignedStart * DAY_MS).getUTCDay();
  return unalignedStart - weekday;
}

function streaks(activeDayIndexes: number[], todayIndex: number): { current: number; longest: number } {
  if (activeDayIndexes.length === 0) return { current: 0, longest: 0 };
  const active = [...new Set(activeDayIndexes)].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let index = 1; index < active.length; index += 1) {
    if (active[index] === active[index - 1]! + 1) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
  }

  const activeSet = new Set(active);
  const latestEligibleDay = activeSet.has(todayIndex)
    ? todayIndex
    : activeSet.has(todayIndex - 1) ? todayIndex - 1 : null;
  let current = 0;
  if (latestEligibleDay !== null) {
    for (let day = latestEligibleDay; activeSet.has(day); day -= 1) current += 1;
  }
  return { current, longest };
}

export function calculateUsageStatistics(
  records: SessionUsageRecord[],
  options: { timezoneOffsetMinutes?: number; now?: number; activityDays?: number } = {},
): UsageStatistics {
  const timezoneOffsetMinutes = Number.isFinite(options.timezoneOffsetMinutes)
    ? Math.max(-840, Math.min(840, Math.trunc(options.timezoneOffsetMinutes!)))
    : 0;
  const now = Number.isFinite(options.now) ? options.now! : Date.now();
  const activityDays = Math.max(7, Math.min(MAX_ACTIVITY_DAYS, Math.trunc(options.activityDays ?? DEFAULT_ACTIVITY_DAYS)));
  const todayIndex = localDayIndex(now, timezoneOffsetMinutes);
  const rangeStart = startOfActivityRange(todayIndex, activityDays);
  const byDay = new Map<number, MutableDayUsage>();
  const breakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let totalTokens = 0;
  let longestSessionMs = 0;
  let sessions = 0;

  for (const record of records) {
    if (record.samples.length > 0) sessions += 1;
    if (record.startedAt !== null && record.endedAt !== null && record.endedAt >= record.startedAt) {
      longestSessionMs = Math.max(longestSessionMs, record.endedAt - record.startedAt);
    }
    for (const sample of record.samples) {
      totalTokens += sample.total;
      breakdown.input += sample.input;
      breakdown.output += sample.output;
      breakdown.cacheRead += sample.cacheRead;
      breakdown.cacheWrite += sample.cacheWrite;
      const day = localDayIndex(sample.timestamp, timezoneOffsetMinutes);
      const current = byDay.get(day) ?? { tokens: 0, turns: 0, breakdown: emptyBreakdown(), hourly: new Map<number, HourlyUsage>() };
      current.tokens += sample.total;
      current.turns += 1;
      // Keep detailed buckets only for the browsable range; all-time totals
      // above continue to include older sessions.
      if (day >= rangeStart && day <= todayIndex) {
        current.breakdown.input += sample.input;
        current.breakdown.output += sample.output;
        current.breakdown.cacheRead += sample.cacheRead;
        current.breakdown.cacheWrite += sample.cacheWrite;
        const hour = new Date(sample.timestamp - timezoneOffsetMinutes * 60_000).getUTCHours();
        const bucket = current.hourly.get(hour) ?? { hour, tokens: 0, turns: 0 };
        bucket.tokens += sample.total;
        bucket.turns += 1;
        current.hourly.set(hour, bucket);
      }
      byDay.set(day, current);
    }
  }

  const activeDayIndexes = [...byDay.entries()].filter(([, value]) => value.tokens > 0).map(([day]) => day);
  const peakDailyTokens = Math.max(0, ...byDay.values().map((value) => value.tokens));
  const streak = streaks(activeDayIndexes, todayIndex);
  const daily: UsageStatistics["activity"]["daily"] = [];
  for (let day = rangeStart; day <= todayIndex; day += 1) {
    const value = byDay.get(day);
    daily.push({
      date: dayKey(day),
      tokens: value?.tokens ?? 0,
      turns: value?.turns ?? 0,
      breakdown: value?.breakdown ?? emptyBreakdown(),
      hourly: value ? [...value.hourly.values()].sort((left, right) => left.hour - right.hour) : [],
    });
  }

  return {
    generatedAt: now,
    timezoneOffsetMinutes,
    totals: {
      tokens: totalTokens,
      peakDailyTokens,
      longestSessionMs,
      currentStreakDays: streak.current,
      longestStreakDays: streak.longest,
      activeDays: activeDayIndexes.length,
      sessions,
    },
    breakdown,
    activity: {
      from: daily[0]?.date ?? dayKey(todayIndex),
      to: daily.at(-1)?.date ?? dayKey(todayIndex),
      daily,
    },
  };
}

export async function readSessionUsageRecord(filePath: string): Promise<SessionUsageRecord> {
  const samples: UsageSample[] = [];
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  let headerTimestamp: number | null = null;
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.includes('"type":"message"') && !line.includes('"type": "message"')) {
        if (headerTimestamp === null && (line.includes('"type":"session"') || line.includes('"type": "session"'))) {
          try { headerTimestamp = timestampValue((JSON.parse(line) as { timestamp?: unknown }).timestamp); }
          catch { /* ignore malformed session headers */ }
        }
        continue;
      }
      if (!line.includes('"role":"assistant"') && !line.includes('"role": "assistant"')
        && !line.includes('"role":"user"') && !line.includes('"role": "user"')) continue;
      try {
        const entry = JSON.parse(line) as {
          timestamp?: unknown;
          message?: { role?: unknown; timestamp?: unknown; usage?: unknown };
        };
        const role = entry.message?.role;
        if (role !== "assistant" && role !== "user") continue;
        const timestamp = timestampValue(entry.timestamp) ?? timestampValue(entry.message?.timestamp) ?? headerTimestamp;
        if (timestamp !== null) {
          startedAt = startedAt === null ? timestamp : Math.min(startedAt, timestamp);
          endedAt = endedAt === null ? timestamp : Math.max(endedAt, timestamp);
        }
        if (role === "assistant") {
          const sample = usageSample(entry.message?.usage, timestamp);
          if (sample) samples.push(sample);
        }
      } catch {
        // A partially-written final line or a legacy malformed entry should not
        // make the entire local usage dashboard unavailable.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { startedAt, endedAt, samples };
}

async function mapWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(FILE_READ_CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function readUsageStatistics(
  sessionPaths: string[],
  options: { timezoneOffsetMinutes?: number; now?: number; activityDays?: number } = {},
): Promise<UsageStatistics> {
  const records = await mapWithConcurrency(sessionPaths, async (filePath) => {
    try { return await readSessionUsageRecord(filePath); }
    catch { return { startedAt: null, endedAt: null, samples: [] }; }
  });
  return calculateUsageStatistics(records, options);
}
