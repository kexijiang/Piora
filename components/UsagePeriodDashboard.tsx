"use client";

import { useId, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { buildUsageDashboard, shiftUsagePeriod, type UsagePeriod } from "@/lib/usage-dashboard";
import type { UsageStatistics } from "@/lib/usage-statistics";
import styles from "./UsageStatsPanel.module.css";

function numberLabel(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function dateLabel(value: string, locale: string, monthly = false): string {
  return new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "long", ...(monthly ? {} : { day: "numeric" }), timeZone: "UTC",
  }).format(new Date(`${value}${monthly ? "-01" : ""}T00:00:00Z`));
}

function Chevron({ next = false }: { next?: boolean }) {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d={next ? "m6 4 4 4-4 4" : "m10 4-4 4 4 4"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function UsagePeriodDashboard({ data }: { data: UsageStatistics }) {
  const { locale, t } = useI18n();
  const id = useId();
  const [period, setPeriod] = useState<UsagePeriod>("monthly");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const requested = period === "monthly" ? month : day;
  const dashboard = useMemo(() => buildUsageDashboard(data, period, requested), [data, period, requested]);
  const { value, bounds, tokens, turns, points, breakdown, peak } = dashboard;
  const monthly = period === "monthly";
  const maximum = Math.max(1, ...points.map(point => point.tokens));
  const categorized = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheWrite;
  const setValue = monthly ? setMonth : setDay;
  const categories = ["input", "output", "cacheRead", "cacheWrite"] as const;
  const metrics = [
    { key: "tokens", label: t(monthly ? "usage.monthlyTokens" : "usage.dailyTokens"), value: numberLabel(tokens, locale), exact: Math.round(tokens).toLocaleString(locale) },
    { key: "turns", label: t("usage.modelCalls"), value: turns.toLocaleString(locale) },
    monthly
      ? { key: "activeDays", label: t("usage.activeDays"), value: dashboard.activeDays.toLocaleString(locale) }
      : { key: "peakHour", label: t("usage.peakHour"), value: peak ? `${peak.key}:00` : "—" },
    { key: "average", label: t(monthly ? "usage.dailyAverage" : "usage.perCallAverage"), value: numberLabel(monthly ? dashboard.averageDailyTokens : turns > 0 ? tokens / turns : 0, locale) },
  ];
  const goToDay = (date: string) => {
    setDay(date);
    setPeriod("daily");
    document.getElementById(`${id}-daily`)?.focus();
  };

  return <section className={styles.dashboard} aria-label={t("usage.periodDashboard")}>
    <div className={styles.dashboardToolbar}>
      <div className={styles.modeSwitch} role="tablist" aria-label={t("usage.periodDashboard")}>
        {(["monthly", "daily"] as const).map(item => <button
          key={item}
          id={`${id}-${item}`}
          type="button"
          role="tab"
          aria-selected={period === item}
          aria-controls={`${id}-panel`}
          tabIndex={period === item ? 0 : -1}
          onClick={() => setPeriod(item)}
          onKeyDown={event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "monthly" : event.key === "End" ? "daily" : period === "monthly" ? "daily" : "monthly";
            setPeriod(next);
            document.getElementById(`${id}-${next}`)?.focus();
          }}
        >{t(item === "monthly" ? "usage.monthlyDashboard" : "usage.dailyDashboard")}</button>)}
      </div>
      <div className={styles.periodControls}>
        <div className={styles.periodPicker}>
          <button type="button" aria-label={t(monthly ? "usage.previousMonth" : "usage.previousDay")} disabled={value <= bounds.min} onClick={() => setValue(shiftUsagePeriod(value, period, -1))}><Chevron /></button>
          <input
            type={monthly ? "month" : "date"}
            aria-label={t(monthly ? "usage.selectMonth" : "usage.selectDay")}
            value={value}
            min={bounds.min}
            max={bounds.max}
            onChange={event => { if (event.target.value && event.target.validity.valid) setValue(event.target.value); }}
          />
          <button type="button" aria-label={t(monthly ? "usage.nextMonth" : "usage.nextDay")} disabled={value >= bounds.max} onClick={() => setValue(shiftUsagePeriod(value, period, 1))}><Chevron next /></button>
        </div>
        <button className={styles.resetPeriod} type="button" disabled={value === bounds.max} onClick={() => setValue("")}>{t(monthly ? "usage.thisMonth" : "usage.today")}</button>
      </div>
    </div>

    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${period}`}>
      <div className={styles.periodHeading}>
        <h3>{dateLabel(value, locale, monthly)}</h3>
        <span>{t(monthly ? "usage.monthlyHint" : "usage.dailyHint")}</span>
      </div>
      <dl className={styles.periodMetrics}>
        {metrics.map(metric => <div key={metric.key} data-metric={metric.key}>
          <dt>{metric.label}</dt>
          <dd title={metric.exact ?? metric.value}>{metric.value}</dd>
        </div>)}
      </dl>

      <div className={styles.dashboardDetails}>
        <section className={styles.periodTrend} aria-label={t(monthly ? "usage.dailyTrend" : "usage.hourlyTrend")}>
          <div className={styles.detailHeading}>
            <h4>{t(monthly ? "usage.dailyTrend" : "usage.hourlyTrend")}</h4>
            <span>{peak ? t("usage.periodPeak", { value: numberLabel(peak.tokens, locale) }) : t("usage.tokens")}</span>
          </div>
          <div className={styles.periodChartViewport}>
            <div className={styles.periodChart} style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
              <div className={styles.chartGrid} aria-hidden="true"><i /><i /><i /></div>
              {points.map((point, index) => {
                const label = monthly ? dateLabel(point.key, locale) : `${point.key}:00 – ${String(Number(point.key) + 1).padStart(2, "0")}:00`;
                const tooltip = point.future ? t("usage.futurePeriod") : `${point.tokens.toLocaleString(locale)} ${t("usage.tokens")} · ${t("usage.callCount", { count: point.turns })}`;
                const showLabel = monthly ? index === 0 || ((index + 1) % 5 === 0 && index < points.length - 2) || index === points.length - 1 : index % 4 === 0 || index === points.length - 1;
                const content = <>
                  <span className={styles.periodBar} data-active={point.tokens > 0} data-future={point.future} style={{ height: point.tokens > 0 ? `${Math.max(3, point.tokens / maximum * 100)}%` : "2px" }} />
                  <span className={styles.barTooltip} aria-hidden="true"><strong>{label}</strong><span>{tooltip}</span></span>
                </>;
                return <div className={styles.periodBarColumn} key={point.key}>
                  {monthly ? <button type="button" className={styles.periodBarSlot} aria-label={`${label} · ${tooltip}`} disabled={point.future} onClick={() => goToDay(point.key)}>{content}</button>
                    : <div className={styles.periodBarSlot} role="img" tabIndex={point.future ? undefined : 0} aria-label={`${label} · ${tooltip}`}>{content}</div>}
                  <span className={styles.periodTick} aria-hidden="true">{showLabel ? monthly ? index + 1 : point.key : ""}</span>
                </div>;
              })}
              {tokens === 0 ? <p className={styles.chartEmpty}>{t("usage.noPeriodUsage")}</p> : null}
            </div>
          </div>
        </section>

        <section className={styles.periodBreakdown} aria-label={t("usage.periodBreakdown")}>
          <div className={styles.detailHeading}><h4>{t("usage.periodBreakdown")}</h4><span>{t("usage.tokens")}</span></div>
          <div className={styles.breakdownTrack} aria-hidden="true">
            {categories.map(key => <span key={key} data-category={key} style={{ width: `${tokens > 0 ? breakdown[key] / tokens * 100 : 0}%` }} />)}
          </div>
          <dl>
            {categories.map(key => <div key={key}>
              <dt><i data-category={key} aria-hidden="true" />{t(`usage.${key}`)}</dt>
              <dd title={breakdown[key].toLocaleString(locale)}>{numberLabel(breakdown[key], locale)}</dd>
            </div>)}
          </dl>
          {tokens > categorized ? <p className={styles.breakdownNote}>{t("usage.breakdownUnavailable")}</p> : null}
        </section>
      </div>
    </div>
  </section>;
}
