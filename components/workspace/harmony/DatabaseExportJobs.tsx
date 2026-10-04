"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarmonyDatabaseExportJob } from "@/lib/harmony/database-export-jobs";
import styles from "../HarmonyPanel.module.css";

export function DatabaseExportJobs({ serial, chinese }: { serial: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [jobs, setJobs] = useState<HarmonyDatabaseExportJob[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/harmony/database-exports?serial=${encodeURIComponent(serial)}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Unable to load database exports");
    if (!Array.isArray(data.jobs)) throw new Error("Invalid database export history");
    setJobs(data.jobs);
  }, [serial]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(controller.signal).catch(() => undefined); }, 2_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);
  const change = async (job: HarmonyDatabaseExportJob, remove: boolean) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const params = new URLSearchParams({ serial, id: job.id, ...(remove ? { remove: "1" } : {}) });
      const response = await fetch(`/api/harmony/database-exports?${params}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Database export action failed");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const download = async (job: HarmonyDatabaseExportJob) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    const url = `/api/harmony/database-exports?${new URLSearchParams({ serial, download: job.id })}`;
    const filename = `harmony-database-${job.id.slice(0, 8)}.${job.format}`;
    try {
      const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }> }).showSaveFilePicker;
      if (picker) {
        const handle = await picker.call(window, { suggestedName: filename });
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok || !response.body) {
          const data = await response.json(); throw new Error(data.error?.message ?? data.error ?? "Database export download failed");
        }
        await response.body.pipeTo(await handle.createWritable());
        setNotice(copy(`已保存 ${filename}`, `Saved ${filename}`));
      } else {
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
        setNotice(copy("已发起下载；请核对浏览器保存结果。", "Download started; check the browser's saved file."));
      }
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError")) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const status = (job: HarmonyDatabaseExportJob) => ({ queued: copy("排队中", "Queued"), running: copy("导出中", "Exporting"),
    completed: copy("已完成", "Completed"), failed: copy("失败", "Failed"), cancelled: copy("已取消", "Cancelled"), interrupted: copy("已中断", "Interrupted") })[job.status];
  return <fieldset className={styles.dbJobBoard} data-harmony-task-section="database" aria-label={copy("数据库导出任务", "Database export jobs")}>
    <legend>{copy("数据库导出任务", "Database export jobs")}</legend>
    <div className={styles.dbJobsHeader}><p>{copy("导出在后台运行，切换页面后可在这里继续查看。每份结果最多 10 万行或 64 MiB；已完成结果可再次下载。", "Exports run in the background and remain here after navigation. Results are capped at 100,000 rows or 64 MiB and can be downloaded again.")}</p>
      <button type="button" disabled={busy} onClick={() => void load().catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy("刷新导出任务", "Refresh export jobs")}</button></div>
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {jobs.length === 0 ? <p>{copy("暂无数据库导出任务", "No database exports yet")}</p> : null}
    <div className={styles.dbJobList}>{jobs.slice(0, 30).map(job => <article className={styles.dbJobCard} key={job.id}>
      <div className={styles.dbJobTop}><strong>{job.source}</strong><span data-status={job.status}>{status(job)}</span></div>
      <div className={styles.dbJobMeta}><span>{job.format.toUpperCase()} / {job.encoding}</span><span>{job.range === "page" ? copy(`第 ${Math.floor(job.offset / 200) + 1} 页`, `Page ${Math.floor(job.offset / 200) + 1}`) : copy("全部结果", "All rows")}</span>
        {job.rows !== undefined ? <span>{job.rows} {copy("行", "rows")}</span> : null}{job.bytes !== undefined ? <span>{job.bytes.toLocaleString()} B</span> : null}
        <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time></div>
      {job.destinationPath && job.status === "completed" ? <p>{copy("已保存到", "Saved to")}: <code>{job.destinationPath}</code></p> : null}
      {job.error ? <p role="alert">{job.error}</p> : null}
      <div className={styles.dbJobActions}>{job.status === "completed" ? <button type="button" disabled={busy} onClick={() => void download(job)}>{copy("下载结果…", "Download result…")}</button> : null}
        {job.status === "queued" || job.status === "running" ? <button type="button" disabled={busy} onClick={() => void change(job, false)}>{copy("取消导出", "Cancel export")}</button>
          : <button type="button" disabled={busy} onClick={() => void change(job, true)}>{copy("移除任务记录", "Remove job record")}</button>}</div>
    </article>)}</div>
  </fieldset>;
}
