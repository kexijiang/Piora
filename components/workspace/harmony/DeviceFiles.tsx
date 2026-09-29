"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyDeviceFile, HarmonyFileScope } from "@/lib/harmony/device-files";
import type { DeviceNewline, DeviceTextEncoding, DeviceTextReadEncoding, WritableDeviceNewline } from "@/lib/harmony/device-text";
import { SqliteViewer } from "./SqliteViewer";
import { visibleDeviceFiles, type FileSortKey } from "./file-list-view";
import { TransferJobs } from "./TransferJobs";
import { TextDiff } from "./TextDiff";

const DEVICE_FILE_PAGE_SIZE = 500;

export function DeviceFiles({ serial, chinese, cwd, canControl, ensureControl }: { serial: string; chinese: boolean; cwd?: string | null; canControl: boolean; ensureControl: () => Promise<string> }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared");
  const [bundleName, setBundleName] = useState("");
  const [path, setPath] = useState("/data/local/tmp");
  const [listedPath, setListedPath] = useState("");
  const [files, setFiles] = useState<HarmonyDeviceFile[]>([]);
  const [offset, setOffset] = useState(0);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<HarmonyDeviceFile>(), [destinationPath, setDestinationPath] = useState(""), [notice, setNotice] = useState("");
  const [sourcePath, setSourcePath] = useState(""), [remotePath, setRemotePath] = useState(""), [overwrite, setOverwrite] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(""), [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState("");
  const [preview, setPreview] = useState<{ text: string; hash: string; size: number; encoding?: DeviceTextEncoding; newline?: DeviceNewline }>();
  const [editedText, setEditedText] = useState("");
  const [readEncoding, setReadEncoding] = useState<DeviceTextReadEncoding>("auto");
  const [diffPreview, setDiffPreview] = useState<{ original: string; edited: string }>();
  const [newlineMode, setNewlineMode] = useState<WritableDeviceNewline>();
  const [databasePath, setDatabasePath] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{ files: HarmonyDeviceFile[]; scannedDirectories: number; skippedDirectories: number; truncated: boolean }>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [batchPaths, setBatchPaths] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [sortKey, setSortKey] = useState<FileSortKey>("name");
  const [descending, setDescending] = useState(false);
  const bookmarkKey = `piora-harmony-bookmarks:${serial}:${kind}:${kind === "sandbox" ? bundleName : ""}`;
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setFiles([]); setBatchPaths([]); setListedPath(""); setOffset(0); setTruncated(false); setSelected(undefined); setPreview(undefined); setError(""); setNotice(""); }, [serial, kind, bundleName]);
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(bookmarkKey) ?? "[]"); setBookmarks(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : []); } catch { setBookmarks([]); } }, [bookmarkKey]);
  const saveBookmarks = (next: string[]) => { setBookmarks(next); try { localStorage.setItem(bookmarkKey, JSON.stringify(next)); } catch { /* Private browsing may disable storage. */ } };
  const chooseFile = (file: HarmonyDeviceFile) => {
    setSelected(file); setPreview(undefined); setDiffPreview(undefined); setNewName(file.name); setNewMode(file.mode?.slice(-3) ?? "");
    setDestinationPath(cwd ? `${cwd}${cwd.includes("\\") ? "\\" : "/"}${file.name}` : "");
  };
  const open = async (nextPath: string, nextOffset = 0) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: nextPath, offset: String(nextOffset), ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setFiles(data.files); setBatchPaths([]); setTruncated(Boolean(data.truncated)); setPath(nextPath); setListedPath(nextPath); setOffset(nextOffset); setSelected(undefined); setPreview(undefined); setNotice("");
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
      if (/\.(?:db|sqlite|sqlite3)$/i.test(data.result.destinationPath)) setDatabasePath(data.result.destinationPath);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const search = async () => {
    if (busy || !searchQuery.trim()) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setSearchResult(undefined);
    try {
      const params = new URLSearchParams({ serial, kind, path, query: searchQuery, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files/search?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setSearchResult(data.result);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const loadPreview = async () => {
    if (!selected || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: selected.path, encoding: readEncoding, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files/text?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setPreview(data.result); setEditedText(data.result.text); setNewlineMode(undefined); setDiffPreview(undefined);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const saveText = async () => {
    if (!selected || !preview || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/harmony/files/text", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ serial, leaseToken: await ensureControl(), kind, ...(kind === "sandbox" ? { bundleName } : {}), path: selected.path,
          text: editedText, expectedHash: preview.hash, encoding: preview.encoding, ...(newlineMode ? { newlineMode } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setPreview(undefined); setDiffPreview(undefined);
      setNotice(copy("设备已核对新文本哈希；重新打开可查看最新内容。", "The device verified the new text hash; reopen to inspect the saved content."));
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
  const mutate = async (action: "create_directory" | "delete_path" | "rename_path" | "chmod_path", fields: Record<string, unknown>) => {
    if (busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action, serial, leaseToken: await ensureControl(), kind, ...(kind === "sandbox" ? { bundleName } : {}), ...fields }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setNotice(copy("设备路径复查完成；请刷新目录查看结果。", "Device path rechecked; refresh the directory to view the result."));
      if (action === "delete_path" || action === "rename_path") setSelected(undefined);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const parent = path === "/" || path === "." ? null : path.slice(0, path.lastIndexOf("/")) || (kind === "shared" ? "/" : ".");
  const visibleFiles = visibleDeviceFiles(files, showHidden, sortKey, descending);
  return <section aria-label={copy("设备文件", "Device files")}>
    <h3>{copy("设备文件", "Device files")}</h3>
    <p>{copy("浏览 HDC 可读取的位置。应用沙箱需要调试签名且应用已启动；设备权限不足会显示错误。", "Browse locations readable through HDC. App sandboxes require a running debug-signed app; unavailable device access is reported.")}</p>
    <label>{copy("范围", "Scope")}<select value={kind} onChange={event => { const next = event.target.value as HarmonyFileScope["kind"]; setKind(next); setPath(next === "shared" ? "/data/local/tmp" : "data/storage/el2/base"); }}><option value="shared">{copy("设备共享路径", "Device path")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></label>
    {kind === "sandbox" ? <label>{copy("应用包名", "App bundle")}<input value={bundleName} onChange={event => setBundleName(event.target.value)} /></label> : null}
    <label>{copy("路径", "Path")}<input value={path} onChange={event => setPath(event.target.value)} /></label>
    <button disabled={busy || (kind === "sandbox" && !bundleName.trim())} onClick={() => void open(path)}>{copy("打开目录", "Open directory")}</button>
    {parent ? <button disabled={busy} onClick={() => void open(parent)}>{copy("上一级", "Parent")}</button> : null}
    <button disabled={busy || bookmarks.includes(path) || bookmarks.length >= 20} onClick={() => saveBookmarks([...bookmarks, path])}>{copy("收藏此路径", "Bookmark this path")}</button>
    {bookmarks.length ? <div>{bookmarks.map(item => <span key={item}><button disabled={busy} onClick={() => void open(item)}>{item}</button><button disabled={busy} aria-label={copy(`移除收藏 ${item}`, `Remove bookmark ${item}`)} onClick={() => saveBookmarks(bookmarks.filter(value => value !== item))}>×</button></span>)}</div> : null}
    <label>{copy("递归查找名称", "Search names recursively")}<input value={searchQuery} maxLength={120} onChange={event => setSearchQuery(event.target.value)} /></label>
    <button disabled={busy || !searchQuery.trim()} onClick={() => void search()}>{copy("查找", "Search")}</button>
    {searchResult ? <div><p role="status">{copy(`已扫描 ${searchResult.scannedDirectories} 个目录，跳过 ${searchResult.skippedDirectories} 个`, `Scanned ${searchResult.scannedDirectories} directories, skipped ${searchResult.skippedDirectories}`)}{searchResult.truncated ? copy("；结果已截断", "; results truncated") : ""}</p>
      <ul>{searchResult.files.map(file => <li key={file.path}><button disabled={busy} onClick={() => file.kind === "directory" ? void open(file.path) : chooseFile(file)}>{file.path}</button></li>)}</ul></div> : null}
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div>
      <label>{copy("排序", "Sort by")}<select value={sortKey} onChange={event => setSortKey(event.target.value as FileSortKey)}>
        <option value="name">{copy("名称", "Name")}</option><option value="kind">{copy("类型", "Type")}</option>
        <option value="size">{copy("大小", "Size")}</option><option value="modifiedAt">{copy("修改时间", "Modified")}</option>
      </select></label>
      <label><input type="checkbox" checked={descending} onChange={event => setDescending(event.target.checked)} />{copy("降序", "Descending")}</label>
      <label><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />{copy("显示隐藏文件", "Show hidden files")}</label>
      <small>{copy(`本页显示 ${visibleFiles.length}/${files.length} 项`, `Showing ${visibleFiles.length}/${files.length} entries on this page`)}</small>
    </div>
    {listedPath ? <div>
      <small>{copy(`目录第 ${offset + 1}–${offset + files.length} 项；排序仅作用于本页，目录变化时分页位置可能移动。`, `Directory entries ${offset + 1}–${offset + files.length}; sorting applies to this page. Changes to the directory may shift page boundaries.`)}</small>
      <button disabled={busy || offset === 0} onClick={() => void open(listedPath, Math.max(0, offset - DEVICE_FILE_PAGE_SIZE))}>{copy("上一页", "Previous page")}</button>
      <button disabled={busy || !truncated || offset >= 50_000} onClick={() => void open(listedPath, offset + DEVICE_FILE_PAGE_SIZE)}>{copy("下一页", "Next page")}</button>
    </div> : null}
    <ul>{visibleFiles.map(file => <li key={file.path}>
      {file.kind === "file" ? <input type="checkbox" aria-label={copy(`选择批量下载 ${file.name}`, `Select ${file.name} for batch download`)} checked={batchPaths.includes(file.path)} onChange={event => setBatchPaths(current => event.target.checked ? [...current, file.path] : current.filter(value => value !== file.path))} /> : null}
      {file.kind === "directory" ? <><button disabled={busy} onClick={() => void open(file.path)}>{file.name}/</button><button disabled={busy} onClick={() => { setSelected(file); setNewName(file.name); setNewMode(file.mode?.slice(-3) ?? ""); }}>{copy("选择", "Select")}</button></>
        : file.kind === "file" ? <button disabled={busy} onClick={() => chooseFile(file)}>{file.name}</button>
          : <span>{file.name}</span>}
      <small> · {file.kind}{file.size === undefined ? "" : ` · ${file.size} B`}{file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString()}` : ""}{file.mode ? ` · ${file.mode}` : ""}</small>
    </li>)}</ul>
    {selected?.kind === "file" ? <fieldset><legend>{copy("下载文件", "Download file")}: {selected.name}</legend>
      <label>{copy("文本编码", "Text encoding")}<select value={readEncoding} onChange={event => setReadEncoding(event.target.value as DeviceTextReadEncoding)}>
        <option value="auto">{copy("自动识别 BOM / UTF-8", "Auto-detect BOM / UTF-8")}</option><option value="utf-8">UTF-8</option>
        <option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option>
      </select></label>
      <button disabled={busy} onClick={() => void loadPreview()}>{copy("预览文本（最多 2 MiB）", "Preview text (up to 2 MiB)")}</button>
      {preview ? <><small>{preview.size} B · SHA-256 {preview.hash} · {preview.encoding ?? "utf-8"} · {preview.newline ?? "lf"}</small>
        {preview.newline === "mixed" ? <label>{copy("原文件混用换行符；保存时统一为", "Mixed line endings; normalize on save to")}
          <select value={newlineMode ?? ""} onChange={event => setNewlineMode(event.target.value ? event.target.value as WritableDeviceNewline : undefined)}>
            <option value="">{copy("选择换行符", "Choose line endings")}</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option>
          </select></label> : null}
        <textarea value={editedText} onChange={event => setEditedText(event.target.value)} rows={16} style={{ width: "100%" }} />
        <button disabled={busy || editedText === preview.text} onClick={() => setDiffPreview({ original: preview.text, edited: editedText })}>{copy("预览差异", "Preview diff")}</button>
        {diffPreview ? <TextDiff original={diffPreview.original} edited={diffPreview.edited} chinese={chinese} /> : null}
        <button disabled={busy || !canControl || (preview.newline === "mixed" && !newlineMode) || (editedText === preview.text && !newlineMode)} onClick={() => void saveText()}>{copy("核对原内容并保存", "Verify original and save")}</button></> : null}
      <p>{copy("保存到已获准工作区中的新文件名；不会覆盖现有文件。", "Save to a new file within an allowed workspace; existing files are never overwritten.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input value={destinationPath} onChange={event => setDestinationPath(event.target.value)} /></label>
      <button disabled={busy || !destinationPath.trim()} onClick={() => void download()}>{copy("下载到本机", "Download to computer")}</button>
    </fieldset> : null}
    {selected && (selected.kind === "file" || selected.kind === "directory") ? <fieldset><legend>{copy("管理选中路径", "Manage selected path")}: {selected.name}</legend>
      <label>{copy("新名称", "New name")}<input value={newName} onChange={event => setNewName(event.target.value)} /></label>
      <button disabled={busy || !canControl || !newName.trim() || newName === selected.name || newName.includes("/")} onClick={() => void mutate("rename_path", { path: selected.path, newPath: `${selected.path.slice(0, selected.path.lastIndexOf("/"))}/${newName}` })}>{copy("重命名", "Rename")}</button>
      <label>{copy("权限（八进制三位）", "Permissions (three octal digits)")}<input value={newMode} maxLength={3} onChange={event => setNewMode(event.target.value)} placeholder="644" /></label>
      <button disabled={busy || !canControl || !/^[0-7]{3}$/.test(newMode) || newMode === selected.mode} onClick={() => void mutate("chmod_path", { path: selected.path, mode: newMode })}>{copy("修改权限", "Change permissions")}</button>
      <button disabled={busy || !canControl} onClick={() => { if (window.confirm(copy(`删除 ${selected.path}？目录必须为空。`, `Delete ${selected.path}? Directories must be empty.`))) void mutate("delete_path", { path: selected.path }); }}>{copy("删除", "Delete")}</button>
    </fieldset> : null}
    <fieldset><legend>{copy("新建目录", "New directory")}</legend>
      <label>{copy("设备完整路径", "Full device path")}<input value={directoryPath} onChange={event => setDirectoryPath(event.target.value)} placeholder={`${path.replace(/\/$/, "")}/new-folder`} /></label>
      <button disabled={busy || !canControl || !directoryPath.trim()} onClick={() => void mutate("create_directory", { path: directoryPath.trim() })}>{copy("创建目录", "Create directory")}</button>
    </fieldset>
    <fieldset><legend>{copy("上传文件", "Upload file")}</legend>
      <p>{copy("只能从已获准工作区上传 1 GiB 内的本地文件；设备目标仅限共享存储或调试应用沙箱。", "Upload a local file of at most 1 GiB from an allowed workspace to shared storage or a debug app sandbox.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input value={sourcePath} onChange={event => { const value = event.target.value; setSourcePath(value); const name = value.split(/[\\/]/).at(-1); if (name) setRemotePath(`${path.replace(/\/$/, "")}/${name}`); }} /></label>
      <label>{copy("设备目标路径", "Device target path")}<input value={remotePath} onChange={event => setRemotePath(event.target.value)} /></label>
      <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{copy("覆盖设备上的同名文件", "Overwrite an existing device file")}</label>
      <button disabled={busy || !canControl || !sourcePath.trim() || !remotePath.trim()} onClick={() => void upload()}>{copy("上传到设备", "Upload to device")}</button>
    </fieldset>
    <TransferJobs serial={serial} scope={kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName }} deviceDirectory={listedPath || path} cwd={cwd}
      selectedFiles={files.filter(file => batchPaths.includes(file.path) && file.kind === "file")} chinese={chinese} canControl={canControl}
      ensureControl={ensureControl} onDownloadsQueued={() => setBatchPaths([])} onOpenDatabase={setDatabasePath} />
    <SqliteViewer initialPath={databasePath} chinese={chinese} />
  </section>;
}
