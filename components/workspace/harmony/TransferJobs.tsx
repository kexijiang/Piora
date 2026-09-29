"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarmonyDeviceFile, HarmonyFileScope } from "@/lib/harmony/device-files";
import type { HarmonyTransferInput, HarmonyTransferJob } from "@/lib/harmony/transfer-jobs";

export function TransferJobs({ serial, scope, deviceDirectory, cwd, selectedFiles, chinese, canControl, ensureControl, onDownloadsQueued, onOpenDatabase, historyOnly = false }: {
  serial: string; scope: HarmonyFileScope; deviceDirectory: string; cwd?: string | null; selectedFiles: HarmonyDeviceFile[];
  chinese: boolean; canControl: boolean; ensureControl: () => Promise<string>; onDownloadsQueued: () => void; onOpenDatabase?: (path: string) => void; historyOnly?: boolean;
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [jobs, setJobs] = useState<HarmonyTransferJob[]>([]);
  const [uploadPaths, setUploadPaths] = useState("");
  const [remoteDirectory, setRemoteDirectory] = useState(deviceDirectory);
  const [downloadDirectory, setDownloadDirectory] = useState(cwd ?? "");
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { setRemoteDirectory(deviceDirectory); }, [deviceDirectory]);
  useEffect(() => { setDownloadDirectory(cwd ?? ""); }, [cwd]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/harmony/transfers?serial=${encodeURIComponent(serial)}`, { signal, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Unable to load transfers");
    setJobs(data.jobs);
  }, [serial]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => undefined);
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(controller.signal).catch(() => undefined); }, 2_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);
  const request = async (items: HarmonyTransferInput[], needsControl: boolean) => {
    if (busy || !items.length) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const leaseToken = needsControl ? await ensureControl() : undefined;
      const response = await fetch("/api/harmony/transfers", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serial, scope, items, ...(leaseToken ? { leaseToken } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Unable to queue transfer");
      setNotice(copy(`任务已入队：${data.job.id}`, `Queued transfer: ${data.job.id}`));
      if (needsControl) setUploadPaths(""); else onDownloadsQueued();
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const queueDownloads = () => {
    const base = downloadDirectory.trim().replace(/[\\/]$/, "");
    if (!base) { setError(copy("请选择本地下载目录", "Choose a local download directory")); return; }
    const separator = base.includes("\\") ? "\\" : "/";
    void request(selectedFiles.map(file => ({ direction: "download", path: file.path, destinationPath: `${base}${separator}${file.name}` })), false);
  };
  const queueUploads = () => {
    const paths = uploadPaths.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    if (!paths.length || paths.length > 20) { setError(copy("每批填写 1–20 个本地文件路径", "Enter 1–20 local file paths per batch")); return; }
    const base = remoteDirectory.trim().replace(/\/$/, "");
    void request(paths.map(sourcePath => ({ direction: "upload", sourcePath, path: `${base}/${sourcePath.split(/[\\/]/).at(-1) ?? ""}`, overwrite })), true);
  };
  const changeJob = async (id: string, remove: boolean) => {
    setError("");
    try {
      const response = await fetch(`/api/harmony/transfers?id=${encodeURIComponent(id)}${remove ? "&remove=1" : ""}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Transfer action failed");
      await load();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <fieldset aria-label={copy("后台传输任务", "Background transfer jobs")}>
    <legend>{copy("后台传输任务", "Background transfer jobs")}</legend>
    {!historyOnly ? <>
    <p>{copy("每批最多 20 个文件。离开面板后任务继续执行；运行中的文件没有可信逐字节百分比，下面显示已确认完成的文件数与字节数。", "Up to 20 files per batch. Jobs continue after leaving this panel. HDC does not provide a reliable live byte percentage; confirmed files and bytes are shown below.")}</p>
    <label>{copy("下载到本地目录", "Download to local directory")}<input value={downloadDirectory} onChange={event => setDownloadDirectory(event.target.value)} /></label>
    <button disabled={busy || !selectedFiles.length} onClick={queueDownloads}>{copy(`下载选中的 ${selectedFiles.length} 个文件`, `Download ${selectedFiles.length} selected files`)}</button>
    <label>{copy("上传的本地文件路径（每行一个）", "Local upload paths (one per line)")}<textarea rows={3} value={uploadPaths} onChange={event => setUploadPaths(event.target.value)} /></label>
    <label>{copy("设备目标目录", "Device destination directory")}<input value={remoteDirectory} onChange={event => setRemoteDirectory(event.target.value)} /></label>
    <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{copy("允许覆盖同名设备文件", "Allow overwriting device files")}</label>
    <button disabled={busy || !canControl || !uploadPaths.trim()} onClick={queueUploads}>{copy("上传这一批", "Upload this batch")}</button>
    </> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <h4>{copy("任务历史", "Job history")}</h4>
    {jobs.length === 0 ? <p>{copy("暂无传输任务", "No transfer jobs yet")}</p> : null}
    <ul>{jobs.slice(0, 30).map(job => <li key={job.id}>
      <strong>{job.status}</strong> · {job.completedItems}/{job.totalItems} {copy("项", "files")} · {job.completedBytes} B
      <small> · {new Date(job.createdAt).toLocaleString()}</small>
      {job.error ? <p role="alert">{job.error}</p> : null}
      <details><summary>{copy("查看文件", "View files")}</summary><ul>{job.items.map((item, index) => <li key={`${job.id}-${index}`}>
        {item.direction === "upload" ? "↑" : "↓"} {item.path} · {item.status}{item.size === undefined ? "" : ` · ${item.size} B`}
        {item.effect === "unknown" ? copy(" · 设备效果未确认", " · device effect unknown") : ""}{item.error ? ` · ${item.error}` : ""}
        {item.direction === "download" && item.status === "completed" && /\.(?:db|sqlite|sqlite3)$/i.test(item.destinationPath) && onOpenDatabase
          ? <button onClick={() => onOpenDatabase(item.destinationPath)}>{copy("用只读 SQLite 查看器打开", "Open in read-only SQLite viewer")}</button> : null}
      </li>)}</ul></details>
      {job.status === "queued" || job.status === "running" ? <button onClick={() => void changeJob(job.id, false)}>{copy("取消", "Cancel")}</button>
        : <button onClick={() => void changeJob(job.id, true)}>{copy("移除记录", "Remove record")}</button>}
    </li>)}</ul>
  </fieldset>;
}
