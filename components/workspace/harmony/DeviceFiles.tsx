"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyDeviceFile, HarmonyFileScope } from "@/lib/harmony/device-files";

export function DeviceFiles({ serial, chinese }: { serial: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared");
  const [bundleName, setBundleName] = useState("");
  const [path, setPath] = useState("/data/local/tmp");
  const [files, setFiles] = useState<HarmonyDeviceFile[]>([]);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setFiles([]); setError(""); }, [serial, kind, bundleName]);
  const open = async (nextPath: string) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: nextPath, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setFiles(data.files); setTruncated(Boolean(data.truncated)); setPath(nextPath);
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
    {truncated ? <p role="status">{copy("只显示前 500 项，请进入子目录。", "Showing the first 500 entries; open a subdirectory.")}</p> : null}
    <ul>{files.map(file => <li key={file.path}>
      {file.kind === "directory" ? <button disabled={busy} onClick={() => void open(file.path)}>{file.name}/</button> : <span>{file.name}</span>}
      <small> · {file.kind}{file.size === undefined ? "" : ` · ${file.size} B`}{file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ""}{file.mode ? ` · ${file.mode}` : ""}</small>
    </li>)}</ul>
  </section>;
}
