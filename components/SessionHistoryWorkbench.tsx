"use client";
import "./SessionHistoryWorkbench.css";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { historyRequest, useSessionHistory, HistoryApiError } from "@/hooks/useSessionHistory";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { historyPath, historyTurns, historyReadingAnchor, selectHistoryBranch, type HistoryNode, type HistoryCategory, type HistorySearchResult, type HistoryHit, type HistoryDetail, type HistoryIndex } from "@/lib/session-history";
import { createVirtualRowState } from "@/lib/virtual-row-state";
import { historyLocationUrl, type HistoryChatControls, type HistoryLocation } from "@/lib/history-navigation";
import { prepareMessageRetry } from "@/lib/message-retry";
import { copyText } from "@/lib/clipboard";
import { VirtualList, type VirtualListHandle } from "./VirtualList";
import { ChatDisclosureTrigger } from "./ChatDisclosure";
import { HistoryEntryCard } from "./history/HistoryEntryCard";
import { AliIcon } from "./AliIcon";
import { CommandExecutionDialog } from "./CommandExecutionView";
import type { CommandExecutionData } from "@/lib/command-execution";

interface Preferences {
  leafId: string | null; entryId: string | null; mode: "turns" | "events"; nav: "turns" | "branches";
  query: string; scope: "all" | "branch"; category: "" | HistoryCategory; from: string; to: string;
  failed: boolean; thinking: boolean; processes: string[]; toggles: Record<string, Record<string, boolean>>;
}
const defaults: Preferences = { leafId: null, entryId: null, mode: "turns", nav: "turns", query: "", scope: "all", category: "", from: "", to: "", failed: false, thinking: false, processes: [], toggles: {} };
const preferenceKey = (id: string) => `piora:history-workbench:v1:${id}`;
function readPreferences(id: string): Preferences {
  try {
    const value = JSON.parse(sessionStorage.getItem(preferenceKey(id)) ?? "null");
    return value && typeof value === "object" ? { ...defaults, ...value } : { ...defaults };
  } catch { return { ...defaults }; }
}
interface Props {
  sessionId: string; sessionName?: string | null; location: HistoryLocation; controls: HistoryChatControls | null;
  onClose: () => void; onLocation: (leafId: string | null, entryId: string | null) => void;
  onOpenFile?: (path: string) => void; onRelated: (sessionId: string) => void | Promise<void>;
}
type Row = { key: string; kind: "entry"; node: HistoryNode } | { key: string; kind: "turn" | "process"; id: string; count: number; preview: string; open?: boolean };

export function SessionHistoryWorkbench({ sessionId, sessionName, location, controls, onClose, onLocation, onOpenFile, onRelated }: Props) {
  const { t } = useI18n();
  const [preferences, setPreferences] = useState<Preferences>(() => ({ ...readPreferences(sessionId), ...(location.leafId ? { leafId: location.leafId } : {}), ...(location.entryId ? { entryId: location.entryId } : {}) }));
  const prefsRef = useRef(preferences); prefsRef.current = preferences;
  const anchor = useRef<string | null>(preferences.entryId);
  const manualScroll = useRef(false);
  const set = useCallback((values: Partial<Preferences>) => setPreferences(previous => ({ ...previous, ...values })), []);
  const history = useSessionHistory(sessionId, preferences.leafId);
  const { index, base, loading, indexError, changed } = history;
  const reload = () => {
    if (anchor.current) set({ entryId: anchor.current });
    history.reload();
  };
  const root = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null), navigation = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<VirtualListHandle>(null);
  const widthRef = useRef(264);
  const resizer = useResizablePanel({ ariaLabel: t("history.resizeNav"), cssVariable: "--history-nav-width", defaultWidth: 264, getMaxWidth: () => 360,
    growthDirection: "right", maxWidth: 360, minWidth: 220, panelRef: root, storageKey: "piora:history-nav-width", widthRef });
  const [drawer, setDrawer] = useState(false), [filters, setFilters] = useState(false), [exportOpen, setExportOpen] = useState(false);
  useEffect(() => { if (drawer && document.activeElement !== searchInput.current) navigation.current?.closest("aside")?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }); }, [drawer]);
  const [operation, setOperation] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [command, setCommand] = useState<CommandExecutionData | null>(null);
  const [search, setSearch] = useState<HistorySearchResult | null>(null);
  const [searchError, setSearchError] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedHit, setSelectedHit] = useState(-1);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const stores = useRef(new Map<string, ReturnType<typeof createVirtualRowState>>());
  const previousVersion = useRef<string | undefined>(undefined);
  const previousIndex = useRef<HistoryIndex | null>(null);
  const busy = !controls || controls.busy || Boolean(operation);
  const getStore = useCallback((id: string) => {
    const existing = stores.current.get(id); if (existing) return existing;
    const store = createVirtualRowState();
    for (const [key, value] of Object.entries(prefsRef.current.toggles[id] ?? {})) store.set(key, value);
    const write = store.set;
    store.set = (key, value) => {
      if (store.get(key, !value) === value) return;
      write(key, value);
      setPreferences(current => ({ ...current, toggles: { ...current.toggles, [id]: { ...current.toggles[id], [key]: value } } }));
    };
    stores.current.set(id, store); return store;
  }, []);
  useEffect(() => {
    try { sessionStorage.setItem(preferenceKey(sessionId), JSON.stringify(preferences)); } catch { /* Browsing still works without storage. */ }
  }, [preferences, sessionId]);
  useEffect(() => () => {
    try { sessionStorage.setItem(preferenceKey(sessionId), JSON.stringify({ ...prefsRef.current, entryId: anchor.current ?? prefsRef.current.entryId })); } catch { /* Optional continuity. */ }
  }, [sessionId]);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!index) return;
    const old = prefsRef.current;
    let leafId = old.leafId;
    if (!leafId || !index.nodes.some(node => node.id === leafId)) leafId = index.currentLeafId ?? index.branches.at(-1)?.id ?? null;
    else if (previousVersion.current && previousVersion.current !== index.version && leafId !== index.currentLeafId && !index.branches.some(branch => branch.id === leafId)) {
      leafId = selectHistoryBranch(index, leafId, index.currentLeafId) ?? leafId;
    }
    previousVersion.current = index.version;
    const path = historyPath(index.nodes, leafId);
    let entryId = old.entryId;
    if (!entryId || !path.some(node => node.id === entryId)) {
      if (entryId) setNotice(t("history.anchorMissing"));
      entryId = historyReadingAnchor(previousIndex.current ? historyPath(previousIndex.current.nodes, old.leafId) : [], path, entryId);
    }
    previousIndex.current = index;
    set({ leafId, entryId });
    anchor.current = entryId;
  }, [index, set, t]);
  useEffect(() => {
    if (!location.open) return;
    if (location.leafId && location.leafId !== prefsRef.current.leafId || location.entryId && location.entryId !== prefsRef.current.entryId) {
      set({ ...(location.leafId ? { leafId: location.leafId } : {}), ...(location.entryId ? { entryId: location.entryId } : {}) });
    }
  }, [location, set]);
  const path = useMemo(() => index ? historyPath(index.nodes, preferences.leafId ?? index.currentLeafId) : [], [index, preferences.leafId]);
  const turns = useMemo(() => historyTurns(path), [path]);
  const rows = useMemo(() => {
    if (preferences.mode === "events") return path.map(node => ({ key: node.id, kind: "entry", node }) as Row);
    const result: Row[] = [];
    for (const turn of turns) {
      result.push({ key: `turn:${turn.id}`, kind: "turn", id: turn.id, count: turn.entries.length, preview: turn.question?.preview ?? t("history.sessionStart") });
      const answer = [...turn.entries].reverse().find(node => node.hasAnswer);
      const process = turn.entries.filter(node => node.id !== turn.question?.id && node.id !== answer?.id);
      if (turn.question) result.push({ key: turn.question.id, kind: "entry", node: turn.question });
      if (process.length) {
        const open = preferences.processes.includes(turn.id);
        result.push({ key: `process:${turn.id}`, kind: "process", id: turn.id, count: process.length, preview: "", open });
        if (open) for (const node of process) {
          // Paired outputs are already rendered in the shared tool card. Keep a
          // standalone row when it is the target, or in the all-events view.
          if (!node.toolOwnerId || node.hasMedia || node.id === preferences.entryId) result.push({ key: node.id, kind: "entry", node });
        }
      }
      if (answer) result.push({ key: answer.id, kind: "entry", node: answer });
    }
    return result;
  }, [path, preferences.mode, preferences.processes, preferences.entryId, t, turns]);
  const rowKeys = useMemo(() => rows.map(row => row.key), [rows]);
  const [jump, setJump] = useState(0);
  const positioned = useRef("");
  useEffect(() => {
    const id = preferences.entryId;
    const token = `${preferences.leafId}:${id}:${preferences.mode}:${jump}`;
    if (!id || positioned.current === token) return;
    if (!rowKeys.includes(id)) {
      const turn = turns.find(turn => turn.entries.some(node => node.id === id));
      if (turn && !preferences.processes.includes(turn.id)) set({ processes: [...preferences.processes, turn.id] });
      return;
    }
    positioned.current = token;
    list.current?.scrollToKey(id);
  }, [jump, preferences.entryId, preferences.leafId, preferences.mode, preferences.processes, rowKeys, set, turns]);
  const reveal = useCallback((id: string, preferred?: string) => {
    if (!index) return;
    const leafId = selectHistoryBranch(index, id, preferred ?? prefsRef.current.leafId);
    if (!leafId) return;
    const turn = historyTurns(historyPath(index.nodes, leafId)).find(turn => turn.entries.some(node => node.id === id));
    setPreferences(current => ({ ...current, leafId, entryId: id, processes: turn ? [...new Set([...current.processes, turn.id])] : current.processes }));
    anchor.current = id; manualScroll.current = false; setJump(value => value + 1); setDrawer(false); onLocation(leafId, id);
  }, [index, onLocation]);

  const searching = Boolean(preferences.query.trim() || preferences.category || preferences.from || preferences.to || preferences.failed);
  const searchQuery = useMemo(() => {
    const query = new URLSearchParams({ q: preferences.query, scope: preferences.scope, version: index?.version ?? "" });
    if (preferences.scope === "branch" && preferences.leafId) query.set("leafId", preferences.leafId);
    if (preferences.category) query.set("category", preferences.category);
    if (preferences.from) query.set("from", new Date(`${preferences.from}T00:00:00`).toISOString());
    if (preferences.to) query.set("to", new Date(`${preferences.to}T23:59:59.999`).toISOString());
    if (preferences.failed) query.set("failed", "1");
    if (preferences.thinking) query.set("thinking", "1");
    return query.toString();
  }, [index?.version, preferences.query, preferences.scope, preferences.leafId, preferences.category, preferences.from, preferences.to, preferences.failed, preferences.thinking]);
  const searchGeneration = useRef(0);
  useEffect(() => {
    searchGeneration.current += 1;
    if (!index || !searching) { setSearch(null); setSearchError(""); setSearchLoading(false); return; }
    const controller = new AbortController();
    setSearchLoading(true); setSearchError("");
    if (root.current && root.current.clientWidth < 900 && document.activeElement === searchInput.current) setDrawer(true);
    const timer = setTimeout(() => {
      void historyRequest<HistorySearchResult>(`${base}/search?${searchQuery}`, controller.signal)
        .then(value => { if (!controller.signal.aborted) { setSearch(value); setSelectedHit(-1); } })
        .catch(error => { if (!controller.signal.aborted) setSearchError(String(error)); })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [base, index, searching, searchQuery, searchRefresh]);
  const selectHit = useCallback((hit: HistoryHit, position: number) => { setSelectedHit(position); reveal(hit.id); }, [reveal]);
  const loadMore = async () => {
    if (search?.nextOffset === null || !search || searchLoading) return;
    setSearchLoading(true);
    const generation = searchGeneration.current;
    try {
      const next = await historyRequest<HistorySearchResult>(`${base}/search?${searchQuery}&offset=${search.nextOffset}`);
      if (generation !== searchGeneration.current) return;
      setSearch(current => current && current.version === next.version ? { ...next, hits: [...current.hits, ...next.hits] } : current);
    } catch (error) { if (generation === searchGeneration.current) setSearchError(String(error)); }
    finally { if (generation === searchGeneration.current) setSearchLoading(false); }
  };

  const perform = async (key: string, action: () => Promise<void>) => {
    if (operation) return;
    setOperation(key); setActionError("");
    try { await action(); } catch (error) { setActionError(String(error)); } finally { setOperation(""); }
  };
  const exportUrl = (format: "json" | "markdown", id?: string, selection?: string) => {
    const query = new URLSearchParams({ format, version: index?.version ?? "", ...(preferences.leafId ? { leafId: preferences.leafId } : {}) });
    if (id) query.set("entryId", id); if (selection) query.set("selection", selection);
    return `${base}/export?${query}`;
  };
  const fetchExport = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new HistoryApiError(body.error || `HTTP ${response.status}`, response.status); }
    return response;
  };
  const copy = (id: string, selection: "entry" | "turn" | "link") => void perform("copy", async () => {
    const text = selection === "link" ? new URL(historyLocationUrl(sessionId, preferences.leafId, id), window.location.href).href
      : await (await fetchExport(exportUrl("markdown", id, selection))).text();
    await copyText(text); setNotice(t("history.copied"));
  });
  const download = (format: "html" | "json" | "markdown") => void perform("export", async () => {
    setExportOpen(false);
    const response = await fetchExport(format === "html" ? `/api/sessions/${encodeURIComponent(sessionId)}/export` : exportUrl(format));
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url; link.download = `piora-history-${sessionId}.${format === "markdown" ? "md" : format}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
  const fork = (id: string) => void perform("fork", async () => {
    if (!controls || controls.busy || !index) return;
    const query = new URLSearchParams({ entryId: id, original: "1", version: index.version, ...(preferences.leafId ? { leafId: preferences.leafId } : {}) });
    const original = await historyRequest<{ entries: HistoryDetail[] }>(`${base}/entries?${query}`);
    const message = original.entries[0]?.message;
    if (message?.role !== "user") throw new Error(t("history.questionMissing"));
    const payload = await prepareMessageRetry(message, async () => "");
    await controls.forkQuestion(id, { value: payload.message, images: payload.images ?? [], files: payload.files ?? [] });
  });
  const switchBranch = () => void perform("switch", async () => {
    if (!controls || controls.busy || !preferences.leafId) return;
    if (await controls.switchBranch(preferences.leafId)) onClose();
  });

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault(); event.stopImmediatePropagation(); searchInput.current?.focus(); searchInput.current?.select(); return;
      }
      if (event.key !== "Escape") return;
      if (document.querySelector(".message-image-dialog[open]")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (command) setCommand(null); else if (exportOpen) setExportOpen(false); else if (drawer) setDrawer(false); else if (filters) setFilters(false); else onClose();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [command, drawer, exportOpen, filters, onClose]);
  const branchName = (id: string | null) => {
    const position = index?.branches.findIndex(branch => branch.id === id) ?? -1;
    return position >= 0 ? t("history.branchNumber", { count: position + 1 }) : t("history.selectedPath");
  };
  const navKeys = searching ? search?.hits.map(hit => hit.id) ?? [] : preferences.nav === "turns" ? turns.map(turn => turn.id) : index?.branches.map(branch => branch.id) ?? [];
  return <section ref={root} className="history-workbench" tabIndex={-1} aria-label={t("history.dialogTitle")} data-history-workbench="">
    <header className="history-workbench-header">
      <button type="button" className="history-back" onClick={onClose}><AliIcon name="arrowleft" size={15} />{t("history.back")}</button>
      <div className="history-heading"><h2>{sessionName || index?.name || t("history.untitled")}</h2><span>{t("history.dialogTitle")}</span></div>
      <button type="button" disabled={loading} onClick={reload} title={t("history.reload")} aria-label={t("history.reload")}><AliIcon name="reload" size={15} /></button>
      <div className="history-export"><button type="button" disabled={Boolean(operation)} aria-expanded={exportOpen} onClick={() => setExportOpen(value => !value)}><AliIcon name="download" size={15} />{t(operation === "export" ? "history.exporting" : "history.export")}</button>
        {exportOpen ? <div className="history-export-menu">
          <button type="button" onClick={() => download("html")}>{t("history.exportHtml")}</button>
          <button type="button" onClick={() => download("json")}>{t("history.exportJson")}</button>
          <button type="button" onClick={() => download("markdown")}>{t("history.exportMarkdown")}</button>
          <button type="button" onClick={() => void perform("copy", async () => { await copyText(await (await fetchExport(exportUrl("markdown"))).text()); setNotice(t("history.copied")); setExportOpen(false); })}>{t("history.copyBranch")}</button>
        </div> : null}
      </div>
    </header>
    <div className="history-search-toolbar">
      <button type="button" className="history-nav-toggle" aria-expanded={drawer} onClick={() => setDrawer(value => !value)}>{t("history.navigation")}</button>
      <label className="history-search-input"><AliIcon name="search" size={15} /><input ref={searchInput} value={preferences.query} onChange={event => set({ query: event.target.value })} placeholder={t("history.searchPlaceholder")} aria-label={t("history.searchPlaceholder")} />{preferences.query ? <button type="button" onClick={() => set({ query: "" })} aria-label={t("history.clearSearch")}><AliIcon name="close" size={12} /></button> : null}</label>
      <select aria-label={t("history.searchScope")} value={preferences.scope} onChange={event => set({ scope: event.target.value as Preferences["scope"] })}><option value="all">{t("history.allBranches")}</option><option value="branch">{t("history.previewBranch")}</option></select>
      <button type="button" aria-expanded={filters} onClick={() => setFilters(value => !value)}>{t("history.filters")}</button>
    </div>
    {filters ? <div className="history-filters">
      <select aria-label={t("history.category")} value={preferences.category} onChange={event => set({ category: event.target.value as Preferences["category"] })}><option value="">{t("history.allTypes")}</option>{(["user", "assistant", "tool", "system"] as const).map(category => <option key={category} value={category}>{t(`history.kind.${category}`)}</option>)}</select>
      <label>{t("history.from")}<input type="date" value={preferences.from} onChange={event => set({ from: event.target.value })} /></label><label>{t("history.to")}<input type="date" value={preferences.to} onChange={event => set({ to: event.target.value })} /></label>
      <label><input type="checkbox" checked={preferences.failed} onChange={event => set({ failed: event.target.checked })} />{t("history.failedOnly")}</label>
      <label><input type="checkbox" checked={preferences.thinking} onChange={event => set({ thinking: event.target.checked })} />{t("history.includeThinking")}</label>
      <button type="button" onClick={() => set({ category: "", from: "", to: "", failed: false, thinking: false })}>{t("history.resetFilters")}</button>
    </div> : null}
    {changed || indexError || actionError || notice ? <div className="history-notices" role={indexError || actionError ? "alert" : "status"}>
      {changed ? <span>{t("history.changed")} <button type="button" onClick={reload}>{t("history.refresh")}</button></span> : null}
      {indexError ? <span>{indexError} <button type="button" onClick={reload}>{t("history.retry")}</button></span> : null}
      {actionError ? <span>{actionError}</span> : null}{notice ? <span>{notice}<button type="button" aria-label={t("i18n.close")} onClick={() => setNotice("")}>×</button></span> : null}
    </div> : null}
    {!index ? <div className="history-empty" role="status">{loading ? t("history.loadingIndex") : t("history.loadError")}</div> : <div className="history-workbench-body">
      {drawer ? <button type="button" className="history-drawer-backdrop" onClick={() => setDrawer(false)} aria-label={t("i18n.close")} /> : null}
      <aside className={`history-navigation${drawer ? " is-open" : ""}`} aria-label={t("history.navigation")}>
        <div className="history-nav-tabs">{(["turns", "branches"] as const).map(nav => <button type="button" key={nav} aria-pressed={preferences.nav === nav && !searching} onClick={() => { set({ nav, query: "", category: "", from: "", to: "", failed: false }); }}>{t(`history.${nav}`)}</button>)}</div>
        {searching ? <div className="history-result-controls"><span>{searchLoading ? t("history.searching") : t("history.resultCount", { count: search?.total ?? 0 })}</span>
          <button type="button" aria-label={t("history.previousResult")} disabled={selectedHit <= 0} onClick={() => selectHit(search!.hits[selectedHit - 1], selectedHit - 1)}>↑</button>
          <button type="button" aria-label={t("history.nextResult")} disabled={!search?.hits.length || selectedHit >= search.hits.length - 1} onClick={() => selectHit(search!.hits[selectedHit + 1], selectedHit + 1)}>↓</button>
        </div> : null}
        <div ref={navigation} className="history-nav-scroll">
          {searchError ? <div className="history-inline-error" role="alert">{searchError}<button type="button" onClick={() => setSearchRefresh(value => value + 1)}>{t("history.retry")}</button></div> : null}
          {!navKeys.length ? <p className="history-nav-empty">{t(searching ? "history.noResults" : "history.empty")}</p> : <VirtualList keys={navKeys} estimate={76} scrollContainer={navigation} renderItem={(key, position) => {
            if (searching) { const hit = search!.hits[position]; return <button type="button" className={`history-nav-item${hit.id === preferences.entryId ? " is-active" : ""}`} onClick={() => selectHit(hit, position)}><span className="history-nav-kicker">{t(`history.kind.${hit.category}`)} · {branchName(hit.leafId)}</span><span>{hit.snippet}</span><small>{hit.timestamp.slice(0, 16).replace("T", " ")}</small></button>; }
            if (preferences.nav === "turns") { const turn = turns[position]; return <button type="button" className={`history-nav-item${turn.entries.some(node => node.id === preferences.entryId) ? " is-active" : ""}`} onClick={() => reveal(turn.question?.id ?? turn.id)}><span className="history-nav-kicker">{t("history.turnNumber", { count: position + 1 })} · {turn.entries.length} {t("history.events")}</span><span>{turn.question?.preview || t("history.sessionStart")}</span></button>; }
            const branch = index.branches[position]; return <button type="button" className={`history-nav-item${key === preferences.leafId ? " is-active" : ""}`} style={{ paddingLeft: 12 + Math.min(branch.depth, 5) * 10 }} onClick={() => { const branchPath = historyPath(index.nodes, key); reveal([...branchPath].reverse().find(node => node.category === "user")?.id ?? key, key); }}><span className="history-nav-kicker">{branchName(key)}{key === controls?.leafId || key === index.currentLeafId ? ` · ${t("history.current")}` : ""}</span><span>{branch.preview || t("history.sessionStart")}</span>{branch.forkId ? <small>{t("history.forkPoint", { id: branch.forkId })}</small> : null}</button>;
          }} />}
          {searching && search?.nextOffset !== null && search?.nextOffset !== undefined ? <button type="button" disabled={searchLoading} className="history-load-more" onClick={() => void loadMore()}>{t("history.moreResults")}</button> : null}
        </div>
        {index.related.length ? <div className="history-related"><span>{t("history.related")}</span>{index.related.map(item => <button type="button" key={item.id} disabled={Boolean(operation)} onClick={() => void perform("related", async () => { await onRelated(item.id); })} title={item.name}>{t(`history.${item.relation}`)} · {item.name}</button>)}</div> : null}
        <div {...resizer.separatorProps} className="history-nav-resizer" />
      </aside>
      <div className="history-reader">
        <div className="history-reader-toolbar"><div><span>{t("history.previewing")} {branchName(preferences.leafId)}</span><small>{t("history.currentConversation")} {branchName(controls?.leafId ?? index.currentLeafId)}</small></div>
          <select aria-label={t("history.readingMode")} value={preferences.mode} onChange={event => set({ mode: event.target.value as Preferences["mode"], entryId: anchor.current ?? preferences.entryId })}><option value="turns">{t("history.byTurns")}</option><option value="events">{t("history.allEvents")}</option></select>
          {preferences.leafId !== controls?.leafId ? <button type="button" disabled={busy} title={t(busy ? "history.busy" : "history.switchDescription")} onClick={switchBranch}>{t("history.switchBranch")}</button> : null}
        </div>
        <div ref={scroller} className="history-reader-scroll overflow-y-auto" tabIndex={0}
          onWheelCapture={() => { manualScroll.current = true; }} onTouchMoveCapture={() => { manualScroll.current = true; }}
          onPointerDown={event => { if (event.target === event.currentTarget) manualScroll.current = true; }}
          onKeyDown={event => { if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"].includes(event.key)) manualScroll.current = true; }}
          onScroll={() => {
          if (!manualScroll.current) return;
          const viewport = scroller.current; if (!viewport) return;
          const target = viewport.getBoundingClientRect().top + viewport.clientHeight * .3;
          const entries = Array.from(viewport.querySelectorAll<HTMLElement>("[data-history-entry]"));
          const nearest = entries.reduce<HTMLElement | null>((best, item) => !best || Math.abs(item.getBoundingClientRect().top - target) < Math.abs(best.getBoundingClientRect().top - target) ? item : best, null);
          if (nearest) anchor.current = nearest.dataset.historyEntry ?? null;
        }}>
          <div className="history-reading-column">
            {!rows.length ? <div className="history-empty">{t("history.empty")}</div> : <VirtualList keys={rowKeys} estimate={150} scrollContainer={scroller} handleRef={list} renderItem={(_key, position) => {
              const row = rows[position];
              if (row.kind === "turn") return <div className="history-turn-heading"><span title={row.preview}>{row.preview}</span><button type="button" onClick={() => copy(row.id, "turn")} title={t("history.copyTurn")} aria-label={t("history.copyTurn")}><AliIcon name="copy" size={13} /></button></div>;
              if (row.kind === "process") return <ChatDisclosureTrigger className="history-process" expanded={Boolean(row.open)} label={t("chat.processDetails")} icon="activity" description={t("history.eventCount", { count: row.count })} onClick={() => set({ processes: row.open ? preferences.processes.filter(id => id !== row.id) : [...preferences.processes, row.id] })} />;
              if (row.kind !== "entry") return null;
              return <HistoryEntryCard node={row.node} detail={history.detail(row.node.id)} error={history.error(row.node.id)} ensure={history.ensure} store={getStore(row.node.id)} selected={row.node.id === preferences.entryId}
                includeThinking={preferences.thinking} sessionId={sessionId} version={index.version} cwd={index.cwd} onOpenFile={onOpenFile} onOpenCommand={setCommand} onCopy={copy}
                canFocus={Boolean(controls?.entryIds.includes(row.node.id))} onFocus={id => { controls?.focusEntry(id); onClose(); }} onFork={fork} busy={busy} />;
            }} />}
          </div>
        </div>
      </div>
    </div>}
    {command ? <CommandExecutionDialog data={command} onClose={() => setCommand(null)} /> : null}
  </section>;
}
