"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { readOrganizationAnalyticsStatus } from "@/lib/analytics-status";
import styles from "./SettingsDialog.module.css";

export function OrganizationAnalyticsSettings() {
  const { locale } = useI18n(),
    zh = locale === "zh-CN";
  const [status, setStatus] = useState<ReturnType<
      typeof readOrganizationAnalyticsStatus
    > | null>(null),
    [error, setError] = useState(false);
  const refresh = () => {
    setError(false);
    void fetch("/api/analytics/status")
      .then(async (r) => {
        if (!r.ok) throw new Error();
        setStatus(await r.json());
      })
      .catch(() => setError(true));
  };
  useEffect(() => {
    refresh();
  }, []);
  const date = (value: number | null | undefined) =>
    value ? new Date(value).toLocaleString(locale) : "—";
  return (
    <section
      className={styles.conversationSection}
      data-settings-id="general.organizationAnalytics"
    >
      <div className={styles.conversationRow}>
        <div className={styles.conversationCopy}>
          <h3 className={styles.rowTitle}>
            {zh ? "组织使用统计" : "Organization usage statistics"}
          </h3>
          <p className={styles.rowDescription}>
            {zh
              ? "由公司配置启用。上传使用次数、时长、Token 和文件变更数量；不上传对话原文、代码、文件路径或模型密钥。"
              : "Enabled by your organization. Reports counts, durations, tokens and file-change totals. Prompts, code, file paths and model credentials are excluded."}
          </p>
        </div>
        <button type="button" onClick={refresh}>
          {zh ? "刷新状态" : "Refresh status"}
        </button>
      </div>
      <div className={styles.rowDescription} role="status">
        {error ? (
          zh ? (
            "暂时无法读取统计状态"
          ) : (
            "Status is temporarily unavailable"
          )
        ) : !status ? (
          zh ? (
            "正在读取…"
          ) : (
            "Loading…"
          )
        ) : !status.configured ? (
          zh ? (
            "未配置组织统计，当前不会上传。"
          ) : (
            "Not configured. No organization telemetry is uploaded."
          )
        ) : (
          <>
            <p>
              {status.organization_name ??
                (zh ? "等待注册" : "Awaiting enrollment")}{" "}
              ·{" "}
              {status.upload_paused
                ? zh
                  ? "上传已暂停，请联系管理员"
                  : "Upload paused; contact your administrator"
                : status.enabled
                  ? zh
                    ? "已启用"
                    : "Enabled"
                  : zh
                    ? "组织已暂停采集"
                    : "Collection paused by organization"}
            </p>
            <p>
              {zh ? "同步间隔" : "Upload interval"}:{" "}
              {status.interval_min_minutes}–{status.interval_max_minutes}{" "}
              {zh ? "分钟，独立随机错峰" : "minutes, independently randomized"}
            </p>
            <p>
              {zh ? "待上传事件" : "Queued events"}: {status.queue_events} ·{" "}
              {zh ? "最近成功" : "Last success"}: {date(status.last_success_at)}
            </p>
            <p>
              {zh ? "下次计划" : "Next scheduled upload"}:{" "}
              {status.upload_paused ? "—" : date(status.next_due_at)}
              {status.last_error ? " · " + status.last_error : ""}
            </p>
            <p>
              {zh ? "统计服务" : "Analytics server"}: {status.backend_url}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
