import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listAllSessions } from "@/lib/session-reader";
import { readUsageStatistics, type UsageStatistics } from "@/lib/usage-statistics";

export const dynamic = "force-dynamic";

const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 16;

declare global {
  var __pioraUsageStatisticsCache: Map<string, { at: number; value: UsageStatistics }> | undefined;
}

function cache(): Map<string, { at: number; value: UsageStatistics }> {
  if (!globalThis.__pioraUsageStatisticsCache) globalThis.__pioraUsageStatisticsCache = new Map();
  return globalThis.__pioraUsageStatisticsCache;
}

function numericQuery(url: URL, key: string, fallback: number, min: number, max: number): number {
  const parsed = Number(url.searchParams.get(key));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.trunc(parsed))) : fallback;
}

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const url = new URL(request.url);
    const timezoneOffsetMinutes = numericQuery(url, "timezoneOffset", 0, -840, 840);
    const activityDays = numericQuery(url, "days", 365, 7, 730);
    const force = url.searchParams.get("refresh") === "1";
    const key = `periods-v1:${timezoneOffsetMinutes}:${activityDays}`;
    const cached = cache().get(key);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return NextResponse.json(cached.value, { headers: { "Cache-Control": "no-store" } });
    }
    const sessions = await listAllSessions();
    const value = await readUsageStatistics(sessions.map((session) => session.path), {
      timezoneOffsetMinutes,
      activityDays,
    });
    cache().set(key, { at: Date.now(), value });
    if (cache().size > MAX_CACHE_ENTRIES) {
      const oldestKey = [...cache().entries()].sort((left, right) => left[1].at - right[1].at)[0]?.[0];
      if (oldestKey && oldestKey !== key) cache().delete(oldestKey);
    }
    return NextResponse.json(value, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
