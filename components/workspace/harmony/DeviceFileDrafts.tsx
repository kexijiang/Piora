"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/clipboard";
import { DEVICE_FILE_DRAFT_EVENT, forgetDeviceFileDraft, listDeviceFileDrafts, readDeviceFileDraft, type DeviceFileDraft, type DeviceFileDraftEntry } from "@/lib/harmony/device-file-drafts";
import styles from "../HarmonyPanel.module.css";

export function DeviceFileDrafts({ serial, chinese, busy, onVerify }: {
  serial: string; chinese: boolean; busy: boolean; onVerify: (draft: DeviceFileDraft) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<DeviceFileDraftEntry[]>([]);
  const [next, setNext] = useState<string>();
  const [pageStarts, setPageStarts] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState<string>();
  const [draft, setDraft] = useState<DeviceFileDraft>();
  const [draftStale, setDraftStale] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const listRequest = useRef(0), openRequest = useRef(0);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const load = useCallback(async (after?: string, targetPage = 0) => {
    const generation = ++listRequest.current;
    setLoading(true); setError("");
    try {
      const result = await listDeviceFileDrafts(serial, after);
      if (generation !== listRequest.current) return;
      setEntries(result.entries); setNext(result.next); setStorageUnavailable(Boolean(result.storageUnavailable)); setChanged(false);
      setPageStarts(previous => [...previous.slice(0, targetPage), after]); setPageIndex(targetPage);
    } catch { if (generation === listRequest.current) setError(chinese ? "本机草稿列表读取失败，请重试；没有删除任何草稿。" : "Could not read the local draft list. Retry; no drafts were deleted."); }
    finally { if (generation === listRequest.current) setLoading(false); }
  }, [serial, chinese]);
  useEffect(() => {
    ++listRequest.current; ++openRequest.current; setDraft(undefined); setDraftStale(false); setEntries([]); setNext(undefined); setPageStarts([undefined]); setPageIndex(0); setOpening(undefined); setNotice("");
  }, [serial]);
  useEffect(() => {
    const listGuard = listRequest, openGuard = openRequest;
    if (expanded) void load();
    return () => { ++listGuard.current; ++openGuard.current; };
  }, [expanded, load]);
  useEffect(() => {
    const markChanged = () => setChanged(true);
    window.addEventListener(DEVICE_FILE_DRAFT_EVENT, markChanged);
    return () => window.removeEventListener(DEVICE_FILE_DRAFT_EVENT, markChanged);
  }, []);
  const open = async (entry: DeviceFileDraftEntry) => {
    const generation = ++openRequest.current;
    setOpening(entry.key); setError(""); setNotice("");
    try {
      const result = await readDeviceFileDraft(serial, entry.scope, entry.path);
      if (generation !== openRequest.current) return;
      if (!result) { setDraft(undefined); setError(copy("这条记录没有有效草稿，请刷新列表；没有自动删除内容。", "This record has no valid draft. Refresh the list; nothing was automatically deleted.")); }
      else { setDraft(result); setDraftStale(false); }
    } catch { if (generation === openRequest.current) setError(copy("草稿内容读取失败，请重试。", "Could not read this draft. Retry.")); }
    finally { if (generation === openRequest.current) setOpening(undefined); }
  };
  const discard = async (value: DeviceFileDraft) => {
    const generation = ++openRequest.current;
    setOpening("discard"); setError("");
    try {
      await forgetDeviceFileDraft(value.serial, value.scope, value.path, value);
      if (generation !== openRequest.current) return;
      setDraft(undefined); setNotice(copy("这份本机草稿已放弃；设备文件未更改。", "Local draft discarded; device file unchanged.")); await load();
    } catch (failure) { if (generation === openRequest.current) {
      const stale = failure instanceof Error && failure.message === "Draft changed during discard";
      setDraftStale(stale); setError(stale ? copy("草稿已有新编辑或已变化，未放弃；请刷新并重新选择。", "Draft changed or has newer edits; it was not discarded. Refresh and select it again.")
        : copy("本机草稿删除失败，保留恢复副本；可复制后重试。", "Local draft deletion failed; recovery copy retained. Copy it and retry."));
    } }
    finally { if (generation === openRequest.current) setOpening(undefined); }
  };
  const current = draft?.serial === serial ? draft : undefined;
  return <section className={styles.fileDrafts} aria-label={copy("本机文件草稿", "Local device file drafts")}>
    <div className={styles.fileDraftToolbar}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{copy("本机草稿", "Local drafts")}{expanded ? " ▴" : " ▾"}</button>
      <small>{copy("文件已移走或设备不可读时，也可找回与复制草稿", "Recover and copy drafts even when files moved or the device is unreadable")}</small>
    </div>
    {expanded ? <>
      <div className={styles.fileDraftBody} data-has-draft={Boolean(current)}>
      <div className={styles.fileDraftCatalog}>
      <div className={styles.fileDraftToolbar}>
        <button type="button" disabled={loading || Boolean(opening)} onClick={() => void load()}>{copy("刷新草稿列表", "Refresh drafts")}</button>
        <button type="button" disabled={loading || Boolean(opening) || pageIndex === 0} onClick={() => void load(pageStarts[pageIndex - 1], pageIndex - 1)}>{copy("上一页草稿", "Previous draft page")}</button>
        <button type="button" disabled={loading || Boolean(opening) || !next} onClick={() => void load(next, pageIndex + 1)}>{copy("下一页草稿", "Next draft page")}</button>
        <small>{loading ? copy("读取本机列表…", "Reading local list…") : copy(`第 ${pageIndex + 1} 页，本页 ${entries.filter(entry => entry.serial === serial).length} 份；每页最多 50 份`, `Page ${pageIndex + 1}, ${entries.filter(entry => entry.serial === serial).length} drafts; up to 50 per page`)}</small>
      </div>
      {changed ? <small>{copy("草稿有变化，可刷新列表。", "Drafts changed. Refresh the list.")}</small> : null}
      {storageUnavailable ? <p role="alert">{copy("本机持久存储不可读，仅列出当前窗口内副本；关闭前请复制。", "Durable storage unreadable; only this window's copies are listed. Copy before closing.")}</p> : null}
      <ul className={styles.fileDraftList} aria-label={copy("本机草稿列表", "Local draft list")}>
        {entries.filter(entry => entry.serial === serial).map(entry => <li key={entry.key}>
          <button type="button" disabled={Boolean(opening)} aria-pressed={current?.path === entry.path && current.scope.kind === entry.scope.kind && (current.scope.kind === "shared" || entry.scope.kind === "sandbox" && current.scope.bundleName === entry.scope.bundleName)} onClick={() => void open(entry)}>
            <code>{entry.path}</code><small>{entry.scope.kind === "sandbox" ? entry.scope.bundleName : copy("共享目录", "Shared storage")}{entry.updatedAt ? ` · ${new Date(entry.updatedAt).toLocaleString()}` : copy(" · 修改时间未知", " · Modification time unknown")}</small>
          </button>
        </li>)}
      </ul>
      {!loading && !entries.length && !error ? <small>{copy("没有可显示的本机草稿。", "No local drafts to display.")}</small> : null}
      </div>
      {current ? <section className={styles.fileDraftRecovery} aria-label={copy("本机恢复草稿", "Recovered local draft")}>
        <strong>{copy("本机恢复副本 · 尚未核对设备", "Local recovery copy · device not verified")}</strong>
        <code>{current.scope.kind === "sandbox" ? `${current.scope.bundleName} · ` : ""}{current.path}</code>
        <small>{copy("原文与 SHA-256 来自编辑前采集；不是当前设备内容。", "Original and SHA-256 were captured before editing; this is not current device content.")}<code>{current.original.hash}</code></small>
        <textarea aria-label={copy("本机恢复草稿内容", "Recovered draft content")} readOnly value={current.text} rows={8} />
        <div className={styles.fileDraftToolbar}>
          <button type="button" onClick={() => void copyText(current.text).then(() => setNotice(copy("恢复草稿已复制", "Recovered draft copied"))).catch(() => setError(copy("草稿复制失败，请重试。", "Could not copy this draft. Retry.")))}>{copy("复制恢复草稿", "Copy recovered draft")}</button>
          <button type="button" disabled={busy || Boolean(opening)} onClick={() => onVerify(current)}>{copy("核对设备文件", "Check device file")}</button>
          <button type="button" disabled={Boolean(opening) || draftStale} onClick={() => void discard(current)}>{copy("放弃这份本机草稿", "Discard this local draft")}</button>
        </div>
        <details><summary>{copy("查看采集时原文", "View captured original")}</summary><textarea aria-label={copy("草稿采集时原文", "Original captured for draft")} readOnly value={current.original.text} rows={6} /></details>
      </section> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    </> : null}
  </section>;
}
