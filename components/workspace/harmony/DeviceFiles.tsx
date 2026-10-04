"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AliIcon } from "@/components/AliIcon";
import { copyText } from "@/lib/clipboard";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import { getNextTreeRenderCount, getTreeRenderWindow, TREE_INITIAL_RENDER_COUNT } from "@/lib/tree-progressive";
import { deviceFolderViewKey, readDeviceFolderView, writeDeviceFolderView, type DeviceFolderView } from "@/lib/harmony/device-folder-view";
import { DEVICE_FILE_DRAFT_DISCARDED_EVENT, DEVICE_FILE_DRAFT_EVENT, deviceFileDraftKey, deviceFileDraftStatus, forgetDeviceFileDraft, readDeviceFileDraft, rememberDeviceFileDraft, type DeviceTextPreview } from "@/lib/harmony/device-file-drafts";
import styles from "../HarmonyPanel.module.css";
import type { HarmonyDeviceFile, HarmonyFileScope } from "@/lib/harmony/device-files";
import type { DeviceTextReadEncoding, WritableDeviceNewline } from "@/lib/harmony/device-text";
import { visibleDeviceFiles, type FileSortKey } from "./file-list-view";
import { TransferJobs } from "./TransferJobs";
import { TextDiff } from "./TextDiff";
import { DeviceFileDrafts } from "./DeviceFileDrafts";
import { WorkbenchTreeSeparator } from "./WorkbenchTreeSeparator";

const DEVICE_FILE_PAGE_SIZE = 500;
type FolderViewContext = { key: string; snapshot: DeviceFolderView | null; ready: boolean; scrollPending: boolean };

export function DeviceFiles({ serial, chinese, cwd, canControl, ensureControl, onControlHandoff, onDatabaseOpen, initialSandbox }: { serial: string; chinese: boolean; cwd?: string | null; canControl: boolean; ensureControl: () => Promise<string>; onControlHandoff?: () => void; onDatabaseOpen?: (id: string) => void; initialSandbox?: { id: number; bundleName: string } }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [kind, setKind] = useState<HarmonyFileScope["kind"]>("shared");
  const [sharedRoots, setSharedRoots] = useState(["/data/local/tmp", "/storage"]);
  const [treeEntries, setTreeEntries] = useState<Record<string, HarmonyDeviceFile[]>>({});
  const [treePages, setTreePages] = useState<Record<string, { nextOffset: number; scanned: number; truncated: boolean }>>({});
  const [treeErrors, setTreeErrors] = useState<Record<string, string>>({});
  const [treeRenderCounts, setTreeRenderCounts] = useState<Record<string, number>>({});
  const focusedTreePath = useRef("");
  const focusedTreeElement = useRef<HTMLElement | null>(null);
  const treePaneRef = useRef<HTMLElement>(null);
  const treeViewContext = useRef<FolderViewContext | null>(null);
  const treeRestoreController = useRef<AbortController | null>(null);
  const treeSaveFrame = useRef<number | null>(null);
  const treeRestoreFrame = useRef<number | null>(null);
  const [treeRestoring, setTreeRestoring] = useState(false);
  const [treeViewRevision, setTreeViewRevision] = useState(0);
  const [treeLoadedContext, setTreeLoadedContext] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [extraRoot, setExtraRoot] = useState("");
  const [treeLoading, setTreeLoading] = useState<string | null>(null);
  const [bundleName, setBundleName] = useState("");
  const treeViewKey = deviceFolderViewKey(serial, kind === "shared" ? { kind } : { kind, bundleName });
  const [sandboxApps, setSandboxApps] = useState<Array<{ bundleName: string; label?: string }>>([]);
  const [appListError, setAppListError] = useState("");
  const appListId = useId();
  const treePaneId = `${appListId}-folder-tree`;
  const explorerLayoutRef = useRef<HTMLDivElement>(null);
  const [path, setPath] = useState("/data/local/tmp");
  const [listedPath, setListedPath] = useState("");
  const [files, setFiles] = useState<HarmonyDeviceFile[]>([]);
  const [pinnedPath, setPinnedPath] = useState("");
  const [offset, setOffset] = useState(0);
  const [truncated, setTruncated] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [selected, setSelected] = useState<HarmonyDeviceFile>(), [destinationPath, setDestinationPath] = useState(""), [notice, setNotice] = useState("");
  const [contextMenu, setContextMenu] = useState<{ file: HarmonyDeviceFile; x: number; y: number } | null>(null);
  const [deviceTargetPath, setDeviceTargetPath] = useState("");
  const [matchedDatabaseId, setMatchedDatabaseId] = useState("");
  const [sourcePath, setSourcePath] = useState(""), [remotePath, setRemotePath] = useState(""), [overwrite, setOverwrite] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(""), [newName, setNewName] = useState("");
  const [newMode, setNewMode] = useState("");
  const [preview, setPreview] = useState<DeviceTextPreview>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [draftStatus, setDraftStatus] = useState<"saving" | "saved" | "failed">("saved");
  const [draftVerified, setDraftVerified] = useState(false);
  const [hexPreview, setHexPreview] = useState<{ size: number; shown: number; truncated: boolean; sha256: string; text: string }>();
  const [imageError, setImageError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [imageSize, setImageSize] = useState<{ width: number; height: number }>();
  const [imageZoom, setImageZoom] = useState<number | null>(null);
  const [editedText, setEditedText] = useState("");
  const [readEncoding, setReadEncoding] = useState<DeviceTextReadEncoding>("auto");
  const [diffPreview, setDiffPreview] = useState<{ original: string; edited: string }>();
  const [showOriginal, setShowOriginal] = useState(true);
  const [newlineMode, setNewlineMode] = useState<WritableDeviceNewline>();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{ files: HarmonyDeviceFile[]; scannedDirectories: number; skippedDirectories: number; truncated: boolean }>();
  const [bookmarks, setBookmarks] = useState<string[]>([]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [restoredTarget, setRestoredTarget] = useState<{ kind: HarmonyFileScope["kind"]; bundleName: string; path: string } | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [batchPaths, setBatchPaths] = useState<string[]>([]);
  const [droppedUpload, setDroppedUpload] = useState<{ id: number; paths: string[] }>();
  const [draggingLocalFiles, setDraggingLocalFiles] = useState(false);
  const [showHidden, setShowHidden] = useState(true);
  const [sortKey, setSortKey] = useState<FileSortKey>("name");
  const [descending, setDescending] = useState(false);
  const bookmarkKey = `piora-harmony-bookmarks:${serial}:${kind}:${kind === "sandbox" ? bundleName : ""}`;
  const recentKey = `piora-harmony-recent-paths:${serial}:${kind}:${kind === "sandbox" ? bundleName : ""}`;
  const locationKey = `piora-harmony-file-location:${serial}`;
  const controller = useRef<AbortController | null>(null);
  const jumpController = useRef<AbortController | null>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextReturnFocusRef = useRef<HTMLElement | null>(null);
  const inspectorRef = useRef<HTMLFieldSetElement>(null);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const transferDetailsRef = useRef<HTMLDetailsElement>(null);
  const dropId = useRef(0);
  const detailsRef = useRef<HTMLElement>(null);
  const textActionsRef = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<{ path: string; context: string } | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const downloadPathRef = useRef<HTMLInputElement>(null);
  const treeController = useRef<AbortController | null>(null);
  const persistTreeView = useCallback(() => {
    if (treeSaveFrame.current !== null) return;
    treeSaveFrame.current = requestAnimationFrame(() => {
      treeSaveFrame.current = null;
      const context = treeViewContext.current;
      if (context?.ready && context.snapshot) { try { writeDeviceFolderView(sessionStorage, context.key, context.snapshot); } catch { /* Session storage may be disabled. */ } }
    });
  }, []);
  const stopTreeRestore = useCallback(() => {
    if (!treeRestoreController.current) return;
    treeRestoreController.current.abort(); treeRestoreController.current = null;
    if (treeRestoreFrame.current !== null) { cancelAnimationFrame(treeRestoreFrame.current); treeRestoreFrame.current = null; }
    const context = treeViewContext.current;
    if (context) { context.ready = true; context.scrollPending = false; }
    setTreeRestoring(false); setTreeViewRevision(version => version + 1);
  }, []);
  useEffect(() => {
    let snapshot: DeviceFolderView | null = null;
    try { snapshot = readDeviceFolderView(sessionStorage, treeViewKey, kind === "shared" ? { kind } : { kind, bundleName }); } catch { /* Optional view state. */ }
    const context: FolderViewContext = { key: treeViewKey, snapshot, ready: false, scrollPending: Boolean(snapshot) };
    treeViewContext.current = context;
    if (treePaneRef.current) treePaneRef.current.scrollTop = 0;
    return () => {
      treeRestoreController.current?.abort(); treeRestoreController.current = null;
      if (treeSaveFrame.current !== null) { cancelAnimationFrame(treeSaveFrame.current); treeSaveFrame.current = null; }
      if (treeRestoreFrame.current !== null) { cancelAnimationFrame(treeRestoreFrame.current); treeRestoreFrame.current = null; }
      if (context.ready && context.snapshot) { try { writeDeviceFolderView(sessionStorage, context.key, context.snapshot); } catch { /* Optional view state. */ } }
    };
  }, [treeViewKey, kind, bundleName]);
  useEffect(() => () => { controller.current?.abort(); previewController.current?.abort(); jumpController.current?.abort(); treeController.current?.abort(); }, []);
  useEffect(() => { controller.current?.abort(); previewController.current?.abort(); jumpController.current?.abort(); treeController.current?.abort(); controller.current = null; previewController.current = null; jumpController.current = null; treeController.current = null; setBusy(false); setPreviewLoading(false); setTreeLoading(null); setTreeRestoring(false); setTreeLoadedContext(treeViewKey); setTreeEntries({}); setTreePages({}); setTreeErrors({}); setTreeRenderCounts(treeViewContext.current?.snapshot?.renderCounts ?? {}); focusedTreePath.current = ""; focusedTreeElement.current = null; setExpandedPaths([]); setExtraRoot(treeViewContext.current?.snapshot?.extraRoot ?? ""); setFiles([]); setPinnedPath(""); setBatchPaths([]); setDroppedUpload(undefined); setDraggingLocalFiles(false); setListedPath(""); setOffset(0); setTruncated(false); setSelected(undefined); setContextMenu(null); setPreview(undefined); setDraftVerified(false); setEditedText(""); setDiffPreview(undefined); setSearchResult(undefined); setHexPreview(undefined); setError(""); setNotice(""); }, [serial, kind, bundleName, treeViewKey]);
  useEffect(() => {
    const context = treeViewContext.current;
    if (context?.key !== treeViewKey || !context.ready) return;
    context.snapshot = { expandedPaths, renderCounts: treeRenderCounts, extraRoot,
      scrollTop: context.scrollPending ? context.snapshot?.scrollTop ?? 0 : treePaneRef.current?.scrollTop ?? 0 };
    persistTreeView();
  }, [treeViewKey, expandedPaths, treeRenderCounts, extraRoot, treeViewRevision, persistTreeView]);
  useEffect(() => {
    if (focusedTreeElement.current?.isConnected) return;
    const first = treePaneRef.current?.querySelector<HTMLElement>("[data-device-folder-node]");
    if (first) { first.tabIndex = 0; focusedTreePath.current = first.dataset.folderPath ?? ""; focusedTreeElement.current = first; }
  }, [treeEntries, expandedPaths, showHidden, treeRenderCounts, sharedRoots]);
  useEffect(() => {
    if (!selected) return;
    const scope: HarmonyFileScope = kind === "shared" ? { kind } : { kind, bundleName };
    const key = deviceFileDraftKey(serial, scope, selected.path);
    const update = (event?: Event) => { if (!event || (event as CustomEvent<string>).detail === key) setDraftStatus(deviceFileDraftStatus(key)); };
    const discarded = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key) return;
      setPreview(undefined); setEditedText(""); setNewlineMode(undefined); setDraftVerified(false); setDiffPreview(undefined);
    };
    update(); window.addEventListener(DEVICE_FILE_DRAFT_EVENT, update);
    window.addEventListener(DEVICE_FILE_DRAFT_DISCARDED_EVENT, discarded);
    return () => { window.removeEventListener(DEVICE_FILE_DRAFT_EVENT, update); window.removeEventListener(DEVICE_FILE_DRAFT_DISCARDED_EVENT, discarded); };
  }, [selected, serial, kind, bundleName]);
  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const dismiss = (event: PointerEvent) => { if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null); };
    const dismissOnUserScroll = () => setContextMenu(null);
    const dismissOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setContextMenu(null); contextReturnFocusRef.current?.focus(); } };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("wheel", dismissOnUserScroll, true);
    document.addEventListener("touchmove", dismissOnUserScroll, true);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => { document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("wheel", dismissOnUserScroll, true); document.removeEventListener("touchmove", dismissOnUserScroll, true); document.removeEventListener("keydown", dismissOnEscape, true); };
  }, [contextMenu]);
  useEffect(() => {
    setSharedRoots(["/data/local/tmp", "/storage"]);
    if (!serial) return;
    const current = new AbortController();
    const params = new URLSearchParams({ serial, kind: "shared", path: "/sdcard", stat: "1" });
    void fetch(`/api/harmony/files?${params}`, { cache: "no-store", signal: current.signal })
      .then(async response => response.ok ? response.json() : null)
      .then(data => { if (!current.signal.aborted && data?.file?.kind === "directory") setSharedRoots(["/data/local/tmp", "/sdcard", "/storage"]); })
      .catch(() => undefined);
    return () => current.abort();
  }, [serial]);
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(bookmarkKey) ?? "[]"); setBookmarks(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20) : []); } catch { setBookmarks([]); } }, [bookmarkKey]);
  useEffect(() => { try { const value = JSON.parse(localStorage.getItem(recentKey) ?? "[]"); setRecentPaths(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12) : []); } catch { setRecentPaths([]); } }, [recentKey]);
  useEffect(() => {
    setRestoring(true);
    let saved: { kind: HarmonyFileScope["kind"]; bundleName: string; path: string } = { kind: "shared", bundleName: "", path: "/data/local/tmp" };
    try {
      const value = JSON.parse(sessionStorage.getItem(locationKey) ?? "null");
      if ((value?.kind === "shared" || value?.kind === "sandbox") && typeof value.path === "string" && value.path.length <= 4096
        && (value.kind === "shared" || typeof value.bundleName === "string" && value.bundleName.length > 0 && value.bundleName.length <= 256)) {
        saved = { kind: value.kind, bundleName: value.kind === "sandbox" ? value.bundleName : "", path: value.path };
      }
    } catch { /* Start from the shared temporary directory when session storage is unavailable. */ }
    setKind(saved.kind); setBundleName(saved.bundleName); setPath(saved.path); setRestoredTarget(saved);
  }, [locationKey]);
  useEffect(() => {
    if (!initialSandbox || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(initialSandbox.bundleName)) return;
    const target = { kind: "sandbox" as const, bundleName: initialSandbox.bundleName, path: "data/storage/el2/base" };
    setKind(target.kind); setBundleName(target.bundleName); setPath(target.path); setRestoredTarget(target); setRestoring(true);
  }, [initialSandbox, serial]);
  useEffect(() => {
    if (kind !== "sandbox" || !serial) return;
    const current = new AbortController();
    void fetch(`/api/harmony/apps?serial=${encodeURIComponent(serial)}`, { signal: current.signal, cache: "no-store" })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Application list unavailable"); return data; })
      .then(data => { if (!current.signal.aborted) { setSandboxApps(data.applications ?? []); setAppListError(""); } })
      .catch(failure => { if (!current.signal.aborted) setAppListError(failure instanceof Error ? failure.message : String(failure)); });
    return () => current.abort();
  }, [kind, serial]);
  const saveBookmarks = (next: string[]) => { setBookmarks(next); try { localStorage.setItem(bookmarkKey, JSON.stringify(next)); } catch { /* Private browsing may disable storage. */ } };
  const rememberPath = useCallback((visited: string) => {
    let previous: string[] = [];
    try { const value = JSON.parse(localStorage.getItem(recentKey) ?? "[]"); if (Array.isArray(value)) previous = value.filter((item): item is string => typeof item === "string"); } catch { /* History remains optional. */ }
    const next = [visited, ...previous.filter(item => item !== visited)].slice(0, 12);
    setRecentPaths(next);
    try { localStorage.setItem(recentKey, JSON.stringify(next)); } catch { /* Private browsing may disable storage. */ }
  }, [recentKey]);
  const rememberLocation = useCallback((visited: string) => {
    try { sessionStorage.setItem(locationKey, JSON.stringify({ kind, bundleName: kind === "sandbox" ? bundleName : "", path: visited })); }
    catch { /* The current view remains usable without persistence. */ }
  }, [locationKey, kind, bundleName]);
  const loadPreview = async (file: HarmonyDeviceFile | undefined = selected) => {
    if (!file || busy) return;
    controller.current?.abort();
    previewController.current?.abort();
    const current = new AbortController(); controller.current = current; previewController.current = current; setPreviewLoading(true); setBusy(true); setError("");
    const scope: HarmonyFileScope = kind === "shared" ? { kind } : { kind, bundleName };
    try {
      const draft = await readDeviceFileDraft(serial, scope, file.path).catch(() => { if (!current.signal.aborted) setDraftStatus("failed"); return null; });
      if (current.signal.aborted) return;
      setDraftVerified(false);
      if (draft) { setPreview(draft.original); setEditedText(draft.text); setNewlineMode(draft.newlineMode); setDiffPreview(undefined); }
      const params = new URLSearchParams({ serial, kind, path: file.path, encoding: readEncoding, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files/text?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      if (draft) {
        const unchanged = data.result.hash === draft.original.hash;
        setDraftVerified(unchanged);
        setNotice(unchanged ? copy("已恢复本机未保存草稿，设备原内容未变。", "Local unsaved draft restored; device content is unchanged.")
          : copy("设备文件已变化；保留草稿与原文，停止覆盖。请复制草稿，或明确放弃草稿后重新读取。", "Device file changed; draft and original retained, saving blocked. Copy the draft, or explicitly discard it before rereading."));
      } else { setPreview(data.result); setEditedText(data.result.text); setNewlineMode(undefined); setDiffPreview(undefined); setDraftVerified(true); }
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      if (previewController.current === current) { previewController.current = null; setPreviewLoading(false); }
      if (controller.current === current) setBusy(false);
    }
  };
  const loadHexPreview = async () => {
    if (!selected || selected.kind !== "file" || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: selected.path, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files/hex?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      setHexPreview(data.preview);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const selectedPath = selected?.path;
  const previewReady = Boolean(preview);
  useLayoutEffect(() => {
    const request = pendingReveal.current;
    const details = detailsRef.current;
    if (!request || request.context !== treeViewKey || request.path !== selectedPath
      || details?.dataset.path !== selectedPath || !details.getClientRects().length) return;
    // Reveal a primary control, not the entire tall preview. Preserve the path
    // bar when that control is already visible; async text actions may need a
    // separate, minimal scroll inside the mounted preview.
    ((previewReady ? textActionsRef.current : null)
      ?? inspectorRef.current?.querySelector<HTMLElement>("button, select, input") ?? details)
      .scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    // A path jump may finish before its separate text read. Keep the reveal
    // until that read settles, including validation of a restored local draft.
    if (!busy && !previewLoading) pendingReveal.current = null;
  }, [selectedPath, previewReady, previewLoading, busy, treeViewKey]);
  const revealFile = (file: HarmonyDeviceFile, allowCached = true) => {
    pendingReveal.current = { path: file.path, context: treeViewKey };
    if (allowCached && !previewLoading && selectedPath === file.path && previewReady && detailsRef.current?.getClientRects().length) {
      (textActionsRef.current ?? detailsRef.current).scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      pendingReveal.current = null;
    }
  };
  const chooseFile = (file: HarmonyDeviceFile, force = false, reveal = false) => {
    if (reveal) revealFile(file, !force);
    if (!force && selected?.path === file.path && preview) return;
    controller.current?.abort();
    previewController.current?.abort(); previewController.current = null; setPreviewLoading(false);
    setSelected(file); setMatchedDatabaseId(""); setPreview(undefined); setDraftVerified(false); setHexPreview(undefined); setImageError(""); setMediaError(""); setImageSize(undefined); setImageZoom(null); setDiffPreview(undefined); setNewName(file.name); setNewMode(file.mode?.slice(-3) ?? "");
    if (detailsRef.current) detailsRef.current.scrollTop = 0;
    setDestinationPath(cwd ? `${cwd}${cwd.includes("\\") ? "\\" : "/"}${file.name}` : "");
    setDeviceTargetPath(`${file.path}.copy`);
    if (file.kind === "file" && (file.size ?? 0) <= 2 * 1024 * 1024 && /\.(?:txt|json|xml|csv|md|log|ts|tsx|js|jsx|html|css|java|ets|yaml|yml|sql|ini|properties)$/i.test(file.name)) {
      void loadPreview(file);
    }
  };
  const showContextMenu = (file: HarmonyDeviceFile, x: number, y: number, trigger?: HTMLElement | null) => {
    if (busy) return;
    // Reopening the selected item's menu must preserve its editor draft and
    // preview. A redundant fetch also disables the row during Escape's focus restore.
    if (selected?.path !== file.path) chooseFile(file);
    contextReturnFocusRef.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setContextMenu({ file, x: Math.max(8, Math.min(x, window.innerWidth - 220)), y: Math.max(8, Math.min(y, window.innerHeight - 204)) });
  };
  const revealContextTarget = (target: "inspector" | "download" | "manage") => {
    setContextMenu(null);
    requestAnimationFrame(() => {
      if (target === "manage") { if (advancedRef.current) advancedRef.current.open = true; advancedRef.current?.scrollIntoView({ block: "nearest" }); }
      else { inspectorRef.current?.scrollIntoView({ block: "nearest" }); if (target === "download") downloadPathRef.current?.focus(); }
    });
  };
  useEffect(() => {
    // Discovery also recognizes extensionless SQLite files in the standard
    // application database directories. Resolve every selected sandbox file
    // against the bounded in-memory catalog instead of guessing from its name.
    if (!selected || selected.kind !== "file" || kind !== "sandbox" || !bundleName) return;
    const current = new AbortController();
    void fetch("/api/harmony/databases", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
      body: JSON.stringify({ action: "resolve", serial, bundleName, path: selected.path }) })
      .then(async response => response.ok ? response.json() : null)
      .then(data => { if (!current.signal.aborted) setMatchedDatabaseId(data?.databaseId ?? ""); })
      .catch(() => undefined);
    return () => current.abort();
  }, [selected, serial, kind, bundleName]);
  const open = useCallback(async (nextPath: string, nextOffset = 0, preserveAddress = false) => {
    stopTreeRestore();
    controller.current?.abort();
    treeController.current?.abort(); treeController.current = null; setTreeLoading(null);
    const current = new AbortController(); controller.current = current; setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: nextPath, offset: String(nextOffset), ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(new HarmonyRequestError(data.error, response.status).messageFor(chinese));
      setFiles(data.files); setPinnedPath(""); if (nextOffset === 0) { setTreeEntries(current => ({ ...current, [nextPath]: data.files.filter((file: HarmonyDeviceFile) => file.kind === "directory") })); setTreePages(current => ({ ...current, [nextPath]: { nextOffset: DEVICE_FILE_PAGE_SIZE, scanned: data.files.length, truncated: Boolean(data.truncated) } })); setTreeErrors(current => ({ ...current, [nextPath]: "" })); setExpandedPaths(current => current.includes(nextPath) ? current : [...current, nextPath]); } setBatchPaths([]); setTruncated(Boolean(data.truncated)); if (!preserveAddress) { setPath(nextPath); rememberPath(nextPath); rememberLocation(nextPath); } setListedPath(nextPath); setOffset(nextOffset); setSelected(undefined); setPreview(undefined); setHexPreview(undefined); setNotice("");
      return data.files as HarmonyDeviceFile[];
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  }, [serial, kind, bundleName, chinese, rememberPath, rememberLocation, stopTreeRestore]);
  const revealDirectory = async (directory: string) => {
    const roots = kind === "shared" ? sharedRoots
      : ["data/storage/el2/base", "data/storage/el2/database", "data/storage/el1/base", "data/storage/el1/database"];
    const root = roots.find(candidate => directory === candidate || directory.startsWith(`${candidate}/`));
    if (!root) { setExtraRoot(directory); setExpandedPaths(currentPaths => [...new Set([...currentPaths, directory])]); return; }
    const suffix = directory.slice(root.length).split("/").filter(Boolean);
    const ancestors = [root, ...suffix.map((_, index) => `${root}/${suffix.slice(0, index + 1).join("/")}`)];
    if (ancestors.length > 16) return;
    treeController.current?.abort();
    const current = new AbortController(); treeController.current = current;
    for (const [index, ancestor] of ancestors.slice(0, -1).entries()) {
      const params = new URLSearchParams({ serial, kind, path: ancestor, offset: "0", ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      const children = data.files as HarmonyDeviceFile[];
      const scanned = children.length;
      const next = ancestors[index + 1];
      if (!children.some(child => child.path === next)) {
        const exact = new URLSearchParams({ serial, kind, path: next, stat: "1", ...(kind === "sandbox" ? { bundleName } : {}) });
        const located = await fetch(`/api/harmony/files?${exact}`, { signal: current.signal, cache: "no-store" });
        const item = await located.json();
        if (current.signal.aborted) return;
        if (!located.ok || item.file?.kind !== "directory") throw new Error(copy("父目录无法在目录树中定位。", "Could not reveal a parent folder in the tree."));
        children.push(item.file);
      }
      setTreeEntries(entries => ({ ...entries, [ancestor]: children.filter(file => file.kind === "directory") }));
      setTreePages(pages => ({ ...pages, [ancestor]: { nextOffset: DEVICE_FILE_PAGE_SIZE, scanned, truncated: Boolean(data.truncated) } }));
      setTreeErrors(errors => ({ ...errors, [ancestor]: "" }));
    }
    setExpandedPaths(currentPaths => [...new Set([...currentPaths, ...ancestors])]);
  };
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!addressRef.current?.getClientRects().length) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
        event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select();
      } else if (event.altKey && event.key === "ArrowLeft" && listedPath) {
        const parent = listedPath.slice(0, listedPath.lastIndexOf("/")) || (kind === "shared" ? "/" : ".");
        if (parent !== listedPath) { event.preventDefault(); void open(parent); }
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [kind, listedPath, open]);
  const jump = async (input = path) => {
    jumpController.current?.abort();
    controller.current?.abort();
    treeController.current?.abort();
    const current = new AbortController(); jumpController.current = current;
    const entered = input.trim().replace(/\/$/, "") || (kind === "shared" ? "/" : ".");
    const target = kind === "sandbox" && entered.startsWith("/data/storage/") ? entered.slice(1) : entered;
    setBusy(true); setError("");
    try {
      const params = new URLSearchParams({ serial, kind, path: target, stat: "1", ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { cache: "no-store", signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      const entry = data.file as HarmonyDeviceFile;
      if (entry.kind !== "directory" && entry.kind !== "file") {
        throw new Error(copy("目标不是可直接打开的普通文件或目录；符号链接请先核对其指向。", "The target is not a regular file or folder. Check a symlink's destination first."));
      }
      if (entry.kind === "directory") {
        if (await open(entry.path)) {
          if (current.signal.aborted) return;
          try { await revealDirectory(entry.path); }
          catch { setNotice(copy("目录已打开，但父目录树未能完整展开。", "Folder opened, but the parent tree could not be fully revealed.")); }
        }
      }
      else {
        const parentPath = target.slice(0, target.lastIndexOf("/")) || (kind === "shared" ? "/" : ".");
        const siblings = await open(parentPath, 0, true);
        if (!siblings || current.signal.aborted) return;
        try { await revealDirectory(parentPath); }
        catch { setNotice(copy("文件已定位，但父目录树未能完整展开。", "File located, but the parent tree could not be fully revealed.")); }
        if (!siblings.some(file => file.path === entry.path)) {
          setFiles(current => [entry, ...current]);
          setPinnedPath(entry.path);
          setNotice(copy("目标位于目录的其他分页，已置顶显示。", "This file is on another directory page and is pinned above this page."));
        }
        if (current.signal.aborted) return;
        setPath(entry.path); chooseFile(entry, true, true); setError(""); rememberPath(entry.path); rememberLocation(entry.path);
      }
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (jumpController.current === current) setBusy(false); }
  };
  const openSelectedDatabase = async () => {
    if (!selected || kind !== "sandbox" || !bundleName) return;
    try {
      const response = await fetch("/api/harmony/databases", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", serial, bundleName, path: selected.path }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (!data.databaseId) throw new Error(copy("该文件未在数据库扫描中发现，请先打开数据库页重新扫描。", "This file was not discovered as a database. Rescan in the database view."));
      onDatabaseOpen?.(data.databaseId);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  };
  useEffect(() => {
    if (!restoredTarget || !serial || kind !== restoredTarget.kind || bundleName !== restoredTarget.bundleName) return;
    setRestoredTarget(null);
    void jump(restoredTarget.path).finally(() => setRestoring(false));
    // A restored location is consumed once. Later input edits must not reopen it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredTarget, serial, kind, bundleName]);
  useEffect(() => {
    const context = treeViewContext.current;
    if (restoring || !serial || treeLoadedContext !== treeViewKey || context?.key !== treeViewKey || context.ready
      || kind === "sandbox" && !bundleName) return;
    const snapshot = context.snapshot;
    if (!snapshot) { context.ready = true; setTreeViewRevision(version => version + 1); return; }
    const current = new AbortController(); treeRestoreController.current = current;
    setTreeRestoring(true); setExpandedPaths(snapshot.expandedPaths);
    // Revalidate only previously expanded folders, never reload cached device
    // rows from browser storage or recursively scan a device. Three read lanes
    // keep restoration bounded; any manual tree navigation cancels this run.
    const pending = snapshot.expandedPaths.filter(directory => !treeEntries[directory]);
    let cursor = 0;
    const restore = async () => {
      while (!current.signal.aborted && cursor < pending.length) {
        const directory = pending[cursor++];
        try {
          const params = new URLSearchParams({ serial, kind, path: directory, offset: "0", ...(kind === "sandbox" ? { bundleName } : {}) });
          const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
          const data = await response.json();
          if (current.signal.aborted || treeViewContext.current !== context) return;
          if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
          setTreeEntries(entries => ({ ...entries, [directory]: (data.files as HarmonyDeviceFile[]).filter(file => file.kind === "directory") }));
          setTreePages(pages => ({ ...pages, [directory]: { nextOffset: DEVICE_FILE_PAGE_SIZE, scanned: data.files.length, truncated: Boolean(data.truncated) } }));
          setTreeErrors(errors => ({ ...errors, [directory]: "" }));
        } catch (failure) {
          if (!current.signal.aborted && treeViewContext.current === context) setTreeErrors(errors => ({ ...errors,
            [directory]: failure instanceof HarmonyRequestError ? failure.messageFor(chinese) : failure instanceof Error ? failure.message : String(failure) }));
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, pending.length) }, restore)).then(() => {
      if (current.signal.aborted || treeViewContext.current !== context) return;
      context.ready = true; setTreeRestoring(false); setTreeViewRevision(version => version + 1);
      treeRestoreFrame.current = requestAnimationFrame(() => {
        treeRestoreFrame.current = requestAnimationFrame(() => {
          treeRestoreFrame.current = null;
          if (current.signal.aborted || treeViewContext.current !== context) return;
          const pane = treePaneRef.current;
          if (pane) pane.scrollTop = snapshot.scrollTop;
          context.scrollPending = false;
          if (context.snapshot) context.snapshot.scrollTop = pane?.scrollTop ?? 0;
          treeRestoreController.current = null; persistTreeView();
        });
      });
    });
    return () => { current.abort(); };
    // Consume the saved view once after the current location has been read.
    // Updating a directory page must not restart restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeViewKey, treeLoadedContext, restoring]);
  const loadTreePage = async (directory: string, append = false) => {
    stopTreeRestore();
    const page = treePages[directory];
    const nextOffset = append ? page?.nextOffset ?? 0 : 0;
    if (append && (!page?.truncated || nextOffset > 50_000)) return false;
    treeController.current?.abort();
    const current = new AbortController(); treeController.current = current;
    setTreeLoading(directory); setTreeErrors(errors => ({ ...errors, [directory]: "" }));
    try {
      const params = new URLSearchParams({ serial, kind, path: directory, offset: String(nextOffset), ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (current.signal.aborted) return false;
      if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
      const directories = (data.files as HarmonyDeviceFile[]).filter(file => file.kind === "directory");
      setTreeEntries(entries => ({ ...entries, [directory]: append
        ? [...new Map([...(entries[directory] ?? []), ...directories].map(file => [file.path, file])).values()]
        : directories }));
      setTreePages(pages => ({ ...pages, [directory]: { nextOffset: nextOffset + DEVICE_FILE_PAGE_SIZE,
        scanned: (append ? pages[directory]?.scanned ?? 0 : 0) + data.files.length, truncated: Boolean(data.truncated) } }));
      return true;
    } catch (failure) {
      if (!current.signal.aborted) setTreeErrors(errors => ({ ...errors, [directory]: failure instanceof HarmonyRequestError ? failure.messageFor(chinese) : failure instanceof Error ? failure.message : String(failure) }));
      return false;
    } finally { if (treeController.current === current) setTreeLoading(null); }
  };
  const toggleTree = async (directory: string) => {
    stopTreeRestore();
    if (expandedPaths.includes(directory)) {
      setExpandedPaths(current => current.filter(item => item !== directory));
      return;
    }
    if (treeEntries[directory] || await loadTreePage(directory)) setExpandedPaths(current => current.includes(directory) ? current : [...current, directory]);
  };
  const handleTreeKey = (event: React.KeyboardEvent<HTMLDivElement>, directory: string, depth: number, expanded: boolean) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target !== event.currentTarget && event.target instanceof HTMLElement && event.target.closest("button")) {
      // Native button activation must not also open its parent folder. Footer
      // buttons are separate controls, while row buttons still support arrows.
      if (event.key === "Enter" || event.key === " " || !event.target.closest("[data-device-folder-row]")) {
        if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
        return;
      }
    }
    const tree = event.currentTarget.closest<HTMLElement>('[role="tree"]');
    const items = Array.from(tree?.querySelectorAll<HTMLElement>("[data-device-folder-node]") ?? []);
    const index = items.indexOf(event.currentTarget);
    const focus = (item?: HTMLElement) => { if (item) { event.preventDefault(); event.stopPropagation(); item.focus({ preventScroll: true }); } };
    if (event.key === "ArrowDown") focus(items[Math.min(items.length - 1, index + 1)]);
    else if (event.key === "ArrowUp") focus(items[Math.max(0, index - 1)]);
    else if (event.key === "Home") focus(items[0]);
    else if (event.key === "End") focus(items.at(-1));
    else if (event.key === "ArrowRight") {
      event.preventDefault(); event.stopPropagation();
      if (!expanded) void toggleTree(directory);
      else if (items[index + 1]?.getAttribute("aria-level") === String(depth + 2)) focus(items[index + 1]);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault(); event.stopPropagation();
      if (expanded) setExpandedPaths(paths => paths.filter(path => path !== directory));
      else focus(items.slice(0, index).reverse().find(item => item.getAttribute("aria-level") === String(depth)));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Enter") void open(directory); else void toggleTree(directory);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopPropagation();
      const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
      focus(ordered.find(item => item.dataset.treeLabel?.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())));
    }
  };
  const renderTree = (directory: string, label: string, depth: number): React.ReactNode => {
    const expanded = expandedPaths.includes(directory);
    const children = (treeEntries[directory] ?? []).filter(file => file.kind === "directory" && (showHidden || !file.name.startsWith(".")));
    const renderWindow = getTreeRenderWindow(children.length, treeRenderCounts[directory] ?? TREE_INITIAL_RENDER_COUNT);
    const page = treePages[directory];
    return <div key={directory} role="treeitem" aria-label={label} aria-level={depth + 1} aria-expanded={expanded} aria-selected={listedPath === directory}
      data-device-folder-node data-folder-path={directory} data-tree-label={label} tabIndex={focusedTreePath.current === directory || !focusedTreePath.current && depth === 0 && directory === (kind === "shared" ? sharedRoots[0] : "data/storage/el2/base") ? 0 : -1}
      onFocus={event => {
        event.stopPropagation(); focusedTreePath.current = directory;
        if (focusedTreeElement.current && focusedTreeElement.current !== event.currentTarget) focusedTreeElement.current.tabIndex = -1;
        event.currentTarget.tabIndex = 0; focusedTreeElement.current = event.currentTarget;
        if (event.target !== event.currentTarget && event.target instanceof HTMLElement && !event.target.closest("[data-device-folder-row]")) return;
        const pane = event.currentTarget.closest<HTMLElement>("[data-device-folder-tree]"), row = event.currentTarget.querySelector<HTMLElement>("[data-device-folder-row]");
        if (pane && row) { const bounds = pane.getBoundingClientRect(), target = row.getBoundingClientRect();
          if (target.top < bounds.top) pane.scrollTop -= bounds.top - target.top;
          else if (target.bottom > bounds.bottom) pane.scrollTop += target.bottom - bounds.bottom;
        }
      }} onKeyDown={event => handleTreeKey(event, directory, depth, expanded)} className={styles.fileTreeItem}>
      <div className={styles.fileTreeRow} data-device-folder-row data-selected={listedPath === directory} style={{ paddingLeft: 7 + depth * 14 }}>
        <button type="button" tabIndex={-1} className={styles.fileTreeToggle} aria-label={copy(`展开或折叠 ${label}`, `Expand or collapse ${label}`)} disabled={treeLoading === directory} onClick={() => void toggleTree(directory)}>{treeLoading === directory ? "…" : expanded ? "⌄" : "›"}</button>
        <AliIcon name={expanded ? "folder-open" : "folder"} size={14} />
        <button type="button" tabIndex={-1} className={styles.fileTreeLabel} title={directory} onClick={() => void open(directory)}>{label}</button>
      </div>
      {expanded ? <div role="group">{children.slice(0, renderWindow.endIndex).map(file => renderTree(file.path, file.name, depth + 1))}
        {!treeEntries[directory] && !treeRestoring && !treeErrors[directory] ? <button type="button" className={styles.fileTreeMore} disabled={treeLoading === directory} onClick={() => void loadTreePage(directory)}>{copy(`读取 ${label} 目录`, `Read ${label} folders`)}</button> : null}
        {renderWindow.remaining ? <button type="button" className={styles.fileTreeMore} onClick={() => setTreeRenderCounts(counts => ({ ...counts, [directory]: getNextTreeRenderCount(counts[directory] ?? TREE_INITIAL_RENDER_COUNT, children.length) }))}>{copy(`显示更多目录（还有 ${renderWindow.remaining} 个）`, `Show more folders (${renderWindow.remaining} remaining)`)}</button> : null}
        {page?.truncated ? <div className={styles.fileTreeHint}><small>{copy(`已检查 ${page.scanned} 项，后面可能还有目录。`, `${page.scanned} entries checked; more folders may follow.`)}</small>
          {page.nextOffset <= 50_000 ? <button type="button" className={styles.fileTreeMore} disabled={treeLoading === directory} onClick={() => void loadTreePage(directory, true)}>{treeLoading === directory ? copy("读取目录中…", "Loading folders…") : copy("继续读取下一页目录", "Read next folder page")}</button>
            : <small>{copy("已达目录读取上限；可输入已知路径直达。", "Folder listing limit reached; enter a known path to jump directly.")}</small>}
        </div> : null}
      </div> : null}
      {treeErrors[directory] ? <div className={styles.fileTreeHint} role="alert"><small>{treeErrors[directory]}</small><button type="button" disabled={treeLoading === directory} onClick={() => void loadTreePage(directory, Boolean(page?.truncated)).then(loaded => { if (loaded) setExpandedPaths(paths => paths.includes(directory) ? paths : [...paths, directory]); })}>{copy(`重试 ${label}`, `Retry ${label}`)}</button></div> : null}
    </div>;
  };
  const download = async () => {
    if (!selected || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/harmony/files", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action: "download", serial, kind, ...(kind === "sandbox" ? { bundleName } : {}), path: selected.path, destinationPath }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      setNotice(copy(`已保存 ${data.result.size} 字节到 ${data.result.destinationPath}`, `Saved ${data.result.size} bytes to ${data.result.destinationPath}`));
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const search = async () => {
    if (busy || !searchQuery.trim()) return;
    controller.current?.abort();
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setSearchResult(undefined);
    try {
      const params = new URLSearchParams({ serial, kind, path: listedPath || path, query: searchQuery, ...(kind === "sandbox" ? { bundleName } : {}) });
      const response = await fetch(`/api/harmony/files/search?${params}`, { signal: current.signal, cache: "no-store" });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      setSearchResult(data.result);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const saveText = async () => {
    if (!selected || !preview || busy || !draftVerified) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const leaseToken = await ensureControl();
      if (current.signal.aborted) return;
      const response = await fetch("/api/harmony/files/text", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ serial, leaseToken, kind, ...(kind === "sandbox" ? { bundleName } : {}), path: selected.path,
          text: editedText, expectedHash: preview.hash, encoding: preview.encoding, ...(newlineMode ? { newlineMode } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      const scope: HarmonyFileScope = kind === "shared" ? { kind } : { kind, bundleName };
      const cleared = await forgetDeviceFileDraft(serial, scope, selected.path, { serial, scope, path: selected.path, original: preview, text: editedText, newlineMode }).then(() => true).catch(() => false);
      if (current.signal.aborted) return;
      setPreview(undefined); setDiffPreview(undefined);
      setNotice(cleared ? copy("设备已核对新文本哈希；重新打开可查看最新内容。", "The device verified the new text hash; reopen to inspect the saved content.")
        : copy("设备新文本已核对，本机仍有草稿未清理；再次打开将核对设备版本，不会自动覆盖。", "Device text verified; a local draft is still retained. Reopening checks device content and never overwrites automatically."));
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const editDraft = (text: string, newline: WritableDeviceNewline | undefined) => {
    if (!selected || !preview) return;
    setEditedText(text); setNewlineMode(newline); setDiffPreview(undefined);
    void rememberDeviceFileDraft({ serial, scope: kind === "shared" ? { kind } : { kind, bundleName }, path: selected.path,
      original: preview, text, newlineMode: newline }).catch(() => undefined);
  };
  const discardDraft = async () => {
    if (!selected || !preview || busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true);
    try {
      const scope: HarmonyFileScope = kind === "shared" ? { kind } : { kind, bundleName };
      await forgetDeviceFileDraft(serial, scope, selected.path, { serial, scope, path: selected.path, original: preview, text: editedText, newlineMode });
      if (current.signal.aborted || controller.current !== current) return;
      setPreview(undefined); setDraftVerified(false); setEditedText(""); setDiffPreview(undefined); setNotice("");
      await loadPreview();
    } catch (failure) { if (!current.signal.aborted) {
      if (failure instanceof Error && failure.message === "Draft changed during discard") setError(copy("本机草稿已有新编辑，未放弃；请重新打开核对。", "Local draft has newer edits and was not discarded. Reopen to check it."));
      else setDraftStatus("failed");
    } }
    finally { if (controller.current === current) setBusy(false); }
  };
  const upload = async () => {
    if (busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const leaseToken = await ensureControl();
      if (current.signal.aborted) return;
      const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action: "upload_file", serial, leaseToken, kind,
          ...(kind === "sandbox" ? { bundleName } : {}), sourcePath, path: remotePath, overwrite }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      setNotice(copy("上传命令已完成；请刷新目录并核对设备文件。", "Upload command completed; refresh the directory to inspect the device file."));
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const mutate = async (action: "create_directory" | "delete_path" | "rename_path" | "copy_path" | "move_path" | "chmod_path", fields: Record<string, unknown>) => {
    if (busy) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setNotice("");
    try {
      const leaseToken = await ensureControl();
      if (current.signal.aborted) return;
      const response = await fetch("/api/harmony/action", { method: "POST", headers: { "Content-Type": "application/json" }, signal: current.signal,
        body: JSON.stringify({ action, serial, leaseToken, kind, ...(kind === "sandbox" ? { bundleName } : {}), ...fields }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? data.error);
      if (current.signal.aborted) return;
      if ((action === "copy_path" || action === "move_path") && data.result?.receipt?.verification !== "passed") {
        throw new Error(copy("设备未确认文件内容和目标路径；请核对源和目标。", "The device did not verify the file content and destination. Inspect both paths."));
      }
      if (listedPath) {
        try {
          const params = new URLSearchParams({ serial, kind, path: listedPath, offset: String(offset), ...(kind === "sandbox" ? { bundleName } : {}) });
          const listing = await fetch(`/api/harmony/files?${params}`, { signal: current.signal, cache: "no-store" });
          const refreshed = await listing.json();
          if (current.signal.aborted) return;
          if (!listing.ok) throw new Error(refreshed.error?.message ?? refreshed.error);
          setFiles(refreshed.files); setPinnedPath(""); setTruncated(Boolean(refreshed.truncated));
          if (offset === 0) setTreeEntries(entries => ({ ...entries, [listedPath]: refreshed.files }));
        } catch {
          if (!current.signal.aborted) setError(copy("设备操作已完成，但目录刷新失败；请点击刷新目录。", "The device operation completed, but the folder could not refresh. Refresh it manually."));
        }
      }
      if (current.signal.aborted) return;
      setNotice(action === "copy_path" ? copy(`已校验并复制到 ${fields.newPath}`, `Verified copy at ${fields.newPath}`)
        : action === "move_path" ? copy(`已校验并移动到 ${fields.newPath}`, `Verified move to ${fields.newPath}`)
          : copy("设备路径复查完成；请刷新目录查看结果。", "Device path rechecked; refresh the directory to view the result."));
      if (action === "move_path" && typeof fields.newPath === "string") {
        setPath(fields.newPath); rememberPath(fields.newPath); rememberLocation(fields.newPath);
      } else if (action === "rename_path" && typeof fields.newPath === "string" && path === fields.path) {
        setPath(fields.newPath); rememberPath(fields.newPath); rememberLocation(fields.newPath);
      } else if (action === "delete_path" && path === fields.path) {
        setPath(listedPath); rememberLocation(listedPath);
      }
      if (action === "delete_path" || action === "rename_path" || action === "move_path") setSelected(undefined);
    } catch (failure) { if (!current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (controller.current === current) setBusy(false); }
  };
  const parent = listedPath === "/" || listedPath === "." ? null : listedPath.slice(0, listedPath.lastIndexOf("/")) || (kind === "shared" ? "/" : ".");
  const visibleFiles = visibleDeviceFiles(files, showHidden, sortKey, descending);
  const handleLocalDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); setDraggingLocalFiles(false); setError("");
    const dropped = Array.from(event.dataTransfer.files);
    if (!listedPath || dropped.length < 1 || dropped.length > 20) {
      setError(copy("请选择设备目录，每次拖入 1–20 个本地文件。", "Choose a device folder and drop 1–20 local files.")); return;
    }
    const paths = dropped.map(file => { try { return window.piDesktop?.files?.getPathForFile(file) ?? ""; } catch { return ""; } });
    if (paths.some(value => !value)) {
      setError(copy("无法取得本地文件路径；请在桌面端使用路径输入上传。", "Cannot read local file paths; enter their paths in the desktop upload form.")); return;
    }
    setDroppedUpload({ id: ++dropId.current, paths });
    transferDetailsRef.current!.open = true;
    setNotice(copy(`已选择 ${paths.length} 个本地文件；请核对设备目标目录后点击“上传这一批”。`, `${paths.length} local files selected; review the device destination before uploading.`));
    requestAnimationFrame(() => transferDetailsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const isImageFile = selected?.kind === "file" && /\.(?:png|jpe?g|gif|webp)$/i.test(selected.name);
  const selectedImage = isImageFile && (selected.size ?? Number.POSITIVE_INFINITY) <= 5 * 1024 * 1024;
  const imagePreviewUrl = selectedImage ? `/api/harmony/files/preview?${new URLSearchParams({ serial, kind, path: selected.path, ...(kind === "sandbox" ? { bundleName } : {}) })}` : "";
  const mediaType = selected?.kind === "file" ? /\.(?:wav|ogg|mp3|m4a)$/i.test(selected.name) ? "audio" : /\.(?:mp4|m4v|webm)$/i.test(selected.name) ? "video" : null : null;
  const selectedMedia = mediaType && (selected?.size ?? Number.POSITIVE_INFINITY) <= 16 * 1024 * 1024 ? mediaType : null;
  const mediaPreviewUrl = selectedMedia && selected ? `/api/harmony/files/media?${new URLSearchParams({ serial, kind, path: selected.path, ...(kind === "sandbox" ? { bundleName } : {}) })}` : "";
  const rootPath = kind === "shared" ? "/" : ".";
  const segments = listedPath.split("/").filter(Boolean);
  const breadcrumbs = segments.map((segment, index) => ({
    label: segment,
    target: kind === "shared" ? `/${segments.slice(0, index + 1).join("/")}` : segments.slice(0, index + 1).join("/"),
  }));
  return <section className={styles.fileManager} aria-label={copy("设备文件", "Device files")}>
    <div className={styles.fileHeader}>
      <div><strong>{copy("设备资源管理器", "Device explorer")}</strong><small>{copy("目录树、路径跳转与文件预览", "Folder tree, path navigation and file preview")}</small></div>
    </div>
    <div className={styles.fileScopeBar}><select aria-label={copy("文件范围", "File scope")} value={kind} onChange={event => { const next = event.target.value as HarmonyFileScope["kind"]; setKind(next); setPath(next === "shared" ? "/data/local/tmp" : "data/storage/el2/base"); setRestoring(next === "shared"); setRestoredTarget(next === "shared" ? { kind: "shared", bundleName, path: "/data/local/tmp" } : null); }}><option value="shared">{copy("共享目录", "Shared storage")}</option><option value="sandbox">{copy("调试应用沙箱", "Debug app sandbox")}</option></select></div>
    <DeviceFileDrafts serial={serial} chinese={chinese} busy={busy} onVerify={draft => {
      controller.current?.abort(); jumpController.current?.abort(); treeController.current?.abort();
      const target = { kind: draft.scope.kind, bundleName: draft.scope.kind === "sandbox" ? draft.scope.bundleName : "", path: draft.path };
      setKind(target.kind); setBundleName(target.bundleName); setPath(target.path); setRestoredTarget(target); setRestoring(true);
    }} />
    {kind === "sandbox" ? <label className={styles.fileScopeInput}>{copy("选择应用（名称或包名）", "Choose app (name or bundle)")}
      <input list={appListId} aria-label={copy("选择应用（名称或包名）", "Choose app (name or bundle)")} value={bundleName} onChange={event => setBundleName(event.target.value)} placeholder={copy("输入名称搜索，或填写包名", "Search apps or enter a bundle name")} />
      <datalist id={appListId}>{sandboxApps.map(app => <option key={app.bundleName} value={app.bundleName}>{app.label || app.bundleName}</option>)}</datalist>
      {appListError ? <small role="alert">{appListError}</small> : <small>{copy(`已列出 ${sandboxApps.length} 个应用；沙箱访问取决于调试签名和运行状态。`, `${sandboxApps.length} apps listed; sandbox access depends on a running debug-signed app.`)}</small>}
    </label> : null}
    <div ref={explorerLayoutRef} className={styles.fileExplorerBody}>
      <aside id={treePaneId} ref={treePaneRef} className={styles.fileTreePane} data-device-folder-tree data-tree-restoring={treeRestoring} aria-label={copy("设备目录树", "Device folder tree")}
        onPointerDownCapture={stopTreeRestore} onKeyDownCapture={stopTreeRestore} onWheel={stopTreeRestore}
        onScroll={event => {
          const context = treeViewContext.current;
          if (context?.key !== treeViewKey || !context.ready || context.scrollPending || !context.snapshot) return;
          context.snapshot.scrollTop = event.currentTarget.scrollTop; persistTreeView();
        }}>
        {treeRestoring ? <p className={styles.fileTreeHint} role="status">{copy("正在重新读取已展开的目录… 点击或键盘导航可停止恢复。", "Rereading expanded folders… Navigate to stop restoring.")}</p> : null}
        <div className={styles.fileTreeHeading}>{copy("目录", "Folders")}</div>
        <div role="tree" aria-label={copy("设备目录树", "Device folder tree")}>
          {[...(kind === "shared" ? sharedRoots : ["data/storage/el2/base", "data/storage/el2/database", "data/storage/el1/base", "data/storage/el1/database"]), ...(extraRoot ? [extraRoot] : [])].map(directory => renderTree(directory, directory.split("/").filter(Boolean).at(-1) || directory, 0))}
        </div>
        {bookmarks.length ? <div className={styles.fileTreeBookmarks}><strong>{copy("收藏", "Bookmarks")}</strong>{bookmarks.map(item => <button type="button" key={item} title={item} onClick={() => void open(item)}>{item}</button>)}</div> : null}
      </aside>
      <WorkbenchTreeSeparator key={serial} layoutRef={explorerLayoutRef} treeId={treePaneId} label={copy("调整文件目录树宽度", "Resize file folder tree")}
        chinese={chinese} storageKey={`piora-harmony-files-tree-width:${serial}`} minimumTreeWidth={160} defaultWidth={200} />
      <div className={styles.fileMain}>
    <div className={styles.fileNavigation}>
      <button type="button" title={copy("上一级", "Parent directory")} aria-label={copy("上一级", "Parent directory")} disabled={busy || !parent} onClick={() => { if (parent) void open(parent); }}><AliIcon name="arrowup" size={15} /></button>
      <nav aria-label={copy("当前位置", "Current location")} className={styles.fileBreadcrumbs}>
        <button type="button" disabled={busy} onClick={() => void open(rootPath)}>{rootPath}</button>
        {breadcrumbs.map((crumb, index) => <span key={crumb.target}>{rootPath === "/" && index === 0 ? "" : "/"}<button type="button" disabled={busy} onClick={() => void open(crumb.target)}>{crumb.label}</button></span>)}
      </nav>
      <button type="button" title={copy("刷新目录", "Refresh directory")} aria-label={copy("刷新目录", "Refresh directory")} disabled={busy || (kind === "sandbox" && !bundleName.trim())} onClick={() => void open(listedPath || path)}><AliIcon name="reload" size={15} /></button>
    </div>
    <div className={styles.fileAddress}>
      <div className={styles.filePathJump}>
        <input ref={addressRef} aria-label={copy("设备文件或文件夹路径", "Device file or folder path")} title={copy("Ctrl+L 编辑路径，Enter 前往文件或文件夹", "Ctrl+L to edit the path, Enter to go to a file or folder")} value={path} disabled={restoring} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !busy && !restoring) void jump(); }} />
        <button type="button" disabled={busy || restoring || (kind === "sandbox" && !bundleName.trim())} onClick={() => void jump()}>{restoring ? copy("恢复中…", "Restoring…") : copy("前往", "Go")}</button>
      </div>
      <div className={styles.fileAddressTools}>
      <select aria-label={copy("最近访问的设备路径", "Recent device paths")} value="" disabled={busy || !recentPaths.length} onChange={event => { if (event.target.value) void jump(event.target.value); }}><option value="">{copy("最近路径", "Recent paths")}</option>{recentPaths.map(item => <option key={item} value={item}>{item}</option>)}</select>
      <button type="button" disabled={!listedPath} onClick={() => void copyText(listedPath).then(() => setNotice(copy("目录路径已复制", "Folder path copied"))).catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy("复制路径", "Copy path")}</button>
      <button type="button" title={copy("收藏当前目录", "Bookmark current directory")} aria-label={copy("收藏当前目录", "Bookmark current directory")} disabled={busy || !listedPath || bookmarks.includes(listedPath) || bookmarks.length >= 20} onClick={() => saveBookmarks([...bookmarks, listedPath])}>☆</button>
      </div>
    </div>
    {bookmarks.length ? <div className={styles.fileBookmarks}>{bookmarks.map(item => <span key={item}><button type="button" disabled={busy} onClick={() => void open(item)}>{item}</button><button type="button" disabled={busy} aria-label={copy(`移除收藏 ${item}`, `Remove bookmark ${item}`)} onClick={() => saveBookmarks(bookmarks.filter(value => value !== item))}>×</button></span>)}</div> : null}
    <div className={styles.fileSearch}>
      <AliIcon name="search" size={14} />
      <input aria-label={copy("递归查找名称", "Search names recursively")} value={searchQuery} maxLength={120} onChange={event => setSearchQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && searchQuery.trim()) void search(); }} placeholder={copy("在当前目录中查找", "Search this directory")} />
      <button type="button" disabled={busy || !searchQuery.trim()} onClick={() => void search()}>{copy("查找", "Search")}</button>
    </div>
    {searchResult ? <div className={styles.fileResults}><p role="status">{copy(`已扫描 ${searchResult.scannedDirectories} 个目录，跳过 ${searchResult.skippedDirectories} 个`, `Scanned ${searchResult.scannedDirectories} directories, skipped ${searchResult.skippedDirectories}`)}{searchResult.truncated ? copy("；结果已截断", "; results truncated") : ""}</p>
      <ul>{searchResult.files.map(file => <li key={file.path}><button type="button" disabled={busy} onClick={() => file.kind === "directory" ? void open(file.path) : chooseFile(file, false, true)}>{file.path}</button></li>)}</ul></div> : null}
    {busy ? <button type="button" onClick={() => { controller.current?.abort(); jumpController.current?.abort(); treeController.current?.abort(); setNotice(copy("已请求取消；已发送的设备写入请在任务与诊断中核对，草稿保留。", "Cancellation requested; inspect already dispatched writes in tasks and diagnostics. Draft retained.")); }}>{copy("取消当前操作", "Cancel operation")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className={styles.fileContentGrid} data-preview={Boolean(preview)}>
      <div className={styles.fileListing}>
    <div className={styles.fileListToolbar}>
      <span>{copy(`${visibleFiles.length} 个项目`, `${visibleFiles.length} items`)}</span>
      <label>{copy("排序", "Sort")}<select value={sortKey} onChange={event => setSortKey(event.target.value as FileSortKey)}>
        <option value="name">{copy("名称", "Name")}</option><option value="kind">{copy("类型", "Type")}</option>
        <option value="size">{copy("大小", "Size")}</option><option value="modifiedAt">{copy("修改时间", "Modified")}</option>
      </select></label>
      <button type="button" aria-label={copy("切换排序方向", "Reverse sort")} title={copy("切换排序方向", "Reverse sort")} onClick={() => setDescending(value => !value)}>{descending ? "↓" : "↑"}</button>
      <label className={styles.fileHiddenToggle}><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />{copy("隐藏文件", "Hidden")}</label>
    </div>
    <small className={styles.fileDropCaption}>{copy("拖入本地文件，核对目标目录后上传", "Drop local files to review and upload")}</small>
    <div className={styles.fileList} role="table" aria-label={copy("当前目录文件", "Current directory files")} data-local-drag={draggingLocalFiles}
      onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) setDraggingLocalFiles(true); }}
      onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingLocalFiles(false); }} onDrop={handleLocalDrop}>
      <div className={styles.fileListHead} role="row"><span role="columnheader">{copy("名称", "Name")}</span><span role="columnheader">{copy("大小", "Size")}</span><span role="columnheader">{copy("修改时间", "Modified")}</span></div>
      {draggingLocalFiles ? <div className={styles.fileDropHint}>{copy("松开后核对目标目录，再确认上传", "Drop to review destination before uploading")}</div> : null}
      {!listedPath ? <div className={styles.fileEmpty}>{copy("输入路径并打开目录", "Enter a path and open a directory")}</div>
        : visibleFiles.length === 0 ? <div className={styles.fileEmpty}>{copy("此目录没有可显示的项目", "No visible items in this directory")}</div>
          : visibleFiles.map(file => <div className={styles.fileListRow} role="row" data-selected={selected?.path === file.path} key={file.path} onContextMenu={event => { event.preventDefault(); showContextMenu(file, event.clientX, event.clientY, event.currentTarget.querySelector<HTMLButtonElement>('button')); }}>
            <div role="cell" className={styles.fileName}>
              {file.kind === "file" ? <input type="checkbox" aria-label={copy(`选择批量下载 ${file.name}`, `Select ${file.name} for batch download`)} checked={batchPaths.includes(file.path)} onChange={event => setBatchPaths(current => event.target.checked ? [...current, file.path] : current.filter(value => value !== file.path))} /> : null}
              <AliIcon name={file.kind === "directory" ? "folder" : "file"} size={16} />
              <button type="button" disabled={busy} title={file.path} onClick={() => file.kind === "directory" ? void open(file.path) : chooseFile(file, false, true)} onKeyDown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); showContextMenu(file, rect.left + 16, rect.bottom, event.currentTarget); } }}>{file.name}{pinnedPath === file.path ? ` · ${copy("路径直达", "Path target")}` : ""}</button>
              {file.kind === "directory" ? <button type="button" className={styles.fileRowAction} disabled={busy} aria-label={copy(`管理目录 ${file.name}`, `Manage folder ${file.name}`)} onClick={() => chooseFile(file)}>⋯</button> : null}
            </div>
            <span role="cell">{file.kind === "directory" ? "—" : file.size === undefined ? "—" : `${file.size.toLocaleString()} B`}</span>
            <span role="cell" title={file.modifiedAt ? new Date(file.modifiedAt).toLocaleString() : undefined}>{file.modifiedAt ? new Date(file.modifiedAt).toLocaleDateString() : "—"}</span>
          </div>)}
    </div>
    {listedPath ? <div className={styles.filePagination}>
      <small>{copy(`目录第 ${offset + 1}–${offset + files.length - (pinnedPath ? 1 : 0)} 项${pinnedPath ? "，另有 1 个路径直达项" : ""}；排序仅作用于本页。`, `Entries ${offset + 1}–${offset + files.length - (pinnedPath ? 1 : 0)}${pinnedPath ? ", plus one path target" : ""}; sorting applies to this page.`)}</small>
      <button type="button" disabled={busy || offset === 0} onClick={() => void open(listedPath, Math.max(0, offset - DEVICE_FILE_PAGE_SIZE))}>{copy("上一页", "Previous")}</button>
      <button type="button" disabled={busy || !truncated || offset >= 50_000} onClick={() => void open(listedPath, offset + DEVICE_FILE_PAGE_SIZE)}>{copy("下一页", "Next")}</button>
    </div> : null}
      </div>
      <aside ref={detailsRef} className={styles.fileDetails} data-path={selected?.path} aria-label={copy("选中项详情", "Selected item details")}>
    {!selected ? <div className={styles.fileDetailsEmpty}>{copy("选择文件或文件夹，查看预览与操作。", "Select a file or folder to see its preview and actions.")}</div> : null}
    {selected?.kind === "file" ? <fieldset ref={inspectorRef} className={styles.fileInspector}><legend>{copy("文件预览与下载", "File preview and download")}: {selected.name}</legend>
      {matchedDatabaseId ? <button type="button" onClick={() => void openSelectedDatabase()}>{copy("在数据库工作台打开", "Open in database workbench")}</button> : null}
      {selectedImage ? <div className={styles.fileImagePreview}>
        <div className={styles.fileImageControls}>
          <button type="button" disabled={!imageSize || (imageZoom ?? 100) <= 25} onClick={() => setImageZoom(Math.max(25, (imageZoom ?? 100) - 25))}>{copy("缩小", "Zoom out")}</button>
          <button type="button" disabled={!imageSize || (imageZoom ?? 100) >= 400} onClick={() => setImageZoom(Math.min(400, (imageZoom ?? 100) + 25))}>{copy("放大", "Zoom in")}</button>
          <button type="button" disabled={imageZoom === null} onClick={() => setImageZoom(null)}>{copy("适合窗口", "Fit")}</button>
          <small>{imageSize ? `${imageSize.width} × ${imageSize.height} · ${imageZoom === null ? copy("适合窗口", "Fit") : `${imageZoom}%`}` : copy("加载中…", "Loading…")}</small>
        </div>
        <div className={styles.fileImageCanvas}>
        {/* eslint-disable-next-line @next/next/no-img-element -- The authenticated device route cannot be fetched through the Next image optimizer. */}
        <img key={imagePreviewUrl} src={imagePreviewUrl} alt={copy(`${selected.name} 的设备图片预览`, `Device image preview of ${selected.name}`)}
          style={imageZoom !== null && imageSize ? { width: imageSize.width * imageZoom / 100, maxWidth: "none", maxHeight: "none" } : undefined}
          onLoad={event => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setImageError(copy("图片无法预览：文件可能已变化或格式无效。", "Image preview unavailable: the file may have changed or its format is invalid."))} />
        </div>
        {imageError ? <small role="alert">{imageError}</small> : <small>{copy("只读预览，最多 5 MiB", "Read-only preview, up to 5 MiB")}</small>}
      </div> : null}
      {isImageFile && !selectedImage ? <small>{copy("图片超过 5 MiB 或大小未知；请下载到本机查看。", "Image exceeds 5 MiB or has unknown size; download it to view locally.")}</small> : null}
      {selectedMedia ? <div className={styles.fileMediaPreview}>
        {selectedMedia === "audio" ? <audio key={mediaPreviewUrl} controls preload="metadata" src={mediaPreviewUrl} onError={() => setMediaError(copy("音频无法播放：文件可能已变化、格式无效或当前桌面端不支持其编码。", "Audio unavailable: the file may have changed, be invalid or use an unsupported codec."))} />
          : <video key={mediaPreviewUrl} controls preload="metadata" src={mediaPreviewUrl} onError={() => setMediaError(copy("视频无法播放：文件可能已变化、格式无效或当前桌面端不支持其编码。", "Video unavailable: the file may have changed, be invalid or use an unsupported codec."))} />}
        {mediaError ? <small role="alert">{mediaError}</small> : <small>{copy("只读播放，最多 16 MiB；播放能力取决于桌面端支持的编码。", "Read-only playback, up to 16 MiB; codec support depends on the desktop runtime.")}</small>}
      </div> : null}
      {mediaType && !selectedMedia ? <small>{copy("音视频超过 16 MiB 或大小未知；请下载到本机播放。", "Media exceeds 16 MiB or has unknown size; download it to play locally.")}</small> : null}
      {!isImageFile && !mediaType ? <><label>{copy("文本编码", "Text encoding")}<select value={readEncoding} onChange={event => setReadEncoding(event.target.value as DeviceTextReadEncoding)}>
        <option value="auto">{copy("自动识别 BOM / UTF-8", "Auto-detect BOM / UTF-8")}</option><option value="utf-8">UTF-8</option>
        <option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option><option value="gb18030">GB18030</option>
      </select></label>
      <button disabled={busy} onClick={() => void loadPreview()}>{copy("预览文本（最多 2 MiB）", "Preview text (up to 2 MiB)")}</button>
      {preview ? <section className={styles.fileTextEditor} aria-label={copy("文件文本工作区", "File text workspace")}>
        <small>{preview.size} B · {preview.encoding ?? "utf-8"} · {preview.newline ?? "lf"}</small>
        <div ref={textActionsRef} className={styles.fileTextActions} role="group" aria-label={copy("文件编辑操作", "File editing actions")}>
          <button type="button" disabled={busy || !canControl || !draftVerified || (preview.newline === "mixed" && !newlineMode) || (editedText === preview.text && !newlineMode)} onClick={() => void saveText()}>{copy("核对原内容并保存", "Verify original and save")}</button>
          <button type="button" disabled={busy || editedText === preview.text} onClick={() => setDiffPreview({ original: preview.text, edited: editedText })}>{copy("预览差异", "Preview diff")}</button>
          <button type="button" onClick={() => void copyText(editedText).then(() => setNotice(copy("草稿已复制", "Draft copied"))).catch(failure => setError(String(failure)))}>{copy("复制草稿", "Copy draft")}</button>
          <button type="button" aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)}>{copy("原文对照", "Compare original")}</button>
          {editedText !== preview.text || newlineMode ? <button type="button" disabled={busy} onClick={() => void discardDraft()}>{copy("放弃草稿并重新读取", "Discard draft and reread")}</button> : null}
        </div>
        {editedText !== preview.text || newlineMode ? <small role="status">{draftStatus === "saving" ? copy("本机草稿保存中…", "Saving local draft…") : draftStatus === "failed" ? copy("本机持久保存失败，草稿仍在当前窗口；关闭前请复制。", "Local persistence failed; draft remains in this window. Copy before closing.") : copy("未保存到手机 · 本机草稿已保留", "Not saved to phone · local draft retained")}</small> : null}
        {!draftVerified ? <small>{copy("当前设备原内容尚未核对一致，保存不可用；可重试只读预览。", "Current device content is not verified unchanged; saving unavailable. Retry the read-only preview.")}</small> : null}
        {preview.newline === "mixed" ? <label>{copy("原文件混用换行符；保存时统一为", "Mixed line endings; normalize on save to")}
          <select disabled={busy} value={newlineMode ?? ""} onChange={event => editDraft(editedText, event.target.value ? event.target.value as WritableDeviceNewline : undefined)}>
            <option value="">{copy("选择换行符", "Choose line endings")}</option><option value="lf">LF</option><option value="crlf">CRLF</option><option value="cr">CR</option>
          </select></label> : null}
        <div className={styles.fileTextColumns} data-compare={showOriginal}>
          {showOriginal ? <label><span>{copy("采集时原文（只读）", "Captured original (read-only)")}</span>
            <textarea aria-label={copy("设备文件采集时原文", "Captured device file original")} readOnly value={preview.text} rows={10} />
          </label> : null}
          <label><span>{copy("修改草稿（尚未保存到手机）", "Editable draft (not saved to phone)")}</span>
            <textarea aria-label={copy("设备文件编辑草稿", "Device file draft")} disabled={busy} maxLength={2 * 1024 * 1024} value={editedText} onChange={event => editDraft(event.target.value, newlineMode)} rows={12} />
          </label>
        </div>
        {diffPreview ? <TextDiff original={diffPreview.original} edited={diffPreview.edited} chinese={chinese} /> : null}
        <details className={styles.fileTextMetadata}><summary>{copy("采集时的 SHA-256", "Captured SHA-256")}</summary><code>{preview.hash}</code><small>{copy("此原文与哈希属于采集副本，保存前还会核对当前设备。", "This original and hash belong to the captured copy; saving checks the current device again.")}</small></details>
      </section> : null}</> : null}
      {(selected.size ?? Number.POSITIVE_INFINITY) <= 64 * 1024 ? <>
        <button type="button" disabled={busy} onClick={() => void loadHexPreview()}>{copy("查看十六进制", "View hex")}</button>
        {hexPreview ? <div className={styles.fileHexPreview}><small>{copy(`只读显示前 ${hexPreview.shown} / ${hexPreview.size} 字节`, `Read-only: first ${hexPreview.shown} of ${hexPreview.size} bytes`)} · SHA-256 {hexPreview.sha256}</small><pre>{hexPreview.text || copy("空文件", "Empty file")}</pre></div> : null}
      </> : !isImageFile && !mediaType && !preview ? <small>{copy("文件超过 64 KiB；如需检查二进制内容，请先下载。", "File exceeds 64 KiB; download it to inspect binary content.")}</small> : null}
      <p>{copy("保存到已获准工作区中的新文件名；不会覆盖现有文件。", "Save to a new file within an allowed workspace; existing files are never overwritten.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input ref={downloadPathRef} value={destinationPath} onChange={event => setDestinationPath(event.target.value)} /></label>
      <button disabled={busy || !destinationPath.trim()} onClick={() => void download()}>{copy("下载到本机", "Download to computer")}</button>
    </fieldset> : null}
    {selected && (selected.kind === "file" || selected.kind === "directory") ? <details ref={advancedRef} className={styles.fileAdvanced}><summary>{copy("复制、移动、重命名与删除", "Copy, move, rename and delete")}</summary><fieldset><legend>{copy("管理选中路径", "Manage selected path")}: {selected.name}</legend>
      <label>{copy("新名称", "New name")}<input value={newName} onChange={event => setNewName(event.target.value)} /></label>
      <button disabled={busy || !canControl || !newName.trim() || newName === selected.name || newName.includes("/")} onClick={() => void mutate("rename_path", { path: selected.path, newPath: `${selected.path.slice(0, selected.path.lastIndexOf("/"))}/${newName}` })}>{copy("重命名", "Rename")}</button>
      <label>{copy("复制或移动到设备路径（不覆盖）", "Copy or move to device path (no overwrite)")}<input value={deviceTargetPath} onChange={event => setDeviceTargetPath(event.target.value)} /></label>
      <button disabled={busy || !canControl || !deviceTargetPath.trim() || deviceTargetPath.trim() === selected.path} onClick={() => void mutate("copy_path", { path: selected.path, newPath: deviceTargetPath.trim() })}>{selected.kind === "directory" ? copy("复制文件夹", "Copy folder") : copy("复制文件", "Copy file")}</button>
      <button disabled={busy || !canControl || !deviceTargetPath.trim() || deviceTargetPath.trim() === selected.path} onClick={() => void mutate("move_path", { path: selected.path, newPath: deviceTargetPath.trim() })}>{selected.kind === "directory" ? copy("移动文件夹", "Move folder") : copy("移动文件", "Move file")}</button>
      <label>{copy("权限（八进制三位）", "Permissions (three octal digits)")}<input value={newMode} maxLength={3} onChange={event => setNewMode(event.target.value)} placeholder="644" /></label>
      <button disabled={busy || !canControl || !/^[0-7]{3}$/.test(newMode) || newMode === selected.mode} onClick={() => void mutate("chmod_path", { path: selected.path, mode: newMode })}>{copy("修改权限", "Change permissions")}</button>
      <button disabled={busy || !canControl} onClick={() => void mutate("delete_path", { path: selected.path })}>{copy("删除", "Delete")}</button>
    </fieldset></details> : null}
      </aside>
    </div>
    <details className={styles.fileAdvanced}><summary>{copy("新建目录", "New folder")}</summary><fieldset><legend>{copy("新建目录", "New folder")}</legend>
      <label>{copy("设备完整路径", "Full device path")}<input value={directoryPath} onChange={event => setDirectoryPath(event.target.value)} placeholder={`${path.replace(/\/$/, "")}/new-folder`} /></label>
      <button disabled={busy || !canControl || !directoryPath.trim()} onClick={() => void mutate("create_directory", { path: directoryPath.trim() })}>{copy("创建目录", "Create directory")}</button>
    </fieldset></details>
    <details className={styles.fileAdvanced}><summary>{copy("上传文件", "Upload file")}</summary><fieldset><legend>{copy("上传文件", "Upload file")}</legend>
      <p>{copy("只能从已获准工作区上传 1 GiB 内的本地文件；设备目标仅限共享存储或调试应用沙箱。", "Upload a local file of at most 1 GiB from an allowed workspace to shared storage or a debug app sandbox.")}</p>
      <label>{copy("本地完整路径", "Full local path")}<input value={sourcePath} onChange={event => { const value = event.target.value; setSourcePath(value); const name = value.split(/[\\/]/).at(-1); if (name) setRemotePath(`${path.replace(/\/$/, "")}/${name}`); }} /></label>
      <label>{copy("设备目标路径", "Device target path")}<input value={remotePath} onChange={event => setRemotePath(event.target.value)} /></label>
      <label><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.target.checked)} />{copy("覆盖设备上的同名文件", "Overwrite an existing device file")}</label>
      <button disabled={busy || !canControl || !sourcePath.trim() || !remotePath.trim()} onClick={() => void upload()}>{copy("上传到设备", "Upload to device")}</button>
    </fieldset></details>
    <details ref={transferDetailsRef} className={styles.fileAdvanced}><summary>{copy("传输任务与批量下载", "Transfers and batch downloads")}</summary>
    <TransferJobs serial={serial} scope={kind === "shared" ? { kind: "shared" } : { kind: "sandbox", bundleName }} deviceDirectory={listedPath || path} cwd={cwd}
      selectedFiles={files.filter(file => batchPaths.includes(file.path) && file.kind === "file")} chinese={chinese} canControl={canControl}
      ensureControl={ensureControl} onControlHandoff={onControlHandoff} onDownloadsQueued={() => setBatchPaths([])} droppedUpload={droppedUpload} />
    </details>
      </div>
    </div>
    {contextMenu ? <div ref={contextMenuRef} role="menu" aria-label={copy(`${contextMenu.file.name} 的操作`, `Actions for ${contextMenu.file.name}`)} className={styles.fileContextMenu} style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={event => {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
      if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
    }}>
      {contextMenu.file.kind === "file" || contextMenu.file.kind === "directory" ? <button type="button" role="menuitem" onClick={() => { const file = contextMenu.file; setContextMenu(null); if (file.kind === "directory") void open(file.path); else revealContextTarget("inspector"); }}>{contextMenu.file.kind === "directory" ? copy("打开文件夹", "Open folder") : copy("预览文件", "Preview file")}</button> : null}
      <button type="button" role="menuitem" onClick={() => { const file = contextMenu.file; setContextMenu(null); void copyText(file.path).then(() => setNotice(copy("设备路径已复制", "Device path copied"))).catch(failure => setError(failure instanceof Error ? failure.message : String(failure))); }}>{copy("复制设备路径", "Copy device path")}</button>
      {contextMenu.file.kind === "file" ? <button type="button" role="menuitem" onClick={() => revealContextTarget("download")}>{copy("下载到本机…", "Download to computer…")}</button> : null}
      {(contextMenu.file.kind === "file" || contextMenu.file.kind === "directory") ? <button type="button" role="menuitem" onClick={() => revealContextTarget("manage")}>{copy("复制、移动或重命名…", "Copy, move or rename…")}</button> : null}
    </div> : null}
  </section>;
}
