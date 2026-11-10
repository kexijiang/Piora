// Adapted from Alentaoker/dsh-harmoneydev-tools @ 8b178a755d33cee9899160a7be283af2b23eb85d.
// SPDX-License-Identifier: MIT; see third_party/harmony-log-workbench/SOURCE.md.
"use client";
import { saveLogSnapshot } from "@/lib/harmony-log-download";

import { useContext, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LogSessionContext, saveSessionLog } from './log-session';
import { LogApplicationPicker } from './LogApplicationPicker';
import { ResizableLogDetails } from './ResizableLogDetails';
import { createLogMatcher, createLogTimeRange, logHighlightParts } from "@/lib/harmony/log-workbench-filter";
import { LogRingBuffer } from "@/lib/harmony/log-buffer";
import { logApplicationPids, logBelongsToApplication } from "@/lib/harmony/log-application";
import { AliIcon } from "../../../AliIcon";
import { SearchHistoryMenu, historyKeyAction, isComposingKey, nextCursor, useLogSearchHistory } from "./LiveLogSearchHistory";
import styles from "./RealtimeLogs.module.css";

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
type DeviceProcess = { pid: number; name: string };
type DeviceApplication = { bundleName: string; label?: string; process?: string };
type LogEntry = { timestamp?: string; level: LogLevel; pid?: number; tid?: number; domain?: string; tag?: string; message: string; raw: string };

async function requestJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } | string };
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(error || `Request failed (${response.status})`);
  }
  return payload;
}

export function RealtimeLogs({ active, visible = true, serial, online, copy, onSavedToSession, onShowSessionLogs }: {
  active: boolean;
  visible?: boolean;
  serial: string;
  online: boolean;
  copy: (zh: string, en: string) => string;
  onSavedToSession?: (fileId: string) => void;
  onShowSessionLogs?: () => void;
}) {
  const [processes, setProcesses] = useState<DeviceProcess[]>([]);
  const [applications, setApplications] = useState<DeviceApplication[]>([]);
  const [bundle, setBundle] = useState("");
  const [appProcess, setAppProcess] = useState<string>();
  const [appError, setAppError] = useState("");
  const [processUpdatedAt, setProcessUpdatedAt] = useState("");
  const [pid, setPid] = useState("");
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [tag, setTag] = useState("");
  const [tagRegex, setTagRegex] = useState(false);
  const [tid, setTid] = useState("");
  const [domain, setDomain] = useState("");
  const [findOpen, setFindOpen] = useState(true);
  const [findText, setFindText] = useState("");
  const [findRegex, setFindRegex] = useState(false);
  const [findCase, setFindCase] = useState(false);
  const [findIndex, setFindIndex] = useState(-1);
  const [filterHistoryOpen, setFilterHistoryOpen] = useState(false);
  const [filterCursor, setFilterCursor] = useState(0);
  const [filterSelected, setFilterSelected] = useState(false);
  const [findHistoryOpen, setFindHistoryOpen] = useState(false);
  const [findCursor, setFindCursor] = useState(0);
  const [findSelected, setFindSelected] = useState(false);
  const filterHistory = useLogSearchHistory("filter", Boolean(active));
  const findHistory = useLogSearchHistory("find", Boolean(active));
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Shared on disk with the other log view, so re-read it whenever the list is
  // opened instead of trusting a snapshot from mount time.
  const openFilterHistory = () => { setFindHistoryOpen(false); setFilterHistoryOpen(true); setFilterSelected(false); filterHistory.reload(); };
  const openFindHistory = () => { setFilterHistoryOpen(false); setFindHistoryOpen(true); setFindSelected(false); findHistory.reload(); };
  const rootRef = useRef<HTMLElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [dropped, setDropped] = useState(0);
  const [evicted, setEvicted] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<LogEntry & { id: number }>();
  const logSession = useContext(LogSessionContext);
  const sessionRef = useRef(logSession.sessionId), serialRef = useRef(serial), savingRef = useRef(false), saveController = useRef<AbortController | undefined>(undefined);
  sessionRef.current = logSession.sessionId; serialRef.current = serial;
  const [saving, setSaving] = useState(false), [savedFile, setSavedFile] = useState<{ id: string; sessionId: string }>();
  useEffect(() => () => saveController.current?.abort(), []);
  useEffect(() => { setSavedFile(undefined); setNotice(undefined); }, [logSession.sessionId]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(300);
  const [rowHeight, setRowHeight] = useState(24);
  const measureRef = useRef<HTMLDivElement>(null);
  const processListId = useId();
  const deferredQuery = useDeferredValue(query);
  const [entries, setEntries] = useState<Array<LogEntry & { id: number }>>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const rowHeightRef = useRef(rowHeight);
  const visibleEntriesRef = useRef<Array<LogEntry & { id: number }>>([]);
  rowHeightRef.current = rowHeight;
  const nextId = useRef(0);
  const following = useRef(true);
  const [followTail, setFollowTail] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const [buffered] = useState(() => new LogRingBuffer<LogEntry & { id: number }>());
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const captureAnchor = () => {
    const output = outputRef.current;
    if (!output) return;
    // A programmatic scroll and a new log batch can land in the same frame. Read
    // the element here instead of trusting the previous scroll event, otherwise
    // the stale `following` flag can snap a reader back to the newest row.
    const currentRowHeight = Math.max(1, rowHeightRef.current);
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < currentRowHeight;
    following.current = atBottom;
    if (atBottom) return;
    const currentEntries = visibleEntriesRef.current;
    const currentIndex = Math.min(currentEntries.length - 1, Math.max(0, Math.floor(output.scrollTop / currentRowHeight)));
    const currentEntry = currentEntries[currentIndex];
    if (currentEntry) {
      anchor.current = { id: String(currentEntry.id), offset: currentIndex * currentRowHeight - output.scrollTop };
      return;
    }
    const top = output.getBoundingClientRect().top;
    const row = Array.from(output.querySelectorAll<HTMLElement>("[data-log-id]")).find((item) => item.getBoundingClientRect().bottom > top);
    anchor.current = row ? { id: row.dataset.logId!, offset: row.getBoundingClientRect().top - top } : null;
  };

  useEffect(() => {
    buffered.clear(); setEntries([]); setDropped(0); setEvicted(0); setSelected(undefined); setNotice(undefined); setSavedFile(undefined);
    anchor.current = null; following.current = true; setFollowTail(true); setScrollTop(0);
  }, [serial, refreshKey]);

  useEffect(() => {
    setBundle(""); setAppProcess(undefined); setApplications([]); setAppError("");
  }, [serial]);

  useEffect(() => {
    if (!active || !online || !serial) return;
    const controller = new AbortController();
    void requestJson<{ applications: DeviceApplication[] }>(`/api/harmony/apps?serial=${encodeURIComponent(serial)}`, controller.signal)
      .then(payload => { if (!controller.signal.aborted) setApplications(payload.applications.slice(0, 5000).sort((a, b) => (a.label ?? a.bundleName).localeCompare(b.label ?? b.bundleName))); })
      .catch(failure => { if (!controller.signal.aborted) setAppError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [active, online, serial]);

  useEffect(() => {
    setAppProcess(undefined);
    if (!active || !online || !serial || !bundle) return;
    const controller = new AbortController();
    void requestJson<{ applications: DeviceApplication[] }>(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&bundleName=${encodeURIComponent(bundle)}`, controller.signal)
      .then(payload => { if (!controller.signal.aborted) { setAppProcess(payload.applications.find(app => app.bundleName === bundle)?.process); setAppError(""); } })
      .catch(failure => { if (!controller.signal.aborted) setAppError(failure instanceof Error ? failure.message : String(failure)); });
    return () => controller.abort();
  }, [active, online, serial, bundle]);

  useEffect(() => {
    setPid("");
    if (!active || !online || !serial) {
      setProcesses([]);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const payload = await requestJson<{ processes: DeviceProcess[] }>(`/api/harmony/logs?action=processes&serial=${encodeURIComponent(serial)}`, controller.signal); if (!controller.signal.aborted) { setProcesses(payload.processes); setProcessUpdatedAt(new Date().toLocaleTimeString()); } }
      catch (failure) { if (!controller.signal.aborted) setAppError(failure instanceof Error ? failure.message : String(failure)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, online, serial, refreshKey]);

  useEffect(() => {
    if (!active || !online || !serial) return;
    setLoading(true); setError(null);
    const stream = new EventSource(`/api/harmony/logs/events?serial=${encodeURIComponent(serial)}`);
    let changed = false;
    const flushDisplay = setInterval(() => {
      // Capture keeps running while this pane is hidden; only the visible pane
      // is allowed to refresh the list and re-run filtering.
      if (!visibleRef.current) return;
      if (changed && !pausedRef.current) { changed = false; captureAnchor(); setEntries(buffered.snapshot()); }
    }, 250);
    stream.addEventListener("connected", () => { setLoading(false); setError(null); });
    stream.addEventListener("logs", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { entries: LogEntry[]; dropped?: number };
        const batch = buffered.push(payload.entries.map((entry) => ({ ...entry, id: nextId.current++ })));
        const removed = batch.removed;
        if (removed) setEvicted(count => count + removed);
        if (Number.isSafeInteger(payload.dropped) && payload.dropped! > 0) setDropped(count => count + payload.dropped!);
        changed = true;
      } catch { setError(copy("日志数据无法解析", "Invalid log data")); }
    });
    stream.addEventListener("error", (event) => {
      setLoading(false);
      const data = (event as MessageEvent).data;
      if (data) { try { setError(JSON.parse(data).message); } catch { setError(String(data)); } stream.close(); }
      else setError(copy("日志连接中断，正在重新连接…", "Log connection interrupted; reconnecting…"));
    });
    return () => { clearInterval(flushDisplay); stream.close(); };
    // copy changes with locale; filter and pause must not restart device capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, online, refreshKey, serial]);

  useLayoutEffect(() => {
    const output = outputRef.current, measure = measureRef.current;
    if (!output || !measure) return;
    const update = () => { setViewportHeight(output.clientHeight); setRowHeight(measure.getBoundingClientRect().height || 24); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(output); observer.observe(measure);
    return () => observer.disconnect();
  }, []);

  const selectedProcess = useMemo(() => processes.find((process) => String(process.pid) === pid), [pid, processes]);
  const applicationPids = useMemo(() => logApplicationPids(processes, bundle, appProcess), [processes, bundle, appProcess]);
  const matchingPids = useMemo(() => new Set(processes.filter(process => process.name.toLocaleLowerCase().includes(pid.toLocaleLowerCase())).map(process => process.pid)), [pid, processes]);
  const matcher = useMemo(() => createLogMatcher(deferredQuery, regex, caseSensitive), [deferredQuery, regex, caseSensitive]);
  const tagMatcher = useMemo(() => createLogMatcher(tag, tagRegex, caseSensitive), [tag, tagRegex, caseSensitive]);
  const timeRange = useMemo(() => createLogTimeRange(fromTime, toTime), [fromTime, toTime]);
  const severity: Record<string, number> = { unknown: -1, debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };
  const visibleEntries = useMemo(() => entries.filter((entry) => logBelongsToApplication(entry, bundle, applicationPids, appProcess) && (!pid || String(entry.pid) === pid || (entry.pid !== undefined && matchingPids.has(entry.pid)))
    && (!level || severity[entry.level] >= severity[level]) && tagMatcher.matches(entry.tag ?? "")
    && (!tid || String(entry.tid) === tid) && (!domain || (entry.domain ?? "").toLocaleLowerCase().includes(domain.toLocaleLowerCase()))
    && timeRange.matches(entry.timestamp) && matcher.matches(entry.raw)), [entries, bundle, applicationPids, appProcess, pid, matchingPids, level, tagMatcher, tid, domain, timeRange, matcher]);
  const deferredFind = useDeferredValue(findText);
  const findMatcher = useMemo(() => createLogMatcher(deferredFind, findRegex, findCase), [deferredFind, findRegex, findCase]);
  const findRows = useMemo(() => visible && deferredFind && !findMatcher.error ? visibleEntries.reduce<number[]>((rows, entry, index) => { if (findMatcher.matches(entry.raw)) rows.push(index); return rows; }, []) : [], [visibleEntries, deferredFind, findMatcher, visible]);
  useEffect(() => { setFindIndex(-1); }, [deferredFind, findRegex, findCase, bundle, pid, level, tag, tid, domain, deferredQuery]);
  useEffect(() => {
    // Returning to the live pane refreshes it once with everything captured
    // while it was hidden.
    if (!visible || pausedRef.current) return;
    setEntries(buffered.snapshot());
  }, [visible]);
  useEffect(() => { if (findOpen && visible) findRef.current?.focus(); }, [findOpen, visible]);
  useEffect(() => {
    if (!active) return;
    const handle = (event: KeyboardEvent) => {
      if (!visibleRef.current) return;
      const scope = rootRef.current?.closest('[data-harmony-panel]') ?? rootRef.current;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && scope?.contains(event.target as Node)) {
        event.preventDefault(); event.stopPropagation(); setFindOpen(true); findRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handle, true);
    return () => document.removeEventListener("keydown", handle, true);
  }, [active]);
  const jumpFind = (delta: number) => {
    if (!findRows.length || !outputRef.current) return;
    const next = findIndex < 0 ? (delta > 0 ? 0 : findRows.length - 1) : (findIndex + delta + findRows.length) % findRows.length;
    setFindIndex(next); following.current = false; setFollowTail(false); anchor.current = null;
    outputRef.current.scrollTop = findRows[next] * rowHeight; setScrollTop(outputRef.current.scrollTop);
  };
  /** Only an applied, valid filter becomes history. */
  const commitFilterHistory = () => { if (query.trim() && !matcher.error) filterHistory.record(query, regex, caseSensitive); };
  const applyFilterHistory = (entry: { query: string; regex: boolean; caseSensitive: boolean }) => {
    setQuery(entry.query); setRegex(entry.regex); setCaseSensitive(entry.caseSensitive);
    filterHistory.record(entry.query, entry.regex, entry.caseSensitive);
  };
  const highlight = (text: string) => findOpen && deferredFind ? logHighlightParts(text, deferredFind, findRegex, findCase).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : part.text) : text;
  visibleEntriesRef.current = visibleEntries;
  const firstRow = Math.min(Math.max(0, visibleEntries.length - 1), Math.max(0, Math.floor(scrollTop / rowHeight) - 8));
  const lastRow = Math.min(visibleEntries.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + 8);

  useLayoutEffect(() => {
    const output = outputRef.current;
    if (!output) return;
    if (following.current && !paused) output.scrollTop = output.scrollHeight;
    else if (anchor.current) {
      const index = visibleEntries.findIndex(entry => String(entry.id) === anchor.current!.id);
      if (index >= 0) output.scrollTop = index * rowHeight - anchor.current.offset;
      else output.scrollTop = 0;
    }
    anchor.current = null;
    setScrollTop(output.scrollTop);
  }, [visibleEntries, paused, rowHeight]);

  const saveLogs = async (toSession: boolean) => {
    if (savingRef.current || !visibleEntries.length) return;
    const targetSession = logSession.sessionId, targetSerial = serial;
    if (toSession && !targetSession) { setError(copy('请先打开一个会话', 'Open a session first')); return; }
    if (matcher.error || tagMatcher.error || timeRange.error || query !== deferredQuery) { setError(copy('请先完成有效的筛选，再保存日志', 'Finish valid filters before saving')); return; }
    // One immutable bounded snapshot for both destinations. Ctrl+F is excluded.
    const rows = visibleEntries, capturedAt = new Date().toISOString();
    const name = `${applications.find(app => app.bundleName === bundle)?.label || bundle || 'harmony'}-${capturedAt.replace(/[:.]/g, '-')}.log`.replace(/[\\/<>"|?*]/g, '_');
    const file = new File([rows.map(entry => entry.raw).join('\r\n') + '\r\n'], name, { type: 'text/plain;charset=utf-8' });
    const snapshot = { bundle, serial: targetSerial, filters: { pid, level, query: deferredQuery, regex, caseSensitive, tag, tagRegex, tid, domain, fromTime, toTime }, capturedAt, count: rows.length, firstTimestamp: rows[0]?.timestamp, lastTimestamp: rows.at(-1)?.timestamp, dropped, evicted };
    setSavedFile(undefined); savingRef.current = true; setSaving(true); setError(null); const abort = new AbortController(); saveController.current = abort;
    try {
      if (toSession) {
        const saved = await saveSessionLog(file, targetSession!, snapshot, abort.signal);
        if (sessionRef.current === targetSession && serialRef.current === targetSerial) { setSavedFile({ id: saved.id, sessionId: targetSession! }); setNotice(copy(`已保存到当前会话 · ${rows.length} 行`, `Saved ${rows.length} lines to this session`)); }
      } else {
        const mode = await saveLogSnapshot(file);
        if (sessionRef.current === targetSession && serialRef.current === targetSerial) setNotice(mode === 'saved'
          ? copy(`已保存 ${rows.length} 行；仅包含当前保留的筛选日志`, `Saved ${rows.length} retained filtered lines`)
          : copy(`已发起 ${rows.length} 行日志下载，请核对保存结果`, `Started download of ${rows.length} log lines; check the saved file`));
      }
    } catch (failure) { if (sessionRef.current === targetSession && serialRef.current === targetSerial && (failure as Error).name !== 'AbortError') setError((failure as Error).message); }
    finally { savingRef.current = false; setSaving(false); saveController.current = undefined; }
  };
  const analyzeSelected = () => { setSavedFile(undefined);
    if (!selected) return;
    try {
      if (!logSession.onAnalyze) throw Error('请在会话中打开日志');
      logSession.onAnalyze(`请分析当前会话中的这条实时日志，只分析日志，不操作手机或重新执行测试。\n\n来源：实时日志\n应用：${bundle || '未指定'}\n时间：${selected.timestamp}\nPID：${selected.pid ?? '未指定'}\nTAG：${selected.tag || '未指定'}\n日志内容：${selected.raw.slice(0, 2000)}${selected.raw.length > 2000 ? '…（该行摘录已截断）' : ''}\n\n现象 / Bug 描述：\n其它补充：`);
      setNotice(copy('已填入当前会话草稿，请检查后发送', 'Draft inserted; review before sending'));
    } catch (failure) { setError((failure as Error).message); }
  };
  const copyText = async (text: string) => { setSavedFile(undefined);
    try { await navigator.clipboard.writeText(text); setNotice(copy("日志已复制", "Logs copied")); }
    catch { setError(copy("复制失败，请选中文字后复制", "Copy failed. Select the text and copy it.")); }
  };

  return <section ref={rootRef} tabIndex={0} className={styles.logViewer} aria-label={copy("设备日志", "Device logs")}>
    <div className={styles.logApplication}>
      <span>{copy('应用 / 包名', 'Application / bundle')}</span><LogApplicationPicker applications={applications} processes={processes} value={bundle} onChange={value => { setBundle(value); setPid(''); }} copy={copy}/>
      {bundle ? <span title={copy("通过当前 PID 与日志明确的进程字段筛选；不搜索消息正文", "Current PID map and explicit log process field; not message text")}>PID {applicationPids.size ? [...applicationPids].join(", ") : copy("暂无运行进程", "not running")}</span> : null}
    </div>
    <div className={styles.logToolbar}>
      <input list={processListId} value={pid} onChange={(event) => setPid(event.target.value)} placeholder={copy("进程名称 / PID", "Process name / PID")} aria-label={copy("搜索进程", "Search processes")} style={{ width: 150, minWidth: 80, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
      <datalist id={processListId}>{processes.map((process) => <option key={process.pid} value={process.pid}>{process.name} ({process.pid})</option>)}</datalist>
      <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label={copy("最低日志级别", "Minimum log level")}>
        <option value="">{copy("所有级别", "All levels")}</option>
        <option value="debug">Debug+</option><option value="info">Info+</option><option value="warn">Warn+</option><option value="error">Error+</option><option value="fatal">Fatal</option>
      </select>
      <div className={styles.logSearchAnchor} data-history-anchor="filter" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFilterHistoryOpen(false); }}>
      <label className={styles.logSearch}>
        <AliIcon name="search" size={13} />
        <input value={query} onChange={(event) => { setFilterSelected(false); setQuery(event.target.value); }} placeholder={copy("筛选日志", "Filter logs")} aria-label={copy("筛选日志", "Filter logs")}
          onFocus={() => openFilterHistory()}
          onBlur={event => { if (event.relatedTarget && event.currentTarget.closest('[data-history-anchor]')?.contains(event.relatedTarget as Node)) return; window.setTimeout(() => { setFilterHistoryOpen(false); setFilterSelected(false); if (visibleRef.current) commitFilterHistory(); }, 120); }}
          onKeyDown={(event) => {
            if (isComposingKey(event)) return;
            const action = historyKeyAction(event, { open: filterHistoryOpen, cursor: filterCursor, count: filterHistory.entries.length, selected: filterSelected });
            if (action === "close") { event.preventDefault(); event.stopPropagation(); setFilterHistoryOpen(false); setFilterSelected(false); return; }
            if (action === "up" || action === "down") { event.preventDefault(); setFilterSelected(true); setFilterCursor(current => nextCursor(current, action === "up" ? -1 : 1, filterHistory.entries.length)); return; }
            if (action === "apply") { event.preventDefault(); const entry = filterHistory.entries[filterCursor]; if (entry) applyFilterHistory(entry); setFilterHistoryOpen(false); setFilterSelected(false); return; }
            if (event.key === "Enter") { event.preventDefault(); commitFilterHistory(); setFilterHistoryOpen(false); setFilterSelected(false); }
          }} />
      </label>
      <button className={styles.iconButton} type="button" aria-expanded={filterHistoryOpen} title={copy("筛选历史", "Filter history")} aria-label={copy("筛选历史", "Filter history")}
        onClick={() => { if (filterHistoryOpen) { setFilterHistoryOpen(false); setFilterSelected(false); } else openFilterHistory(); }}>↺</button>
      {filterHistoryOpen ? <SearchHistoryMenu entries={filterHistory.entries} cursor={filterCursor} onCursor={setFilterCursor}
        onPick={entry => { applyFilterHistory(entry); setFilterHistoryOpen(false); }} onRemove={filterHistory.remove} onClear={filterHistory.clear} onClose={() => setFilterHistoryOpen(false)} copy={copy} /> : null}
      </div>
      <button className={styles.iconButton} type="button" onClick={() => setRegex(!regex)} aria-pressed={regex} title={copy("正则表达式", "Regular expression")}>.*</button>
      <button className={styles.iconButton} type="button" onClick={() => setCaseSensitive(!caseSensitive)} aria-pressed={caseSensitive} title={copy("筛选区分大小写", "Case-sensitive filters")}>Aa</button>
      <button className={styles.iconButton} type="button" onClick={() => { if (paused) { captureAnchor(); setEntries(buffered.snapshot()); } pausedRef.current = !paused; setPaused(!paused); }} aria-pressed={paused} aria-label={paused ? copy("继续显示日志", "Resume log display") : copy("暂停显示日志", "Pause log display")} title={paused ? copy("继续", "Resume") : copy("暂停", "Pause")}>
        <AliIcon name={paused ? "play" : "pause"} size={13} />
      </button>
      <button className={styles.iconButton} type="button" onClick={() => setRefreshKey((key) => key + 1)} title={copy("刷新日志", "Refresh logs")} aria-label={copy("刷新日志", "Refresh logs")}>
        <AliIcon name="reload" size={13} />
      </button>
    </div>
    <details className={styles.logAdvanced}><summary>{copy("更多筛选 · TAG / TID / Domain / 时间", "More filters · TAG / TID / Domain / time")}{tag || tid || domain || fromTime || toTime ? copy("（已启用）", " (active)") : ""}</summary><div className={styles.logFilters}>
      <input value={tag} onChange={event => setTag(event.target.value)} aria-label={copy("日志 TAG", "Log TAG")} placeholder="TAG" />
      <label><input type="checkbox" checked={tagRegex} onChange={event => setTagRegex(event.target.checked)} />{copy("TAG 正则", "TAG regex")}</label>
      <input value={tid} onChange={event => setTid(event.target.value)} aria-label="TID" placeholder="TID" inputMode="numeric" />
      <input value={domain} onChange={event => setDomain(event.target.value)} aria-label="Domain" placeholder="Domain" />
      <input value={fromTime} onChange={event => setFromTime(event.target.value)} aria-label={copy("日志开始时间", "Log start time")} placeholder={copy("开始 HH:mm:ss", "From HH:mm:ss")} />
      <input value={toTime} onChange={event => setToTime(event.target.value)} aria-label={copy("日志结束时间", "Log end time")} placeholder={copy("结束 HH:mm:ss", "To HH:mm:ss")} />
      <small>{copy("设备时钟；可填 MM-DD HH:mm:ss，起止格式一致。", "Device clock; optional MM-DD prefix, same format for both limits.")}</small>
    </div></details>
    <div className={styles.logActions}>
      {!findOpen ? <button type="button" onClick={() => setFindOpen(true)}>{copy("查找 · Ctrl+F", "Find · Ctrl+F")}</button> : null}
      <button type="button" disabled={!logSession.sessionId} onClick={() => onShowSessionLogs?.()}>{copy('会话日志', 'Session logs')}</button>
      <button type="button" disabled={saving || !visibleEntries.length} onClick={() => void saveLogs(false)}>{copy('保存日志', 'Save logs')}</button>
      <button type="button" disabled={saving || !visibleEntries.length || !logSession.sessionId} onClick={() => void saveLogs(true)}>{saving ? copy('保存中…', 'Saving…') : copy('保存到当前会话', 'Save to session')}</button>
      <details className={styles.logMore}><summary>{copy("复制 / 清理", "Copy / clear")}</summary><div>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
        const selection = window.getSelection();
        if (selection?.anchorNode && outputRef.current?.contains(selection.anchorNode) && selection.focusNode && outputRef.current.contains(selection.focusNode) && selection.toString()) void copyText(selection.toString());
        else if (selected) void copyText(selected.raw);
        else setNotice(copy("请先选中日志文字或打开一行详情", "Select log text or open a line first"));
      }}>{copy("复制选中日志", "Copy selected logs")}</button>
      </div></details>
      <button type="button" onClick={() => { buffered.clear(); setEntries([]); setSelected(undefined); setDropped(0); setEvicted(0); setNotice(undefined); anchor.current = null; }}>{copy("清空当前视图", "Clear current view")}</button>
      <button type="button" onClick={() => { setBundle(""); setPid(""); setLevel(""); setQuery(""); setRegex(false); setCaseSensitive(false); setTag(""); setTagRegex(false); setTid(""); setDomain(""); setFromTime(""); setToTime(""); }}>{copy("重置筛选", "Reset filters")}</button>
    </div>
    {findOpen ? <div className={styles.logFind}>
      <div className={styles.logSearchAnchor} data-history-anchor="find" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFindHistoryOpen(false); }}>
      <input ref={findRef} value={findText} onChange={event => { setFindSelected(false); setFindText(event.target.value); }} aria-label={copy("查找保留的筛选结果", "Find in retained filtered logs")} placeholder={copy("查找 · Ctrl+F（不改变筛选）", "Find · Ctrl+F (without filtering)")}
        onFocus={() => openFindHistory()}
        onBlur={event => { if (event.relatedTarget && event.currentTarget.closest('[data-history-anchor]')?.contains(event.relatedTarget as Node)) return; window.setTimeout(() => { setFindHistoryOpen(false); setFindSelected(false); }, 120); }}
        onKeyDown={event => {
          if (isComposingKey(event)) return;
          const action = historyKeyAction(event, { open: findHistoryOpen, cursor: findCursor, count: findHistory.entries.length, selected: findSelected });
          if (action === "close") { event.preventDefault(); event.stopPropagation(); setFindHistoryOpen(false); setFindSelected(false); return; }
          if (action === "up" || action === "down") { event.preventDefault(); setFindSelected(true); setFindCursor(current => nextCursor(current, action === "up" ? -1 : 1, findHistory.entries.length)); return; }
          if (action === "apply") { event.preventDefault(); const entry = findHistory.entries[findCursor]; if (entry) { setFindText(entry.query); setFindRegex(entry.regex); setFindCase(entry.caseSensitive); findHistory.record(entry.query, entry.regex, entry.caseSensitive); } setFindHistoryOpen(false); setFindSelected(false); return; }
          if (event.key === "Enter") { event.preventDefault(); jumpFind(event.shiftKey ? -1 : 1); if (!findMatcher.error && findText.trim()) findHistory.record(findText, findRegex, findCase); }
          // Escape closes the history first, then the find bar; it never closes the workbench.
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFindOpen(false); }
        }} />
      <button type="button" aria-expanded={findHistoryOpen} onClick={() => { if (findHistoryOpen) { setFindHistoryOpen(false); setFindSelected(false); } else openFindHistory(); }} title={copy("查找历史", "Find history")}>{copy("历史", "History")}</button>
      {findHistoryOpen ? <SearchHistoryMenu entries={findHistory.entries} cursor={findCursor} onCursor={setFindCursor}
        onPick={entry => { setFindText(entry.query); setFindRegex(entry.regex); setFindCase(entry.caseSensitive); findHistory.record(entry.query, entry.regex, entry.caseSensitive); setFindHistoryOpen(false); findRef.current?.focus(); }}
        onRemove={findHistory.remove} onClear={findHistory.clear} onClose={() => setFindHistoryOpen(false)} copy={copy} /> : null}
      </div>
      <button type="button" aria-pressed={findCase} onClick={() => setFindCase(!findCase)} title={copy("查找区分大小写", "Case-sensitive find")}>Aa</button>
      <button type="button" aria-pressed={findRegex} onClick={() => setFindRegex(!findRegex)} title={copy("查找正则", "Find regex")}>.*</button>
      <span>{findIndex >= 0 ? Math.min(findIndex + 1, findRows.length) : 0}/{findRows.length} {copy("行", "rows")}</span>
      <button type="button" disabled={!findRows.length} onClick={() => jumpFind(-1)} aria-label={copy("上一个匹配", "Previous match")}>↑</button><button type="button" disabled={!findRows.length} onClick={() => jumpFind(1)} aria-label={copy("下一个匹配", "Next match")}>↓</button>
      <button type="button" onClick={() => setFindOpen(false)} aria-label={copy("关闭查找", "Close find")}>×</button>
      <small>{copy("当前保留的筛选结果", "Retained filtered rows")}{deferredFind !== findText ? ` · ${copy("查找中…", "Searching…")}` : ""}</small>
    </div> : null}
    <div className={styles.logMeta}>
      <span>{bundle || (selectedProcess ? `${selectedProcess.name} · PID ${selectedProcess.pid}` : copy("所有进程", "All processes"))}{processUpdatedAt ? ` · PID ${processUpdatedAt}` : ""}</span>
      <span>{visibleEntries.length} / {entries.length} {copy("行（最近 100000 行 / 128 MiB 文本上限）", "lines (100000 rows / 128 MiB text limit)")}{loading ? ` · ${copy("连接中", "connecting")}` : ""}{paused ? ` · ${copy("已暂停显示，继续采集", "display paused; still collecting")}` : ""}{!online ? ` · ${copy("已断开，保留已采集日志", "disconnected; collected logs retained")}` : ""}{dropped ? ` · ${copy("未接收", "Dropped")} ${dropped}` : ""}{evicted ? ` · ${copy("超出保留上限", "Evicted")} ${evicted}` : ""}</span>
      {(!followTail || paused) && <button onClick={() => { following.current = true; setFollowTail(true); pausedRef.current = false; setPaused(false); setEntries(buffered.snapshot()); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>{copy("跟随最新日志", "Follow latest")}</button>}
    </div>
    <div ref={columnsRef} className={styles.logColumns}><div className={styles.logLine}><span>{copy("时间", "Time")}</span><span>L</span><span>PID:TID</span><span>Domain / TAG</span><span>{copy("消息 · 点击查看完整行", "Message · click for details")}</span></div></div>
    <div ref={outputRef} className={styles.logOutput} role="log" aria-live="off" onScroll={(event) => { const output = event.currentTarget; if (columnsRef.current) columnsRef.current.scrollLeft = output.scrollLeft; setScrollTop(output.scrollTop); const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < rowHeight; following.current = atBottom; setFollowTail(atBottom); }}>
      <div ref={measureRef} className={styles.logRowMeasure} aria-hidden="true" />
      {visibleEntries.length ? <div style={{ height: visibleEntries.length * rowHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: firstRow * rowHeight, left: 0, right: 0 }}>
        {visibleEntries.slice(firstRow, lastRow).map((entry) => <div className={styles.logLine} style={{ height: rowHeight }} data-log-id={entry.id} data-level={entry.level} key={entry.id}
          role="button" tabIndex={0} aria-label={copy("查看日志详情", "View log details")} onClick={() => setSelected(entry)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(entry); } }}>
        <span className={styles.logTime} title={entry.timestamp}>{highlight(entry.timestamp ?? "")}</span>
        <span className={styles.logLevel}>{entry.level === "unknown" ? "·" : entry.level.slice(0, 1).toUpperCase()}</span>
        <span className={styles.logPid} title={`PID ${entry.pid ?? ""} / TID ${entry.tid ?? ""}`}>{highlight(`${entry.pid ?? ""}:${entry.tid ?? ""}`)}</span>
        <span className={styles.logTag} title={`${entry.domain ?? ""}/${entry.tag ?? ""}`}>{highlight(`${entry.domain ? entry.domain + "/" : ""}${entry.tag ?? ""}`)}</span>
        <span className={styles.logMessage}>{highlight(entry.message)}</span>
      </div>)}</div></div> : <div className={styles.logEmpty}>{online ? copy("没有匹配的日志", "No matching logs") : copy("请先连接设备", "Connect a device first")}</div>}
    </div>
    {selected ? <ResizableLogDetails copy={copy} tools={<><strong>{copy('日志详情', 'Log details')}</strong><button onClick={() => void copyText(selected.raw)}>{copy('复制完整行', 'Copy complete line')}</button><button onClick={analyzeSelected}>{copy('AI 分析此行', 'Analyze this line')}</button><button onClick={() => setSelected(undefined)}>{copy('关闭详情', 'Close details')}</button></>}><pre>{highlight(selected.raw)}</pre>{!entries.some(entry => entry.id === selected.id) && <small>{copy('此记录已离开当前缓冲，正在查看打开时的快照', 'This record left the buffer; showing its retained snapshot')}</small>}</ResizableLogDetails> : null}
    {notice ? <div role="status" className={styles.inlineHint}>{notice}{savedFile && savedFile.sessionId === logSession.sessionId && <button onClick={() => { if (onSavedToSession) onSavedToSession(savedFile.id); else logSession.onOpenLogs?.(savedFile.id); }}>{copy('查看文件', 'View file')}</button>}</div> : null}
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {appError ? <div className={styles.error} role="alert">{copy("应用 / 进程信息：", "App / process information: ")}{appError}</div> : null}
    {matcher.error && <div className={styles.error} role="alert">{copy("正则表达式无效：", "Invalid regular expression: ")}{matcher.error}</div>}
    {tagMatcher.error && <div className={styles.error} role="alert">TAG: {tagMatcher.error}</div>}
    {findOpen && findMatcher.error && <div className={styles.error} role="alert">{copy("查找正则无效：", "Invalid find regex: ")}{findMatcher.error}</div>}
    {timeRange.error && <div className={styles.error} role="alert">{copy("时间格式无效：填写 HH:mm[:ss] 或 MM-DD HH:mm[:ss]，起止格式一致。", "Invalid time: use HH:mm[:ss] or MM-DD HH:mm[:ss], with matching limit formats.")}</div>}
  </section>;
}
