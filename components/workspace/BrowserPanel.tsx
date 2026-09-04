"use client";

/* Browser frames are live, no-store screenshots; Next Image caching is intentionally not applicable. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopBrowserAction,
  DesktopBrowserDownload,
  DesktopBrowserState,
  ImportedChromeBookmarkNode,
  ImportedChromeBookmarkProfile,
} from "@/components/sidebar/sidebar-types";
import { useI18n } from "@/hooks/useI18n";
import { createBrowserViewportSync } from "@/lib/browser-viewport-sync";
import { AliIcon } from "../AliIcon";
import styles from "./WorkspacePanel.module.css";

type BrowserState = {
  ready: true;
  revision: number;
  title: string;
  url: string;
  viewport: { width: number; height: number };
  cursor: string;
  activeTabIndex: number;
  tabs: Array<{ index: number; title: string; url: string }>;
};

type BrowserAction = {
  action: "navigate" | "back" | "forward" | "reload" | "click" | "mouse_move" | "mouse_down" | "mouse_up" | "resize" | "type" | "press" | "scroll" | "new_tab" | "switch_tab" | "close_tab";
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  deltaY?: number;
  tabIndex?: number;
  button?: "left" | "middle" | "right";
  width?: number;
  height?: number;
};

const BROWSER_ONBOARDING_KEY = "piora-desktop-browser-onboarding-v1";
const BROWSER_BOOKMARKS_KEY = "piora-desktop-browser-bookmarks-v2";

type DesktopBrowserBridge = NonNullable<NonNullable<Window["piDesktop"]>["browser"]>;

function normalizeBookmarkNode(value: unknown, depth = 0): ImportedChromeBookmarkNode | null {
  if (!value || typeof value !== "object" || depth > 100) return null;
  const candidate = value as Partial<ImportedChromeBookmarkNode>;
  if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return null;
  if (candidate.type === "bookmark" && typeof candidate.url === "string") {
    return { id: candidate.id, title: candidate.title, type: "bookmark", url: candidate.url };
  }
  if (candidate.type !== "folder" || !Array.isArray(candidate.children)) return null;
  return {
    children: candidate.children.flatMap((child) => {
      const normalized = normalizeBookmarkNode(child, depth + 1);
      return normalized ? [normalized] : [];
    }),
    id: candidate.id,
    title: candidate.title,
    type: "folder",
  };
}

function legacyBookmarkProfiles(values: unknown[]): ImportedChromeBookmarkProfile[] {
  const profiles = new Map<string, ImportedChromeBookmarkProfile>();
  values.forEach((value, bookmarkIndex) => {
    if (!value || typeof value !== "object") return;
    const legacy = value as { folder?: unknown; profile?: unknown; title?: unknown; url?: unknown };
    if (typeof legacy.profile !== "string" || typeof legacy.title !== "string" || typeof legacy.url !== "string") return;
    const profile = profiles.get(legacy.profile) ?? { children: [], id: legacy.profile, title: legacy.profile };
    profiles.set(legacy.profile, profile);
    let children = profile.children;
    const folders = typeof legacy.folder === "string" ? legacy.folder.split(" / ").filter(Boolean) : [];
    folders.forEach((title, folderIndex) => {
      const folderId = `legacy:${legacy.profile}:${folders.slice(0, folderIndex + 1).join("/")}`;
      let folder = children.find((node) => node.type === "folder" && node.id === folderId);
      if (!folder || folder.type !== "folder") {
        folder = { children: [], id: folderId, title, type: "folder" };
        children.push(folder);
      }
      children = folder.children;
    });
    children.push({ id: `legacy:${legacy.profile}:bookmark:${bookmarkIndex}`, title: legacy.title, type: "bookmark", url: legacy.url });
  });
  return [...profiles.values()];
}

function storedBookmarkProfiles(): ImportedChromeBookmarkProfile[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BROWSER_BOOKMARKS_KEY) ?? "null") as unknown;
    if (Array.isArray(parsed)) return legacyBookmarkProfiles(parsed);
    if (!parsed || typeof parsed !== "object") return [];
    const profiles = (parsed as { profiles?: unknown }).profiles;
    if (!Array.isArray(profiles)) return [];
    return profiles.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const profile = value as Partial<ImportedChromeBookmarkProfile>;
      if (typeof profile.id !== "string" || typeof profile.title !== "string" || !Array.isArray(profile.children)) return [];
      return [{
        children: profile.children.flatMap((child) => {
          const normalized = normalizeBookmarkNode(child);
          return normalized ? [normalized] : [];
        }),
        id: profile.id,
        title: profile.title,
      }];
    });
  } catch {
    return [];
  }
}

function storeBookmarkProfiles(profiles: ImportedChromeBookmarkProfile[]): void {
  try {
    window.localStorage.setItem(BROWSER_BOOKMARKS_KEY, JSON.stringify({ profiles, version: 2 }));
  } catch {
    // Very large Chrome collections still remain available for this run and
    // are refreshed from Chrome the next time the browser panel opens.
  }
}

function bookmarkCount(nodes: ImportedChromeBookmarkNode[]): number {
  return nodes.reduce((count, node) => count + (node.type === "bookmark" ? 1 : bookmarkCount(node.children)), 0);
}

function bookmarkBarNodes(profiles: ImportedChromeBookmarkProfile[]): ImportedChromeBookmarkNode[] {
  return profiles.flatMap((profile) => profile.children);
}

export function BrowserPanel({ active, maximized, sessionId }: { active: boolean; maximized: boolean; sessionId: string | null }) {
  const { t } = useI18n();
  const [desktopBridge, setDesktopBridge] = useState<DesktopBrowserBridge | null | undefined>(undefined);

  useEffect(() => {
    setDesktopBridge(window.piDesktop?.browser ?? null);
  }, []);

  if (desktopBridge === undefined) {
    return <div className={styles.browserLoading}>{t("browser.starting")}</div>;
  }
  if (desktopBridge) return <DesktopBrowserPanel active={active} bridge={desktopBridge} maximized={maximized} sessionId={sessionId} />;
  return <ScreenshotBrowserPanel active={active} sessionId={sessionId} />;
}

function DesktopBrowserPanel({ active, bridge, maximized, sessionId }: { active: boolean; bridge: DesktopBrowserBridge; maximized: boolean; sessionId: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [bookmarkProfiles, setBookmarkProfiles] = useState<ImportedChromeBookmarkProfile[]>([]);
  const [openBookmarkFolderId, setOpenBookmarkFolderId] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [download, setDownload] = useState<DesktopBrowserDownload | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const viewportSyncRef = useRef<ReturnType<typeof createBrowserViewportSync> | null>(null);
  const panelActiveRef = useRef(active);
  panelActiveRef.current = active;

  useLayoutEffect(() => {
    const sync = createBrowserViewportSync((bounds, visible) => bridge.setViewport(bounds, visible));
    viewportSyncRef.current = sync;
    return () => {
      // Closing the right panel unmounts us; passive cleanup may already see
      // viewportRef.current === null. Hide without reading the removed DOM.
      sync.dispose();
      if (viewportSyncRef.current === sync) viewportSyncRef.current = null;
    };
  }, [bridge]);

  const applyState = useCallback((next: DesktopBrowserState | null) => {
    if (!next) return;
    setState(next);
    if (document.activeElement !== addressRef.current) {
      setAddress(next.url === "about:blank" ? "" : next.url);
    }
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void bridge.action({ action: "set_session", ...(sessionId ? { sessionId } : {}) }).then((next) => {
      if (!cancelled) applyState(next);
    }).catch((sessionError) => {
      if (!cancelled) setError(sessionError instanceof Error ? sessionError.message : t("browser.unavailable"));
    });
    return () => { cancelled = true; };
  }, [applyState, bridge, sessionId, t]);

  useEffect(() => {
    let cancelled = false;
    setBookmarkProfiles(storedBookmarkProfiles());
    const onboardingComplete = window.localStorage.getItem(BROWSER_ONBOARDING_KEY) === "done";
    setShowOnboarding(!onboardingComplete);
    if (onboardingComplete) {
      void bridge.importChromeBookmarks().then((result) => {
        if (cancelled || !result || result.bookmarkCount === 0) return;
        storeBookmarkProfiles(result.profiles);
        setBookmarkProfiles(result.profiles);
      }).catch(() => {});
    }
    void bridge.getState().then(applyState).catch((stateError) => {
      setError(stateError instanceof Error ? stateError.message : t("browser.unavailable"));
    });
    const unsubscribeState = bridge.onState(applyState);
    const unsubscribeDownload = bridge.onDownload(setDownload);
    return () => {
      cancelled = true;
      unsubscribeState();
      unsubscribeDownload();
    };
  }, [applyState, bridge, t]);

  const syncViewport = useCallback((visible = state?.url !== "about:blank") => {
    const element = viewportRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    viewportSyncRef.current?.sync({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }, panelActiveRef.current && visible && rect.width > 0 && rect.height > 0);
  }, [state?.url]);

  useLayoutEffect(() => {
    // WebContentsView lives above the renderer DOM and is not clipped by the
    // panel's width animation. Queue an explicit hide before paint so a widened
    // browser view cannot remain over the chat after the panel is collapsed.
    syncViewport(active && state?.url !== "about:blank");
  }, [active, state?.url, syncViewport]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame = 0;
    const scheduleSync = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => syncViewport());
    };
    const observer = new ResizeObserver(scheduleSync);
    const panel = element.closest("#file-panel");
    observer.observe(element);
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("scroll", scheduleSync, true);
    panel?.addEventListener("transitionend", scheduleSync);
    scheduleSync();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("scroll", scheduleSync, true);
      panel?.removeEventListener("transitionend", scheduleSync);
      syncViewport(false);
    };
  }, [syncViewport]);

  useEffect(() => {
    syncViewport();
    const frame = window.requestAnimationFrame(() => window.requestAnimationFrame(() => syncViewport()));
    const settle = window.setTimeout(() => syncViewport(), 240);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(settle);
    };
  }, [maximized, syncViewport]);

  const act = useCallback(async (input: DesktopBrowserAction) => {
    try {
      applyState(await bridge.action(input));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t("browser.actionFailed"));
    }
  }, [applyState, bridge, t]);

  const finishOnboarding = () => {
    window.localStorage.setItem(BROWSER_ONBOARDING_KEY, "done");
    setShowOnboarding(false);
  };

  const importChromeBookmarks = async () => {
    setImporting(true);
    setError(null);
    try {
      const result = await bridge.importChromeBookmarks();
      if (!result || result.bookmarkCount === 0) {
        setError(t("browser.importNoChrome"));
        return;
      }
      storeBookmarkProfiles(result.profiles);
      setBookmarkProfiles(result.profiles);
      setOpenBookmarkFolderId(null);
      finishOnboarding();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t("browser.importFailed"));
    } finally {
      setImporting(false);
    }
  };

  const blank = !state || state.url === "about:blank";
  const barNodes = bookmarkBarNodes(bookmarkProfiles);
  const openBookmarkFolder = barNodes.find((node) => node.type === "folder" && node.id === openBookmarkFolderId);
  const downloadLabel = download?.state === "completed"
    ? t("browser.downloadComplete", { filename: download.filename })
    : download?.state === "cancelled"
      ? t("browser.downloadCancelled", { filename: download.filename })
      : download?.state === "interrupted"
        ? t("browser.downloadInterrupted", { filename: download.filename })
        : download
          ? t("browser.downloading", { filename: download.filename, percent: download.percent })
          : null;

  return <div className={styles.browserRoot} data-native-browser="true">
    <div className={styles.browserTabs} role="tablist" aria-label={t("browser.tabs")}>
      {state?.tabs.map((tab) => <button
        key={tab.id}
        type="button"
        role="tab"
        aria-selected={state.activeTabId === tab.id}
        title={tab.url}
        onClick={() => void act({ action: "switch_tab", tabId: tab.id })}
      >
        <AliIcon name="earth" size={13} /><b>{tab.title || t("browser.newTab")}</b>
        <span
          className={styles.browserTabClose}
          role="button"
          aria-label={t("browser.closeTab")}
          onClick={(event) => { event.stopPropagation(); void act({ action: "close_tab", tabId: tab.id }); }}
        ><AliIcon name="close" size={11} /></span>
      </button>)}
      <button className={styles.browserNewTab} type="button" aria-label={t("browser.newTab")} onClick={() => void act({ action: "new_tab" })}><AliIcon name="plus" size={14} /></button>
    </div>
    <div className={styles.browserToolbar}>
      <button type="button" aria-label={t("browser.back")} disabled={!state?.canGoBack} onClick={() => void act({ action: "back" })}><AliIcon name="arrowleft" size={14} /></button>
      <button type="button" aria-label={t("browser.forward")} disabled={!state?.canGoForward} onClick={() => void act({ action: "forward" })}><AliIcon name="arrowright" size={14} /></button>
      <button type="button" aria-label={t("browser.reload")} disabled={!state} onClick={() => void act({ action: "reload" })}><AliIcon name="reload" size={14} /></button>
      <form onSubmit={(event) => { event.preventDefault(); if (address.trim()) void act({ action: "navigate", url: address.trim() }); }}>
        <input ref={addressRef} value={address} aria-label={t("browser.address")} placeholder={t("browser.addressPlaceholder")} onChange={(event) => setAddress(event.target.value)} />
      </form>
    </div>
    <div className={styles.browserBookmarkBar} aria-label={t("browser.bookmarkBar")}>
      <div className={styles.browserBookmarkBarItems}>
        {barNodes.length ? barNodes.map((node) => node.type === "bookmark" ? (
          <button key={node.id} type="button" title={`${node.title}\n${node.url}`} onClick={() => void act({ action: "navigate", url: node.url })}>
            <AliIcon name="earth" size={12} /><span>{node.title}</span>
          </button>
        ) : (
          <button
            key={node.id}
            type="button"
            aria-expanded={openBookmarkFolderId === node.id}
            title={`${node.title} · ${t("browser.bookmarkCount", { count: bookmarkCount(node.children) })}`}
            onClick={() => setOpenBookmarkFolderId((current) => current === node.id ? null : node.id)}
          >
            <AliIcon name={openBookmarkFolderId === node.id ? "folder-open" : "folder"} size={13} /><span>{node.title}</span>
          </button>
        )) : <span className={styles.browserBookmarkBarEmpty}>{t("browser.bookmarkBarEmpty")}</span>}
      </div>
      <button
        className={styles.browserBookmarkRefresh}
        type="button"
        disabled={importing}
        title={t("browser.refreshBookmarks")}
        aria-label={t("browser.refreshBookmarks")}
        onClick={() => void importChromeBookmarks()}
      >
        <AliIcon name="reload" size={12} />
      </button>
    </div>
    {openBookmarkFolder?.type === "folder" ? (
      <div className={styles.browserBookmarkDrawer} aria-label={openBookmarkFolder.title}>
        <div className={styles.browserBookmarkDrawerHeader}>
          <AliIcon name="folder-open" size={14} />
          <strong>{openBookmarkFolder.title}</strong>
          <span>{t("browser.bookmarkCount", { count: bookmarkCount(openBookmarkFolder.children) })}</span>
          <button type="button" aria-label={t("browser.closeBookmarks")} onClick={() => setOpenBookmarkFolderId(null)}><AliIcon name="close" size={12} /></button>
        </div>
        <BookmarkTree
          nodes={openBookmarkFolder.children}
          onNavigate={(url) => {
            setOpenBookmarkFolderId(null);
            void act({ action: "navigate", url });
          }}
        />
      </div>
    ) : null}
    {error ? <div className={styles.browserError} role="alert">{error}</div> : null}
    <div ref={viewportRef} className={styles.browserViewport} data-busy={state?.loading ? "true" : undefined}>
      {blank ? <div className={styles.browserStart} data-onboarding={showOnboarding ? "true" : undefined}>
        <AliIcon name="earth" size={28} />
        <strong>{showOnboarding ? t("browser.welcomeTitle") : t("browser.startTitle")}</strong>
        <span>{showOnboarding ? t("browser.welcomeDescription") : t("browser.startDescription")}</span>
        {showOnboarding ? <div className={styles.browserOnboardingActions}>
          <button type="button" disabled={importing} onClick={() => void importChromeBookmarks()}>{importing ? t("browser.importing") : t("browser.importChrome")}</button>
          <button type="button" onClick={finishOnboarding}>{t("browser.skipImport")}</button>
          <small>{t("browser.importSafety")}</small>
        </div> : <>
          <button className={styles.browserImportLink} type="button" disabled={importing} onClick={() => void importChromeBookmarks()}>{t("browser.importChrome")}</button>
        </>}
      </div> : null}
    </div>
    <div className={styles.browserPrivacy}>
      {download ? <button type="button" onClick={() => download.path && window.piDesktop?.revealPath?.(download.path)}>
        {downloadLabel}
      </button> : t("browser.profileNotice")}
    </div>
  </div>;
}

function BookmarkTree({ nodes, onNavigate }: { nodes: ImportedChromeBookmarkNode[]; onNavigate: (url: string) => void }) {
  return <ul className={styles.browserBookmarkTree}>
    {nodes.map((node) => node.type === "bookmark" ? (
      <li key={node.id}>
        <button type="button" title={node.url} onClick={() => onNavigate(node.url)}>
          <AliIcon name="earth" size={12} /><span>{node.title}</span><small>{node.url}</small>
        </button>
      </li>
    ) : (
      <li key={node.id}>
        <details>
          <summary><AliIcon name="folder" size={13} /><span>{node.title}</span><small>{bookmarkCount(node.children)}</small></summary>
          <BookmarkTree nodes={node.children} onNavigate={onNavigate} />
        </details>
      </li>
    ))}
  </ul>;
}

function ScreenshotBrowserPanel({ active, sessionId }: { active: boolean; sessionId: string | null }) {
  const { t } = useI18n();
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [screenshotKey, setScreenshotKey] = useState(0);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const pointerMoveRef = useRef<{ x: number; y: number } | null>(null);
  const pointerMoveInFlightRef = useRef(false);
  const actionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const hoverRefreshTimerRef = useRef<number | null>(null);

  const applyState = useCallback((next: BrowserState) => {
    setState(next);
    setAddress(next.url === "about:blank" ? "" : next.url);
    setScreenshotKey((key) => key + 1);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
      const response = await fetch(`/api/browser${query}`, { cache: "no-store" });
      const payload = await response.json() as BrowserState & { error?: string };
      if (!response.ok) throw new Error(payload.error || t("browser.unavailable"));
      setState((previous) => {
        if (!previous || previous.revision !== payload.revision || previous.url !== payload.url) {
          setAddress(payload.url === "about:blank" ? "" : payload.url);
          setScreenshotKey((key) => key + 1);
        }
        return payload;
      });
      setError(null);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : t("browser.unavailable"));
    }
  }, [sessionId, t]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 900);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const act = useCallback((input: BrowserAction, options: { transient?: boolean; focusKeyboard?: boolean; refreshScreenshot?: boolean } = {}) => {
    if (!options.transient) setBusy(true);
    const queued = actionQueueRef.current.catch(() => undefined).then(async () => {
      try {
        const response = await fetch("/api/browser", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, ...(sessionId ? { sessionId } : {}) }),
        });
        const payload = await response.json() as BrowserState & { error?: string };
        if (!response.ok) throw new Error(payload.error || t("browser.actionFailed"));
        if (options.transient) {
          setState(payload);
          setError(null);
          if (options.refreshScreenshot) setScreenshotKey((key) => key + 1);
        } else {
          applyState(payload);
        }
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : t("browser.actionFailed"));
      } finally {
        if (!options.transient) setBusy(false);
        if (options.focusKeyboard !== false) keyboardRef.current?.focus({ preventScroll: true });
      }
    });
    actionQueueRef.current = queued;
    return queued;
  }, [applyState, sessionId, t]);

  useEffect(() => {
    if (!active || !viewportRef.current) return;
    let lastSize = "";
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width < 1 || height < 1) return;
      const size = `${width}x${height}`;
      if (size === lastSize) return;
      lastSize = size;
      void act({ action: "resize", width, height }, { transient: true, focusKeyboard: false, refreshScreenshot: true });
    });
    observer.observe(viewportRef.current);
    return () => observer.disconnect();
  }, [active, act]);

  useEffect(() => () => {
    if (hoverRefreshTimerRef.current !== null) window.clearTimeout(hoverRefreshTimerRef.current);
  }, []);

  const pointerCoordinates = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!state) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * state.viewport.width,
      y: ((event.clientY - bounds.top) / bounds.height) * state.viewport.height,
    };
  };

  const browserButton = (button: number): "left" | "middle" | "right" => button === 1 ? "middle" : button === 2 ? "right" : "left";

  const flushPointerMove = async () => {
    if (pointerMoveInFlightRef.current) return;
    const pending = pointerMoveRef.current;
    if (!pending) return;
    pointerMoveRef.current = null;
    pointerMoveInFlightRef.current = true;
    await act({ action: "mouse_move", ...pending }, { transient: true, focusKeyboard: false });
    pointerMoveInFlightRef.current = false;
    if (hoverRefreshTimerRef.current !== null) window.clearTimeout(hoverRefreshTimerRef.current);
    hoverRefreshTimerRef.current = window.setTimeout(() => {
      hoverRefreshTimerRef.current = null;
      setScreenshotKey((key) => key + 1);
    }, 90);
    if (pointerMoveRef.current) void flushPointerMove();
  };

  const queuePointerMove = (coordinates: { x: number; y: number }) => {
    pointerMoveRef.current = coordinates;
    void flushPointerMove();
  };

  const pressKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composingRef.current || event.key === "Process" || event.key === "Dead") return;
    event.preventDefault();
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length > 1) {
      const modifiers = [event.ctrlKey ? "Control" : "", event.metaKey ? "Meta" : "", event.altKey ? "Alt" : "", event.shiftKey ? "Shift" : ""].filter(Boolean);
      const key = event.key === " " ? "Space" : event.key;
      void act({ action: "press", key: [...modifiers, key].join("+") });
    } else if (event.key.length === 1) {
      void act({ action: "type", text: event.key });
    }
  };

  return <div className={styles.browserRoot}>
    <div className={styles.browserTabs} role="tablist" aria-label={t("browser.tabs")}>
      {state?.tabs.map((tab) => <button
        key={`${tab.index}-${tab.url}`}
        type="button"
        role="tab"
        aria-selected={state.activeTabIndex === tab.index}
        title={tab.url}
        onClick={() => void act({ action: "switch_tab", tabIndex: tab.index })}
      >
        <AliIcon name="earth" size={13} /><b>{tab.title || t("browser.newTab")}</b>
        <span
          className={styles.browserTabClose}
          role="button"
          aria-label={t("browser.closeTab")}
          onClick={(event) => { event.stopPropagation(); void act({ action: "close_tab", tabIndex: tab.index }); }}
        ><AliIcon name="close" size={11} /></span>
      </button>)}
      <button className={styles.browserNewTab} type="button" aria-label={t("browser.newTab")} onClick={() => void act({ action: "new_tab" })}><AliIcon name="plus" size={14} /></button>
    </div>
    <div className={styles.browserToolbar}>
      <button type="button" aria-label={t("browser.back")} disabled={busy} onClick={() => void act({ action: "back" })}><AliIcon name="arrowleft" size={14} /></button>
      <button type="button" aria-label={t("browser.forward")} disabled={busy} onClick={() => void act({ action: "forward" })}><AliIcon name="arrowright" size={14} /></button>
      <button type="button" aria-label={t("browser.reload")} disabled={busy} onClick={() => void act({ action: "reload" })}><AliIcon name="reload" size={14} /></button>
      <form onSubmit={(event) => { event.preventDefault(); if (address.trim()) void act({ action: "navigate", url: address.trim() }); }}>
        <input value={address} aria-label={t("browser.address")} placeholder={t("browser.addressPlaceholder")} onChange={(event) => setAddress(event.target.value)} />
      </form>
    </div>
    {error ? <div className={styles.browserError} role="alert">{error}</div> : null}
    <div
      ref={viewportRef}
      className={styles.browserViewport}
      data-busy={busy}
      style={{ cursor: state?.cursor || "default" }}
      onPointerDown={(event) => {
        if (!state || state.url === "about:blank") return;
        const coordinates = pointerCoordinates(event);
        if (!coordinates) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        keyboardRef.current?.focus({ preventScroll: true });
        void act({ action: "mouse_down", ...coordinates, button: browserButton(event.button) }, { transient: true });
      }}
      onPointerMove={(event) => {
        const coordinates = pointerCoordinates(event);
        if (coordinates) queuePointerMove(coordinates);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const coordinates = pointerCoordinates(event);
        void act({ action: "mouse_up", ...(coordinates ?? {}), button: browserButton(event.button) }, { transient: true, refreshScreenshot: true });
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const coordinates = pointerCoordinates(event);
        void act({ action: "mouse_up", ...(coordinates ?? {}), button: browserButton(event.button) }, { transient: true, focusKeyboard: false, refreshScreenshot: true });
      }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={(event) => { event.preventDefault(); void act({ action: "scroll", deltaY: event.deltaY }, { transient: true, focusKeyboard: false, refreshScreenshot: true }); }}
    >
      {state ? <img src={`/api/browser/screenshot?v=${screenshotKey}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`} alt={t("browser.pagePreview")} draggable={false} /> : <div className={styles.browserLoading}>{t("browser.starting")}</div>}
      {state?.url === "about:blank" ? <div className={styles.browserStart}>
        <AliIcon name="earth" size={28} />
        <strong>{t("browser.startTitle")}</strong>
        <span>{t("browser.startDescription")}</span>
      </div> : null}
      <textarea
        ref={keyboardRef}
        className={styles.browserKeyboardCapture}
        aria-label={t("browser.keyboardCapture")}
        value=""
        onChange={() => undefined}
        onKeyDown={pressKey}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          if (event.data) void act({ action: "type", text: event.data });
        }}
      />
    </div>
    <div className={styles.browserPrivacy}>{t("browser.profileNotice")}</div>
  </div>;
}
