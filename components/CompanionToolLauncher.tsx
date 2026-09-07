"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./CompanionToolLauncher.module.css";

export interface PocketTool { id: string; icon: AliIconName; label: string; description: string; keywords: string }
type Entry = { id: string; name: string; kind: "app" | "setting" | "tool"; keywords: string; description: string; icon?: AliIconName };
const RECENT_KEY = "pi-pocket-launcher-recent";
export function CompanionToolLauncher({ tools, searchRef, onOpen }: { tools: PocketTool[]; searchRef: RefObject<HTMLInputElement | null>; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [apps, setApps] = useState<Entry[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const mounted = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async (refresh = false) => {
    const bridge = window.piDesktop?.launcher;
    if (!bridge) { if (refresh) setStatus("请更新并重启 Windows 桌面版以搜索本机应用。"); return; }
    setLoading(true); setStatus("");
    try {
      const result = await bridge.list(refresh);
      if (!mounted.current) return;
      setAvailable(result.supported); setApps(result.items); setStatus(result.warning);
    } catch { if (mounted.current) setStatus("应用列表暂时无法读取，点击刷新重试。"); }
    finally { if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    try { const value: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); if (Array.isArray(value)) setRecent(value.filter((id): id is string => typeof id === "string").slice(0, 12)); } catch { /* Recents are optional. */ }
    void load();
    return () => { mounted.current = false; };
  }, [load]);
  const entries: Entry[] = [...tools.map((tool): Entry => ({ ...tool, name: tool.label, kind: "tool" })), ...apps];
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const score = (entry: Entry) => {
    const name = entry.name.toLocaleLowerCase();
    const text = `${name} ${entry.keywords.toLocaleLowerCase()}`;
    if (!terms.every((term) => text.includes(term))) return -1;
    return (name === query.trim().toLowerCase() ? 1000 : terms.length && name.startsWith(terms[0]) ? 500 : 0) + (recent.includes(entry.id) ? 100 - recent.indexOf(entry.id) : 0) + (entry.kind === "tool" ? 10 : 0);
  };
  const results = entries.map((entry) => ({ entry, score: score(entry) })).filter(({ entry, score }) => score >= 0 && (terms.length || entry.kind === "tool" || recent.includes(entry.id)))
    .sort((a, b) => b.score - a.score).slice(0, 40).map(({ entry }) => entry);
  const selected = Math.min(active, Math.max(0, results.length - 1));
  const open = async (entry: Entry) => {
    if (opening) return;
    setOpening(entry.id); setStatus("");
    try {
      if (entry.kind !== "tool") await window.piDesktop?.launcher?.open(entry.id);
      const next = [entry.id, ...recent.filter((id) => id !== entry.id)].slice(0, 12);
      setRecent(next);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* Launching is independent of localStorage. */ }
      if (entry.kind === "tool") onOpen(entry.id);
      else setStatus(`已打开 ${entry.name}`);
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "应用未能打开，请重试。"); }
    finally { setOpening(null); }
  };
  return <div className={styles.launcher}>
    <div className={styles.search}><AliIcon name="search" size={20} /><input ref={searchRef} role="combobox" aria-label="搜索工具" aria-controls="pocket-launcher-results" aria-expanded={results.length > 0} aria-autocomplete="list" aria-activedescendant={results.length ? `launcher-result-${selected}` : undefined} placeholder="搜索工具、应用或系统设置…" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && results[selected]) { event.preventDefault(); void open(results[selected]); }
      if (["ArrowDown", "ArrowUp"].includes(event.key) && results.length) {
        event.preventDefault(); const next = (selected + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length; setActive(next);
        listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
      }
      if (event.key === "Escape") { setQuery(""); setActive(0); }
    }} /><kbd>↵</kbd></div>
    <div className={styles.caption}><span>{query ? `搜索结果 · ${results.length}${results.length === 40 ? "+" : ""}` : recent.length ? "最近使用与常用工具" : "常用工具"}</span><button type="button" aria-label="刷新本机应用" disabled={loading} onClick={() => void load(true)}>{loading ? "正在索引…" : "刷新应用"}</button></div>
    <div id="pocket-launcher-results" ref={listRef} className={styles.results} role="listbox" aria-label="工具和应用">{results.map((entry, index) => <div key={entry.id} id={`launcher-result-${index}`} role="option" aria-selected={selected === index}>
      <button type="button" className={styles.result} disabled={opening !== null} onPointerMove={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => void open(entry)}>
        <span className={styles.icon}><AliIcon name={entry.icon ?? (entry.kind === "setting" ? "setting" : "appstore-add")} size={20} /></span>
        <span className={styles.label}><b>{entry.name}</b><small>{entry.description}</small></span>
        <span className={styles.kind}>{entry.kind === "tool" ? "工具" : entry.kind === "setting" ? "设置" : "应用"}</span><AliIcon name="arrowright" size={14} />
      </button>
    </div>)}</div>
    {!results.length ? <div className={styles.empty}>没有匹配结果，试试应用名称、“声音”或“蓝牙”。</div> : null}
    <footer className={styles.footer}><span role="status" title={status}>{status || (loading ? "正在读取开始菜单与 Windows 应用…" : available ? "↑ ↓ 选择 · Enter 打开 · Esc 清空" : "本机应用与系统设置搜索需要 Windows 桌面版。")}</span></footer>
  </div>;
}
