"use client";
import { brandText, APP_DISPLAY_NAME } from "@/lib/branding";

import { useRef } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { DesktopUpdateState } from "./sidebar/sidebar-types";
import { AliIcon } from "./AliIcon";
import { MarkdownBody } from "./MarkdownBody";
import styles from "./DesktopUpdateDialog.module.css";

interface DesktopUpdateDialogProps {
  locale: "en" | "zh-CN";
  open: boolean;
  state: DesktopUpdateState;
  onClose: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onRetry: () => void;
}

function formatBytes(value: number | undefined, locale: DesktopUpdateDialogProps["locale"]): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || amount >= 10 ? 0 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(amount)} ${units[unitIndex]}`;
}

export function DesktopUpdateDialog({
  locale,
  open,
  state,
  onClose,
  onDownload,
  onInstall,
  onRetry,
}: DesktopUpdateDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open, { initialFocus: closeButtonRef, onEscape: onClose });
  if (!open) return null;

  const chinese = locale === "zh-CN";
  const upToDate = state.status === "up-to-date";
  const version = state.availableVersion ? `v${state.availableVersion}` : "";
  const progress = Math.max(0, Math.min(100, state.progressPercent ?? 0));
  const transferred = formatBytes(state.transferredBytes, locale);
  const total = formatBytes(state.totalBytes, locale);
  const speed = formatBytes(state.bytesPerSecond, locale);
  const progressDetail = transferred && total
    ? `${transferred} / ${total}${speed ? ` · ${speed}/s` : ""}`
    : speed
      ? `${speed}/s`
      : chinese ? "正在准备下载…" : "Preparing download…";
  const releaseNotes = state.releaseNotes?.trim()
    || (chinese
      ? "暂时无法读取此版本的更新说明，可在 GitHub 发布页面查看完整内容。"
      : "Release notes are currently unavailable. See the GitHub release page for full details.");

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className={`${styles.dialog}${upToDate ? ` ${styles.compactDialog}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
        aria-describedby="desktop-update-summary"
      >
        <header className={styles.header}>
          <div className={`${styles.updateMark}${upToDate ? ` ${styles.successMark}` : ""}`} aria-hidden="true">
            <AliIcon name={upToDate ? "check-circle" : "download"} size={18} />
          </div>
          <div className={styles.heading}>
            <h2 id="desktop-update-title">{upToDate
              ? (chinese ? "已是最新版本" : "You’re up to date")
              : (chinese ? brandText("Piora 更新") : brandText("Piora update"))}</h2>
            <p id="desktop-update-summary">
              {upToDate
                ? `${APP_DISPLAY_NAME} v${state.currentVersion}`
                : version
                ? (chinese ? `${version} 已准备好` : `${version} is ready`)
                : (chinese ? "有可用的新版本" : "A new version is available")}
            </p>
          </div>
          <button ref={closeButtonRef} type="button" className={styles.iconButton} onClick={onClose} aria-label={chinese ? "关闭更新窗口" : "Close update dialog"}>
            <AliIcon name="close" size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {upToDate ? (
            <section className={styles.currentVersionCard} aria-label={chinese ? "当前版本状态" : "Current version status"}>
              <div>
                <span className={styles.currentVersionLabel}>{chinese ? "当前版本" : "Current version"}</span>
                <strong>{APP_DISPLAY_NAME} v{state.currentVersion}</strong>
              </div>
              <span className={styles.latestBadge}>
                <span aria-hidden="true" />
                {chinese ? "最新" : "Latest"}
              </span>
            </section>
          ) : (
            <section className={styles.notes} aria-labelledby="desktop-update-notes-title">
              <div className={styles.sectionHeader}>
                <h3 id="desktop-update-notes-title">{chinese ? "本次更新" : "What’s new"}</h3>
                <span>{state.currentVersion}{version ? ` → ${version}` : ""}</span>
              </div>
              <div className={styles.notesScroll}>
                <MarkdownBody className={styles.releaseMarkdown}>{releaseNotes}</MarkdownBody>
              </div>
            </section>
          )}

          {state.status === "downloading" || state.status === "downloaded" ? (
            <section className={styles.progressSection} aria-live="polite">
              <div className={styles.progressCopy}>
                <span>{state.status === "downloaded"
                  ? (chinese ? "下载完成" : "Download complete")
                  : (chinese ? "正在下载更新" : "Downloading update")}</span>
                <strong>{Math.round(progress)}%</strong>
              </div>
              <div className={styles.progressTrack} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
                <div className={styles.progressValue} style={{ width: `${progress}%` }} />
              </div>
              <div className={styles.progressDetail}>{state.status === "downloaded"
                ? (chinese ? brandText("安装时 Piora 会自动重新打开") : brandText("Piora will reopen automatically after installation"))
                : progressDetail}</div>
            </section>
          ) : null}

          {state.status === "error" ? (
            <div className={styles.error} role="alert">
              <AliIcon name="alert" size={16} />
              <span>{state.error || (chinese ? "更新失败，请重试。" : "The update failed. Please try again.")}</span>
            </div>
          ) : null}
        </div>

        <footer className={styles.footer}>
          <a
            className={styles.releaseLink}
            href={state.availableVersion ? `https://github.com/kexijiang/Piora/releases/tag/v${state.availableVersion}` : "https://github.com/kexijiang/Piora/releases/latest"}
            target="_blank"
            rel="noopener noreferrer"
          >
            {chinese ? "查看完整发布说明" : "View full release notes"}
            <AliIcon name="external-link" size={13} />
          </a>
          <div className={styles.actions}>
            <button type="button" className={upToDate ? styles.primaryButton : styles.secondaryButton} onClick={onClose}>
              {upToDate ? (chinese ? "完成" : "Done") : (chinese ? "稍后" : "Later")}
            </button>
            {state.status === "downloaded" ? (
              <button type="button" className={styles.primaryButton} onClick={onInstall}>
                {chinese ? "安装并重启" : "Install and restart"}
              </button>
            ) : state.status === "error" ? (
              <button type="button" className={styles.primaryButton} onClick={onRetry}>
                {chinese ? "重试" : "Retry"}
              </button>
            ) : state.status === "available" ? (
              <button type="button" className={styles.primaryButton} onClick={onDownload}>
                <AliIcon name="download" size={14} />
                {chinese ? "下载更新" : "Download update"}
              </button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}
