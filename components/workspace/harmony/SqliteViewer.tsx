"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { HarmonySqliteResult } from "@/lib/harmony/sqlite-inspector";
import { AliIcon } from "@/components/AliIcon";
import { copyText } from "@/lib/clipboard";
import { HarmonySqliteQueryError, sqliteQueryPosition } from "@/lib/harmony/sqlite-query-error";
import styles from "../HarmonyPanel.module.css";
import { WorkbenchTreeSeparator } from "./WorkbenchTreeSeparator";

type SnapshotResponse = { id: string; result: HarmonySqliteResult; capturedAt: string; database?: { size?: number; verification?: "double-copy-sha256" } };
type CatalogDatabase = { id: string; identity?: string; name: string; size?: number; status?: "unavailable"; reason?: string };
type CatalogApp = { bundleName: string; label?: string; status: "pending" | "scanning" | "ready" | "empty" | "inaccessible"; reason?: string; databases: CatalogDatabase[] };
type Catalog = { startedAt: string; completedAt?: string; scanning: boolean; applications: CatalogApp[] };
type SavedDatabaseTab = { bundleName: string; identity?: string; name: string; sql: string; tableTabs?: string[] };
type SavedDatabaseTabs = { tabs: SavedDatabaseTab[]; active?: { bundleName: string; identity?: string; name: string } };
type QueryContext = { fullText: string; start: number };
type QueryFailure = QueryContext & { message: string; offset?: number; database: string };
type DatabaseTreeKeyOptions = {
  expanded?: boolean;
  parentKey?: string;
  onActivate?: () => void;
  onCollapse?: () => void;
  onExpand?: () => void;
};

function databaseDisplayName(app: CatalogApp, database: CatalogDatabase): string {
  return app.databases.filter(item => item.name === database.name).length > 1
    ? `${database.name} · ${(database.identity ?? database.id).slice(0, 6)}` : database.name;
}

type GridCell = NonNullable<HarmonySqliteResult["rows"]>[number][number];

function copyableCell(cell: GridCell): string {
  if (cell === null) return "NULL";
  if (typeof cell === "object") return `BLOB ${cell.size} B: ${cell.blobHex}${cell.truncated ? "… (truncated)" : ""}`;
  return String(cell);
}

async function databaseRequest<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api/harmony/databases", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new HarmonySqliteQueryError(data.error, response.status);
  return data as T;
}

function closeSnapshot(id: string, serial: string): void {
  void databaseRequest({ action: "close", id, serial }).catch(() => undefined);
}

type SqliteViewerProps = { serial: string; initialDatabaseId?: string; chinese: boolean; onShowTasks?: () => void };

export function SqliteViewer(props: SqliteViewerProps) {
  // Catalogs, open snapshots and saved tab state belong to one physical device.
  return <SqliteViewerSession key={props.serial} {...props} />;
}

function SqliteViewerSession({ serial, initialDatabaseId, chinese, onShowTasks }: SqliteViewerProps) {
  const appTreeId = useId();
  const databaseLayoutRef = useRef<HTMLDivElement>(null);
  const databaseTreeRef = useRef<HTMLDivElement>(null);
  const focusedDatabaseTreeKey = useRef("");
  const focusedDatabaseTreeElement = useRef<HTMLElement | null>(null);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [catalog, setCatalog] = useState<Catalog>();
  const [search, setSearch] = useState("");
  const [selectedApp, setSelectedApp] = useState("");
  const [selectedDatabase, setSelectedDatabase] = useState(initialDatabaseId ?? "");
  const [openDatabaseTabs, setOpenDatabaseTabs] = useState<string[]>([]);
  const [tableTabsByDatabase, setTableTabsByDatabase] = useState<Record<string, string[]>>({});
  const [sqlDrafts, setSqlDrafts] = useState<Record<string, string>>({});
  const [tabsReady, setTabsReady] = useState(false);
  const [capturedAt, setCapturedAt] = useState("");
  const [snapshotSize, setSnapshotSize] = useState<number | null>(null);
  const [snapshotVerified, setSnapshotVerified] = useState(false);
  const [contentTab, setContentTab] = useState<"data" | "structure">("data");
  const [queryConsoleOpen, setQueryConsoleOpen] = useState(true);
  const [databaseObjectsCollapsed, setDatabaseObjectsCollapsed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState("");
  const [objectIndexes, setObjectIndexes] = useState<NonNullable<HarmonySqliteResult["indexes"]>>([]);
  const [rowFilter, setRowFilter] = useState("");
  const [sortColumn, setSortColumn] = useState<number | null>(null);
  const [sortDescending, setSortDescending] = useState(false);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizingColumn = useRef<{ key: string; startX: number; width: number } | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ row: number; column: number } | null>(null);
  const [copyNotice, setCopyNotice] = useState("");
  const [exportFormat, setExportFormat] = useState<"csv" | "json" | null>(null);
  const [exportRange, setExportRange] = useState<"all" | "page">("all");
  const [exportEncoding, setExportEncoding] = useState<"utf-8" | "utf-8-bom" | "utf-16le">("utf-8");
  const [exportDestination, setExportDestination] = useState("");
  const [exportBusy, setExportBusy] = useState(false), [exportNotice, setExportNotice] = useState("");
  const [queryDurationMs, setQueryDurationMs] = useState<number | null>(null);
  const [queryFailure, setQueryFailure] = useState<QueryFailure | null>(null);
  const [result, setResult] = useState<HarmonySqliteResult>();
  const sql = sqlDrafts[selectedDatabase] ?? "";
  const sqlInput = useRef<HTMLTextAreaElement>(null);
  const resultGrid = useRef<HTMLDivElement>(null);
  const pendingResultReveal = useRef<HarmonySqliteResult | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const snapshot = useRef<string | null>(null);
  const autoOpened = useRef("");
  const restoredTabs = useRef(false);
  const scanStartedAt = useRef("");
  const catalogRequest = useRef<AbortController | null>(null);
  const savedTabs = useRef<SavedDatabaseTabs | null>(null);
  const tabsKey = `piora-harmony-database-tabs:${serial}`;
  useLayoutEffect(() => {
    if (!result || pendingResultReveal.current !== result) return;
    pendingResultReveal.current = null;
    const grid = resultGrid.current;
    if (grid) {
      grid.scrollTop = 0;
      grid.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }, [result]);
  const invalidateCatalog = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    if (snapshot.current) closeSnapshot(snapshot.current, serial);
    snapshot.current = null;
    setBusy(false); setResult(undefined); setObjectIndexes([]); setSelectedIndex(""); setDatabaseObjectsCollapsed(false);
    setCapturedAt(""); setSnapshotSize(null); setSnapshotVerified(false);
    setSelectedCell(null); setCopyNotice(""); setExportFormat(null); setExportNotice("");
    setQueryDurationMs(null); setError(""); setQueryFailure(null);
    setTabsReady(false); restoredTabs.current = false;
    setOpenDatabaseTabs([]); setSelectedDatabase("");
  }, [serial]);
  const refreshCatalog = useCallback(async (rescan = false) => {
    if (!serial || (catalogRequest.current && !rescan)) return;
    catalogRequest.current?.abort();
    const request = new AbortController();
    catalogRequest.current = request;
    if (rescan) { invalidateCatalog(); setCatalog(undefined); }
    try {
      const response = await fetch(`/api/harmony/databases?serial=${encodeURIComponent(serial)}${rescan ? "&refresh=1" : ""}`, {
        cache: "no-store", signal: request.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Database discovery failed");
      if (request.signal.aborted || catalogRequest.current !== request) return;
      if (scanStartedAt.current && scanStartedAt.current !== data.startedAt) invalidateCatalog();
      scanStartedAt.current = data.startedAt;
      setCatalog(data);
    } catch (failure) {
      if (!request.signal.aborted && catalogRequest.current === request) setError(failure instanceof Error ? failure.message : String(failure));
    } finally { if (catalogRequest.current === request) catalogRequest.current = null; }
  }, [serial, invalidateCatalog]);
  useEffect(() => {
    if (!serial) return;
    void refreshCatalog();
    const timer = window.setInterval(() => { void refreshCatalog(); }, 2500);
    return () => {
      window.clearInterval(timer); catalogRequest.current?.abort(); catalogRequest.current = null;
      if (scanStartedAt.current) void databaseRequest({ action: "cancel_scan", serial, startedAt: scanStartedAt.current }).catch(() => undefined);
    };
  }, [serial, refreshCatalog]);
  useEffect(() => { if (initialDatabaseId) setSelectedDatabase(initialDatabaseId); }, [initialDatabaseId]);
  useEffect(() => () => {
    controller.current?.abort();
    if (snapshot.current) closeSnapshot(snapshot.current, serial);
  }, [serial]);

  const open = useCallback(async (databaseId = selectedDatabase) => {
    if (!databaseId) return;
    setQueryConsoleOpen(true);
    controller.current?.abort();
    if (snapshot.current) closeSnapshot(snapshot.current, serial);
    snapshot.current = null; setResult(undefined); setSelectedCell(null); setCopyNotice(""); setExportFormat(null); setExportNotice(""); setSelectedDatabase(databaseId); setCapturedAt(""); setSnapshotSize(null); setSnapshotVerified(false); setObjectIndexes([]); setSelectedIndex(""); setDatabaseObjectsCollapsed(false);
    restoredTabs.current = true;
    setTabsReady(true);
    setOpenDatabaseTabs(currentTabs => currentTabs.includes(databaseId) ? currentTabs : [...currentTabs, databaseId].slice(-8));
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setQueryFailure(null);
    try {
      const data = await databaseRequest<SnapshotResponse>({ action: "open", serial, databaseId }, current.signal);
      if (current.signal.aborted) { closeSnapshot(data.id, serial); return; }
      snapshot.current = data.id; setResult(data.result); setObjectIndexes(data.result.indexes ?? []); setCapturedAt(data.capturedAt);
      setSnapshotSize(typeof data.database?.size === "number" ? data.database.size : null);
      setSnapshotVerified(data.database?.verification === "double-copy-sha256");
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof HarmonySqliteQueryError ? failure.messageFor(chinese) : failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  }, [serial, selectedDatabase, chinese]);
  useEffect(() => {
    if (!initialDatabaseId || autoOpened.current === `${serial}:${initialDatabaseId}`
      || !catalog?.applications.some(app => app.databases.some(database => database.id === initialDatabaseId))) return;
    autoOpened.current = `${serial}:${initialDatabaseId}`;
    const app = catalog.applications.find(item => item.databases.some(database => database.id === initialDatabaseId));
    if (app) setSelectedApp(app.bundleName);
    void open(initialDatabaseId);
  }, [catalog, initialDatabaseId, serial, open]);
  useEffect(() => {
    if (!catalog || catalog.scanning || restoredTabs.current) return;
    if (initialDatabaseId && catalog.applications.some(app => app.databases.some(database => database.id === initialDatabaseId))) {
      restoredTabs.current = true;
      setTabsReady(true);
      return;
    }
    let saved = savedTabs.current;
    try {
      const value = JSON.parse(sessionStorage.getItem(tabsKey) ?? "null");
      if (!saved && value && Array.isArray(value.tabs)) saved = value;
    } catch { /* Previously open tabs are optional. */ }
    restoredTabs.current = true;
    if (!saved) { if (initialDatabaseId) setSelectedDatabase(""); setTabsReady(true); return; }
    const available = catalog.applications.flatMap(app => app.databases.filter(database => database.status !== "unavailable")
      .map(database => ({ bundleName: app.bundleName, database })));
    const restored = saved.tabs.slice(-8).flatMap(tab => {
      if (typeof tab?.bundleName !== "string" || typeof tab?.name !== "string") return [];
      const matches = available.filter(item => item.bundleName === tab.bundleName && (tab.identity
        ? item.database.identity === tab.identity : item.database.name === tab.name));
      const match = matches.length === 1 ? matches[0] : undefined;
      return match ? [{ id: match.database.id, bundleName: tab.bundleName, identity: match.database.identity, name: tab.name, sql: typeof tab.sql === "string" ? tab.sql.slice(0, 100_000) : "",
        tableTabs: Array.isArray(tab.tableTabs) ? tab.tableTabs.filter((item): item is string => typeof item === "string" && item.length <= 256).slice(-8) : [] }] : [];
    });
    if (!restored.length) { setTabsReady(true); return; }
    setOpenDatabaseTabs(restored.map(tab => tab.id));
    setSqlDrafts(Object.fromEntries(restored.map(tab => [tab.id, tab.sql])));
    setTableTabsByDatabase(Object.fromEntries(restored.map(tab => [tab.id, tab.tableTabs])));
    const activeTab = restored.find(tab => tab.bundleName === saved.active?.bundleName && (saved.active?.identity
      ? tab.identity === saved.active.identity : tab.name === saved.active?.name)) ?? restored.at(-1)!;
    setSelectedApp(activeTab.bundleName);
    void open(activeTab.id);
    setTabsReady(true);
  }, [catalog, initialDatabaseId, open, tabsKey]);
  useEffect(() => {
    if (!tabsReady || !catalog || catalog.scanning || (initialDatabaseId
      && catalog.applications.some(app => app.databases.some(database => database.id === initialDatabaseId))
      && !openDatabaseTabs.includes(initialDatabaseId))) return;
    const available = catalog.applications.flatMap(app => app.databases.map(database => ({ bundleName: app.bundleName, database })));
    const tabs = openDatabaseTabs.flatMap(id => {
      const match = available.find(item => item.database.id === id);
      return match ? [{ bundleName: match.bundleName, identity: match.database.identity, name: match.database.name, sql: sqlDrafts[id] ?? "", tableTabs: tableTabsByDatabase[id] ?? [] }] : [];
    });
    const active = available.find(item => item.database.id === selectedDatabase);
    savedTabs.current = { tabs, active: active ? { bundleName: active.bundleName, identity: active.database.identity, name: active.database.name } : undefined };
    try { sessionStorage.setItem(tabsKey, JSON.stringify(savedTabs.current)); }
    catch { /* The open workbench remains usable without session persistence. */ }
  }, [catalog, initialDatabaseId, openDatabaseTabs, selectedDatabase, sqlDrafts, tableTabsByDatabase, tabsKey, tabsReady]);
  const read = async (table?: string, offset = 0, query?: string, indexToShow = "", queryContext?: QueryContext) => {
    if (!snapshot.current) return;
    // Reflect the selected workspace immediately. Device snapshot reads may take
    // long enough that leaving the SQL editor open makes the table click appear
    // to have done nothing, and wastes the space reserved for incoming rows.
    setQueryConsoleOpen(!table);
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setQueryFailure(null);
    try {
      const data = await databaseRequest<{ result: HarmonySqliteResult; durationMs?: number }>({ action: "read", id: snapshot.current, serial, table, offset, sql: query }, current.signal);
      if (!current.signal.aborted) {
        if (query !== undefined && !indexToShow) pendingResultReveal.current = data.result;
        setResult(data.result); setSelectedCell(null); setCopyNotice(""); setSelectedIndex(indexToShow); setContentTab(indexToShow ? "structure" : "data"); setQueryDurationMs(data.durationMs ?? null);
        if (table) setTableTabsByDatabase(currentTabs => ({ ...currentTabs, [selectedDatabase]: currentTabs[selectedDatabase]?.includes(table) ? currentTabs[selectedDatabase] : [...(currentTabs[selectedDatabase] ?? []), table].slice(-8) }));
      }
    } catch (failure) {
      if (!current.signal.aborted) {
        const message = failure instanceof HarmonySqliteQueryError ? failure.messageFor(chinese) : failure instanceof Error ? failure.message : String(failure);
        if (query !== undefined) setQueryFailure({ ...(queryContext ?? { fullText: query, start: 0 }), message, database: selectedDatabase,
          offset: failure instanceof HarmonySqliteQueryError && failure.offset !== undefined && failure.offset <= query.length ? failure.offset : undefined });
        else setError(message);
      }
    }
    finally { if (controller.current === current) setBusy(false); }
  };
  const queueExport = async () => {
    if (!snapshot.current || !exportFormat || (!result?.table && !result?.sql) || exportBusy) return;
    setExportBusy(true); setError(""); setExportNotice("");
    try {
      const response = await fetch("/api/harmony/database-exports", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ action: "create", serial, snapshotId: snapshot.current,
          source: selected ? `${selected.app.label || selected.app.bundleName} / ${databaseDisplayName(selected.app, selected.database)} / ${result.table || "SQL"}` : result.table || "SQL",
          table: result.table, sql: result.sql, format: exportFormat,
          options: { range: exportRange, offset: exportRange === "page" ? result.offset ?? 0 : 0, encoding: exportFormat === "json" ? "utf-8" : exportEncoding },
          ...(exportDestination.trim() ? { destinationPath: exportDestination.trim() } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new HarmonySqliteQueryError(data.error, response.status);
      setExportNotice(copy(`导出任务已创建：${data.job.id.slice(0, 8)}。在“任务”页查看进度和下载结果。`, `Export job ${data.job.id.slice(0, 8)} queued. Open Tasks for progress and download.`));
      setExportFormat(null);
    } catch (failure) { setError(failure instanceof HarmonySqliteQueryError ? failure.messageFor(chinese) : failure instanceof Error ? failure.message : String(failure)); }
    finally { setExportBusy(false); }
  };
  const pageBy = (delta: number) => void read(result?.table, Math.max(0, (result?.offset ?? 0) + delta), result?.sql);
  const selected = catalog?.applications.flatMap(app => app.databases.map(database => ({ app, database }))).find(item => item.database.id === selectedDatabase);
  const runSql = () => {
    const field = sqlInput.current;
    const start = field && field.selectionEnd > field.selectionStart ? field.selectionStart : 0;
    const selection = field && field.selectionEnd > field.selectionStart ? sql.slice(start, field.selectionEnd) : sql;
    if (selection.trim() && !busy) void read(undefined, 0, selection, "", { fullText: sql, start });
  };
  const currentQueryFailure = queryFailure?.database === selectedDatabase ? queryFailure : null;
  const failedOffset = currentQueryFailure?.offset === undefined ? undefined : currentQueryFailure.start + currentQueryFailure.offset;
  const failedPosition = failedOffset === undefined || !currentQueryFailure ? undefined : sqliteQueryPosition(currentQueryFailure.fullText, failedOffset);
  const locateQueryError = () => {
    if (failedOffset === undefined || !currentQueryFailure || currentQueryFailure.fullText !== sql) return;
    const field = sqlInput.current;
    field?.focus(); field?.setSelectionRange(failedOffset, failedOffset);
  };
  const closeCurrent = () => {
    controller.current?.abort();
    setQueryFailure(null);
    if (snapshot.current) closeSnapshot(snapshot.current, serial);
    snapshot.current = null; setResult(undefined); setObjectIndexes([]); setSelectedIndex(""); setCapturedAt(""); setSnapshotSize(null); setSnapshotVerified(false); setExportFormat(null); setDatabaseObjectsCollapsed(false);
    const remaining = openDatabaseTabs.filter(id => id !== selectedDatabase);
    setOpenDatabaseTabs(remaining);
    const next = remaining.at(-1);
    if (next) void open(next); else setSelectedDatabase("");
  };
  const filtered = catalog?.applications.filter(app => `${app.label ?? ""}\n${app.bundleName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  useEffect(() => {
    const items = Array.from(databaseTreeRef.current?.querySelectorAll<HTMLElement>("[data-database-tree-item]") ?? []);
    const current = items.find(item => item.dataset.databaseTreeKey === focusedDatabaseTreeKey.current);
    const next = current ?? items[0];
    for (const item of items) item.tabIndex = item === next ? 0 : -1;
    if (!current) {
      focusedDatabaseTreeKey.current = next?.dataset.databaseTreeKey ?? "";
      focusedDatabaseTreeElement.current = next ?? null;
    }
  }, [catalog, search, selectedApp, selectedDatabase, result, databaseObjectsCollapsed]);
  const databaseTreeTabIndex = (key: string, first = false) => focusedDatabaseTreeKey.current === key || !focusedDatabaseTreeKey.current && first ? 0 : -1;
  const rememberDatabaseTreeFocus = (event: React.FocusEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    const item = event.currentTarget;
    if (focusedDatabaseTreeElement.current && focusedDatabaseTreeElement.current !== item) focusedDatabaseTreeElement.current.tabIndex = -1;
    item.tabIndex = 0;
    focusedDatabaseTreeKey.current = item.dataset.databaseTreeKey ?? "";
    focusedDatabaseTreeElement.current = item;
  };
  const focusDatabaseTreeItem = (item?: HTMLElement) => {
    if (item) item.focus({ preventScroll: true });
  };
  const handleDatabaseTreeKey = (event: React.KeyboardEvent<HTMLElement>, options: DatabaseTreeKeyOptions = {}) => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    const items = Array.from(databaseTreeRef.current?.querySelectorAll<HTMLElement>("[data-database-tree-item]") ?? []);
    const index = items.indexOf(event.currentTarget);
    const level = Number(event.currentTarget.getAttribute("aria-level") ?? 1);
    const move = (item?: HTMLElement) => { if (item) { event.preventDefault(); event.stopPropagation(); focusDatabaseTreeItem(item); } };
    if (event.key === "ArrowDown") move(items[Math.min(items.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") move(items[Math.max(0, index - 1)]);
    else if (event.key === "Home") move(items[0]);
    else if (event.key === "End") move(items.at(-1));
    else if (event.key === "ArrowRight") {
      event.preventDefault(); event.stopPropagation();
      if (options.expanded === false) options.onExpand?.();
      else if (options.expanded === true && items[index + 1]?.getAttribute("aria-level") === String(level + 1)) focusDatabaseTreeItem(items[index + 1]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault(); event.stopPropagation();
      if (options.expanded === true) options.onCollapse?.();
      else if (options.parentKey) focusDatabaseTreeItem(items.find(item => item.dataset.databaseTreeKey === options.parentKey));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation(); options.onActivate?.();
    } else if (event.key.length === 1) {
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      move(ordered.find(item => item.dataset.databaseTreeLabel?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())));
    }
  };
  const displayedRows = (result?.rows ?? []).map((row, index) => ({ row, index }))
    .filter(item => !rowFilter || item.row.some(cell => String(cell === null ? "NULL" : typeof cell === "object" ? cell.blobHex : cell).toLocaleLowerCase().includes(rowFilter.toLocaleLowerCase())))
    .sort((left, right) => {
      if (sortColumn === null) return left.index - right.index;
      const a = left.row[sortColumn], b = right.row[sortColumn];
      const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
      return sortDescending ? -comparison : comparison;
    });
  const gridKey = `${selectedDatabase}:${result?.table ?? result?.sql ?? ""}`;
  const gridWidths = (result?.columns ?? []).map((column, index) => columnWidths[`${gridKey}:${index}:${column}`] ?? 150);
  const resizeColumn = (index: number, width: number) => {
    const column = result?.columns?.[index];
    if (column === undefined) return;
    setColumnWidths(current => ({ ...current, [`${gridKey}:${index}:${column}`]: Math.max(80, Math.min(600, Math.round(width))) }));
  };
  const beginColumnResize = (index: number, event: React.PointerEvent<HTMLSpanElement>) => {
    event.preventDefault(); event.stopPropagation();
    const column = result?.columns?.[index];
    if (column === undefined) return;
    resizingColumn.current = { key: `${gridKey}:${index}:${column}`, startX: event.clientX, width: gridWidths[index] };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveColumnResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    const drag = resizingColumn.current;
    if (drag) setColumnWidths(current => ({ ...current, [drag.key]: Math.max(80, Math.min(600, Math.round(drag.width + event.clientX - drag.startX))) }));
  };
  const endColumnResize = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resizingColumn.current = null;
  };
  const copySelection = async (scope: "cell" | "row") => {
    const row = selectedCell && result?.rows?.[selectedCell.row];
    if (!row) return;
    const value = scope === "row" ? row.map(copyableCell).join("\t") : copyableCell(row[selectedCell.column]);
    try {
      await copyText(value);
      setCopyNotice(scope === "row" ? copy("已复制整行（制表符分隔）", "Row copied as tab-separated values") : copy("已复制单元格", "Cell copied"));
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  return <section className={styles.dbWorkbench} aria-label={copy("SQLite 数据库工作台", "SQLite database workbench")}>
    <header className={styles.dbHeader}>
      <div><strong>{copy("数据库工作台", "Database workbench")}</strong><small>{copy("按应用自动发现 · 设备只读快照", "Automatic app discovery · read-only device snapshot")}</small></div>
      {catalog?.scanning ? <span>{catalog.applications.length
        ? copy(`扫描中 · ${catalog.applications.filter(app => app.status !== "pending" && app.status !== "scanning").length}/${catalog.applications.length} 个应用`, `Scanning · ${catalog.applications.filter(app => app.status !== "pending" && app.status !== "scanning").length}/${catalog.applications.length} apps`)
        : copy("正在读取应用列表…", "Loading installed apps…")}</span> : null}
      {snapshot.current ? <span className={styles.dbConnected}>{copy("快照已打开", "Snapshot open")}</span> : null}
    </header>
    <div className={styles.dbOpenBar}>
      <input aria-label={copy("搜索应用或包名", "Search app or bundle")} value={search} placeholder={copy("搜索应用名或包名", "Search app name or bundle")} onChange={event => setSearch(event.target.value)} />
      <button type="button" disabled={busy || !serial} onClick={() => void refreshCatalog(true)}><AliIcon name="reload" size={14} />{copy("重新扫描", "Rescan")}</button>
      <button type="button" disabled={busy || !selectedDatabase} onClick={() => void open()}><AliIcon name="reload" size={14} />{copy("刷新快照", "Refresh snapshot")}</button>
      {snapshot.current ? <button type="button" onClick={closeCurrent}>{copy("关闭当前库", "Close database")}</button> : null}
    </div>
    {openDatabaseTabs.length ? <div className={styles.dbContentTabs} role="tablist" aria-label={copy("已打开的数据库", "Open databases")}>
      {openDatabaseTabs.map(id => {
        const entry = catalog?.applications.flatMap(app => app.databases.map(database => ({ app, database }))).find(item => item.database.id === id);
        return <button type="button" role="tab" key={id} aria-selected={id === selectedDatabase} disabled={busy} title={copy("切换时重新采集快照", "Switching captures a fresh snapshot")} onClick={() => void open(id)}>{entry ? `${entry.app.label || entry.app.bundleName} / ${databaseDisplayName(entry.app, entry.database)}` : id.slice(0, 8)}</button>;
      })}
    </div> : null}
    <p className={styles.dbHint}>{capturedAt ? <>{copy(`采集时间：${new Date(capturedAt).toLocaleString("zh-CN")}`, `Captured: ${new Date(capturedAt).toLocaleString()}`)}{snapshotSize !== null ? ` · ${snapshotSize.toLocaleString()} B` : ""}{snapshotVerified ? ` · ${copy("双份 SHA-256 校验一致", "Two copies matched by SHA-256")}` : ""}</> : copy("选择应用数据库后采集快照；无法验证一致性时不会显示数据。", "Choose an app database to capture a snapshot. Unverified data is never displayed.")}</p>
    {busy ? <button type="button" onClick={() => controller.current?.abort()}>{copy("取消", "Cancel")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div ref={databaseLayoutRef} className={styles.dbLayout} data-has-snapshot={result ? "true" : "false"}>
      <aside id={`${appTreeId}-objects`} className={styles.dbObjects}>
        <div className={styles.dbObjectsHeader}>{copy("应用 / 数据库 / 对象", "Apps / databases / objects")}</div>
        <div ref={databaseTreeRef} role="tree" aria-label={copy("数据库对象", "Database objects")}>
        {filtered.map((app, appIndex) => {
          const appKey = `app:${app.bundleName || "catalog-error"}`;
          const appExpanded = selectedApp === app.bundleName;
          const appStatusId = `${appTreeId}-${app.bundleName}-status`;
          const appReasonId = `${appTreeId}-${app.bundleName}-reason`;
          const appName = app.label || app.bundleName || copy("应用列表", "Applications");
          return <div className={styles.dbObjectGroup} key={app.bundleName || "catalog-error"} role="treeitem" aria-label={appName}
            aria-level={1} aria-expanded={appExpanded} aria-selected={appExpanded} aria-describedby={`${appStatusId}${app.reason ? ` ${appReasonId}` : ""}`}
            data-database-tree-item data-database-tree-key={appKey} data-database-tree-label={appName} tabIndex={databaseTreeTabIndex(appKey, appIndex === 0)}
            onFocus={rememberDatabaseTreeFocus} onKeyDown={event => handleDatabaseTreeKey(event, {
              expanded: appExpanded, onExpand: () => setSelectedApp(app.bundleName), onCollapse: () => setSelectedApp(""),
              onActivate: () => setSelectedApp(appExpanded ? "" : app.bundleName),
            })}>
            <button type="button" tabIndex={-1} className={styles.dbAppRow} aria-label={appName} aria-describedby={appStatusId} title={app.bundleName}
              aria-expanded={appExpanded} onClick={event => { event.currentTarget.parentElement?.focus({ preventScroll: true }); setSelectedApp(appExpanded ? "" : app.bundleName); }}>
              <span className={styles.dbAppChevron} aria-hidden="true">›</span><AliIcon name="mobile" size={13} /><span className={styles.dbAppName}>{appName}</span>
              <small id={appStatusId} className={styles.dbScanState} data-status={app.status}>{app.status === "pending" ? copy("等待扫描", "Waiting to scan") : app.status === "scanning" ? copy("扫描中", "Scanning") : app.status === "empty" ? copy("确认无数据库", "No database") : app.status === "inaccessible" ? copy("无法完整扫描", "Cannot fully scan") : copy(`已发现 ${app.databases.length} 个`, `${app.databases.length} found`)}</small>
            </button>
            {app.label && app.bundleName ? <small className={styles.dbAppMeta} title={app.bundleName} aria-hidden="true">{app.bundleName}</small> : null}
            {appExpanded ? <div role="group">
              {app.reason ? <small id={appReasonId} className={styles.dbAppReason}>{app.reason}</small> : null}
              {app.databases.map(database => {
                const databaseKey = `database:${database.id}`;
                const databaseName = databaseDisplayName(app, database);
                const databaseUnavailable = database.status === "unavailable";
                const databaseExpanded = selectedDatabase === database.id && Boolean(result) && !databaseObjectsCollapsed;
                const databaseReasonId = `${appTreeId}-${database.id}-reason`;
                const expandDatabase = () => {
                  if (busy || databaseUnavailable) return;
                  if (selectedDatabase === database.id && result) setDatabaseObjectsCollapsed(false);
                  else void open(database.id);
                };
                return <div className={styles.dbDatabaseNode} key={database.id} role="treeitem" aria-label={databaseName} aria-level={2}
                  aria-expanded={databaseUnavailable ? undefined : databaseExpanded} aria-selected={selectedDatabase === database.id}
                  aria-disabled={busy || databaseUnavailable} aria-describedby={database.reason ? databaseReasonId : undefined}
                  data-database-tree-item data-database-tree-key={databaseKey} data-database-tree-label={databaseName} tabIndex={databaseTreeTabIndex(databaseKey)}
                  onFocus={rememberDatabaseTreeFocus} onKeyDown={event => handleDatabaseTreeKey(event, {
                    expanded: databaseUnavailable ? undefined : databaseExpanded, parentKey: appKey, onExpand: expandDatabase,
                    onCollapse: () => setDatabaseObjectsCollapsed(true), onActivate: busy || databaseUnavailable ? undefined : () => void open(database.id),
                  })}>
                  <button type="button" tabIndex={-1} aria-expanded={databaseUnavailable ? undefined : databaseExpanded} data-selected={selectedDatabase === database.id}
                    aria-disabled={busy || databaseUnavailable} title={database.reason} onClick={event => {
                      event.currentTarget.parentElement?.focus({ preventScroll: true });
                      if (!busy && !databaseUnavailable) void open(database.id);
                    }}><AliIcon name="file" size={13} />{databaseName}{databaseUnavailable ? ` · ${copy("无法查看", "Unavailable")}` : ""}</button>
                  {database.reason ? <small id={databaseReasonId} role="status">{database.reason}</small> : null}
                  {databaseExpanded && result ? <div className={styles.dbObjectChildren} role="group">
                    <strong role="presentation" aria-hidden="true">{copy("表", "Tables")} <span>{result.tables.length}</span></strong>
                    {result.tables.map(table => {
                      const tableKey = `table:${database.id}:${table}`;
                      return <div className={styles.dbObjectLeaf} role="treeitem" aria-level={3} key={tableKey} aria-label={table}
                        aria-selected={result.table === table && !selectedIndex} aria-disabled={busy} data-database-tree-item data-database-tree-key={tableKey} data-database-tree-label={table}
                        tabIndex={databaseTreeTabIndex(tableKey)} onFocus={rememberDatabaseTreeFocus}
                        onKeyDown={event => handleDatabaseTreeKey(event, { parentKey: databaseKey, onActivate: busy ? undefined : () => void read(table) })}>
                        <button type="button" tabIndex={-1} data-selected={result.table === table && !selectedIndex} aria-disabled={busy}
                          onClick={event => { event.currentTarget.parentElement?.focus({ preventScroll: true }); if (!busy) void read(table); }}><AliIcon name="file" size={13} />{table}</button>
                      </div>;
                    })}
                    <strong role="presentation" aria-hidden="true">{copy("视图", "Views")} <span>{result.views?.length ?? 0}</span></strong>
                    {result.views?.map(view => {
                      const viewKey = `view:${database.id}:${view}`;
                      return <div className={styles.dbObjectLeaf} role="treeitem" aria-level={3} key={viewKey} aria-label={view}
                        aria-selected={result.table === view && !selectedIndex} aria-disabled={busy} data-database-tree-item data-database-tree-key={viewKey} data-database-tree-label={view}
                        tabIndex={databaseTreeTabIndex(viewKey)} onFocus={rememberDatabaseTreeFocus}
                        onKeyDown={event => handleDatabaseTreeKey(event, { parentKey: databaseKey, onActivate: busy ? undefined : () => void read(view) })}>
                        <button type="button" tabIndex={-1} data-selected={result.table === view && !selectedIndex} aria-disabled={busy}
                          onClick={event => { event.currentTarget.parentElement?.focus({ preventScroll: true }); if (!busy) void read(view); }}><AliIcon name="file-search" size={13} />{view}</button>
                      </div>;
                    })}
                    <strong role="presentation" aria-hidden="true">{copy("索引", "Indexes")} <span>{objectIndexes.length}</span></strong>
                    {objectIndexes.map(index => {
                      const indexKey = `index:${database.id}:${index.name}`;
                      const indexDisabled = busy || !index.table;
                      return <div className={styles.dbObjectLeaf} role="treeitem" aria-level={3} key={indexKey} aria-label={index.name}
                        aria-selected={selectedIndex === index.name} aria-disabled={indexDisabled} data-database-tree-item data-database-tree-key={indexKey} data-database-tree-label={index.name}
                        tabIndex={databaseTreeTabIndex(indexKey)} onFocus={rememberDatabaseTreeFocus}
                        onKeyDown={event => handleDatabaseTreeKey(event, { parentKey: databaseKey, onActivate: indexDisabled ? undefined : () => void read(index.table, 0, undefined, index.name) })}>
                        <button type="button" tabIndex={-1} data-selected={selectedIndex === index.name} aria-disabled={indexDisabled}
                          onClick={event => { event.currentTarget.parentElement?.focus({ preventScroll: true }); if (!indexDisabled) void read(index.table, 0, undefined, index.name); }}><AliIcon name="file-search" size={13} />{index.name}</button>
                      </div>;
                    })}
                  </div> : null}
                </div>;
              })}
            </div> : null}
          </div>;
        })}
        </div>
        {!catalog?.scanning && !filtered.length ? <small>{copy("没有匹配的应用", "No matching apps")}</small> : null}
      </aside>
      <WorkbenchTreeSeparator key={serial} layoutRef={databaseLayoutRef} treeId={`${appTreeId}-objects`} label={copy("调整数据库应用树宽度", "Resize database application tree")}
        chinese={chinese} storageKey={`piora-harmony-databases-tree-width:${serial}`} minimumTreeWidth={220} defaultWidth={260} enabled={Boolean(result)} />
      <div className={styles.dbContent}>
        {result ? <>
        <div className={styles.dbContentTabs} role="tablist" aria-label={copy("已打开的对象", "Open objects")}>
          {(tableTabsByDatabase[selectedDatabase] ?? []).map(table => <button type="button" role="tab" key={table} aria-selected={!queryConsoleOpen && result.table === table && !selectedIndex} disabled={busy} onClick={() => void read(table)}>{table}</button>)}
          <button type="button" role="tab" aria-selected={queryConsoleOpen} onClick={() => { setQueryConsoleOpen(true); requestAnimationFrame(() => sqlInput.current?.focus()); }}>{copy("SQL 控制台", "SQL console")}</button>
        </div>
        <div hidden={!queryConsoleOpen}>
        <textarea ref={sqlInput} aria-label={copy("只读 SQL 查询", "Read-only SQL query")} value={sql} onChange={event => setSqlDrafts(drafts => ({ ...drafts, [selectedDatabase]: event.target.value }))} rows={3} placeholder="SELECT * FROM table_name LIMIT 200" onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && sql.trim() && !busy) { event.preventDefault(); runSql(); } }} />
        <div className={styles.dbQueryActions}><small>{copy("仅 SELECT / WITH", "SELECT / WITH only")}</small><button type="button" disabled={busy || !sql.trim()} onClick={runSql}><AliIcon name="play" size={13} />{copy("运行查询", "Run query")}</button><small>{copy("选中语句或全文", "Selection or full text")} · Ctrl / ⌘ + Enter</small></div>
        {currentQueryFailure ? <div className={styles.dbQueryError} role="alert"><strong>{currentQueryFailure.message}</strong>
          {failedPosition ? <><span>{copy(`第 ${failedPosition.line} 行 · 第 ${failedPosition.column} 列`, `Line ${failedPosition.line} · column ${failedPosition.column}`)}</span>
            <button type="button" disabled={currentQueryFailure.fullText !== sql} onClick={locateQueryError}>{copy("定位错误", "Locate error")}</button>
            {currentQueryFailure.fullText !== sql ? <small>{copy("查询草稿已更改，请重新运行以更新位置。", "The draft changed. Run it again to update the position.")}</small> : null}</>
            : <small>{copy("未取得可核验的错误位置，请根据 SQLite 错误信息检查查询。", "No verified error location is available. Check the SQLite error message.")}</small>}
        </div> : null}
        </div>
        <div className={styles.dbResultsHeader}><strong>{selectedIndex || result.table || (result.sql ? copy("查询结果", "Query result") : copy("选择左侧表或运行查询", "Choose a table or run a query"))}</strong>
          {result.rows ? <span>{copy(`${result.rows.length} 行 · 偏移 ${result.offset ?? 0}${queryDurationMs === null ? "" : ` · ${queryDurationMs} ms`}`, `${result.rows.length} rows · offset ${result.offset ?? 0}${queryDurationMs === null ? "" : ` · ${queryDurationMs} ms`}`)}</span> : null}
          {currentQueryFailure && result.rows ? <small>{copy("保留上一次成功读取的结果", "Previous successful result retained")}</small> : null}
          {result.table || result.sql ? <div><button type="button" disabled={busy || exportBusy} onClick={() => setExportFormat("csv")}>{copy("导出 CSV", "Export CSV")}</button><button type="button" disabled={busy || exportBusy} onClick={() => setExportFormat("json")}>{copy("导出 JSON", "Export JSON")}</button></div> : null}
        </div>
        {exportFormat ? <fieldset className={styles.dbExportPanel} aria-label={copy("导出数据库结果", "Export database result")}>
          <legend>{copy(`导出 ${exportFormat.toUpperCase()}`, `Export ${exportFormat.toUpperCase()}`)}</legend>
          <label>{copy("导出范围", "Export range")}<select value={exportRange} onChange={event => setExportRange(event.target.value as "all" | "page")}>
            <option value="all">{copy("全部查询结果（最多 10 万行 / 64 MiB）", "All query rows (up to 100,000 rows / 64 MiB)")}</option>
            <option value="page">{copy(`当前页原始顺序（偏移 ${result.offset ?? 0}，最多 200 行）`, `Current page in source order (offset ${result.offset ?? 0}, up to 200 rows)`)}</option>
          </select></label>
          <label>{copy("文件编码", "File encoding")}<select value={exportFormat === "json" ? "utf-8" : exportEncoding} disabled={exportFormat === "json"} onChange={event => setExportEncoding(event.target.value as "utf-8" | "utf-8-bom" | "utf-16le")}>
            <option value="utf-8">UTF-8</option><option value="utf-8-bom">UTF-8 BOM</option><option value="utf-16le">UTF-16 LE</option>
          </select></label>
          <label>{copy("本地目标路径（可选）", "Local target path (optional)")}<input value={exportDestination} onChange={event => setExportDestination(event.target.value)} placeholder={copy("留空后在任务页下载；填写已获准工作区的新文件路径", "Leave blank to download from Tasks; or enter a new file in an allowed workspace")} /></label>
          <small>{copy("当前页导出不应用界面筛选或排序；结果来自同一份已验证快照。目标文件不会覆盖。", "Page export uses source order before UI filtering or sorting. Data comes from the verified snapshot; existing targets are never overwritten.")}</small>
          <div><button type="button" disabled={exportBusy} onClick={() => void queueExport()}>{exportBusy ? copy("正在创建任务…", "Creating job…") : copy("开始导出任务", "Start export job")}</button><button type="button" disabled={exportBusy} onClick={() => setExportFormat(null)}>{copy("取消", "Cancel")}</button></div>
        </fieldset> : null}
        {exportNotice ? <p role="status" className={styles.dbExportNotice}>{exportNotice} {onShowTasks ? <button type="button" onClick={onShowTasks}>{copy("查看任务", "View Tasks")}</button> : null}</p> : null}
        {result.table || result.sql ? <>
          <div className={styles.dbContentTabs} role="tablist" aria-label={copy("数据库内容", "Database content")}>
            <button type="button" role="tab" aria-selected={contentTab === "data"} onClick={() => setContentTab("data")}>{copy("数据", "Data")}</button>
            <button type="button" role="tab" aria-selected={contentTab === "structure"} disabled={!result.table || (!result.fields?.length && !result.definition && !result.indexes?.length)} onClick={() => setContentTab("structure")}>{copy("结构", "Structure")}</button>
          </div>
          {contentTab === "data" ? <>
          <div className={styles.dbGridActions}>
            <input className={styles.dbRowFilter} aria-label={copy("筛选当前页", "Filter current page")} value={rowFilter} onChange={event => { setRowFilter(event.target.value); setSelectedCell(null); setCopyNotice(""); }} placeholder={copy("筛选当前页的单元格", "Filter cells on this page")} />
            {selectedCell ? <span>{copy(`已选第 ${(result.offset ?? 0) + selectedCell.row + 1} 行 · ${result.columns?.[selectedCell.column] ?? selectedCell.column + 1}`, `Row ${(result.offset ?? 0) + selectedCell.row + 1} · ${result.columns?.[selectedCell.column] ?? selectedCell.column + 1}`)}</span> : null}
            <button type="button" disabled={!selectedCell} onClick={() => void copySelection("cell")}>{copy("复制单元格", "Copy cell")}</button>
            <button type="button" disabled={!selectedCell} onClick={() => void copySelection("row")}>{copy("复制整行", "Copy row")}</button>
            {copyNotice ? <span role="status">{copyNotice}</span> : null}
          </div>
          <div ref={resultGrid} className={styles.dbGrid} role="region" aria-label={copy("查询结果表格", "Query result grid")}>
            <table style={{ width: `${48 + gridWidths.reduce((sum, width) => sum + width, 0)}px` }}><colgroup><col style={{ width: 48 }} />{gridWidths.map((width, index) => <col key={index} style={{ width }} />)}</colgroup><thead><tr><th>#</th>{result.columns?.map((column, index) => <th key={`${column}-${index}`}><button type="button" aria-label={copy(`按 ${column} 排序当前页`, `Sort current page by ${column}`)} onClick={() => { setSortDescending(sortColumn === index ? !sortDescending : false); setSortColumn(index); }}>{column}{sortColumn === index ? sortDescending ? " ↓" : " ↑" : ""}</button><span role="separator" tabIndex={0} aria-orientation="vertical" aria-label={copy(`调整 ${column} 列宽`, `Resize ${column} column`)} aria-valuemin={80} aria-valuemax={600} aria-valuenow={gridWidths[index]} className={styles.dbColumnResize} onPointerDown={event => beginColumnResize(index, event)} onPointerMove={moveColumnResize} onPointerUp={endColumnResize} onPointerCancel={endColumnResize} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); resizeColumn(index, gridWidths[index] + (event.key === "ArrowRight" ? 16 : -16)); } }} /></th>)}</tr></thead>
              <tbody>{displayedRows.map(({ row, index: rowIndex }) => <tr key={`${result.offset}-${rowIndex}`}><th scope="row">{(result.offset ?? 0) + rowIndex + 1}</th>{row.map((cell, columnIndex) => <td key={columnIndex} tabIndex={0} aria-selected={selectedCell?.row === rowIndex && selectedCell.column === columnIndex} title={cell === null ? "NULL" : typeof cell === "object" ? `BLOB ${cell.size} B` : String(cell)} onClick={() => { setSelectedCell({ row: rowIndex, column: columnIndex }); setCopyNotice(""); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCell({ row: rowIndex, column: columnIndex }); setCopyNotice(""); } }}>{cell === null ? <em>NULL</em> : typeof cell === "object" ? `BLOB ${cell.size} B: ${cell.blobHex}${cell.truncated ? "…" : ""}` : String(cell)}</td>)}</tr>)}</tbody></table>
            {!displayedRows.length ? <p className={styles.dbGridEmpty} role="status">{rowFilter && result.rows?.length
              ? copy("当前页没有匹配的行；清除筛选可恢复显示。", "No rows match on this page. Clear the filter to show them again.")
              : result.sql ? copy("查询未返回记录。", "The query returned no rows.") : copy("当前页没有记录。", "No rows on this page.")}</p> : null}
          </div>
          <div className={styles.dbPagination}><button type="button" disabled={busy || !result.offset} onClick={() => pageBy(-200)}>{copy("上一页", "Previous")}</button><span>{copy(`第 ${Math.floor((result.offset ?? 0) / 200) + 1} 页`, `Page ${Math.floor((result.offset ?? 0) / 200) + 1}`)}</span><button type="button" disabled={busy || !result.hasMore || (result.offset ?? 0) >= (result.sql ? 800 : 10_000)} onClick={() => pageBy(200)}>{copy("下一页", "Next")}</button></div>
          </> : result.fields?.length || result.definition || result.indexes?.length ? <section className={styles.dbStructure} aria-label={copy("表结构", "Table structure")}>
            {result.fields?.length ? <div className={styles.dbFieldGrid}><strong>{copy("字段", "Column")}</strong><strong>{copy("类型", "Type")}</strong><strong>{copy("约束", "Constraints")}</strong><strong>{copy("默认值", "Default")}</strong>
              {result.fields.map(field => <div key={field.name} className={styles.dbFieldRow}><span title={field.name}>{field.name}</span><span title={field.type}>{field.type || "—"}</span><span>{[field.primaryKey ? `PK ${field.primaryKey}` : "", field.notNull ? "NOT NULL" : "", field.generated === "virtual" ? copy("生成列 · VIRTUAL", "Generated · VIRTUAL") : field.generated === "stored" ? copy("生成列 · STORED", "Generated · STORED") : ""].filter(Boolean).join(" · ") || "—"}</span><span title={field.defaultValue ?? undefined}>{field.defaultValue ?? "—"}</span></div>)}
            </div> : null}
            {result.foreignKeys?.length ? <div className={styles.dbSchemaGroup}><h4>{copy("外键", "Foreign keys")}</h4><ul>{result.foreignKeys.map((key, index) => <li key={index}><code>{key.from} → {key.table}{key.to === null ? copy("（主键）", " (primary key)") : `.${key.to}`}</code></li>)}</ul></div> : null}
            {result.indexes?.length ? <div className={styles.dbSchemaGroup}><h4>{copy("索引", "Indexes")}</h4>{result.indexes.map(index => <article key={index.name} className={styles.dbIndexCard} data-selected={selectedIndex === index.name} aria-label={copy(`索引 ${index.name}`, `Index ${index.name}`)}>
              <div className={styles.dbIndexHeading}><strong>{index.name}</strong>{selectedIndex === index.name ? <span>{copy("当前索引", "Selected index")}</span> : null}{index.unique ? <span>UNIQUE</span> : null}{index.partial ? <span>{copy("部分索引", "Partial index")}</span> : null}</div>
              <p>{index.origin === "unique" ? copy("由 UNIQUE 约束自动创建", "Created by a UNIQUE constraint") : index.origin === "primary-key" ? copy("由主键约束自动创建", "Created by a primary key constraint") : copy("显式创建的索引", "Explicitly created index")}</p>
              <ol>{index.keyParts?.length ? index.keyParts.map((part, position) => <li key={position}><code>{part.kind === "expression" ? copy("表达式（见创建语句）", "Expression (see definition)") : part.kind === "rowid" ? "rowid" : part.name} · {part.descending ? "DESC" : "ASC"}{part.collation ? ` · COLLATE ${part.collation}` : ""}</code></li>) : index.columns?.map(column => <li key={column}><code>{column}</code></li>)}</ol>
              {index.definition ? <pre className={styles.dbDefinition} aria-label={copy(`索引创建语句 ${index.name}`, `Index definition ${index.name}`)}>{index.definition}</pre> : null}
            </article>)}</div> : null}
            {result.definition ? <div className={styles.dbSchemaGroup}><h4>{copy("创建语句", "Definition")}</h4><pre className={styles.dbDefinition} aria-label={copy("对象创建语句", "Object definition")}>{result.definition}</pre></div> : null}
          </section> : <div className={styles.dbEmpty}>{copy("该对象没有可显示的结构", "No structure available for this object")}</div>}
        </> : <div className={styles.dbEmpty}>{copy("从左侧选择一张表，或在上方运行只读 SQL。", "Choose a table on the left or run a read-only SQL query above.")}</div>}
        </> : <div className={styles.dbEmpty}>{copy("从左侧应用树选择数据库。", "Choose a database in the application tree.")}</div>}
      </div>
    </div>
  </section>;
}
