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
import type { SessionCapabilitiesState } from "@/lib/session-capabilities";

export type RightPanelTab = "home" | "automation" | "review" | "files" | "commands" | "browser" | "design" | "harmony";
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
  onOpenFile: (path: string, name: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; line?: number }) => void;
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
  onSelectAutomation?: (id: string) => void;
  onAutomationChanged?: () => void;
  capabilities: SessionCapabilitiesState | null;
}

const TOOLS: Array<{ id: Exclude<RightPanelTab, "home">; icon: AliIconName; shortcut?: string }> = [
  { id: "automation", icon: "calendar" },
  { id: "review", icon: "diff", shortcut: "Ctrl+Shift+G" },
  { id: "commands", icon: "code" },
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

export const RightPanel = forwardRef<RightPanelHandle, Props>(function RightPanel(props, ref) {
  const { t } = useI18n();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const firstLauncherRef = useRef<HTMLButtonElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const { activeTab, onActiveTabChange, cwd, refreshKey, active, fileTabs, activeFileTabId } = props;
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuPosition, setAddMenuPosition] = useState({ left: 8, top: 48, width: 278 });
  const [openTools, setOpenTools] = useState<ToolTab[]>(() => activeTab === "home" ? [] : [activeTab]);
  const [draggedTool, setDraggedTool] = useState<ToolTab | null>(null);
  const [dropTargetTool, setDropTargetTool] = useState<ToolTab | null>(null);
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
    focusFileSearch: () => explorerRef.current?.focusSearch(),
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

  return <div className={`${styles.root} right-panel-surface`}>
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
    <section id="workspace-files" role="tabpanel" aria-labelledby="workspace-files-tab" hidden={activeTab !== "files"} className={styles.panel}>
      {activeTab === "files" ? <RenderErrorBoundary resetKey={`files:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}>
      <div className={styles.filesRoot}>
        <div className={styles.explorer}>{cwd ? <FileExplorer ref={explorerRef} cwd={cwd} selectedFilePath={fileTabs.find((tab) => tab.id === activeFileTabId)?.filePath ?? null} onOpenFile={props.onOpenFile} refreshKey={refreshKey} onAtMention={props.onMention} onAtMentions={props.onMentions} changesCollapsed /> : <div className={styles.empty}>{t("workspace.selectProject")}</div>}</div>
        <div className={styles.fileViewer}>
          <div className={styles.fileTabs}><TabBar
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
          <div className={styles.fileBody}>{fileTabs.length ? fileTabs.map((tab) => {
            const selected = tab.id === activeFileTabId;
            return <div key={tab.id} aria-hidden={!selected} style={{ position: "absolute", inset: 0, display: selected ? "block" : "none", overflow: "hidden" }}><FileViewer filePath={tab.filePath} cwd={tab.cwd ?? cwd ?? undefined} sourceSessionId={tab.sourceSessionId} gitRefreshKey={refreshKey} initialDisplayMode={tab.initialDisplayMode} revealLine={tab.revealLine} revealKey={tab.revealKey} active={active && activeTab === "files" && selected} onDirtyChange={(dirty) => props.onDirtyChange(tab.id, dirty)} onSaved={props.onRefresh} onMentionLines={active && selected ? props.onMentionLines : undefined} onOpenFile={(path) => props.onOpenFile(path, path.replace(/\\/g, "/").split("/").pop() ?? path)} /></div>;
          }) : <div className={styles.empty}>{t("files.noneOpen")}</div>}</div>
        </div>
      </div>
      </RenderErrorBoundary> : null}
    </section>
    <section id="workspace-commands" role="tabpanel" aria-labelledby="workspace-commands-tab" hidden={activeTab !== "commands"} className={styles.panel}>
      {activeTab === "commands" ? <RenderErrorBoundary resetKey={`commands:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><CommandPanel cwd={cwd} sessionId={props.sessionId} onClose={() => closeTool("commands")} /></RenderErrorBoundary> : null}
    </section>
    <section id="workspace-browser" role="tabpanel" aria-labelledby="workspace-browser-tab" hidden={activeTab !== "browser"} className={styles.panel}>
      {activeTab === "browser" ? <div className={styles.capabilityPanel}>{capabilityAccess("browser")}<div className={styles.capabilityPanelBody}><RenderErrorBoundary resetKey={`browser:${props.sessionId ?? "manual"}:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><BrowserPanel active={active && activeTab === "browser"} maximized={props.maximized} sessionId={props.sessionId} /></RenderErrorBoundary></div></div> : null}
    </section>
    <section id="workspace-harmony" role="tabpanel" aria-labelledby="workspace-harmony-tab" hidden={activeTab !== "harmony"} className={styles.panel}>
      {activeTab === "harmony" ? <div className={styles.capabilityPanel}>{capabilityAccess("device")}<div className={styles.capabilityPanelBody}><RenderErrorBoundary resetKey={`harmony:${refreshKey}`} fallbackLabel={t("workspace.panelRenderFailed")}><SafeHarmonyPanel active={active && activeTab === "harmony"} sessionRunning={props.sessionRunning} onGuideAgent={props.onGuideAgent} /></RenderErrorBoundary></div></div> : null}
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
