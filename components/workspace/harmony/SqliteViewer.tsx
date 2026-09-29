"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonySqliteResult } from "@/lib/harmony/sqlite-inspector";

type SnapshotResponse = { id: string; result: HarmonySqliteResult };

async function databaseRequest<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/harmony/sqlite", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Database operation failed");
  return data as T;
}

function closeSnapshot(id: string): void {
  void databaseRequest({ action: "close", id }).catch(() => undefined);
}

export function SqliteViewer({ initialPath, chinese }: { initialPath: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [path, setPath] = useState(initialPath);
  const [result, setResult] = useState<HarmonySqliteResult>();
  const [sql, setSql] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const snapshot = useRef<string | null>(null);
  useEffect(() => {
    controller.current?.abort();
    if (snapshot.current) closeSnapshot(snapshot.current);
    snapshot.current = null; setPath(initialPath); setResult(undefined);
  }, [initialPath]);
  useEffect(() => () => {
    controller.current?.abort();
    if (snapshot.current) closeSnapshot(snapshot.current);
  }, []);

  const open = async () => {
    controller.current?.abort();
    if (snapshot.current) closeSnapshot(snapshot.current);
    snapshot.current = null; setResult(undefined);
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const data = await databaseRequest<SnapshotResponse>({ action: "open", path }, current.signal);
      if (current.signal.aborted) { closeSnapshot(data.id); return; }
      snapshot.current = data.id; setResult(data.result);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const read = async (table?: string, offset = 0, query?: string) => {
    if (!snapshot.current) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const data = await databaseRequest<{ result: HarmonySqliteResult }>({ action: "read", id: snapshot.current, table, offset, sql: query }, current.signal);
      if (!current.signal.aborted) setResult(data.result);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const exportData = async (format: "csv" | "json") => {
    if (!snapshot.current || (!result?.table && !result?.sql)) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    const filename = `harmony-database-${snapshot.current.slice(0, 8)}.${format}`;
    try {
      const picker = (window as Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }> }).showSaveFilePicker;
      const handle = picker ? await picker({ suggestedName: filename }) : null;
      const response = await fetch("/api/harmony/sqlite", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "export", id: snapshot.current, table: result.table, sql: result.sql, format }), signal: current.signal, cache: "no-store" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error?.message ?? data.error ?? "Database export failed");
      }
      if (handle && response.body) await response.body.pipeTo(await handle.createWritable(), { signal: current.signal });
      else {
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (failure) {
      if (!current.signal.aborted && !(failure instanceof DOMException && failure.name === "AbortError")) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally { if (controller.current === current) setBusy(false); }
  };
  const pageBy = (delta: number) => void read(result?.table, Math.max(0, (result?.offset ?? 0) + delta), result?.sql);
  return <fieldset><legend>{copy("SQLite 只读查看", "Read-only SQLite viewer")}</legend>
    <p>{copy("先由应用导出一致快照并下载到工作区。打开后本页使用固定的本地副本，关闭或十分钟后清理；运行中数据库的主文件可能遗漏 WAL 事务。", "Export a consistent snapshot from the app and download it into a workspace. This page keeps a fixed local copy until closed or ten minutes elapse; a live database main file can miss WAL transactions.")}</p>
    <label>{copy("本地数据库完整路径", "Full local database path")}<input value={path} onChange={event => {
      controller.current?.abort();
      if (snapshot.current) closeSnapshot(snapshot.current);
      snapshot.current = null; setResult(undefined); setPath(event.target.value);
    }} /></label>
    <button disabled={busy || !path.trim()} onClick={() => void open()}>{copy("打开数据库快照", "Open database snapshot")}</button>
    {snapshot.current ? <button onClick={() => { controller.current?.abort(); closeSnapshot(snapshot.current!); snapshot.current = null; setResult(undefined); }}>{copy("关闭", "Close")}</button> : null}
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <><div>{result.tables.map(table => <button key={`table-${table}`} disabled={busy} onClick={() => void read(table)}>{table}</button>)}
      {result.views?.map(view => <button key={`view-${view}`} disabled={busy} onClick={() => void read(view)}>{copy("视图", "View")}: {view}</button>)}</div>
      <label>{copy("只读 SQL（单条 SELECT 或 WITH）", "Read-only SQL (one SELECT or WITH)")}
        <textarea value={sql} onChange={event => setSql(event.target.value)} rows={3} /></label>
      <button disabled={busy || !sql.trim()} onClick={() => void read(undefined, 0, sql)}>{copy("执行查询", "Run query")}</button>
      {result.table || result.sql ? <><h4>{result.table ?? copy("查询结果", "Query result")}</h4>
        <button disabled={busy} onClick={() => void exportData("csv")}>{copy("导出 CSV", "Export CSV")}</button>
        <button disabled={busy} onClick={() => void exportData("json")}>{copy("导出 JSON", "Export JSON")}</button>
        {result.fields?.length ? <details><summary>{copy("字段与索引", "Fields and indexes")}</summary><ul>
          {result.fields.map(field => <li key={field.name}>{field.name} {field.type}{field.primaryKey ? " · PK" : ""}{field.notNull ? " · NOT NULL" : ""}</li>)}
          {result.indexes?.map(index => <li key={index.name}>{copy("索引", "Index")}: {index.name}{index.unique ? " · UNIQUE" : ""}</li>)}
        </ul></details> : null}
        <div style={{ overflowX: "auto" }}><table><thead><tr>{result.columns?.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr></thead>
          <tbody>{result.rows?.map((row, rowIndex) => <tr key={`${result.offset}-${rowIndex}`}>{row.map((cell, columnIndex) => <td key={columnIndex}>{cell === null ? "NULL" : typeof cell === "object" ? `BLOB ${cell.size} B: ${cell.blobHex}${cell.truncated ? "…" : ""}` : String(cell)}</td>)}</tr>)}</tbody></table></div>
        <button disabled={busy || !result.offset} onClick={() => pageBy(-200)}>{copy("上一页", "Previous")}</button>
        <button disabled={busy || !result.hasMore || (result.offset ?? 0) >= (result.sql ? 800 : 10_000)} onClick={() => pageBy(200)}>{copy("下一页", "Next")}</button></> : null}</> : null}
  </fieldset>;
}
