"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UsageStatistics } from "@/lib/usage-statistics";
import { UsagePeriodDashboard } from "./UsagePeriodDashboard";
import styles from "./UsageStatsPanel.module.css";

type ChartMode = "daily" | "weekly" | "cumulative";
type Day = UsageStatistics["activity"]["daily"][number];

function compactNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function durationLabel(milliseconds: number, locale: string): string {
  if (milliseconds <= 0) return locale === "zh-CN" ? "不足 1 分钟" : "Under 1 min";
  const minutes = Math.max(1, Math.floor(milliseconds / 60_000));
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (locale === "zh-CN") {
    if (days > 0) return `${days} 天 ${hours} 小时`;
    if (hours > 0) return `${hours} 小时 ${rest} 分`;
    return `${rest} 分钟`;
  }
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest} min`;
}

function dateLabel(date: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

function chunks<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function cumulativeWeeklyPoints(weeks: Day[][], beforeRange: number): number[] {
  let total = beforeRange;
  return weeks.map((week) => {
    total += week.reduce((sum, day) => sum + day.tokens, 0);
    return total;
  });
}

function activityLevel(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0;
  const ratio = Math.log1p(value) / Math.log1p(maximum);
  return Math.max(1, Math.min(4, Math.ceil(ratio * 4)));
}

function isUsageStatistics(value: UsageStatistics | { error?: string }): value is UsageStatistics {
  return "totals" in value && "activity" in value && "breakdown" in value;
}

function DailyHeatmap({ days, locale, tokenLabel }: { days: Day[]; locale: string; tokenLabel: string }) {
  const maximum = Math.max(0, ...days.map((day) => day.tokens));
  const padded: Array<Day | null> = [...days];
  while (padded.length % 7 !== 0) padded.push(null);
  const weekCount = Math.ceil(padded.length / 7);
  const months = days.flatMap((day, index) => {
    const date = new Date(`${day.date}T00:00:00Z`);
    if (date.getUTCDate() !== 1 && index !== 0) return [];
    return [{ label: dateLabel(day.date, locale, { month: "short" }), column: Math.floor(index / 7) + 1 }];
  }).filter((month, index, items) => index === 0 || month.column - items[index - 1]!.column >= 2);

  return <div className={styles.heatmapViewport}>
    <div className={styles.heatmapSurface} style={{ width: weekCount * 14 - 3 }}>
      <div className={styles.months} style={{ gridTemplateColumns: `repeat(${weekCount}, 11px)` }}>
        {months.map((month) => <span key={`${month.label}:${month.column}`} style={{ gridColumn: month.column }}>{month.label}</span>)}
      </div>
      <div className={styles.heatmap} style={{ gridTemplateColumns: `repeat(${weekCount}, 11px)` }}>
        {padded.map((day, index) => day ? <span
          key={day.date}
          className={styles.activityCell}
          data-level={activityLevel(day.tokens, maximum)}
          title={`${dateLabel(day.date, locale, { year: "numeric", month: "short", day: "numeric" })} · ${day.tokens.toLocaleString(locale)} ${tokenLabel}`}
          aria-hidden="true"
        /> : <span className={styles.activityCell} data-empty="true" key={`empty:${index}`} />)}
      </div>
    </div>
  </div>;
}

function WeeklyBars({ days, locale, tokenLabel }: { days: Day[]; locale: string; tokenLabel: string }) {
  const weeks = chunks(days, 7).map((week) => ({
    from: week[0]!.date,
    to: week.at(-1)!.date,
    tokens: week.reduce((sum, day) => sum + day.tokens, 0),
  }));
  const maximum = Math.max(0, ...weeks.map((week) => week.tokens));
  return <div className={styles.barViewport}>
    <div className={styles.barChart}>
      {weeks.map((week) => {
        const ratio = maximum > 0 ? Math.log1p(week.tokens) / Math.log1p(maximum) : 0;
        return <span className={styles.barSlot} key={week.from} title={`${dateLabel(week.from, locale, { month: "short", day: "numeric" })} – ${dateLabel(week.to, locale, { month: "short", day: "numeric" })} · ${week.tokens.toLocaleString(locale)} ${tokenLabel}`}>
          <span className={styles.bar} style={{ height: week.tokens > 0 ? `${Math.max(5, ratio * 116)}px` : "2px" }} data-active={week.tokens > 0} />
        </span>;
      })}
    </div>
  </div>;
}

function CumulativeChart({ data, locale, tokenLabel }: { data: UsageStatistics; locale: string; tokenLabel: string }) {
  const weeks = chunks(data.activity.daily, 7);
  const rangeTokens = data.activity.daily.reduce((sum, day) => sum + day.tokens, 0);
  const beforeRange = Math.max(0, data.totals.tokens - rangeTokens);
  const points = cumulativeWeeklyPoints(weeks, beforeRange);
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 1);
  const width = 720;
  const height = 154;
  const coordinates = points.map((value, index) => {
    const x = points.length <= 1 ? 0 : index / (points.length - 1) * width;
    const y = height - ((value - min) / Math.max(1, max - min)) * (height - 16) - 8;
    return [x, y] as const;
  });
  const line = coordinates.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = coordinates.length ? `${line} L${width},${height} L0,${height} Z` : "";
  return <div className={styles.cumulativeWrap}>
    <div className={styles.cumulativeValue}>{compactNumber(data.totals.tokens, locale)} <span>{tokenLabel}</span></div>
    <svg className={styles.cumulativeChart} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${data.totals.tokens.toLocaleString(locale)} ${tokenLabel}`}>
      <defs><linearGradient id="usage-cumulative-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill="url(#usage-cumulative-fill)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    </svg>
    <div className={styles.chartDates}><span>{dateLabel(data.activity.from, locale, { year: "numeric", month: "short" })}</span><span>{dateLabel(data.activity.to, locale, { year: "numeric", month: "short" })}</span></div>
  </div>;
}

export function UsageStatsPanel() {
  const { locale, t } = useI18n();
  const [data, setData] = useState<UsageStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<ChartMode>("daily");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        timezoneOffset: String(new Date().getTimezoneOffset()),
        days: "365",
        ...(refresh ? { refresh: "1" } : {}),
      });
      const response = await fetch(`/api/usage?${query}`, { cache: "no-store" });
      const payload = await response.json() as UsageStatistics | { error?: string };
      if (!response.ok || !isUsageStatistics(payload)) throw new Error("error" in payload ? payload.error || `HTTP ${response.status}` : `HTTP ${response.status}`);
      setData(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const metrics = useMemo(() => data ? [
    [compactNumber(data.totals.tokens, locale), t("usage.totalTokens")],
    [compactNumber(data.totals.peakDailyTokens, locale), t("usage.peakDailyTokens")],
    [durationLabel(data.totals.longestSessionMs, locale), t("usage.longestChat")],
    [data.totals.currentStreakDays.toLocaleString(locale), t("usage.currentStreak")],
    [data.totals.longestStreakDays.toLocaleString(locale), t("usage.longestStreak")],
  ] : [], [data, locale, t]);

  return <div className={styles.root}>
    <header className={styles.heading}>
      <div><h2>{t("usage.title")}</h2><p>{t("usage.description")}</p></div>
      <button type="button" onClick={() => void load(true)} disabled={loading}>{loading ? t("usage.refreshing") : t("usage.refresh")}</button>
    </header>

    {error ? <div className={styles.error} role="alert"><span>{t("usage.loadFailed")}</span><button type="button" onClick={() => void load(true)}>{t("usage.retry")}</button></div> : null}
    {!data && loading ? <div className={styles.loading} aria-label={t("usage.loading")}><div /><div /><div /></div> : null}

    {data ? <>
      <UsagePeriodDashboard data={data} />
      <h3 className={styles.allTimeHeading}>{t("usage.allTime")}</h3>
      <section className={styles.metrics} aria-label={t("usage.summary")}>
        {metrics.map(([value, label]) => <div className={styles.metric} key={label}><strong>{value}</strong><span>{label}</span></div>)}
      </section>

      <section className={styles.activitySection}>
        <div className={styles.activityHeader}>
          <div><h3>{t("usage.activity")}</h3><p>{t("usage.activityDescription")}</p></div>
          <div className={styles.modeSwitch} role="tablist" aria-label={t("usage.chartMode")}>
            {(["daily", "weekly", "cumulative"] as ChartMode[]).map((item) => <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => setMode(item)}>{t(`usage.${item}`)}</button>)}
          </div>
        </div>
        <div className={styles.chartPanel}>
          {mode === "daily" ? <DailyHeatmap days={data.activity.daily} locale={locale} tokenLabel={t("usage.tokens")} /> : null}
          {mode === "weekly" ? <WeeklyBars days={data.activity.daily} locale={locale} tokenLabel={t("usage.tokens")} /> : null}
          {mode === "cumulative" ? <CumulativeChart data={data} locale={locale} tokenLabel={t("usage.tokens")} /> : null}
          {mode !== "cumulative" ? <div className={styles.legend}><span>{t("usage.less")}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}<span>{t("usage.more")}</span></div> : null}
        </div>
      </section>

      <section className={styles.breakdown} aria-label={t("usage.breakdown")}>
        <div><span>{t("usage.input")}</span><strong>{compactNumber(data.breakdown.input, locale)}</strong></div>
        <div><span>{t("usage.output")}</span><strong>{compactNumber(data.breakdown.output, locale)}</strong></div>
        <div><span>{t("usage.cacheRead")}</span><strong>{compactNumber(data.breakdown.cacheRead, locale)}</strong></div>
        <div><span>{t("usage.cacheWrite")}</span><strong>{compactNumber(data.breakdown.cacheWrite, locale)}</strong></div>
      </section>
      <p className={styles.privacy}>{t("usage.localOnly", { sessions: data.totals.sessions, days: data.totals.activeDays })}</p>
    </> : null}
  </div>;
}
