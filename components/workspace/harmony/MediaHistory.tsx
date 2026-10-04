"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarmonyMediaArtifact } from "@/lib/harmony/types";
import { copyText } from "@/lib/clipboard";
import styles from "../HarmonyPanel.module.css";

export function MediaHistory({ serial, refreshKey, chinese }: { serial: string; refreshKey?: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [artifacts, setArtifacts] = useState<HarmonyMediaArtifact[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState<"all" | "screenshot" | "recording">("all");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/harmony/media/history?serial=${encodeURIComponent(serial)}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Unable to load media history");
    if (!Array.isArray(data.artifacts)) throw new Error("Invalid media history");
    setArtifacts(data.artifacts); setTruncated(Boolean(data.truncated)); setError("");
  }, [serial]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [load, refreshKey]);
  const act = async (action: () => Promise<unknown>, success: string) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(success); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const visible = artifacts.filter(item => filter === "all" || item.kind === filter);
  return <fieldset className={styles.mediaHistory} data-harmony-task-section="media" aria-label={copy("截图与录屏历史", "Screenshot and recording history")}>
    <legend>{copy("截图与录屏历史", "Screenshot and recording history")}</legend>
    <div className={styles.mediaHistoryToolbar}>
      <label>{copy("显示", "Show")}<select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">{copy("全部", "All")}</option><option value="screenshot">{copy("截图", "Screenshots")}</option><option value="recording">{copy("录屏", "Recordings")}</option>
      </select></label>
      <button type="button" disabled={busy} onClick={() => void load().catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy("刷新历史", "Refresh history")}</button>
    </div>
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {truncated ? <small>{copy("仅展示最近 40 个结果；媒体目录内容较多。", "Showing the 40 newest results; the media directory contains more.")}</small> : null}
    {!visible.length ? <p className={styles.mediaEmpty}>{copy("此设备暂无已保存的截图或录屏。", "No saved screenshots or recordings for this device.")}</p> : null}
    <div className={styles.mediaHistoryList}>{visible.map(item => <article className={styles.mediaHistoryCard} key={item.path}>
      <div><strong>{item.kind === "screenshot" ? copy("截图", "Screenshot") : copy("录屏", "Recording")}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
      {item.kind === "screenshot" ? <>
        {/* eslint-disable-next-line @next/next/no-img-element -- The desktop-authenticated route must retain the request headers. */}
        <img loading="lazy" src={`/api/harmony/media/preview?${new URLSearchParams({ serial, filename: item.filename })}`} alt={copy(`${item.filename} 的缩略图`, `Thumbnail of ${item.filename}`)} />
      </> : null}
      <small>{item.filename}{item.width && item.height ? ` · ${item.width}×${item.height}` : ""} · {(item.size / 1024).toFixed(1)} KiB</small>
      <code className={styles.mediaHistoryPath} title={item.path}>{item.path}</code>
      <div className={styles.mediaHistoryActions}>
        <button type="button" disabled={busy || !window.piDesktop?.openPath} onClick={() => void act(async () => {
          if (!await window.piDesktop?.openPath?.(item.path)) throw new Error(copy("无法打开媒体文件", "Could not open media file"));
        }, copy("已打开文件", "Opened file"))}>{copy("打开文件", "Open file")}</button>
        <button type="button" disabled={busy} onClick={() => void act(() => copyText(item.path), copy("路径已复制", "Path copied"))}>{copy("复制路径", "Copy path")}</button>
        <button type="button" disabled={busy || !window.piDesktop?.clipboard?.copyHarmonyMedia} onClick={() => void act(async () => {
          const copyMedia = window.piDesktop?.clipboard?.copyHarmonyMedia;
          if (!copyMedia) throw new Error(copy("媒体剪贴板不可用", "Media clipboard unavailable"));
          await copyMedia({ kind: item.kind, path: item.path });
        }, copy("媒体已复制", "Media copied"))}>{copy("复制媒体", "Copy media")}</button>
      </div>
    </article>)}</div>
  </fieldset>;
}
