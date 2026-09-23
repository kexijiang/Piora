"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { FileExplorer, type FileExplorerHandle } from "../FileExplorer";
import { FileViewer } from "../FileViewer";
import { TabBar, type Tab } from "../TabBar";
import { ReviewPanel } from "./ReviewPanel";
import { CommandPanel } from "./CommandPanel";
import { BrowserPanel } from "./BrowserPanel";
import { SafeHarmonyPanel } from "./HarmonyPanel";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import { AliIcon, type AliIconName } from "../AliIcon";
import styles from "./WorkspacePanel.module.css";
import { AutomationPanel } from "../AutomationPanel";
import { SSHPanel } from "./SSHPanel";
import type { SessionCapabilitiesState } from "@/lib/session-capabilities";
import type { PromptFileChanges } from "@/lib/prompt-file-changes";

export type RightPanelTab = "home" | "automation" | "review" | "files" | "commands" | "ssh" | "browser" | "design" | "harmony";
export interface RightPanelHandle { focusActiveTab: () => void; focusFileSearch: () => void; }

interface Props {
  contextHeader?: ReactNode;
  activeTab: RightPanelTab;
  onActiveTabChange: (tab: RightPanelTab) => void;
  cwd: string | null;
  refreshKey: number;
  active: boolean;
  maximized: boolean;
  onMaximizedChange: (maximized: boolean) => void;
  onClosePanel: () => void;
  fileTabs: Tab[];
  activeFileTabId: string | null;
  canReopenClosedFileTab: boolean;
  onSelectFileTab: (id: string) => void;
  onCloseFileTab: (id: string) => void;
  onCloseOtherFileTabs: (id: string) => void;
  onCloseFileTabsToRight: (id: string) => void;
  onMoveFileTab: (id: string, targetIndex: number) => void;
  onReopenClosedFileTab: () => void;
  onOpenFile: (path: string, name: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; line?: number; column?: number }) => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
  onRefresh: () => void;
  onMention: (relativePath: string, isDir: boolean) => void;
  onMentions: (relativePaths: string[]) => void;
  onMentionLines: (relativePath: string, startLine: number, endLine: number) => void;
  selectedAutomationId: string | null;
  sessionId: string | null;
  sessionName?: string;
  sessionRunning?: boolean;
  onGuideAgent?: ((prompt?: string) => void) | undefined;
  onOpenShellSettings?: () => void;
  onSelectAutomation?: (id: string) => void;
  onAutomationChanged?: () => void;
  capabilities: SessionCapabilitiesState | null;
}

const TOOLS: Array<{ id: Exclude<RightPanelTab, "home">; icon: AliIconName; shortcut?: string }> = [
  { id: "automation", icon: "calendar" },
  { id: "review", icon: "diff", shortcut: "Ctrl+Shift+G" },
  { id: "commands", icon: "code" },
  { id: "ssh", icon: "server" },
  { id: "browser", icon: "earth", shortcut: "Ctrl+T" },
  { id: "design", icon: "workflow" },
  { id: "harmony", icon: "mobile" },
  { id: "files", icon: "folder-open", shortcut: "Ctrl+P" },
];

const DesignToHarmonyPanel = dynamic(
  () => import("./design-to-harmony/DesignToHarmonyPanel").then((module) => module.DesignToHarmonyPanel),
  { ssr: false },
);

type ToolTab = Exclude<RightPanelTab, "home">;
const TREE_SPLIT_KEY = "piora-file-tree-share";
const TREE_HANDLE_WIDTH = 6;

export const RightPanel = forwardRef<RightPanelHandle, Props>(function RightPanel(props, ref) {
  const { t } = useI18n();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const filesRootRef = useRef<HTMLDivElement>(null);
  const [filesWidth, setFilesWidth] = useState(0);
  const [treeShare, setTreeShare] = useState(0.28);
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [resizingTree, setResizingTree] = useState(false);
  const [fileNavMode, setFileNavMode] = useState<"tree" | "run">("tree");
  const [runChanges, setRunChanges] = useState<PromptFileChanges | null>(null);
  const [browserNavigation, setBrowserNavigation] = useState<{ id: string; url: string } | undefined>();
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const firstLauncherRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const { activeTab, onActiveTabChange, cwd, refreshKey, active, fileTabs, activeFileTabId } = props;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState({ left: 8, top: 48, width: 278 });
  const [openTools, setOpenTools] = useState<ToolTab[]>(() => activeTab === "home" ? [] : [activeTab]);
  const [filesHasOpened, setFilesHasOpened] = useState(activeTab === "files");
  const [draggedTool, setDraggedTool] = useState<ToolTab | null>(null);
  const [dropTargetTool, setDropTargetTool] = useState<ToolTab | null>(null);
  const compactFiles = filesWidth > 0 && filesWidth < 600;
  const maxTreeWidth = Math.max(160, Math.min(Math.round(filesWidth * 0.55), filesWidth - TREE_HANDLE_WIDTH - 320, 900));
  const treeWidth = Math.max(160, Math.min(maxTreeWidth, Math.round((filesWidth - TREE_HANDLE_WIDTH) * treeShare)));

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem(TREE_SPLIT_KEY));
      if (Number.isFinite(saved) && saved >= 0.1 && saved <= 0.75) setTreeShare(saved);
    } catch { /* The splitter still works when storage is unavailable. */ }
  }, []);

  useEffect(() => {
    if (activeTab !== "files" || !filesRootRef.current) return;
    const observer = new ResizeObserver(([entry]) => setFilesWidth(entry.contentRect.width));
    observer.observe(filesRootRef.current);
    return () => observer.disconnect();
  }, [activeTab]);

  useEffect(() => { if (!compactFiles) setTreeDrawerOpen(false); }, [compactFiles]);

  useEffect(() => {
    if (activeTab !== "files" || !props.sessionId) { setRunChanges(null); return; }
    const sessionId = props.sessionId;
    setRunChanges((current) => current?.sessionId === sessionId ? current : null);
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sessionId)}/changes`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as PromptFileChanges | null;
        if (!cancelled) setRunChanges(data);
      } catch { if (!cancelled) setRunChanges(null); }
    };
    void load();
    const timer = props.sessionRunning ? window.setInterval(() => void load(), 2500) : null;
    return () => { cancelled = true; if (timer !== null) window.clearInterval(timer); };
  }, [activeTab, props.sessionId, props.sessionRunning, refreshKey]);

  const changeTreeWidth = (candidate: number) => {
    const width = filesRootRef.current?.getBoundingClientRect().width ?? 0;
    if (width < 600) return;
    const maximum = Math.min(Math.round(width * 0.55), width - TREE_HANDLE_WIDTH - 320, 900);
    const nextShare = Math.max(160, Math.min(maximum, candidate)) / (width - TREE_HANDLE_WIDTH);
    setTreeShare(nextShare);
    try { window.localStorage.setItem(TREE_SPLIT_KEY, String(nextShare)); } catch { /* Keep the live split. */ }
  };
  const capabilityAccess = (kind: "browser" | "device") => {
    if (!props.capabilities) return null;
    const items = props.capabilities.items.filter((item) => item.kind === kind && item.available);
    const enabledCount = items.filter((item) => item.enabled).length;
    const status = items.length === 0
      ? "unavailable"
      : enabledCount === 0
        ? "off"
        : enabledCount === items.length
          ? "on"
          : "partial";
    if (kind === "browser" && status === "on") return null;
    const labelKey = kind === "device" && status === "unavailable"
      ? "sessionTools.panelDeviceUnavailable"
      : kind === "device" && status === "off"
        ? "sessionTools.panelDeviceAccessOff"
        : status === "on"
      ? "sessionTools.panelAccessOn"
      : status === "partial"
        ? "sessionTools.panelAccessPartial"
        : status === "unavailable"
          ? "sessionTools.panelUnavailable"
          : "sessionTools.panelAccessOff";
    return <div className={styles.capabilityAccess} data-enabled={status === "on" ? "true" : status}>
      <AliIcon name={status === "on" ? "check-circle" : "alert"} size={13} />
      <span>{t(labelKey)}</span>
    </div>;
  };
  useImperativeHandle(ref, () => ({
    focusActiveTab: () => (activeTab === "home" ? firstLauncherRef.current : activeTabRef.current)?.focus({ preventScroll: true }),
    focusFileSearch: () => { setFileNavMode("tree"); setTreeDrawerOpen(true); requestAnimationFrame(() => explorerRef.current?.focusSearch()); },
  }), [activeTab]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node) && !toolMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAddMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const placeMenu = () => {
      const rect = addButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      const inset = 8;
      const gap = 6;
      const width = Math.min(278, Math.max(180, window.innerWidth - inset * 2));
      const estimatedHeight = toolMenuRef.current?.offsetHeight ?? 164;
      const left = Math.min(Math.max(inset, rect.left), Math.max(inset, window.innerWidth - width - inset));
      const below = rect.bottom + gap;
      const top = below + estimatedHeight <= window.innerHeight - inset
        ? below
        : Math.max(inset, rect.top - estimatedHeight - gap);
      setAddMenuPosition({ left, top, width });
    };
    placeMenu();
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    if (activeTab === "files") setFilesHasOpened(true);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "home") return;
    setOpenTools((current) => current.includes(activeTab) ? current : [...current, activeTab]);
  }, [activeTab]);

  const selectTool = (tab: ToolTab) => {
    setOpenTools((current) => current.includes(tab) ? current : [...current, tab]);
    onActiveTabChange(tab);
    setAddMenuOpen(false);
  };

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTab, openTools]);

  const closeTool = (tab: ToolTab) => {
    const closingIndex = openTools.indexOf(tab);
    const remaining = openTools.filter((openTool) => openTool !== tab);
    setOpenTools(remaining);
    if (activeTab !== tab) return;
    onActiveTabChange(remaining[Math.min(closingIndex, remaining.length - 1)] ?? "home");
  };

  const moveTool = (source: ToolTab, target: ToolTab) => {
    if (source === target) return;
    setOpenTools((current) => {
      const sourceIndex = current.indexOf(source);
      const targetIndex = current.indexOf(target);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const reordered = [...current];
      reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, source);
      return reordered;
    });
  };

  const moveToolTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, tab: ToolTab) => {
    const currentIndex = openTools.indexOf(tab);
    let nextIndex: number;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % openTools.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + openTools.length) % openTools.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = openTools.length - 1;
    else return;
    event.preventDefault();
    onActiveTabChange(openTools[nextIndex]);
    requestAnimationFrame(() => activeTabRef.current?.focus({ preventScroll: true }));
  };

  return <div className={`${styles.root} right-panel-surface`} style={{ height: "100%", minHeight: 0, minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
    {props.contextHeader}
    <div className={`${styles.panelChrome} right-panel-chrome`}>
      <div className={styles.toolTabs} role="tablist" aria-label={t("workspace.panelTabs")}>
        {openTools.map((toolId) => {
          const tool = TOOLS.find((candidate) => candidate.id === toolId);
          if (!tool) return null;
          const selected = activeTab === tool.id;
          return <div
            key={tool.id}
            className={styles.activeToolTab}
            data-active={selected ? "true" : "false"}
            data-dragging={draggedTool === tool.id ? "true" : undefined}
            data-drop-target={dropTargetTool === tool.id ? "true" : undefined}
            draggable
            onDragStart={(event) => {
              setDraggedTool(tool.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/piora-tool-tab", tool.id);
            }}
            onDragOver={(event) => {
              if (!draggedTool || draggedTool === tool.id) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTargetTool(tool.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = (draggedTool ?? event.dataTransfer.getData("text/piora-tool-tab")) as ToolTab;
              if (TOOLS.some((candidate) => candidate.id === source)) moveTool(source, tool.id);
              setDraggedTool(null);
              setDropTargetTool(null);
            }}
            onDragEnd={() => { setDraggedTool(null); setDropTargetTool(null); }}
          >
            <button ref={selected ? activeTabRef : undefined} type="button" role="tab" aria-selected={selected} aria-controls={`workspace-${tool.id}`} id={`workspace-${tool.id}-tab`} tabIndex={selected ? 0 : -1} onClick={() => onActiveTabChange(tool.id)} onKeyDown={(event) => moveToolTabFocus(event, tool.id)}>
              <AliIcon name={tool.icon} size={14} />
              <span>{t(`workspace.${tool.id}`)}</span>
            </button>
            <button className={styles.closeToolTab} type="button" aria-label={t("workspace.closeTool")} onClick={() => closeTool(tool.id)}><AliIcon name="close" size={12} /></button>
          </div>;
        })}
      </div>
      <div className={styles.panelChromeActions}>
        <div ref={addMenuRef} className={styles.addToolWrap}>
          <button ref={addButtonRef} className={styles.addToolButton} type="button" aria-label={t("workspace.addTool")} aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}><AliIcon name="plus" size={15} /></button>
          {addMenuOpen ? createPortal(<div ref={toolMenuRef} className={styles.toolMenu} role="menu" style={addMenuPosition}>
            {TOOLS.map((tool) => <button key={tool.id} type="button" role="menuitem" data-active={activeTab === tool.id ? "true" : "false"} onClick={() => selectTool(tool.id)}>
              <AliIcon name={tool.icon} size={15} />
              <span>{t(`workspace.${tool.id}`)}</span>
              {tool.shortcut ? <kbd>{tool.shortcut}</kbd> : null}
            </button>)}
          </div>, document.body) : null}
        </div>
        <button type="button" title={t(props.maximized ? "workspace.restorePanel" : "workspace.maximizePanel")} aria-label={t(props.maximized ? "workspace.restorePanel" : "workspace.maximizePanel")} onClick={() => props.onMaximizedChange(!props.maximized)}><AliIcon name={props.maximized ? "fullscreen-exit" : "fullscreen"} size={14} /></button>
        <button type="button" title={t("files.hidePanel")} aria-label={t("files.hidePanel")} onClick={props.onClosePanel}><AliIcon name="layout" size={15} /></button>
      </div>
    </div>
    {activeTab === "home" ? <div className={styles.toolLauncher} aria-label={t("workspace.panelTabs")}>
      {TOOLS.map((tool, index) => <button ref={index === 0 ? firstLauncherRef : undefined} key={tool.id} type="button" onClick={() => selectTool(tool.id)}>
        <AliIcon name={tool.icon} size={15} />
        <span>{t(`workspace.${tool.id}`)}</span>
        {tool.shortcut ? <kbd>{tool.shortcut}</kbd> : null}
      </button>)}
    </div> : null}
    <section id="workspace-review" role="tabpanel" aria-labelledby="workspace-review-tab" hidden={activeTab !== "review"} className={styles.panel}>
      {activeTab === "review" ? <RenderErrorBoundary resetKey={`review:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><ReviewPanel cwd={cwd} refreshKey={refreshKey} onRefresh={props.onRefresh} onOpenFile={(path) => { props.onOpenFile(path, path.replace(/\\/g, "/").split("/").pop() ?? path); onActiveTabChange("files"); }} /></RenderErrorBoundary> : null}
    </section>
    <section id="workspace-files" role="tabpanel" aria-labelledby="workspace-files-tab" hidden={activeTab !== "files"} className={styles.panel} style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {filesHasOpened ? <RenderErrorBoundary resetKey={`files:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}>
      <div ref={filesRootRef} className={styles.filesRoot} data-compact={compactFiles ? "true" : undefined} data-tree-open={treeDrawerOpen ? "true" : undefined} data-resizing={resizingTree ? "true" : undefined} style={{ position: "relative", display: "grid", height: "100%", minHeight: 0, minWidth: 0, gridTemplateColumns: compactFiles ? "40px minmax(0, 1fr)" : `${treeWidth}px ${TREE_HANDLE_WIDTH}px minmax(0, 1fr)` }}>
        {compactFiles ? <button className={styles.fileTreeRail} type="button" aria-label={t("files.explorer")} aria-expanded={treeDrawerOpen} onClick={() => setTreeDrawerOpen((open) => !open)}><AliIcon name="folder-open" size={16} /></button> : null}
        {compactFiles && treeDrawerOpen ? <button className={styles.fileTreeBackdrop} type="button" aria-label={t("i18n.close")} onClick={() => setTreeDrawerOpen(false)} /> : null}
        <div id="piora-file-explorer" className={styles.explorer} style={{ gridColumn: 1, minWidth: 0, minHeight: 0, overflow: "hidden", display: compactFiles ? treeDrawerOpen ? "flex" : "none" : "flex", flexDirection: "column", ...(compactFiles ? { position: "absolute" as const, zIndex: 12, left: 40, top: 0, bottom: 0, width: "min(320px, calc(100% - 40px))", background: "var(--bg-panel)", boxShadow: "var(--shadow-popover)" } : {}) }}>
          <div className={styles.fileNavigatorTabs} role="tablist" aria-label={t("files.navigator")}>
            <button type="button" role="tab" aria-selected={fileNavMode === "tree"} onClick={() => setFileNavMode("tree")}>{t("files.explorer")}</button>
            <button type="button" role="tab" aria-selected={fileNavMode === "run"} onClick={() => setFileNavMode("run")}>{t("files.thisRun")}{runChanges?.files.length ? ` ${runChanges.files.length}` : ""}</button>
          </div>
          <div className={styles.fileNavigatorBody} hidden={fileNavMode !== "tree"} style={{ flex: 1, minHeight: 0, overflow: "auto", display: fileNavMode === "tree" ? undefined : "none" }}>{cwd ? <FileExplorer ref={explorerRef} cwd={cwd} selectedFilePath={fileTabs.find((tab) => tab.id === activeFileTabId)?.filePath ?? null} onOpenFile={(path, name, options) => { props.onOpenFile(path, name, options); setTreeDrawerOpen(false); }} refreshKey={refreshKey} onAtMention={props.onMention} onAtMentions={props.onMentions} changesCollapsed /> : <div className={styles.empty}>{t("workspace.selectProject")}</div>}</div>
          <div className={styles.fileNavigatorBody} hidden={fileNavMode !== "run"} style={{ flex: 1, minHeight: 0, overflow: "auto", display: fileNavMode === "run" ? undefined : "none" }}>
            <div className={styles.runSummary}>
              <span>{runChanges?.status === "running" ? t("files.runRunning") : runChanges?.status === "aborted" ? t("files.runAborted") : runChanges?.status === "error" ? t("files.runError") : runChanges?.status === "unavailable" ? t("files.runUnavailable") : t("files.thisRun")}</span>
              <button type="button" onClick={() => onActiveTabChange("review")}>{t("files.reviewAll")}</button>
            </div>
            {runChanges ? <div className={styles.runScope}>{t("files.runScope")}</div> : null}
            {runChanges?.partial ? <div className={styles.runNotice}>{t("files.runPartial")}</div> : null}
            {runChanges?.files.length ? runChanges.files.map((file) => <button key={file.path} className={styles.runFile} type="button" title={file.path} onClick={() => { props.onOpenFile(file.path, file.path.replace(/\\/g, "/").split("/").pop() ?? file.path, file.kind === "deleted" ? { modeHint: "diff" } : undefined); setTreeDrawerOpen(false); }}><AliIcon name="file" size={14} /><span>{file.path.replace(/\\/g, "/").split("/").pop()}</span><small>{t(`files.run.${file.kind}`)}</small></button>) : <div className={styles.runEmpty}>{!runChanges ? t("files.runNever") : runChanges.status === "running" ? t("files.runPending") : runChanges.status === "unavailable" ? t("files.runUnavailable") : t("files.runEmpty")}</div>}
          </div>
        </div>
        <div className={styles.fileTreeSplitter} style={{ gridColumn: 2, display: compactFiles ? "none" : undefined, position: "relative", cursor: "col-resize", touchAction: "none" }} role="separator" tabIndex={compactFiles ? -1 : 0} aria-hidden={compactFiles} aria-label={t("files.resizeTree")} aria-orientation="vertical" aria-controls="piora-file-explorer piora-file-viewer" aria-valuemin={160} aria-valuemax={maxTreeWidth} aria-valuenow={treeWidth}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            changeTreeWidth(event.key === "Home" ? 160 : event.key === "End" ? maxTreeWidth : treeWidth + (event.key === "ArrowRight" ? 12 : -12));
          }}
          onPointerDown={(event) => { if (event.button !== 0 || compactFiles) return; event.currentTarget.setPointerCapture(event.pointerId); setResizingTree(true); event.preventDefault(); }}
          onPointerMove={(event) => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const left = filesRootRef.current?.getBoundingClientRect().left; if (left !== undefined) changeTreeWidth(event.clientX - left - TREE_HANDLE_WIDTH / 2); }}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onLostPointerCapture={() => setResizingTree(false)} />
        <div id="piora-file-viewer" className={styles.fileViewer} style={{ gridColumn: compactFiles ? 2 : 3, minWidth: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className={styles.fileTabs} style={{ flex: "0 0 auto", minHeight: 36 }}><TabBar
            tabs={fileTabs}
            activeTabId={activeFileTabId ?? ""}
            canReopenClosedTab={props.canReopenClosedFileTab}
            onSelectTab={props.onSelectFileTab}
            onCloseTab={props.onCloseFileTab}
            onCloseOtherTabs={props.onCloseOtherFileTabs}
            onCloseTabsToRight={props.onCloseFileTabsToRight}
            onMoveTab={props.onMoveFileTab}
            onReopenClosedTab={props.onReopenClosedFileTab}
          /></div>
          <div className={styles.fileBody} style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}>{fileTabs.length ? fileTabs.map((tab) => {
            const selected = tab.id === activeFileTabId;
            return <div key={tab.id} aria-hidden={!selected} style={{ position: "absolute", inset: 0, display: selected ? "block" : "none", overflow: "hidden" }}><FileViewer filePath={tab.filePath} cwd={tab.cwd ?? cwd ?? undefined} sourceSessionId={tab.sourceSessionId} gitRefreshKey={refreshKey} initialDisplayMode={tab.initialDisplayMode} revealLine={tab.revealLine} revealColumn={tab.revealColumn} revealKey={tab.revealKey} active={active && activeTab === "files" && selected} onDirtyChange={(dirty) => props.onDirtyChange(tab.id, dirty)} onSaved={props.onRefresh} onMentionLines={active && selected ? props.onMentionLines : undefined} onOpenFile={(path, options) => props.onOpenFile(path, path.replace(/\\/g, "/").split("/").pop() ?? path, options)} /></div>;
          }) : <div className={styles.empty}>{t("files.noneOpen")}</div>}</div>
        </div>
      </div>
      </RenderErrorBoundary> : null}
    </section>
    <section id="workspace-commands" role="tabpanel" aria-labelledby="workspace-commands-tab" hidden={activeTab !== "commands"} className={styles.panel}>
      {active && activeTab === "commands" ? <RenderErrorBoundary resetKey={`commands:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><CommandPanel cwd={cwd} sessionId={props.sessionId} onClose={() => closeTool("commands")} onSettings={props.onOpenShellSettings} onToChat={props.onGuideAgent} onOpenFile={file => { props.onOpenFile(file, file.replace(/\\/g, "/").split("/").pop() || file); onActiveTabChange("files"); }} onOpenUrl={url => { if (/^https?:\/\//i.test(url)) { setBrowserNavigation({ id: crypto.randomUUID(), url }); onActiveTabChange("browser"); } }} /></RenderErrorBoundary> : null}
    </section>
    <section id="workspace-ssh" role="tabpanel" aria-labelledby="workspace-ssh-tab" hidden={activeTab !== "ssh"} className={styles.panel}>
      {active && activeTab === "ssh" ? <RenderErrorBoundary resetKey={`ssh:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><SSHPanel agentSessionId={props.sessionId} /></RenderErrorBoundary> : null}
    </section>
    <section id="workspace-browser" role="tabpanel" aria-labelledby="workspace-browser-tab" hidden={activeTab !== "browser"} className={styles.panel}>
      {activeTab === "browser" ? <div className={styles.capabilityPanel}>{capabilityAccess("browser")}<div className={styles.capabilityPanelBody}><RenderErrorBoundary resetKey={`browser:${props.sessionId ?? "manual"}:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><BrowserPanel active={active && activeTab === "browser"} maximized={props.maximized} sessionId={props.sessionId} navigationRequest={browserNavigation} onNavigationConsumed={() => setBrowserNavigation(undefined)} /></RenderErrorBoundary></div></div> : null}
    </section>
    <section id="workspace-harmony" role="tabpanel" aria-labelledby="workspace-harmony-tab" hidden={activeTab !== "harmony"} className={styles.panel}>
      {activeTab === "harmony" ? <div className={styles.capabilityPanel}>{capabilityAccess("device")}<div className={styles.capabilityPanelBody}><RenderErrorBoundary resetKey={`harmony:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><SafeHarmonyPanel active={active && activeTab === "harmony"} maximized={props.maximized} onMaximizedChange={props.onMaximizedChange} cwd={cwd} sessionRunning={props.sessionRunning} onGuideAgent={props.onGuideAgent} onOpenFile={(path, line) => { props.onOpenFile(path, path.replace(/\\/g, "/").split("/").pop() ?? path, { line }); onActiveTabChange("files"); }} /></RenderErrorBoundary></div></div> : null}
    </section>
    <section id="workspace-design" role="tabpanel" aria-labelledby="workspace-design-tab" hidden={activeTab !== "design"} className={styles.panel}>
      {activeTab === "design" ? <RenderErrorBoundary resetKey={`design:${cwd ?? "no-project"}:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><DesignToHarmonyPanel
        cwd={cwd}
        active={active && activeTab === "design"}
        onGuideAgent={props.onGuideAgent}
        onOpenFile={(path, name) => { props.onOpenFile(path, name); onActiveTabChange("files"); }}
        onOpenReview={() => onActiveTabChange("review")}
        onProjectChanged={() => {
          props.onRefresh();
          window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } }));
        }}
      /></RenderErrorBoundary> : null}
    </section>
    <section id="workspace-automation" role="tabpanel" aria-labelledby="workspace-automation-tab" hidden={activeTab !== "automation"} className={styles.panel}>
      {activeTab === "automation" ? <RenderErrorBoundary resetKey={`automation:${props.selectedAutomationId ?? "list"}:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><AutomationPanel automationId={props.selectedAutomationId} sessionId={props.sessionId} sessionName={props.sessionName} cwd={cwd} onSelectAutomation={props.onSelectAutomation} onAutomationChanged={props.onAutomationChanged} /></RenderErrorBoundary> : null}
    </section>
  </div>;
});
