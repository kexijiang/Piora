"use client";

import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createLogMatcher, createLogTimeRange } from "@/lib/harmony/log-filter";
import { AliIcon } from "../AliIcon";
import styles from "./HarmonyPanel.module.css";

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal" | "unknown";
type DeviceProcess = { pid: number; name: string };
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

export function HarmonyLogViewer({ active, serial, online, copy }: {
  active: boolean;
  serial: string;
  online: boolean;
  copy: (zh: string, en: string) => string;
}) {
  const [processes, setProcesses] = useState<DeviceProcess[]>([]);
  const [pid, setPid] = useState("");
  const [level, setLevel] = useState("");
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [tag, setTag] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [dropped, setDropped] = useState(0);
  const [evicted, setEvicted] = useState(0);
  const [notice, setNotice] = useState<string>();
  const [selected, setSelected] = useState<LogEntry>();
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
  const rowHeightRef = useRef(rowHeight);
  const visibleEntriesRef = useRef<Array<LogEntry & { id: number }>>([]);
  rowHeightRef.current = rowHeight;
  const nextId = useRef(0);
  const following = useRef(true);
  const [followTail, setFollowTail] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const buffered = useRef<Array<LogEntry & { id: number }>>([]);
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
    buffered.current = []; setEntries([]); setDropped(0); setEvicted(0); setSelected(undefined); setNotice(undefined);
    anchor.current = null; following.current = true; setFollowTail(true); setScrollTop(0);
  }, [serial, refreshKey]);

  useEffect(() => {
    setPid("");
    if (!active || !online || !serial) {
      setProcesses([]);
      return;
    }
    const controller = new AbortController();
    void requestJson<{ processes: DeviceProcess[] }>(`/api/harmony/logs?action=processes&serial=${encodeURIComponent(serial)}`, controller.signal)
      .then((payload) => setProcesses(payload.processes))
      .catch((failure) => {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => controller.abort();
  }, [active, online, serial, refreshKey]);

  useEffect(() => {
    if (!active || !online || !serial) return;
    setLoading(true); setError(null);
    const stream = new EventSource(`/api/harmony/logs/events?serial=${encodeURIComponent(serial)}`);
    stream.addEventListener("connected", () => { setLoading(false); setError(null); });
    stream.addEventListener("logs", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { entries: LogEntry[]; dropped?: number };
        const combined = [...buffered.current, ...payload.entries.map((entry) => ({ ...entry, id: nextId.current++ }))];
        const removed = Math.max(0, combined.length - 10000);
        buffered.current = combined.slice(-10000);
        if (removed) setEvicted(count => count + removed);
        if (Number.isSafeInteger(payload.dropped) && payload.dropped! > 0) setDropped(count => count + payload.dropped!);
        if (!pausedRef.current) { captureAnchor(); setEntries(buffered.current); }
      } catch { setError(copy("日志数据无法解析", "Invalid log data")); }
    });
    stream.addEventListener("error", (event) => {
      setLoading(false);
      const data = (event as MessageEvent).data;
      if (data) { try { setError(JSON.parse(data).message); } catch { setError(String(data)); } stream.close(); }
      else setError(copy("日志连接中断，正在重新连接…", "Log connection interrupted; reconnecting…"));
    });
    return () => stream.close();
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
  const matchingPids = useMemo(() => new Set(processes.filter(process => process.name.toLocaleLowerCase().includes(pid.toLocaleLowerCase())).map(process => process.pid)), [pid, processes]);
  const matcher = useMemo(() => createLogMatcher(deferredQuery, regex), [deferredQuery, regex]);
  const timeRange = useMemo(() => createLogTimeRange(fromTime, toTime), [fromTime, toTime]);
  const visibleEntries = useMemo(() => entries.filter((entry) => (!pid || String(entry.pid) === pid || (entry.pid !== undefined && matchingPids.has(entry.pid)))
    && (!level || entry.level === level) && (!tag || (entry.tag ?? "").toLocaleLowerCase().includes(tag.toLocaleLowerCase()))
    && timeRange.matches(entry.timestamp) && matcher.matches(entry.raw)), [entries, pid, matchingPids, level, tag, timeRange, matcher]);
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

  const exportLogs = (filtered: boolean) => {
    const rows = filtered ? visibleEntries : entries;
    const url = URL.createObjectURL(new Blob([rows.map(entry => entry.raw).join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url;
    link.download = `harmony-logs-${new Date().toISOString().replace(/[:.]/g, "-")}-${filtered ? "filtered" : "all"}.txt`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(copy(`已导出 ${rows.length} 行；仅包含当前保留的日志`, `Exported ${rows.length} retained lines`));
  };
  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(copy("日志已复制", "Logs copied")); }
    catch { setError(copy("复制失败，请选中文字后复制", "Copy failed. Select the text and copy it.")); }
  };

  return <section className={styles.logViewer} aria-label={copy("设备日志", "Device logs")}>
    <div className={styles.logToolbar}>
      <input list={processListId} value={pid} onChange={(event) => setPid(event.target.value)} placeholder={copy("进程名称 / PID", "Process name / PID")} aria-label={copy("搜索进程", "Search processes")} style={{ width: 150, minWidth: 80, background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 5, padding: 5 }} />
      <datalist id={processListId}>{processes.map((process) => <option key={process.pid} value={process.pid}>{process.name} ({process.pid})</option>)}</datalist>
      <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label={copy("日志级别", "Log level")}>
        <option value="">{copy("所有级别", "All levels")}</option>
        <option value="debug">Debug</option><option value="info">Info</option><option value="warn">Warn</option><option value="error">Error</option><option value="fatal">Fatal</option>
      </select>
      <label className={styles.logSearch}>
        <AliIcon name="search" size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={copy("筛选日志", "Filter logs")} aria-label={copy("筛选日志", "Filter logs")} />
      </label>
      <button className={styles.iconButton} type="button" onClick={() => setRegex(!regex)} aria-pressed={regex} title={copy("正则表达式", "Regular expression")}>.*</button>
      <button className={styles.iconButton} type="button" onClick={() => { if (paused) { captureAnchor(); setEntries(buffered.current); } pausedRef.current = !paused; setPaused(!paused); }} aria-pressed={paused} aria-label={paused ? copy("继续显示日志", "Resume log display") : copy("暂停显示日志", "Pause log display")} title={paused ? copy("继续", "Resume") : copy("暂停", "Pause")}>
        <AliIcon name={paused ? "play" : "pause"} size={13} />
      </button>
      <button className={styles.iconButton} type="button" onClick={() => setRefreshKey((key) => key + 1)} title={copy("刷新日志", "Refresh logs")} aria-label={copy("刷新日志", "Refresh logs")}>
        <AliIcon name="reload" size={13} />
      </button>
    </div>
    <div className={styles.logFilters}>
      <input value={tag} onChange={event => setTag(event.target.value)} aria-label={copy("日志 TAG", "Log TAG")} placeholder="TAG" />
      <input value={fromTime} onChange={event => setFromTime(event.target.value)} aria-label={copy("日志开始时间", "Log start time")} placeholder={copy("开始 HH:mm:ss", "From HH:mm:ss")} />
      <input value={toTime} onChange={event => setToTime(event.target.value)} aria-label={copy("日志结束时间", "Log end time")} placeholder={copy("结束 HH:mm:ss", "To HH:mm:ss")} />
      <small>{copy("设备时钟；可填 MM-DD HH:mm:ss，起止格式一致。", "Device clock; optional MM-DD prefix, same format for both limits.")}</small>
    </div>
    <div className={styles.logActions}>
      <button type="button" disabled={!entries.length} onClick={() => exportLogs(false)}>{copy("导出保留日志", "Export retained logs")}</button>
      <button type="button" disabled={!visibleEntries.length} onClick={() => exportLogs(true)}>{copy("导出筛选结果", "Export filtered logs")}</button>
      <button type="button" onMouseDown={event => event.preventDefault()} onClick={() => {
        const selection = window.getSelection();
        if (selection?.anchorNode && outputRef.current?.contains(selection.anchorNode) && selection.focusNode && outputRef.current.contains(selection.focusNode) && selection.toString()) void copyText(selection.toString());
        else if (selected) void copyText(selected.raw);
        else setNotice(copy("请先选中日志文字或打开一行详情", "Select log text or open a line first"));
      }}>{copy("复制选中日志", "Copy selected logs")}</button>
      <button type="button" onClick={() => { buffered.current = []; setEntries([]); setSelected(undefined); setDropped(0); setEvicted(0); setNotice(undefined); anchor.current = null; }}>{copy("清空当前视图", "Clear current view")}</button>
    </div>
    <div className={styles.logMeta}>
      <span>{selectedProcess ? `${selectedProcess.name} · PID ${selectedProcess.pid}` : copy("所有进程", "All processes")}</span>
      <span>{visibleEntries.length} / {entries.length} {copy("行（保留最近 10000 行）", "lines (latest 10000 retained)")}{loading ? ` · ${copy("连接中", "connecting")}` : ""}{paused ? ` · ${copy("已暂停显示，继续采集", "display paused; still collecting")}` : ""}{!online ? ` · ${copy("已断开，保留已采集日志", "disconnected; collected logs retained")}` : ""}{dropped ? ` · ${copy("未接收", "Dropped")} ${dropped}` : ""}{evicted ? ` · ${copy("超出保留上限", "Evicted")} ${evicted}` : ""}</span>
      {(!followTail || paused) && <button onClick={() => { following.current = true; setFollowTail(true); pausedRef.current = false; setPaused(false); setEntries(buffered.current); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>{copy("跟随最新日志", "Follow latest")}</button>}
    </div>
    <div ref={outputRef} className={styles.logOutput} role="log" aria-live="off" onScroll={(event) => { const output = event.currentTarget; setScrollTop(output.scrollTop); const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < rowHeight; following.current = atBottom; setFollowTail(atBottom); }}>
      <div ref={measureRef} className={styles.logRowMeasure} aria-hidden="true" />
      {visibleEntries.length ? <div style={{ height: visibleEntries.length * rowHeight, position: "relative" }}>
        <div style={{ position: "absolute", top: firstRow * rowHeight, left: 0, right: 0 }}>
        {visibleEntries.slice(firstRow, lastRow).map((entry) => <div className={styles.logLine} style={{ height: rowHeight }} data-log-id={entry.id} data-level={entry.level} key={entry.id}
          role="button" tabIndex={0} aria-label={copy("查看日志详情", "View log details")} onClick={() => setSelected(entry)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(entry); } }}>
        <span className={styles.logTime}>{entry.timestamp ?? ""}</span>
        <span className={styles.logLevel}>{entry.level === "unknown" ? "·" : entry.level.slice(0, 1).toUpperCase()}</span>
        <span className={styles.logPid}>{entry.pid ?? ""}</span>
        <span className={styles.logTag}>{entry.tag ?? entry.domain ?? ""}</span>
        <span className={styles.logMessage}>{entry.message}</span>
      </div>)}</div></div> : <div className={styles.logEmpty}>{online ? copy("没有匹配的日志", "No matching logs") : copy("请先连接设备", "Connect a device first")}</div>}
    </div>
    {selected ? <div className={styles.logDetails} aria-label={copy("日志详情", "Log details")}>
      <div><strong>{copy("日志详情", "Log details")}</strong><button type="button" onClick={() => void copyText(selected.raw)}>{copy("复制完整行", "Copy complete line")}</button><button type="button" onClick={() => setSelected(undefined)}>{copy("关闭详情", "Close details")}</button></div>
      <pre>{selected.raw}</pre>
    </div> : null}
    {notice ? <div role="status" className={styles.inlineHint}>{notice}</div> : null}
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {matcher.error && <div className={styles.error} role="alert">{copy("正则表达式无效：", "Invalid regular expression: ")}{matcher.error}</div>}
    {timeRange.error && <div className={styles.error} role="alert">{copy("时间格式无效：填写 HH:mm[:ss] 或 MM-DD HH:mm[:ss]，起止格式一致。", "Invalid time: use HH:mm[:ss] or MM-DD HH:mm[:ss], with matching limit formats.")}</div>}
  </section>;
}
