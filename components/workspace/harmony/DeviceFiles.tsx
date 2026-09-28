"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyDeviceFile, HarmonyFileScope } from "@/lib/harmony/device-files";

export function DeviceFiles({ serial, chinese, cwd, canControl, ensureControl }: { serial: string; chinese: boolean; cwd?: string | null; canControl: boolean; ensureControl: () => Promise<string> }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared");
  const [bundleName, setBundleName] = useState("");
  const [path, setPath] = useState("/data/local/tmp");
  const [files, setFiles] = useState<HarmonyDeviceFile[]>([]);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<HarmonyDeviceFile>(), [destinationPath, setDestinationPath] = useState(""), [notice, setNotice] = useState("");
  const [sourcePath, setSourcePath] = useState(""), [remotePath, setRemotePath] = useState(""), [overwrite, setOverwrite] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setFiles([]); setSelected(undefined); setError(""); setNotice(""); }, [serial, kind, bundleName]);
  const open = async (nextPath: string) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: nextPath, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setFiles(data.files); setTruncated(Boolean(data.truncated)); setPath(nextPath); setSelected(undefined); setNotice("");
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const download = async () => {
    if (!selected || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/harmony/files", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action: "download", serial, kind, ...(kind === "sandbox" ? { bundleName } : {}), path: selected.path, destinationPath }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setNotice(copy(`已保存 ${data.result.size} 字节到 ${data.result.destinationPath}`, `Saved ${data.result.size} bytes to ${data.result.destinationPath}`));
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const upload = async () => {
    if (busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action: "upload_file", serial, leaseToken: await ensureControl(), kind,
          ...(kind === "sandbox" ? { bundleName } : {}), sourcePath, path: remotePath, overwrite }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setNotice(copy("上传命令已完成；请刷新目录并核对设备文件。", "Upload command completed; refresh the directory to inspect the device file."));
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const parent = path === "/" || path === "." ? null : path.slice(0, path.lastIndexOf("/")) || (kind === "shared" ? "/" : ".");
  return <section aria-label={copy("设备文件", "Device files")}>
    <h3>{copy("设备文件", "Device files")}</h3>
    <p>{copy("浏览 HDC 可读取的位置。应用沙箱需要调试签名且应用已启动；设备权限不足会显示错误。", "Browse locations readable through HDC. App sandboxes require a running debug-signed app; unavailable device access is reported.")}</p>
    <label>{copy("范围", "Scope")}<select value={kind} onChange={event => { const next = event.target.value as HarmonyFileScope["kind"]; setKind(next); setPath(next === "shared" ? "/data/local/tmp" : "data/storage/el2/base"); }}><option value="shared">{copy("设备共享路径", "Device path")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></label>
    {kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}
    <label>{copy("路径", "Path")}<input value={path} onChange={event => setPath(event.target.value)} /></label>
    <button disabled={busy || (kind === "sandbox" && !bundleName.trim())} onClick={() => void open(path)}>{copy("打开目录", "Open directory")}</button>
    {parent ? <button disabled={busy} onClick={() => void open(parent)}>{copy("上一级", "Parent")}</button> : null}
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {truncated ? <p role="status">{copy("只显示前 500 项，请进入子目录。", "Showing the first 500 entries; open a subdirectory.")}</p> : null}
    <ul>{files.map(file => <li key={file.path}>
      {file.kind === "directory" ? <button disabled={busy} onClick={() => void open(file.path)}>{file.name}/</button>
        : file.kind === "file" ? <button disabled={busy} onClick={() => { setSelected(file); setDestinationPath(cwd ? `${cwd}${cwd.includes("\\") ? "\\" : "/"}${file.name}` : ""); }}>{file.name}</button>
          : <span>{file.name}</span>}
      <small> · {file.kind}{file.size === undefined ? "" : ` · ${file.size} B`}{file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ""}{file.mode ? ` · ${file.mode}` : ""}</small>
    </li>)}</ul>
    {selected ? <fieldset><legend>{copy("下载文件", "Download file")}: {selected.name}</legend>
      <p>{copy("保存到已获准工作区中的新文件名；不会覆盖现有文件。", "Save to a new file within an allowed workspace; existing files are never overwritten.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input value={destinationPath} onChange={event => setDestinationPath(event.target.value)} /></label>
      <button disabled={busy || !destinationPath.trim()} onClick={() => void download()}>{copy("下载到本机", "Download to computer")}</button>
    </fieldset> : null}
    <fieldset><legend>{copy("上传文件", "Upload file")}</legend>
      <p>{copy("只能从已获准工作区上传 256 MiB 内的本地文件；设备目标仅限共享存储或调试应用沙箱。", "Upload a local file of at most 256 MiB from an allowed workspace to shared storage or a debug app sandbox.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input value={sourcePath} onChange={event => { const value = event.target.value; setSourcePath(value); const name = value.split(/[\\/]/).at(-1); if (name) setRemotePath(`${path.replace(/\/$/, "")}/${name}`); }} /></label>
      <label>{copy("设备目标路径", "Device target path")}<input value={remotePath} onChange={event => setRemotePath(event.target.value)} /></label>
      <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{copy("覆盖设备上的同名文件", "Overwrite an existing device file")}</label>
      <button disabled={busy || !canControl || !sourcePath.trim() || !remotePath.trim()} onClick={() => void upload()}>{copy("上传到设备", "Upload to device")}</button>
    </fieldset>
  </section>;
}
