"use client";

import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createLogMatcher } from "@/lib/harmony/log-filter";
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
  const processListId = useId();
  const deferredQuery = useDeferredValue(query);
  const [entries, setEntries] = useState<Array<LogEntry & { id: number }>>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const outputRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const following = useRef(true);
  const [followTail, setFollowTail] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const buffered = useRef<Array<LogEntry & { id: number }>>([]);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const captureAnchor = () => {
    const output = outputRef.current;
    if (!output || following.current) return;
    const top = output.getBoundingClientRect().top;
    const row = Array.from(output.querySelectorAll<HTMLElement>("[data-log-id]")).find((item) => item.getBoundingClientRect().bottom > top);
    anchor.current = row ? { id: row.dataset.logId!, offset: row.getBoundingClientRect().top - top } : null;
  };

  useEffect(() => {
    setPid("");
    setEntries([]);
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
    buffered.current = []; setEntries([]); setLoading(true); setError(null);
    const stream = new EventSource(`/api/harmony/logs/events?serial=${encodeURIComponent(serial)}`);
    stream.addEventListener("connected", () => { setLoading(false); setError(null); });
    stream.addEventListener("logs", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { entries: LogEntry[]; dropped?: number };
        buffered.current = [...buffered.current, ...payload.entries.map((entry) => ({ ...entry, id: nextId.current++ }))].slice(-10000);
        if (payload.dropped) setError(copy("日志产生过快，部分记录未显示", "Some records were dropped because logs arrived too quickly"));
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
    const output = outputRef.current;
    if (!output) return;
    if (following.current && !paused) output.scrollTop = output.scrollHeight;
    else if (anchor.current) {
      const row = output.querySelector<HTMLElement>(`[data-log-id="${anchor.current.id}"]`);
      if (row) output.scrollTop += row.getBoundingClientRect().top - output.getBoundingClientRect().top - anchor.current.offset;
      else output.scrollTop = 0;
    }
    anchor.current = null;
  }, [entries, paused, deferredQuery, regex, pid, level]);

  const selectedProcess = useMemo(() => processes.find((process) => String(process.pid) === pid), [pid, processes]);
  const matcher = useMemo(() => createLogMatcher(deferredQuery, regex), [deferredQuery, regex]);
  const visibleEntries = useMemo(() => entries.filter((entry) => (!pid || String(entry.pid) === pid || processes.some((process) => process.pid === entry.pid && process.name.toLocaleLowerCase().includes(pid.toLocaleLowerCase()))) && (!level || entry.level === level) && matcher.matches(entry.raw)), [entries, pid, processes, level, matcher]);

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
      <button className={styles.iconButton} type="button" onClick={() => { if (paused) { captureAnchor(); setEntries(buffered.current); } setPaused(!paused); }} aria-pressed={paused} title={paused ? copy("继续", "Resume") : copy("暂停", "Pause")}>
        <AliIcon name={paused ? "play" : "pause"} size={13} />
      </button>
      <button className={styles.iconButton} type="button" onClick={() => setRefreshKey((key) => key + 1)} title={copy("刷新日志", "Refresh logs")} aria-label={copy("刷新日志", "Refresh logs")}>
        <AliIcon name="reload" size={13} />
      </button>
    </div>
    <div className={styles.logMeta}>
      <span>{selectedProcess ? `${selectedProcess.name} · PID ${selectedProcess.pid}` : copy("所有进程", "All processes")}</span>
      <span>{visibleEntries.length} / {entries.length} {copy("行（保留最近 10000 行）", "lines (latest 10000 retained)")}{loading ? ` · ${copy("连接中", "connecting")}` : ""}{paused ? ` · ${copy("已暂停显示", "display paused")}` : ""}</span>
      {!followTail && <button onClick={() => { following.current = true; setFollowTail(true); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>{copy("跟随最新日志", "Follow latest")}</button>}
    </div>
    <div ref={outputRef} className={styles.logOutput} role="log" aria-live="off" onScroll={(event) => { const output = event.currentTarget; const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24; following.current = atBottom; setFollowTail(atBottom); }}>
      {visibleEntries.length ? visibleEntries.map((entry) => <div className={styles.logLine} data-log-id={entry.id} data-level={entry.level} key={entry.id}>
        <span className={styles.logTime}>{entry.timestamp ?? ""}</span>
        <span className={styles.logLevel}>{entry.level === "unknown" ? "·" : entry.level.slice(0, 1).toUpperCase()}</span>
        <span className={styles.logPid}>{entry.pid ?? ""}</span>
        <span className={styles.logTag}>{entry.tag ?? entry.domain ?? ""}</span>
        <span className={styles.logMessage}>{entry.message}</span>
      </div>) : <div className={styles.logEmpty}>{online ? copy("没有匹配的日志", "No matching logs") : copy("请先连接设备", "Connect a device first")}</div>}
    </div>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {matcher.error && <div className={styles.error} role="alert">{copy("正则表达式无效：", "Invalid regular expression: ")}{matcher.error}</div>}
  </section>;
}
