"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonySqliteResult } from "@/lib/harmony/sqlite-inspector";

export function SqliteViewer({ initialPath, chinese }: { initialPath: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [path, setPath] = useState(initialPath);
  const [result, setResult] = useState<HarmonySqliteResult>();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { setPath(initialPath); setResult(undefined); }, [initialPath]);
  useEffect(() => () => controller.current?.abort(), []);
  const load = async (table?: string, offset = 0) => {
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ path, ...(table ? { table } : {}), offset: String(offset) });
      const response = await fetch(`/api/harmony/sqlite?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      setResult(data.result);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  return <fieldset><legend>{copy("SQLite 只读查看", "Read-only SQLite viewer")}</legend>
    <p>{copy("先把设备数据库下载到工作区，再打开本地副本。运行中的数据库若使用 WAL，单独下载主文件可能缺少最新事务；请先由应用导出一致快照。", "Download the device database into a workspace first. If a live database uses WAL, its main file alone may miss transactions; export a consistent snapshot from the app first.")}</p>
    <label>{copy("本地数据库完整路径", "Full local database path")}<input value={path} onChange={event => setPath(event.target.value)} /></label>
    <button disabled={busy || !path.trim()} onClick={() => void load()}>{copy("列出数据表", "List tables")}</button>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <><div>{result.tables.map(table => <button key={table} disabled={busy} onClick={() => void load(table)}>{table}</button>)}</div>
      {result.table ? <><h4>{result.table}</h4><div style={{ overflowX: "auto" }}><table><thead><tr>{result.columns?.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
        <tbody>{result.rows?.map((row, rowIndex) => <tr key={`${result.offset}-${rowIndex}`}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell === null ? "NULL" : typeof cell === "object" ? `BLOB ${cell.size} B: ${cell.blobHex}${cell.truncated ? "…" : ""}` : String(cell)}</td>)}</tr>)}</tbody></table></div>
        <button disabled={busy || !result.offset} onClick={() => void load(result.table, Math.max(0, (result.offset ?? 0) - 50))}>{copy("上一页", "Previous")}</button>
        <button disabled={busy || !result.hasMore || (result.offset ?? 0) >= 10_000} onClick={() => void load(result.table, (result.offset ?? 0) + 50)}>{copy("下一页", "Next")}</button></> : null}</> : null}
  </fieldset>;
}
