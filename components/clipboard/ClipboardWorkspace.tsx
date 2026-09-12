"use client";
import { useClipboardI18n } from "./useClipboardI18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ClipboardBridge, ClipboardChange, ClipboardDetail, ClipboardFilter, ClipboardItem, ClipboardMutation, ClipboardOperation, ClipboardQuery, ClipboardStatus } from "@/desktop/src/clipboard-types";
import { ClipboardPreview } from "./ClipboardPreview";
import { ClipboardImageHover } from "./ClipboardImageHover";
import { ClipboardImageViewer } from "./ClipboardImageViewer";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { AliIcon } from "@/components/AliIcon";
import { ClipboardToolbar, type ClipboardToolbarAction } from "./ClipboardToolbar";
import { clipboardAnchor, clipboardAnchorScroll, clipboardCursor, clipboardRowHeight, mergeClipboardWindow } from "./clipboard-view";
import { useClipboardDraftGuard } from "./useClipboardDraftGuard";
import { belongsToClipboardGroup, ClipboardBatchBar, type ClipboardSelectionGroup } from "./ClipboardBatchBar";
import { clipboardByteLabel } from "@/desktop/src/clipboard-content";
import styles from "./ClipboardWorkspace.module.css";
import { ClipboardRecoveryPanel } from "./ClipboardRecoveryPanel";
import type { ClipboardRecoveryDraft } from "./clipboard-draft-store";

const FILTERS: Array<[ClipboardFilter, string]> = [["all", "全部"], ["text", "文字"], ["image", "图片"], ["files", "文件"], ["starred", "收藏"], ["trash", "回收站"]];
const ROW = 56;
const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value)).replace(/^Error invoking remote method 'pi:clipboard-v2-[^']+': (?:Error: )?/, "");
const VIEW_KEY = "piora-clipboard-view:v2";
type SavedPosition = { cursor: string; offset: number } | null;
let nextRequestId = Date.now() * 1000;
const initialView = (surface: string) => {
  const fallback = { text: "", filter: surface === "shelf" ? "shelf" as ClipboardFilter : "all" as ClipboardFilter, source: "", after: "", before: "", preview: surface === "manager", width: 380, position: null as SavedPosition };
  if (surface !== "manager" || typeof window === "undefined") return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "{}");
    return { ...fallback, position: value.position && typeof value.position.cursor === "string" && value.position.cursor.length <= 1024 && Number.isFinite(value.position.offset) ? { cursor: value.position.cursor, offset: Math.max(0, Math.min(200, value.position.offset)) } : null, text: typeof value.text === "string" ? value.text.slice(0, 1000) : "", filter: FILTERS.some(([id]) => id === value.filter) ? value.filter as ClipboardFilter : "all" as ClipboardFilter, source: typeof value.source === "string" ? value.source : "", after: typeof value.after === "string" ? value.after : "", before: typeof value.before === "string" ? value.before : "", preview: value.preview !== false, width: typeof value.width === "number" ? Math.max(240, Math.min(700, value.width)) : 380 };
  } catch { return fallback; }
};
function Match({ text, query }: { text: string; query: string }) {
  const term = query.trim().split(/\s+/)[0];
  const start = term ? text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase()) : -1;
  return start < 0 ? text : <>{text.slice(0, start)}<mark>{text.slice(start, start + term.length)}</mark>{text.slice(start + term.length)}</>;
}

export function ClipboardWorkspace({ surface = "manager", onSave, visible = true, copyOnClick = surface === "quick" }: { surface?: "quick" | "manager" | "shelf"; onSave?: (entry: ClipboardDetail) => Promise<void>; visible?: boolean; copyOnClick?: boolean }) {
  const { tr, locale } = useClipboardI18n();
  const [bridge, setBridge] = useState<ClipboardBridge | null | undefined>(undefined);
  const [view, setView] = useState(() => initialView(surface));
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previousCursor, setPreviousCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<ClipboardStatus | null>(null);
  const storageUnavailable = Boolean(status?.storage && status.storage !== "ready");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pinnedActive, setPinnedActive] = useState<ClipboardItem | null>(null);
  const [selected, setSelected] = useState<ClipboardItem[]>([]);
  const [selectionBeforeGroup, setSelectionBeforeGroup] = useState<ClipboardItem[] | null>(null);
  const [recovered, setRecovered] = useState<ClipboardRecoveryDraft | null>(null);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [detail, setDetail] = useState<ClipboardDetail | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(360);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState<{ ids: string[] } | null>(null);
  const [imagePreview, setImagePreview] = useState<ClipboardItem | null>(null);
  useEffect(() => {
    if (!copyNotice) return;
    const timer = setTimeout(() => setCopyNotice(null), 1300);
    return () => clearTimeout(timer);
  }, [copyNotice]);
  const [newCount, setNewCount] = useState(0);
  const [settings, setSettings] = useState(false);
  const [separator, setSeparator] = useState("\n");
  const [customSeparator, setCustomSeparator] = useState(false);
  const [merge, setMerge] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ClipboardMutation | null>(null);
  const [undo, setUndo] = useState<string[]>([]);
  const [dragReady, setDragReady] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [archiveWarnings, setArchiveWarnings] = useState<string[]>([]);
  const [narrowDetail, setNarrowDetail] = useState(false);
  const rowSize = surface === "manager" ? 64 : ROW;
  const offsets = useMemo(() => {
    const positions = [0];
    for (const item of items) positions.push(positions[positions.length - 1] + clipboardRowHeight(surface, item));
    return positions;
  }, [items, surface]);
  const listHeight = offsets[offsets.length - 1];
  const search = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const modal = useRef<HTMLDivElement>(null);
  const generation = useRef(0), paging = useRef(false), operation = useRef(false), targetToken = useRef<string | undefined>(undefined);
  const pendingScroll = useRef<number | null>(null), lastQuery = useRef<string | null>(null), loadedQuery = useRef<string | null>(null);
  const current = useRef({ items, selected, scroll, activeId, view });
  useEffect(() => { current.current = { items, selected, scroll, activeId, view }; }, [items, selected, scroll, activeId, view]);
  const active = items.find(item => item.id === activeId) ?? (activeId === pinnedActive?.id ? pinnedActive : null) ?? items[0];
  useEffect(() => { if (activeId && active?.id === activeId) setPinnedActive(active); }, [activeId, active]);
  useLayoutEffect(() => {
    if (pendingScroll.current === null || !list.current) return;
    list.current.scrollTop = pendingScroll.current; setScroll(list.current.scrollTop); pendingScroll.current = null;
  }, [items]);
  const selection = selected.length ? selected : active ? [active] : [];
  const ids = selection.map(item => item.id);
  const mixedSelection = selection.some(item => belongsToClipboardGroup(item, "text")) && selection.some(item => belongsToClipboardGroup(item, "files"));
  const selectedIds = new Set(selected.map(item => item.id));
  const refresh = useCallback(() => setEpoch(value => value + 1), []);
  const report = useCallback((error: unknown) => setError(errorText(error)), []);
  const draftGuard = useClipboardDraftGuard(report);
  const { guard, draft: draftRef } = draftGuard;
  useFocusTrap(modal, visible && Boolean(draftGuard.open || settings || confirm || merge !== null));
  useEffect(() => { setRecovered(value => value?.entryId === active?.id ? value : null); }, [active?.id]);
  const detailChanged = useCallback(() => { setError(""); refresh(); }, [refresh]);
  const createdCopy = useCallback(async (id: string) => {
    if (!bridge) return;
    const entry = await bridge.getDetail(id);
    lastQuery.current = null;
    setView(existing => ({ ...existing, text: "", filter: "all", source: "", after: "", before: "", preview: true, position: null }));
    setItems(existing => [entry, ...existing.filter(item => item.id !== id)].slice(0, 500));
    setDetail(entry); setActiveId(id); setSelected([]); setScroll(0);
    if (list.current) list.current.scrollTop = 0;
    refresh();
  }, [bridge, refresh]);

  useEffect(() => { setBridge(window.piDesktop?.clipboard?.historyV2 ?? null); }, []);
  useEffect(() => { if (bridge) void bridge.setLocale(locale === "en" ? "en" : "zh-CN").catch(report); }, [bridge, locale, report]);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const updateStatus = () => void bridge.status().then(value => { if (alive) setStatus(value); }).catch(report);
    updateStatus();
    const unwatch = bridge.subscribe((change: ClipboardChange) => {
      if (!alive) return;
      if (change.error) { report(change.error); refresh(); }
      if (change.targetToken) targetToken.current = change.targetToken;
      if (change.reason === "open" && surface === "quick") {
        if (draftRef.current?.dirty) { setNotice("已保留未保存的编辑，保存或放弃后可查看最新记录。"); updateStatus(); return; }
        lastQuery.current = null; setView(initialView("quick")); setSelected([]); setActiveId(null); setSettings(false); setConfirm(null); setMerge(null); setError(""); setNotice(""); setScroll(0); setNewCount(0);
        if (list.current) list.current.scrollTop = 0;
        requestAnimationFrame(() => search.current?.focus()); refresh();
      } else if (change.reason === "capture") {
        const state = current.current;
        if (state.scroll > ROW || state.selected.length || state.view.text || state.activeId) setNewCount(count => count + 1);
        else { lastQuery.current = null; setView(existing => ({ ...existing, position: null })); refresh(); }
      } else if (change.reason === "mutation") refresh();
      updateStatus();
    });
    return () => { alive = false; unwatch(); };
  }, [bridge, surface, refresh, report, draftRef]);
  const query = useCallback((next?: string): ClipboardQuery => ({ text: view.text, filter: view.filter, ...(view.source ? { source: view.source } : {}), ...(view.after ? { after: new Date(`${view.after}T00:00:00`).getTime() } : {}), ...(view.before ? { before: new Date(`${view.before}T23:59:59.999`).getTime() } : {}), ...(next ? { cursor: next } : {}), limit: 100 }), [view.text, view.filter, view.source, view.after, view.before]);
  const queryKey = JSON.stringify([view.text, view.filter, view.source, view.after, view.before]);
  useEffect(() => {
    if (!bridge) return;
    const sameQuery = lastQuery.current === queryKey, firstQuery = lastQuery.current === null;
    lastQuery.current = queryKey;
    const state = current.current, anchor = sameQuery ? clipboardAnchor(state.items, state.scroll, surface) : null;
    const restore = firstQuery ? view.position : null;
    const from = sameQuery && state.items[0] ? clipboardCursor(state.items[0], view.filter) : restore?.cursor;
    const wanted = sameQuery ? Math.max(100, state.items.length) : 100;
    const token = ++nextRequestId; generation.current = token; setLoading(true); paging.current = false;
    const timer = setTimeout(() => {
      void (async () => {
        let next = from, previous: string | null = null, forward: string | null = null;
        const collected: ClipboardItem[] = [], seen = new Set<string>();
        do {
          const page = await bridge.query({ ...query(next), ...(collected.length === 0 && from ? { includeCursor: true } : {}), limit: Math.min(100, wanted - collected.length), requestId: token });
          if (token !== generation.current) return;
          if (!collected.length) previous = page.previousCursor ?? null;
          for (const item of page.items) if (!seen.has(item.id)) { seen.add(item.id); collected.push(item); }
          forward = page.nextCursor; next = forward ?? undefined;
          if (!page.items.length) break;
        } while (next && collected.length < wanted);
        pendingScroll.current = anchor ? clipboardAnchorScroll(collected, anchor, surface) : restore?.offset ?? 0;
        loadedQuery.current = queryKey;
        setItems(collected); setCursor(forward); setPreviousCursor(previous); setLoading(false);
      })().catch(error => { if (token === generation.current) { report(error); setLoading(false); } });
    }, view.text ? 50 : 0);
    return () => { clearTimeout(timer); generation.current++; void bridge.cancelQuery(token).catch(() => {}); };
    // View position is a one-time restore bookmark; current browse state comes from current.current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge, query, queryKey, epoch, surface, report]);
  useEffect(() => {
    if (surface !== "manager") return;
    const anchor = !loading && loadedQuery.current === queryKey ? clipboardAnchor(items, scroll, surface) : null;
    const position = anchor ? { cursor: clipboardCursor(items[anchor.index], view.filter), offset: anchor.offset } : null;
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ ...view, position })); } catch { /* Optional local UI preferences. */ }
  }, [surface, view, items, scroll, loading, queryKey]);
  const loadPage = useCallback(async (direction: "older" | "newer") => {
    const next = direction === "older" ? cursor : previousCursor;
    if (!bridge || !next || paging.current || loading) return;
    paging.current = true; const token = generation.current;
    try {
      const page = await bridge.query({ ...query(next), direction, requestId: token });
      if (token !== generation.current) return;
      const state = current.current, merged = mergeClipboardWindow(state.items, page.items, direction, state.scroll, surface);
      pendingScroll.current = merged.scroll; setItems(merged.items);
      if (direction === "older") {
        setCursor(page.nextCursor);
        if (merged.trimmed && merged.items[0]) setPreviousCursor(clipboardCursor(merged.items[0], view.filter));
      } else {
        setPreviousCursor(page.previousCursor ?? null);
        if (merged.trimmed && merged.items.length) setCursor(clipboardCursor(merged.items[merged.items.length - 1], view.filter));
      }
    } catch (error) { if (token === generation.current) report(error); }
    finally { if (token === generation.current) paging.current = false; }
  }, [bridge, cursor, previousCursor, query, loading, report, surface, view.filter]);
  const loadMore = useCallback(() => loadPage("older"), [loadPage]);
  useEffect(() => {
    if (list.current && Math.abs(list.current.scrollTop - scroll) > 1) return;
    if (scroll < rowSize * 4 && previousCursor) void loadPage("newer");
    else if (scroll + height > listHeight - 12 * rowSize) void loadMore();
  }, [scroll, height, listHeight, rowSize, previousCursor, loadPage, loadMore]);
  useEffect(() => {
    if (!list.current) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setHeight(entry.contentRect.height); }); observer.observe(list.current); return () => observer.disconnect();
  }, [bridge]);
  useEffect(() => {
    if (!bridge || !active?.id || !view.preview) return;
    let alive = true;
    void bridge.getDetail(active.id).then(entry => { if (alive) setDetail(entry); }).catch(report);
    return () => { alive = false; };
  }, [bridge, active?.id, active?.copiedAt, active?.remark, active?.starred, view.preview, epoch, report]);
  const dragKey = selection.length && selection.every(item => item.kind === "files" || item.kind === "image") ? JSON.stringify(ids) : "";
  useEffect(() => {
    setDragReady(""); if (!bridge || !dragKey) return;
    let alive = true;
    void bridge.prepareDrag(JSON.parse(dragKey)).then(ready => { if (alive && ready) setDragReady(dragKey); }).catch(report);
    return () => { alive = false; };
  }, [bridge, dragKey, report, epoch]);
  const run = async (task: () => Promise<unknown>, success = "") => {
    if (operation.current) return; operation.current = true; setBusy(true); setError(""); setNotice(""); setCopyNotice(null);
    try { await task(); if (success) setNotice(success); } catch (error) { report(error); } finally { operation.current = false; setBusy(false); }
  };
  const mutate = (mutation: ClipboardMutation, success = "") => {
    const action = () => { void run(async () => { await bridge!.mutate(mutation); refresh(); if (mutation.type === "delete") { setUndo(mutation.ids); setSelected([]); } }, success); };
    if (["delete", "purge", "clear-history", "empty-trash", "shelf-remove"].includes(mutation.type)) guard(action); else action();
  };
  const execute = (paste: boolean, plain = false, usingIds = ids) => guard(() => { void run(async () => {
    const known = usingIds.map(id => selected.find(item => item.id === id) ?? items.find(item => item.id === id));
    if (!plain && known.some(item => item && belongsToClipboardGroup(item, "text")) && known.some(item => item && belongsToClipboardGroup(item, "files"))) throw new Error(tr("文字与图片或文件需要分组使用，请先在多选栏选择一组。"));
    const value: ClipboardOperation = { ids: usingIds, plain, separator, ...(targetToken.current ? { targetToken: targetToken.current } : {}) };
    const result = await (paste ? bridge!.paste(value) : bridge!.copy(value));
    if (result.status !== "input-sent" && result.status !== "copied") setError(result.message);
    else if (!paste) setCopyNotice({ ids: usingIds });
    else setNotice(result.message);
  }); });
  const toggle = (item: ClipboardItem) => { setSelectionBeforeGroup(null); setSelected(existing => existing.some(entry => entry.id === item.id) ? existing.filter(entry => entry.id !== item.id) : [...existing, item]); };
  const selectGroup = (group: ClipboardSelectionGroup) => { setSelectionBeforeGroup(selected); setSelected(selected.filter(item => belongsToClipboardGroup(item, group))); setMerge(null); };
  const canClickCopy = copyOnClick && view.filter !== "trash" && !storageUnavailable;
  const choose = (event: MouseEvent, item: ClipboardItem) => guard(() => {
    if ((event.target as HTMLElement).closest("button,input")) return;
    if (event.shiftKey) {
      setSelectionBeforeGroup(null);
      const start = Math.max(0, items.findIndex(entry => entry.id === active?.id)), end = items.indexOf(item);
      const range = items.slice(Math.min(start, end), Math.max(start, end) + 1);
      setSelected(existing => [...existing, ...range.filter(entry => !existing.some(old => old.id === entry.id))]);
    } else if (event.ctrlKey || event.metaKey) toggle(item);
    else if (canClickCopy) {
      setActiveId(item.id); setSelected([]); list.current?.focus();
      if (event.detail < 2) execute(false, false, [item.id]);
      return;
    }
    setActiveId(item.id); setNarrowDetail(true); if (surface === "manager" && window.matchMedia("(max-width:600px)").matches) setView(existing => ({ ...existing, preview: true })); list.current?.focus();
  });
  const changeView = (patch: Partial<typeof view>) => guard(() => { setView(existing => ({ ...existing, ...patch, position: null })); setActiveId(null); setScroll(0); if (list.current) list.current.scrollTop = 0; });
  const moveSelection = (index: number, direction: number) => setSelected(existing => { const next = [...existing]; const to = index + direction; if (to >= 0 && to < next.length) [next[index], next[to]] = [next[to], next[index]]; return next; });
  const showMerge = () => run(async () => {
    if (selection.every(item => item.kind === "text" || item.kind === "link")) {
      const parts: string[] = []; let size = 0;
      for (const item of selection) { const entry = await bridge!.getDetail(item.id); size += entry.text?.length ?? 0; if (size > 2_000_000) throw new Error(tr("合并预览较大，请减少选择后预览。")); parts.push(entry.text ?? ""); }
      setMerge(parts.join(separator));
    } else if (selection.every(item => item.kind === "files" || item.kind === "image")) setMerge(selection.map((item, index) => `${index + 1}. ${item.title}`).join("\n") + tr("\n\n将作为文件集合使用。"));
    else throw new Error(tr("文字与图片或文件不能合并粘贴，请分组使用。"));
  });
  const menu = async (item: ClipboardItem) => {
    if (!bridge) return;
    const chosen = selectedIds.has(item.id) ? selected : [item], usingIds = chosen.map(entry => entry.id);
    try {
      const action = await bridge.menu(usingIds);
      if (action === "copy" || action === "paste" || action === "plain") void execute(action !== "copy", action === "plain", usingIds);
      else if (action === "star") void mutate({ type: "star", ids: usingIds, value: !chosen.every(entry => entry.starred) });
      else if (action === "save") void run(() => bridge.saveAs(item.id));
      else if (action === "purge") setConfirm({ type: "purge", ids: usingIds });
      else if (action === "shelf-top" || action === "shelf-up" || action === "shelf-down") void mutate({ type: "shelf-move", id: item.id, direction: action === "shelf-top" ? "top" : action === "shelf-up" ? "up" : "down" });
      else if (action) void mutate({ type: action, ids: usingIds });
    } catch (error) { report(error); }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (draftGuard.open) { if (event.key === "Escape") { event.preventDefault(); draftGuard.cancel(); } return; }
    const target = event.target as HTMLElement, input = Boolean(target.closest("input,textarea,select,[contenteditable=true]")), inSearch = target === search.current;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "f" || event.key === "/" && !input) { event.preventDefault(); search.current?.focus(); return; }
    if (event.key === "Escape") { event.preventDefault(); if (confirm) setConfirm(null); else if (merge !== null) setMerge(null); else if (settings) setSettings(false); else if (selected.length) setSelected([]); else if (view.text) changeView({ text: "" }); else if (surface === "manager" && narrowDetail && window.matchMedia("(max-width:600px)").matches) setNarrowDetail(false); else if (surface !== "manager") guard(() => { void bridge?.hide(); }); return; }
    if (mod && event.key.toLowerCase() === "c" && !input && !window.getSelection()?.toString()) { if (ids.length) { event.preventDefault(); void execute(false); } return; }
    if (event.altKey && event.key.toLowerCase() === "p") { event.preventDefault(); guard(() => setView(existing => ({ ...existing, preview: !existing.preview }))); return; }
    if (event.ctrlKey && event.key === "Tab" && surface !== "shelf") { event.preventDefault(); const index = FILTERS.findIndex(([id]) => id === view.filter); changeView({ filter: FILTERS[(index + (event.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length][0] }); return; }
    if (input && !inSearch || target.closest("button") || settings || confirm || merge !== null) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); const index = items.findIndex(item => item.id === active?.id), next = Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      if (items[next]) guard(() => { setActiveId(items[next].id); if (list.current) { if (offsets[next] < list.current.scrollTop) list.current.scrollTop = offsets[next]; else if (offsets[next + 1] > list.current.scrollTop + height) list.current.scrollTop = offsets[next + 1] - height; } });
    } else if (event.key === "Enter" && ids.length && view.filter !== "trash") { event.preventDefault(); void execute(false, event.shiftKey); }
    else if (event.key === " " && !input && active) { event.preventDefault(); toggle(active); }
    else if (event.key === "Delete" && !input && ids.length) { event.preventDefault(); if (view.filter === "trash") setConfirm({ type: "purge", ids }); else void mutate({ type: "delete", ids }, tr("已移入回收站")); }
    else if (!input && !mod && !event.altKey && event.key.length === 1) { search.current?.focus(); changeView({ text: event.key }); }
  };
  const firstVisible = Math.max(0, offsets.findIndex(offset => offset >= scroll) - 1);
  const belowViewport = offsets.findIndex(offset => offset >= scroll + height);
  const start = Math.max(0, firstVisible - 4), end = Math.min(items.length, (belowViewport < 0 ? items.length : belowViewport) + 4);
  const toolbarAction = (action: ClipboardToolbarAction) => {
    if (action === "settings") setSettings(true);
    else if (action === "hide") guard(() => { void bridge?.hide(); });
    else if (action === "record") void mutate({ type: "settings", value: { enabled: !status?.settings.enabled } });
    else if (action === "shelf" || action === "manager") void run(() => bridge!.open(action));
    else if (action === "capture") void run(() => bridge!.capture(), tr("已收录当前内容"));
    else if (action === "clear") guard(() => setConfirm({ type: view.filter === "trash" ? "empty-trash" : "clear-history" }));
    else if (action === "export") void run(async () => { setArchiveWarnings([]); if (await bridge!.exportArchive()) setNotice("已导出历史、格式、图片和暂存记录。"); });
    else if (action === "import") void run(async () => { setArchiveWarnings([]); const result = await bridge!.importArchive(); if (result) { setArchiveWarnings(result.warnings); setNotice(tr("已导入 {imported} 条新记录，合并 {merged} 条重复记录。", { imported: result.imported, merged: result.merged })); refresh(); } });
  };
  if (bridge === null) return <section className={styles.unsupported}><h2>{tr("剪贴板需要 Piora 桌面端")}</h2><p>{tr("在新版桌面端打开后，可开启系统剪贴板记录、搜索和粘贴。")}</p></section>;
  return <section className={styles.workspace} data-surface={surface} data-locale={locale} data-preview={view.preview} data-detail={narrowDetail} data-multiple={selected.length > 0} aria-label={surface === "shelf" ? tr("屏幕暂存") : tr("剪贴板")} onKeyDown={keyDown}>
    {copyNotice && visible ? <div className={styles.copyToast} role="status" aria-live="polite"><span aria-hidden="true">✓</span>{tr("已复制")}</div> : null}
    <ClipboardToolbar surface={surface} view={view} status={status} busy={busy} search={search} onAction={toolbarAction} onView={patch => { if (Object.keys(patch).every(key => key === "preview")) guard(() => { setView(existing => ({ ...existing, ...patch })); setNarrowDetail(true); }); else { changeView(patch); setNarrowDetail(false); } }} />
    {newCount ? <button className={styles.newItems} onClick={() => guard(() => { lastQuery.current = null; setView(existing => ({ ...existing, position: null })); setNewCount(0); setActiveId(null); setScroll(0); if (list.current) list.current.scrollTop = 0; refresh(); })}>{tr("新增")} {newCount} {tr("条 · 查看最新")}</button> : null}
    {narrowDetail && view.preview ? <button className={styles.backToList} onClick={() => { setNarrowDetail(false); list.current?.focus(); }}><AliIcon name="arrowleft" size={16} />{tr("返回列表")}</button> : null}
    <div className={styles.body} style={{ "--clipboard-list-width": `${view.width}px` } as React.CSSProperties}>
      <div ref={list} className={styles.list} role="listbox" aria-label={tr("剪贴板记录")} aria-multiselectable="true" aria-activedescendant={active ? `clipboard-${active.id}` : undefined} tabIndex={0} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
        {!items.length ? <div className={styles.empty}>{loading || bridge === undefined ? tr("正在读取…") : view.text ? tr("没有匹配记录，试试更短的关键词。") : view.filter === "shelf" ? tr("把常用内容加入屏幕暂存，在这里反复使用。") : status?.settings.enabled ? tr("从下一次复制开始记录。") : tr("开启记录，或收录当前剪贴板。")}</div> : <div className={styles.virtualSpace} style={{ height: listHeight }}>{items.slice(start, end).map((item, index) => <div key={item.id} id={`clipboard-${item.id}`} role="option" aria-selected={selectedIds.has(item.id) || active?.id === item.id} className={styles.row} data-kind={item.kind} data-copyable={canClickCopy} data-active={active?.id === item.id} data-selected={selectedIds.has(item.id)} style={{ top: offsets[start + index], height: offsets[start + index + 1] - offsets[start + index] }} onClick={event => choose(event, item)} onDoubleClick={event => { if ((event.target as HTMLElement).closest("button,input")) return; if (!copyOnClick && view.filter !== "trash") void execute(false, false, selectedIds.has(item.id) ? ids : [item.id]); }} onContextMenu={event => { event.preventDefault(); guard(() => { setActiveId(item.id); void menu(item); }); }} draggable={dragReady === JSON.stringify(selectedIds.has(item.id) ? ids : [item.id])} onDragStart={event => { event.preventDefault(); bridge?.startDrag(selectedIds.has(item.id) ? ids : [item.id]); }}>
          {item.kind === "image" && bridge ? <ClipboardImageHover item={item} bridge={bridge} className={surface === "shelf" ? styles.shelfImage : styles.imageThumbnail} disabled={!visible || Boolean(imagePreview || settings || confirm || merge !== null || draftGuard.open)} /> : <span className={styles.type}><AliIcon name={item.kind === "files" ? "folder" : item.kind === "link" ? "link" : "file"} size={22} /></span>}
          <div className={styles.rowContent}><strong><Match text={item.remark || item.title} query={view.text} /></strong><small><Match text={surface === "shelf" && item.kind === "image" ? `${item.image?.width ?? 0} × ${item.image?.height ?? 0}` : item.preview} query={view.text} /></small></div>
          {surface === "shelf" ? <button className={styles.rowMenu} aria-label={tr("操作 {title}", { title: item.title })} onClick={event => { event.stopPropagation(); guard(() => { setActiveId(item.id); void menu(item); }); }}><AliIcon name="ellipsis" size={18} /></button> : <div className={styles.rowMeta}><time>{new Date(item.copiedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time><span>{item.starred ? "★ " : ""}{item.source.name || tr("来源未知")}</span></div>}
          {item.kind === "image" ? <button className={styles.imagePreviewButton} aria-label={tr("查看大图：{title}", { title: item.title })} onClick={event => { event.stopPropagation(); guard(() => { setError(""); setImagePreview(item); }); }}><AliIcon name="expand" size={14} />{tr("查看大图")}</button> : null}
          <input className={styles.rowCheck} type="checkbox" aria-label={tr("选择 {title}", { title: item.title })} checked={selectedIds.has(item.id)} onClick={event => event.stopPropagation()} onChange={() => toggle(item)} />
        </div>)}</div>}{cursor ? <button className={styles.more} disabled={loading} onClick={() => void loadMore()}>{tr("加载更多")}</button> : null}
      </div>
      {view.preview ? <><div className={styles.resize} role="separator" aria-label={tr("列表宽度")} aria-orientation="vertical" aria-valuenow={view.width} tabIndex={0} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setView(existing => ({ ...existing, width: Math.max(240, Math.min(700, existing.width + (event.key === "ArrowLeft" ? -20 : 20))) })); } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); setView(existing => ({ ...existing, width: Math.max(200, Math.min(bounds.width - 240, event.clientX - bounds.x)) })); } }} />{bridge && active && detail?.id === active.id ? <ClipboardPreview key={`${detail.id}:${previewVersion}`} recovered={recovered?.entryId === detail.id ? recovered : null} onRecoveryCleared={() => setRecovered(null)} entry={detail} bridge={bridge} onChanged={detailChanged} onCreated={createdCopy} onError={report} onSave={onSave} onInteract={() => setActiveId(detail.id)} onExpandImage={() => guard(() => { setError(""); setImagePreview(detail); })} onDraft={draftGuard.register} /> : <div className={styles.empty}>{active ? tr("正在加载预览…") : tr("选择一条记录查看内容")}</div>}</> : null}
    </div>
    {selected.length ? <ClipboardBatchBar selected={selected} busy={busy} separator={separator} customSeparator={customSeparator} restoreCount={selectionBeforeGroup?.length ?? 0} onClear={() => { setSelected([]); setSelectionBeforeGroup(null); }} onSeparator={(value, custom) => { setSeparator(value); setCustomSeparator(custom); setMerge(null); }} onMerge={() => void showMerge()} onGroup={selectGroup} onRestore={() => { if (selectionBeforeGroup) setSelected(selectionBeforeGroup); setSelectionBeforeGroup(null); setMerge(null); }} onMove={moveSelection} onToggle={toggle} /> : null}
    <footer className={styles.actionBar}>
      <div className={styles.footerContext}>{surface === "manager" ? <><span>{status?.storage && status.storage !== "ready" ? tr("历史暂不可用") : <>{(status?.total ?? 0).toLocaleString(locale)} {tr("条记录")}</>}</span><span className={styles.localOnly}>{tr("仅保存在本机")}</span></> : surface === "shelf" ? <span><AliIcon name="info" size={14} />{tr("关闭后内容仍会保留")}</span> : <span className={styles.keyHints}><kbd>↑↓</kbd>{tr("选择")} <kbd>↵</kbd>{tr("复制")} <kbd>⇧↵</kbd>{tr("纯文本")}</span>}</div>
      <div className={styles.actions}>{view.filter === "trash" ? <><button className={styles.secondary} disabled={!ids.length || busy || storageUnavailable} onClick={() => void mutate({ type: "restore", ids }, tr("已恢复"))}>{tr("恢复")}</button><button className={styles.danger} disabled={!ids.length || busy || storageUnavailable} onClick={() => setConfirm({ type: "purge", ids })}>{tr("永久删除…")}</button></> : <>
        {surface === "manager" ? <button className={styles.secondary} disabled={!ids.length || busy || storageUnavailable} onClick={() => void mutate({ type: "shelf-add", ids }, tr("已加入屏幕暂存"))}><AliIcon name="pushpin" size={16} />{tr("暂存")}</button> : null}
        {selected.length > 0 ? <button className={styles.iconButton} aria-label={tr("删除所选记录")} disabled={busy || storageUnavailable} onClick={() => void mutate({ type: "delete", ids }, tr("已移入回收站"))}><AliIcon name="clear" size={16} /></button> : null}
        <button className={styles.primary} aria-label={selected.length > 1 ? tr("合并复制") : tr("复制")} disabled={!ids.length || busy || storageUnavailable || mixedSelection} onClick={() => void execute(false)}>{selected.length > 1 ? tr("合并复制") : tr("复制")}<kbd>↵</kbd></button>
      </>}</div>
    </footer>
    {status?.budgetState === "warning" ? <div className={styles.warning}>{tr("内容容量已达 90%，可在设置中增加预算或整理历史。")}</div> : null}
    {status?.budgetState === "full" ? <div className={styles.warning} role="status"><span>{tr("空间预算不足，已暂停新增。历史仍可搜索和复制。")}</span><button onClick={() => setSettings(true)}>{tr("调整容量")}</button>{surface !== "shelf" ? <button onClick={() => changeView({ filter: "trash" })}>{tr("整理回收站")}</button> : null}</div> : null}
    {status?.listener === "polling" ? <div className={styles.warning}>{tr("当前使用轮询记录，快速连续复制可能遗漏。")}</div> : null}
    {error || status?.error ? <div className={styles.error} role="alert"><span>{tr(error || status?.error || "")}</span><button disabled={busy || status?.storage === "recovering"} onClick={() => { if (status?.storage === "failed") void run(async () => { await bridge!.reconnect(); const next = await bridge!.status(); setStatus(next); refresh(); }, tr("已重新连接。未确认的操作未重放，请核对最近记录。")); else { setError(""); refresh(); } }}>{status?.storage === "recovering" ? tr("正在重新连接…") : status?.storage === "failed" ? tr("重新连接存储") : tr("重试")}</button></div> : null}
    <div className={styles.notice} role="status">{tr(notice)}{undo.length ? <button onClick={() => void run(async () => { await bridge!.mutate({ type: "restore", ids: undo }); setUndo([]); refresh(); }, tr("已撤销删除"))}>{tr("撤销删除")}</button> : null}</div>

    {archiveWarnings.length ? <details className={styles.archiveWarnings} open><summary>{tr("导入报告 ·")} {archiveWarnings.length} {tr("条提示")}</summary><ul>{archiveWarnings.map((warning, index) => <li key={index}>{tr(warning)}</li>)}</ul></details> : null}
    {bridge ? <ClipboardRecoveryPanel guard={guard} onRestore={async draft => {
      const entry = await bridge.getDetail(draft.entryId);
      setPinnedActive(entry); setActiveId(entry.id); setDetail(entry); setSelected([]);
      setRecovered(draft); setPreviewVersion(value => value + 1); setNarrowDetail(true);
      setView(value => ({ ...value, preview: true }));
    }} /> : null}
    {imagePreview && bridge && visible ? <ClipboardImageViewer key={imagePreview.id} item={imagePreview} bridge={bridge} onClose={() => setImagePreview(null)} onCopy={() => execute(false, false, [imagePreview.id])} busy={busy || storageUnavailable} copied={copyNotice?.ids.includes(imagePreview.id) ?? false} error={error} /> : null}
    {draftGuard.open ? <div ref={modal} className={styles.overlay} role="dialog" aria-label={tr("保留未保存的编辑")} aria-modal="true"><div className={styles.dialog}><h3>{tr("还有未保存的编辑")}</h3><p>{tr("备注将保存到原记录，修改的正文将另存为新记录。")}</p>{error ? <p role="alert">{tr(error)}</p> : null}<div><button disabled={draftGuard.saving} onClick={draftGuard.cancel}>{tr("继续编辑")}</button><button disabled={draftGuard.saving} onClick={() => void draftGuard.finish(false)}>{tr("放弃修改并继续")}</button><button className={styles.primary} disabled={draftGuard.saving} onClick={() => void draftGuard.finish(true)}>{draftGuard.saving ? tr("正在保存…") : tr("保存并继续")}</button></div></div></div> : null}
    {settings && status && !draftGuard.open ? <div ref={modal} className={styles.overlay} role="dialog" aria-label={tr("剪贴板设置")} aria-modal="true"><div className={styles.dialog}><h3>{tr("记录与存储")}</h3>{(["captureText", "captureImages", "captureFiles"] as const).map((key, index) => <label key={key}><input type="checkbox" checked={status.settings[key]} disabled={busy} onChange={event => void mutate({ type: "settings", value: { [key]: event.target.checked } })} />{tr("记录")}{[tr("文字与格式"), tr("图片"), tr("文件")][index]}</label>)}<label>{tr("内容容量预算（MiB）")}<input type="number" min={64} max={1048576} defaultValue={status.settings.budgetBytes / 1024 ** 2} onBlur={event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value * 1024 ** 2 !== status.settings.budgetBytes) void mutate({ type: "settings", value: { budgetBytes: value * 1024 ** 2 } }); }} /></label><label>{tr("排除来源应用（每行一个名称或完整程序路径）")}<textarea defaultValue={status.settings.excludedApps.join("\n")} onBlur={event => void mutate({ type: "settings", value: { excludedApps: event.target.value.split("\n").map(value => value.trim()).filter(Boolean) } })} /></label><p>{tr("历史长期保留，空间不足暂停新增。回收站保留 7 天。数据仅存本机。")}</p><p>{tr("内容占用：")}{clipboardByteLabel(status.bytes)} / {clipboardByteLabel(status.settings.budgetBytes)}</p><p>{tr("数据库与索引文件：")}{clipboardByteLabel(status.databaseBytes ?? 0)}</p><p>{tr("旧历史备份：")}{clipboardByteLabel(status.backupBytes)}</p><p>{tr("容量预算按内容计量；数据库、索引与备份额外占用磁盘空间。")}</p>{status.migrationWarnings.map((warning, index) => <p key={index}>{tr(warning)}</p>)}<button onClick={() => setSettings(false)}>{tr("完成")}</button></div></div> : null}
    {confirm && !draftGuard.open ? <div ref={modal} className={styles.overlay} role="dialog" aria-label={tr("确认清理")} aria-modal="true"><div className={styles.dialog}><h3>{confirm.type === "clear-history" ? tr("将未收藏历史移入回收站？") : tr("永久清除所选内容？")}</h3><p>{confirm.type === "clear-history" ? tr("收藏会保留，7 天内可恢复。") : tr("此操作无法撤销。屏幕暂存仍引用的内容会保留。")}</p><div><button disabled={busy} onClick={() => void run(async () => { await bridge!.mutate(confirm); setConfirm(null); setSelected([]); refresh(); }, tr("清理完成"))}>{tr("确认清理")}</button><button onClick={() => setConfirm(null)}>{tr("取消")}</button></div></div></div> : null}
    {merge !== null && !draftGuard.open ? <div ref={modal} className={styles.overlay} role="dialog" aria-label={tr("合并预览")} aria-modal="true"><div className={styles.dialog}><h3>{tr("按选择顺序合并")}</h3><pre>{merge}</pre><div><button onClick={() => void execute(false)}>{tr("复制")}</button><button onClick={() => setMerge(null)}>{tr("关闭")}</button></div></div></div> : null}
  </section>;
}
