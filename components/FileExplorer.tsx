"use client";
import { requestGitStatus } from "@/lib/git-status-client";

import { forwardRef, startTransition, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { getFileIcon, FolderIcon } from "./FileIcons";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { getFileViewerKind } from "@/lib/file-types";
import { getNextTreeRenderCount, getTreeRenderWindow, TREE_INITIAL_RENDER_COUNT } from "@/lib/tree-progressive";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import {
  parseWorkspaceContinuity,
  updateWorkspaceContinuity,
  workspaceContinuityStorageKey,
} from "@/lib/workspace-continuity";
import styles from "./FileExplorer.module.css";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface FileContextTarget {
  name: string;
  fullPath: string;
  isDir: boolean;
}

interface FileContextMenuState {
  target: FileContextTarget;
  x: number;
  y: number;
}

interface Props {
  cwd: string;
  selectedFilePath?: string | null;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  focusSearch: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

const fetchGitStatus = requestGitStatus;

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        fontWeight: 600,
      }}
    >
      {status.code}
    </span>
  );
}

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function AddToChatIcon({ size = 13 }: { size?: number }) {
  return <AliIcon name="message-plus" size={size} strokeWidth={1.75} />;
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <AliIcon name="close" size={13} />
    </button>
  );
}

function FileContextMenu({
  menu,
  cwd,
  onClose,
  onOpenInApp,
  onAtMention,
  t,
}: {
  menu: FileContextMenuState;
  cwd: string;
  onClose: () => void;
  onOpenInApp: (target: FileContextTarget) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  t: Translate;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openWithVisible, setOpenWithVisible] = useState(false);
  const desktopBridge = window.piDesktop;
  const left = Math.max(6, Math.min(menu.x, window.innerWidth - 250));
  const top = Math.max(6, Math.min(menu.y, window.innerHeight - 210));
  const openSubmenuLeft = left + 238 + 222 + 12 > window.innerWidth;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleViewportChange = () => onClose();
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleViewportChange);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [onClose]);

  const runAndClose = (action: () => void | Promise<unknown>) => {
    onClose();
    void action();
  };

  return createPortal(
    <div
      ref={menuRef}
      className={styles.contextMenu}
      role="menu"
      aria-label={t("files.contextMenu")}
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        role="menuitem"
        className={styles.contextMenuItem}
        disabled={!desktopBridge?.revealPath}
        onClick={() => runAndClose(() => desktopBridge?.revealPath?.(menu.target.fullPath))}
      >
        <span className={styles.contextMenuIcon}><FolderIcon size={15} /></span>
        <span className={styles.contextMenuLabel}>{t("files.revealInFileExplorer")}</span>
      </button>

      {menu.target.isDir ? (
        <button
          type="button"
          role="menuitem"
          className={styles.contextMenuItem}
          onClick={() => runAndClose(() => onOpenInApp(menu.target))}
        >
          <span className={styles.contextMenuIcon}><AliIcon name="folder-open" size={15} /></span>
          <span className={styles.contextMenuLabel}>{t("files.expandInPiora")}</span>
        </button>
      ) : (
        <div
          role="menuitem"
          tabIndex={0}
          className={styles.contextMenuItem}
          data-open={openWithVisible}
          onMouseEnter={() => setOpenWithVisible(true)}
          onMouseLeave={() => setOpenWithVisible(false)}
          onFocus={() => setOpenWithVisible(true)}
          onClick={() => setOpenWithVisible((visible) => !visible)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
              event.preventDefault();
              setOpenWithVisible(true);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              setOpenWithVisible(false);
            }
          }}
        >
          <span className={styles.contextMenuIcon}>{getFileIcon(menu.target.name, 15)}</span>
          <span className={styles.contextMenuLabel}>{t("files.openWith")}</span>
          <AliIcon name="chevron-right" size={14} />
          {openWithVisible && (
            <div
              className={`${styles.contextSubmenu}${openSubmenuLeft ? ` ${styles.contextSubmenuLeft}` : ""}`}
              role="menu"
              onMouseEnter={() => setOpenWithVisible(true)}
            >
              <button
                type="button"
                role="menuitem"
                className={styles.contextMenuItem}
                onClick={(event) => {
                  event.stopPropagation();
                  runAndClose(() => onOpenInApp(menu.target));
                }}
              >
                <span className={styles.contextMenuIcon}><AliIcon name="file" size={15} /></span>
                <span className={styles.contextMenuLabel}>{t("files.openInPiora")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.contextMenuItem}
                disabled={!desktopBridge?.openPath}
                onClick={(event) => {
                  event.stopPropagation();
                  runAndClose(() => desktopBridge?.openPath?.(menu.target.fullPath));
                }}
              >
                <span className={styles.contextMenuIcon}><AliIcon name="export" size={15} /></span>
                <span className={styles.contextMenuLabel}>{t("files.openWithDefaultApp")}</span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className={styles.contextMenuSeparator} role="separator" />
      <button
        type="button"
        role="menuitem"
        className={styles.contextMenuItem}
        onClick={() => runAndClose(() => copyText(menu.target.fullPath))}
      >
        <span className={styles.contextMenuIcon}><AliIcon name="copy" size={15} /></span>
        <span className={styles.contextMenuLabel}>{t("files.copyPath")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={styles.contextMenuItem}
        disabled={!onAtMention}
        onClick={() => runAndClose(() => onAtMention?.(
          getRelativeFilePath(menu.target.fullPath, cwd),
          menu.target.isDir,
        ))}
      >
        <span className={styles.contextMenuIcon}><AddToChatIcon size={15} /></span>
        <span className={styles.contextMenuLabel}>{t("files.insertPath")}</span>
      </button>
    </div>,
    document.body,
  );
}

function SearchResultRow({
  entry,
  cwd,
  onOpen,
  onOpenContextMenu,
  selected,
  active,
  onFocus,
}: {
  entry: FileIndexEntry;
  cwd: string;
  onOpen: (target: FileContextTarget) => void;
  onOpenContextMenu: (target: FileContextTarget, x: number, y: number) => void;
  selected: boolean;
  active: boolean;
  onFocus: () => void;
}) {
  const fullPath = joinFilePath(cwd, entry.path);
  const name = getFileName(entry.path);
  const parentPath = getFileDirectory(entry.path);
  const target = { name, fullPath, isDir: entry.isDir };
  return (
    <div
      className={styles.searchResult}
      role="option"
      aria-selected={selected}
      data-file-search-result
      data-tree-label={name}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      title={fullPath}
      style={{ background: selected ? "var(--bg-selected)" : undefined }}
      onClick={() => onOpen(target)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(target);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const rows = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-file-search-result]") ?? [],
          );
          const currentIndex = rows.indexOf(event.currentTarget);
          const nextIndex = event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : event.key === "ArrowDown"
                ? Math.min(rows.length - 1, currentIndex + 1)
                : Math.max(0, currentIndex - 1);
          if (rows[nextIndex]) {
            event.preventDefault();
            rows[nextIndex].focus();
          }
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const rows = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[data-file-search-result]") ?? [],
          );
          const currentIndex = rows.indexOf(event.currentTarget);
          const needle = event.key.toLocaleLowerCase();
          const ordered = [...rows.slice(currentIndex + 1), ...rows.slice(0, currentIndex + 1)];
          const match = ordered.find((row) => row.dataset.treeLabel?.toLocaleLowerCase().startsWith(needle));
          if (match) {
            event.preventDefault();
            match.focus();
          }
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenContextMenu(target, event.clientX, event.clientY);
      }}
    >
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
        {entry.isDir ? <FolderIcon size={15} /> : getFileIcon(name, 15)}
      </span>
      <div className={styles.searchResultText}>
        <div className={styles.searchResultName}>{name}</div>
        <div className={styles.searchResultPath}>{parentPath === "." ? "" : parentPath}</div>
      </div>
    </div>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  onOpenContextMenu,
  selectedFilePath,
  focusedPath,
  onFocusedPathChange,
  positionInSet,
  setSize,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  onOpenContextMenu: (target: FileContextTarget, x: number, y: number) => void;
  selectedFilePath?: string | null;
  focusedPath: string | null;
  onFocusedPathChange: (fullPath: string) => void;
  positionInSet?: number;
  setSize?: number;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const selected = !node.isDir && normalizedPath === selectedFilePath;
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const openHint = !node.isDir && getFileViewerKind(node.fullPath) === "text"
    ? t("files.openInEditor")
    : t("files.openPreview");
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [visibleChildCount, setVisibleChildCount] = useState(TREE_INITIAL_RENDER_COUNT);
  const progressiveSentinelRef = useRef<HTMLButtonElement>(null);
  const childWindow = useMemo(
    () => getTreeRenderWindow(children.length, visibleChildCount),
    [children.length, visibleChildCount],
  );
  const visibleChildren = useMemo(
    () => children.slice(0, childWindow.endIndex),
    [childWindow.endIndex, children],
  );

  const revealMoreChildren = useCallback(() => {
    startTransition(() => {
      setVisibleChildCount((current) => getNextTreeRenderCount(current, children.length));
    });
  }, [children.length]);

  useEffect(() => {
    const sentinel = progressiveSentinelRef.current;
    if (!open || childWindow.remaining === 0 || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) revealMoreChildren();
    }, { rootMargin: "160px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [childWindow.remaining, open, revealMoreChildren]);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  useEffect(() => {
    if (open && !loaded && !loading) void loadChildren();
  }, [loadChildren, loaded, loading, open]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        onClick={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          handleClick();
        }}
        role="treeitem"
        tabIndex={focusedPath === node.fullPath ? 0 : -1}
        data-file-tree-item
        data-tree-label={node.name}
        aria-selected={selected}
        aria-current={selected ? "page" : undefined}
        aria-expanded={node.isDir ? open : undefined}
        aria-level={depth + 1}
        aria-posinset={positionInSet}
        aria-setsize={setSize}
        className={styles.treeItemRow}
        onFocus={() => onFocusedPathChange(node.fullPath)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleClick();
            return;
          }

          const tree = event.currentTarget.closest<HTMLElement>("[role='tree']");
          const items = Array.from(tree?.querySelectorAll<HTMLElement>("[data-file-tree-item]") ?? []);
          const currentIndex = items.indexOf(event.currentTarget);
          const focusAt = (index: number) => {
            const target = items[index];
            if (!target) return;
            event.preventDefault();
            target.focus({ preventScroll: true });
          };

          if (event.key === "ArrowDown") focusAt(Math.min(items.length - 1, currentIndex + 1));
          else if (event.key === "ArrowUp") focusAt(Math.max(0, currentIndex - 1));
          else if (event.key === "Home") focusAt(0);
          else if (event.key === "End") focusAt(items.length - 1);
          else if (event.key === "ArrowRight" && node.isDir) {
            event.preventDefault();
            if (!open) {
              onToggleExpanded(node.fullPath, true);
              if (!loaded) void loadChildren();
            } else {
              const child = items[currentIndex + 1];
              if (child?.getAttribute("aria-level") === String(depth + 2)) {
                child.focus({ preventScroll: true });
              }
            }
          } else if (event.key === "ArrowLeft") {
            if (node.isDir && open) {
              event.preventDefault();
              onToggleExpanded(node.fullPath, false);
            } else {
              const parentLevel = String(depth);
              const parent = items.slice(0, currentIndex).reverse()
                .find((item) => item.getAttribute("aria-level") === parentLevel);
              if (parent) {
                event.preventDefault();
                parent.focus({ preventScroll: true });
              }
            }
          } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            const needle = event.key.toLocaleLowerCase();
            const ordered = [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex + 1)];
            const match = ordered.find((item) => item.dataset.treeLabel?.toLocaleLowerCase().startsWith(needle));
            if (match) {
              event.preventDefault();
              match.focus({ preventScroll: true });
            }
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenContextMenu(node, event.clientX, event.clientY);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          minHeight: "max(24px, calc(var(--text-sm) + 10px))",
          cursor: "pointer",
          background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <AliIcon name="chevron-right" size={14} strokeWidth={1.8} style={{ color: "var(--text-dim)", transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }} />
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.isDir ? node.fullPath : `${node.fullPath} · ${openHint}`}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#3b82f6" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />
          </span>
        )}
        {loading && (
          <AliIcon name="reload" size={10} style={{ color: "var(--text-dim)", animation: "spin 0.8s linear infinite" }} />
        )}
        {hovered && (onAtMention || !node.isDir) && (
          <div
            style={{
              position: "absolute",
              right: 3,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 1,
              padding: 1,
              borderRadius: 5,
              background: "var(--bg-hover)",
              boxShadow: "-8px 0 8px var(--bg-hover)",
            }}
          >
            {onAtMention && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
                }}
                aria-label={t("files.insertPath")}
                title={t("files.insertPath")}
                style={{
                  width: 24,
                  height: 24,
                  padding: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <AddToChatIcon />
              </button>
            )}
            {!node.isDir && (
              <a
                href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
                download
                onClick={(e) => e.stopPropagation()}
                aria-label={t("files.download")}
                title={t("files.download")}
                style={{
                  width: 24,
                  height: 24,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textDecoration: "none",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-selected)"; e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <AliIcon name="download" size={13} strokeWidth={1.75} />
              </a>
            )}
          </div>
        )}
      </div>
      {node.isDir && open && (
        <div role="group">
          {visibleChildren.map((child, index) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onOpenContextMenu={onOpenContextMenu}
              selectedFilePath={selectedFilePath}
              focusedPath={focusedPath}
              onFocusedPathChange={onFocusedPathChange}
              positionInSet={index + 1}
              setSize={children.length}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: "var(--text-xs)", color: "var(--text-dim)", minHeight: "max(22px, calc(var(--text-xs) + 10px))", display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
      {node.isDir && open && childWindow.remaining > 0 ? (
        <button
          ref={progressiveSentinelRef}
          type="button"
          className={styles.treeLoadMore}
          style={{ marginLeft: 8 + (depth + 1) * 14 }}
          onClick={revealMoreChildren}
        >
          {t("files.loadMore", { shown: childWindow.endIndex, total: children.length })}
        </button>
      ) : null}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff" };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  onOpenContextMenu,
  selected,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  onOpenContextMenu: (target: FileContextTarget, x: number, y: number) => void;
  selected: boolean;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff" })}
      onContextMenu={(event) => {
        event.preventDefault();
        onOpenContextMenu({ name, fullPath: status.filePath, isDir: false }, event.clientX, event.clientY);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      aria-current={selected ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 10,
        paddingRight: 8,
        minHeight: "max(24px, calc(var(--text-sm) + 10px))",
        cursor: "pointer",
        background: selected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "flex", alignItems: "center", opacity: 0.85 }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: "var(--text-sm)",
          color: "var(--text)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  selectedFilePath,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  changesCollapsed,
  onChangesCountChange,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FileIndexEntry[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [focusedSearchIndex, setFocusedSearchIndex] = useState(0);
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  const skipExpandedPersistenceRef = useRef(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const normalizedSelectedFilePath = selectedFilePath
    ? normalizeFilePathSlashes(selectedFilePath)
    : null;
  const treeFocusablePath = focusedTreePath ?? roots[0]?.fullPath ?? null;

  useEffect(() => {
    setFocusedSearchIndex(0);
  }, [searchQuery, searchResults]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const handleOpenContextMenu = useCallback((target: FileContextTarget, x: number, y: number) => {
    setContextMenu({ target, x, y });
  }, []);

  const handleOpenTarget = useCallback((target: FileContextTarget) => {
    if (!target.isDir) {
      onOpenFile(target.fullPath, target.name);
      return;
    }
    const relative = normalizeFilePathSlashes(getRelativeFilePath(target.fullPath, cwd));
    const segments = relative.split("/").filter(Boolean);
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      let current = cwd;
      for (const segment of segments) {
        current = joinFilePath(current, segment);
        next.add(current);
      }
      return next;
    });
    setSearchQuery("");
  }, [cwd, onOpenFile]);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
    focusSearch() {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Reset expanded state only when cwd changes, not on refreshKey bumps
    if (cwdChanged) {
      let restored = parseWorkspaceContinuity(null, cwd);
      try {
        restored = parseWorkspaceContinuity(
          window.localStorage.getItem(workspaceContinuityStorageKey(cwd)),
          cwd,
        );
      } catch {
        // The tree remains usable when browser storage is unavailable.
      }
      skipExpandedPersistenceRef.current = true;
      setExpandedPaths(new Set(restored.expandedPaths));
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setSearchQuery("");
      setSearchResults([]);
      setFocusedTreePath(null);
      setContextMenu(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    if (skipExpandedPersistenceRef.current) {
      skipExpandedPersistenceRef.current = false;
      return;
    }
    try {
      const key = workspaceContinuityStorageKey(cwd);
      window.localStorage.setItem(
        key,
        updateWorkspaceContinuity(
          window.localStorage.getItem(key),
          cwd,
          { expandedPaths },
        ),
      );
    } catch {
      // Expansion remains available for the current render when storage fails.
    }
  }, [cwd, expandedPaths]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearchLoading(true);
      setSearchError(false);
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`file search failed: ${response.status}`);
          return response.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setSearchResults(data.matches ?? []))
        .catch((searchFailure) => {
          if ((searchFailure as { name?: string }).name !== "AbortError") setSearchError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [cwd, searchQuery]);

  useEffect(() => {
    if (!selectedFilePath) return;
    const relative = normalizeFilePathSlashes(getRelativeFilePath(selectedFilePath, cwd));
    const directorySegments = relative.split("/").filter(Boolean).slice(0, -1);
    if (directorySegments.length === 0) return;
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      let current = cwd;
      for (const segment of directorySegments) {
        current = joinFilePath(current, segment);
        next.add(current);
      }
      return next;
    });
  }, [cwd, selectedFilePath]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGitFiles([]);
          setGitLineStats({ additions: 0, deletions: 0 });
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitFiles.length);
  }, [gitFiles, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div style={{ minHeight: "100%" }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      <div className={styles.filterBar}>
        <div className={styles.filterShell}>
          <AliIcon name="search" size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            className={styles.filterInput}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchQuery) {
                event.preventDefault();
                setSearchQuery("");
              } else if (event.key === "ArrowDown") {
                const firstResult = document.querySelector<HTMLElement>("[data-file-search-result]");
                if (firstResult) {
                  event.preventDefault();
                  firstResult.focus();
                }
              }
            }}
            placeholder={t("files.searchPlaceholder")}
            aria-label={t("files.searchPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          {searchQuery && (
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => {
                setSearchQuery("");
                searchInputRef.current?.focus();
              }}
              title={t("files.clearSearch")}
              aria-label={t("files.clearSearch")}
            >
              <AliIcon name="close" size={12} />
            </button>
          )}
        </div>
      </div>
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <AliIcon name="reload" size={13} style={{ animation: "spin 0.8s linear infinite" }} />
              ) : (
                <AliIcon name="upload" size={13} />
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: "var(--text-xs)" }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: "var(--text-xs)", color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ minHeight: "max(22px, calc(var(--text-xs) + 12px))", padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: "var(--text-xs)" }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ minHeight: "max(22px, calc(var(--text-xs) + 12px))", padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: "var(--text-xs)" }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ minHeight: "max(22px, calc(var(--text-xs) + 12px))", padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: "var(--text-xs)" }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: "var(--text-xs)", lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: "var(--text-xs)" }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <AliIcon name="check" size={13} />
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <AliIcon name="minus" size={13} />
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <AliIcon name="warning" size={13} />
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  style={{ width: 26, height: 26, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid transparent", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--accent)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.borderColor = "transparent"; e.currentTarget.style.color = "var(--text-dim)"; }}
                >
                  <AddToChatIcon />
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: "var(--text-xs)", color: "#f87171" }}>
                <AliIcon name="error" size={11} />
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {searchQuery.trim() && (
        <div style={{ padding: "1px 0 4px" }} role="listbox" aria-label={t("files.searchResults")}>
          {searchLoading && searchResults.length === 0 ? (
            <div className={styles.searchStatus}>{t("files.searching")}</div>
          ) : searchError ? (
            <div className={styles.searchStatus} style={{ color: "#f87171" }}>{t("files.searchFailed")}</div>
          ) : searchResults.length === 0 ? (
            <div className={styles.searchStatus}>{t("files.noSearchResults")}</div>
          ) : searchResults.map((entry, index) => (
            <SearchResultRow
              key={`${entry.isDir ? "dir" : "file"}:${entry.path}`}
              entry={entry}
              cwd={cwd}
              onOpen={handleOpenTarget}
              onOpenContextMenu={handleOpenContextMenu}
              selected={normalizeFilePathSlashes(joinFilePath(cwd, entry.path)) === normalizedSelectedFilePath}
              active={index === focusedSearchIndex}
              onFocus={() => setFocusedSearchIndex(index)}
            />
          ))}
        </div>
      )}

      {!searchQuery.trim() && !changesCollapsed && gitFiles.length > 0 && (
        <div style={{ padding: "0 4px 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, minHeight: "max(24px, calc(var(--text-sm) + 10px))", padding: "0 10px", fontSize: "var(--text-sm)" }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontFamily: "var(--font-mono)" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontFamily: "var(--font-mono)" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => (
            <ChangeRow
              key={status.filePath}
              status={status}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onOpenContextMenu={handleOpenContextMenu}
              selected={normalizeFilePathSlashes(status.filePath) === normalizedSelectedFilePath}
              t={t}
            />
          ))}
        </div>
      )}

      {!searchQuery.trim() && (changesCollapsed || gitFiles.length === 0) && (
        <div style={{ padding: "2px 4px" }} role="tree" aria-label={t("files.explorer")}>
          {loading ? (
            <div style={{ padding: "8px 12px", fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>Loading files...</div>
          ) : error ? (
            <div style={{ padding: "8px 12px", fontSize: "var(--text-xs)", color: "#f87171" }}>{error}</div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                depth={0}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                onOpenContextMenu={handleOpenContextMenu}
                selectedFilePath={normalizedSelectedFilePath}
                focusedPath={treeFocusablePath}
                onFocusedPathChange={setFocusedTreePath}
                t={t}
              />
            ))
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 12px", fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
      {contextMenu && (
        <FileContextMenu
          menu={contextMenu}
          cwd={cwd}
          onClose={() => setContextMenu(null)}
          onOpenInApp={handleOpenTarget}
          onAtMention={onAtMention}
          t={t}
        />
      )}
    </div>
  );
});
