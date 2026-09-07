"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  useId,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import renderSyntaxNode from "react-syntax-highlighter/dist/esm/create-element";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import ReactMarkdown from "react-markdown";
import { useTheme } from "@/hooks/useTheme";
import {
  DOCX_PREVIEW_MAX_BYTES,
  getFileViewerKind,
  getFileExt,
} from "@/lib/file-types";
import { encodeFilePathForApi, getFileDirectory, getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { resolveLocalFileHref } from "@/lib/file-links";
import { markdownPreviewRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { useMarkdownRehypePlugins } from "@/hooks/useMarkdownRehypePlugins";
import { CodeBlock, MermaidBlock } from "./MermaidBlock";
import type { GitFileDiffResponse } from "@/lib/git-types";
import { useI18n } from "@/hooks/useI18n";
import editorStyles from "./FileEditor.module.css";
import { AliIcon } from "./AliIcon";
import { DiffView } from "./DiffView";
import { LazySyntaxHighlighter as SyntaxHighlighter } from "./LazySyntaxHighlighter";

interface Props {
  filePath: string;
  cwd?: string;
  sourceSessionId?: string | null;
  onOpenFile?: (filePath: string) => void;
  onMentionLines?: (relativePath: string, startLine: number, endLine: number) => void;
  gitRefreshKey?: number;
  initialDisplayMode?: DisplayMode;
  revealLine?: number;
  revealKey?: number;
  active?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onSaved?: () => void;
}

interface FileData {
  content: string;
  language: string;
  size: number;
  version: string;
  mtime: string;
}

export type DisplayMode = "source" | "preview" | "diff" | "edit";

const DISPLAY_MODE_LABEL_KEYS: Record<DisplayMode, string> = {
  source: "i18n.source",
  preview: "i18n.preview",
  diff: "i18n.diff",
  edit: "i18n.edit",
};

interface FileConflictData {
  error?: string;
  code?: string;
  currentVersion?: string;
  mtime?: string;
  size?: number;
  notice?: "changed" | "refreshFailed";
}

type ConflictDecision = "reload" | "overwrite";

const FILE_CODE_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-base)",
  lineHeight: 1.6,
};

const FILE_LINE_NUMBER_STYLE: CSSProperties = {
  width: "max(48px, calc(var(--text-xs) + 37px))",
  minWidth: "max(48px, calc(var(--text-xs) + 37px))",
  padding: "0 10px",
  textAlign: "right",
  color: "var(--text-dim)",
  background: "var(--file-panel-surface-panel, var(--bg-panel))",
  borderRight: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontStyle: "normal",
  fontVariantNumeric: "tabular-nums",
  lineHeight: "var(--editor-code-line-height)",
  userSelect: "none",
  flexShrink: 0,
  verticalAlign: "top",
};

type SourceCodeRendererProps = Parameters<NonNullable<SyntaxHighlighterProps["renderer"]>>[0] & {
  wrapLines: boolean;
};

interface SelectedLineRange {
  startLine: number;
  endLine: number;
}

function MentionIcon() {
  return <AliIcon name="link" size={14} />;
}

function closestSourceLine(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement;
  return element?.closest<HTMLElement>(".file-source-line[data-line-number]") ?? null;
}

function getSelectedSourceLineRange(root: HTMLElement, selection: Selection | null): SelectedLineRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  let startElement = closestSourceLine(range.startContainer);
  let endElement = closestSourceLine(range.endContainer);
  if (!startElement || !endElement || !root.contains(startElement) || !root.contains(endElement)) return null;

  let startLine = Number(startElement.dataset.lineNumber);
  let endLine = Number(endElement.dataset.lineNumber);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;

  if (startLine < endLine) {
    // Browser ranges can start at the end of the preceding line or end at the
    // start of the following line. Exclude either boundary line when none of
    // its source text is actually selected.
    const startContent = startElement.querySelector<HTMLElement>(".file-source-line-content");
    if (startContent?.contains(range.startContainer)) {
      const selectedSuffix = document.createRange();
      selectedSuffix.selectNodeContents(startContent);
      selectedSuffix.setStart(range.startContainer, range.startOffset);
      if (selectedSuffix.toString().length === 0) {
        const nextLine = startElement.nextElementSibling;
        if (nextLine instanceof HTMLElement && nextLine.matches(".file-source-line[data-line-number]")) {
          startElement = nextLine;
          startLine = Number(startElement.dataset.lineNumber);
        }
      }
    }

    const endContent = endElement.querySelector<HTMLElement>(".file-source-line-content");
    if (endContent?.contains(range.endContainer)) {
      const selectedPrefix = document.createRange();
      selectedPrefix.selectNodeContents(endContent);
      selectedPrefix.setEnd(range.endContainer, range.endOffset);
      if (selectedPrefix.toString().length === 0) {
        const previousLine = endElement.previousElementSibling;
        if (previousLine instanceof HTMLElement && previousLine.matches(".file-source-line[data-line-number]")) {
          endElement = previousLine;
          endLine = Number(endElement.dataset.lineNumber);
        }
      }
    }
  }

  if (startLine > endLine) return null;
  return { startLine, endLine };
}

function SourceCodeRenderer({ rows, stylesheet, useInlineStyles, wrapLines }: SourceCodeRendererProps) {
  return rows.map((row, lineIndex) => {
    const children = row.children ?? [];
    const firstChildClasses = children[0]?.properties?.className;
    const hasLineNumber = Array.isArray(firstChildClasses)
      && firstChildClasses.includes("react-syntax-highlighter-line-number");
    const lineNumberNode = hasLineNumber ? children[0] : null;
    const contentNodes = hasLineNumber ? children.slice(1) : children;

    return (
      <span
        className="file-source-line"
        data-line-number={lineIndex + 1}
        key={`source-line-${lineIndex}`}
        style={{ display: "flex", minWidth: "100%" }}
      >
        {lineNumberNode && renderSyntaxNode({
          node: lineNumberNode,
          stylesheet,
          useInlineStyles,
          key: `source-line-number-${lineIndex}`,
        })}
        <span
          className="file-source-line-content"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowWrap: wrapLines ? "anywhere" : "normal",
            whiteSpace: wrapLines ? "pre-wrap" : "pre",
          }}
        >
          {contentNodes.map((node, tokenIndex) => renderSyntaxNode({
            node,
            stylesheet,
            useInlineStyles,
            key: `source-token-${lineIndex}-${tokenIndex}`,
          }))}
        </span>
      </span>
    );
  });
}

function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "preview" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return `/api/files/${encoded}?${searchParams.toString()}`;
}

function getFileWriteApiUrl(filePath: string): string {
  return `/api/files/${encodeFilePathForApi(filePath)}`;
}

function DownloadLink({ filePath, sourceSessionId }: { filePath: string; sourceSessionId?: string | null }) {
  const { t } = useI18n();
  return (
    <a
      href={getFileApiUrl(filePath, "download", sourceSessionId)}
      download={getFileName(filePath)}
      title={t("i18n.downloadFile")}
      aria-label={t("i18n.downloadFile")}
      className="file-viewer-icon-button"
    >
      <AliIcon name="download" size={14} />
    </a>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReadOnlyNotice() {
  const { t } = useI18n();
  return (
    <div className={editorStyles.readOnlyNotice} role="status">
      <AliIcon name="lock" size={13} />
      <span>
        <strong>{t("fileEditor.readOnlyTitle")}</strong>
        {t("fileEditor.readOnlyTypeBody")}
      </span>
    </div>
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function getEditorCursorPosition(value: string, selectionStart: number): { line: number; column: number } {
  const beforeCursor = value.slice(0, selectionStart);
  const line = beforeCursor.split("\n").length;
  const lastNewline = beforeCursor.lastIndexOf("\n");
  return { line, column: selectionStart - lastNewline };
}

function ImageViewer({ filePath, cwd, sourceSessionId, active = true }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setNaturalSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!active) return;

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [active, filePath, sourceSessionId]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  const formatSizeStr = size != null ? formatSize(size) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: "var(--text-xs)",
          color: "var(--text-dim)",
          background: "var(--file-panel-surface, var(--bg))",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "image"}</span>
        {naturalSize && <span>{naturalSize.w} × {naturalSize.h}</span>}
        {formatSizeStr && <span>{formatSizeStr}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <ReadOnlyNotice />
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--file-panel-surface-panel, var(--bg-panel))",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          backgroundImage:
            "linear-gradient(45deg, var(--bg) 25%, transparent 25%), linear-gradient(-45deg, var(--bg) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--bg) 75%), linear-gradient(-45deg, transparent 75%, var(--bg) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        {error ? (
          <div style={{ color: "#f87171", fontSize: "var(--text-base)" }}>{error}</div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={filePath}
            onLoad={(e) => {
              const img = e.currentTarget;
              setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setError("Failed to load image")}
            style={{
              maxWidth: "100%",
              maxHeight: "100%",
              objectFit: "contain",
              boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
            }}
          />
        )}
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  const totalSeconds = Math.round(seconds);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function AudioViewer({ filePath, cwd, sourceSessionId, active = true }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileName(filePath).toLowerCase().split(".").pop() ?? "";

  useEffect(() => {
    setBust(0);
    setSize(null);
    setDuration(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!active) return;

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") setSize(d.size);
      } catch { /* ignore */ }
      setDuration(null);
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [active, filePath, sourceSessionId]);

  const src = getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: "var(--text-xs)",
          color: "var(--text-dim)",
          background: "var(--file-panel-surface, var(--bg))",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext || "audio"}</span>
        {duration != null && <span>{formatDuration(duration)}</span>}
        {size != null && <span>{formatSize(size)}</span>}
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)" }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
      </div>
      <ReadOnlyNotice />
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "var(--file-panel-surface-panel, var(--bg-panel))",
        }}
      >
        <div style={{ width: "min(680px, 100%)" }}>
          {error && (
            <div style={{ color: "#f87171", fontSize: "var(--text-base)", marginBottom: 12, textAlign: "center" }}>
              {error}
            </div>
          )}
          <audio
            key={src}
            controls
            preload="metadata"
            src={src}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
            onError={() => setError("Failed to load audio")}
            style={{ width: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function DocumentViewer({ filePath, cwd, sourceSessionId, active = true }: Props) {
  const { t } = useI18n();
  const [watching, setWatching] = useState(false);
  const [bust, setBust] = useState(0);
  const [size, setSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const ext = getFileExt(filePath);
  const isPdf = ext === "pdf";
  const previewUrl = isPdf
    ? getFileApiUrl(filePath, "read", sourceSessionId, bust ? { v: bust } : undefined)
    : getFileApiUrl(filePath, "preview", sourceSessionId, bust ? { v: bust } : undefined);

  useEffect(() => {
    setBust(0);
    setSize(null);
    setError(null);
    setWatching(false);

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    if (!active) return;

    fetch(getFileApiUrl(filePath, "meta", sourceSessionId))
      .then((r) => r.json())
      .then((d: { size?: number; error?: string }) => {
        if (d.error) setError(d.error);
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
          }
        }
      })
      .catch((e) => setError(String(e)));

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => setWatching(true));
    es.addEventListener("change", (e) => {
      try {
        const d = JSON.parse((e as MessageEvent).data) as { size?: number };
        if (typeof d.size === "number") {
          setSize(d.size);
          if (!isPdf && d.size > DOCX_PREVIEW_MAX_BYTES) {
            setError("DOCX too large for preview (>10MB)");
            return;
          }
        }
      } catch { /* ignore */ }
      setError(null);
      setBust((b) => b + 1);
    });
    es.addEventListener("error", () => setWatching(false));
    es.onerror = () => setWatching(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [active, filePath, isPdf, sourceSessionId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "4px 16px",
          borderBottom: "1px solid var(--border)",
          fontSize: "var(--text-xs)",
          color: "var(--text-dim)",
          background: "var(--file-panel-surface, var(--bg))",
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>
        <span style={{ marginLeft: "auto" }}>{ext === "docx" ? "docx preview" : "pdf"}</span>
        {size != null && <span>{formatSize(size)}</span>}
        <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
        <span
          title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
          style={{ display: "flex", alignItems: "center", gap: 4, color: watching ? "#4ade80" : "var(--text-dim)", flexShrink: 0 }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: watching ? "#4ade80" : "var(--border)",
              display: "inline-block",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
          {watching ? "live" : "static"}
        </span>
      </div>
      <ReadOnlyNotice />
      <div style={{ flex: 1, minHeight: 0, background: "var(--file-panel-surface-panel, var(--bg-panel))" }}>
        {error ? (
          <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f87171", fontSize: "var(--text-base)", textAlign: "center" }}>
            {error}
          </div>
        ) : (
          <iframe
            key={previewUrl}
            src={previewUrl}
            sandbox={isPdf ? undefined : ""}
            title={t("i18n.previewFile", { file: getFileName(filePath) })}
            style={{ width: "100%", height: "100%", border: "none", background: isPdf ? "var(--file-panel-surface, var(--bg))" : "#eef1f5" }}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  gitRefreshKey,
  initialDisplayMode,
  revealLine,
  revealKey,
  active = true,
  onDirtyChange,
  onSaved,
}: Props) {
  const viewerKind = getFileViewerKind(filePath);
  if (viewerKind === "image") {
    return <ImageViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} active={active} />;
  }
  if (viewerKind === "audio") {
    return <AudioViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} active={active} />;
  }
  if (viewerKind === "document") {
    return <DocumentViewer filePath={filePath} cwd={cwd} sourceSessionId={sourceSessionId} active={active} />;
  }
  return (
    <TextFileViewer
      filePath={filePath}
      cwd={cwd}
      sourceSessionId={sourceSessionId}
      onOpenFile={onOpenFile}
      onMentionLines={onMentionLines}
      gitRefreshKey={gitRefreshKey}
      initialDisplayMode={initialDisplayMode}
      revealLine={revealLine}
      revealKey={revealKey}
      active={active}
      onDirtyChange={onDirtyChange}
      onSaved={onSaved}
    />
  );
}

function TextFileViewer({
  filePath,
  cwd,
  sourceSessionId,
  onOpenFile,
  onMentionLines,
  gitRefreshKey,
  initialDisplayMode,
  revealLine,
  revealKey,
  active = true,
  onDirtyChange,
  onSaved,
}: Props) {
  const updateBlockerId = useId();
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<FileData | null>(null);
  const [gitDiff, setGitDiff] = useState<GitFileDiffResponse | null>(null);
  const [gitDiffLoading, setGitDiffLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("edit");
  const [wrapLines, setWrapLines] = useState(false);
  const [watching, setWatching] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState<FileConflictData | null>(null);
  const [conflictDecision, setConflictDecision] = useState<ConflictDecision | null>(null);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const conflictConfirmRef = useRef<HTMLButtonElement | null>(null);
  const loadedRef = useRef(false);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const draftContentRef = useRef("");
  const expectedVersionRef = useRef("");
  const gitDiffRequestRef = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!active || !revealLine || loading || !data) return;
    const timer = window.setTimeout(() => {
      if (displayMode === "edit" && editorRef.current) {
        const lines = editorRef.current.value.split(/\r?\n/);
        const target = Math.max(1, Math.min(revealLine, lines.length));
        let offset = 0;
        for (let index = 0; index < target - 1; index += 1) offset += lines[index].length + 1;
        editorRef.current.focus();
        editorRef.current.setSelectionRange(offset, offset + (lines[target - 1]?.length ?? 0));
        const lineHeight = Number.parseFloat(getComputedStyle(editorRef.current).lineHeight) || 20;
        editorRef.current.scrollTop = Math.max(0, (target - 3) * lineHeight);
      } else {
        const line = contentRef.current?.querySelector<HTMLElement>(`.file-source-line[data-line-number="${revealLine}"]`);
        line?.scrollIntoView({ block: "center" });
        line?.classList.add("search-reveal-line");
        window.setTimeout(() => line?.classList.remove("search-reveal-line"), 1_600);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [active, data, displayMode, loading, revealKey, revealLine]);
  const [selectedLineRange, setSelectedLineRange] = useState<SelectedLineRange | null>(null);

  const dirty = draftContent !== savedContent;
  dirtyRef.current = dirty;
  savingRef.current = saving;
  draftContentRef.current = draftContent;
  expectedVersionRef.current = expectedVersion;

  const fetchContent = useCallback((targetPath: string, replaceDraft = true) => {
    return fetch(getFileApiUrl(targetPath, "read", sourceSessionId))
      .then(async (response) => {
        const next = await response.json() as FileData & { error?: string };
        if (!response.ok || next.error) {
          throw new Error(next.error ?? `HTTP ${response.status}`);
        }
        return next;
      })
      .then((next) => {
        setError(null);
        setData(next);
        loadedRef.current = true;
        if (replaceDraft) {
          setDraftContent(next.content);
          setSavedContent(next.content);
          setExpectedVersion(next.version);
          draftContentRef.current = next.content;
          expectedVersionRef.current = next.version;
          dirtyRef.current = false;
          setExternalChange(null);
          setConflictDecision(null);
          setSaveError(null);
        } else if (next.version !== expectedVersionRef.current) {
          setConflictDecision(null);
          setExternalChange({
            code: "FILE_CONFLICT",
            currentVersion: next.version,
            mtime: next.mtime,
            size: next.size,
            notice: "changed",
          });
        }
        return next;
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (replaceDraft && !dirtyRef.current) {
          setError(message);
        } else {
          setConflictDecision(null);
          setExternalChange({
            error: message,
            code: "FILE_CONFLICT",
            notice: "refreshFailed",
          });
        }
        return null;
      });
  }, [sourceSessionId]);

  const fetchGitDiff = useCallback(async (targetPath: string) => {
    const requestId = ++gitDiffRequestRef.current;
    setGitDiffLoading(true);
    if (!cwd) {
      setGitDiff(null);
      setGitDiffLoading(false);
      return;
    }

    try {
      const params = new URLSearchParams({ cwd, path: targetPath });
      const response = await fetch(`/api/git/diff?${params.toString()}`);
      const next = await response.json() as GitFileDiffResponse & { error?: string };
      if (requestId !== gitDiffRequestRef.current) return;
      setGitDiff(response.ok && next.supported && typeof next.patch === "string" ? next : null);
    } catch {
      if (requestId === gitDiffRequestRef.current) setGitDiff(null);
    } finally {
      if (requestId === gitDiffRequestRef.current) setGitDiffLoading(false);
    }
  }, [cwd]);

  // Reset only when this mounted viewer is repointed to a different file.
  // Active-tab changes must not reset the draft.
  useEffect(() => {
    setLoading(true);
    setError(null);
    setData(null);
    setGitDiff(null);
    setDisplayMode("edit");
    setWrapLines(false);
    setWatching(false);
    setDraftContent("");
    setSavedContent("");
    setExpectedVersion("");
    setSaving(false);
    setSaveError(null);
    setExternalChange(null);
    setConflictDecision(null);
    setCursorPosition({ line: 1, column: 1 });
    setEditorScrollTop(0);
    loadedRef.current = false;
    dirtyRef.current = false;
    savingRef.current = false;
    draftContentRef.current = "";
    expectedVersionRef.current = "";

    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, [filePath]);

  // Only the active tab keeps an EventSource open. Inactive viewers stay
  // mounted so their unsaved drafts, cursor and view mode survive tab switches.
  useEffect(() => {
    if (!active) {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setWatching(false);
      return;
    }

    const replaceDraft = !dirtyRef.current;
    if (!loadedRef.current) setLoading(true);
    fetchContent(filePath, replaceDraft).finally(() => setLoading(false));

    const es = new EventSource(getFileApiUrl(filePath, "watch", sourceSessionId));
    esRef.current = es;

    es.addEventListener("connected", () => {
      setWatching(true);
    });

    es.addEventListener("change", (event) => {
      if (dirtyRef.current || savingRef.current) {
        if (!savingRef.current) {
          let details: FileConflictData = {
            code: "FILE_CONFLICT",
            notice: "changed",
          };
          try {
            details = {
              ...details,
              ...JSON.parse((event as MessageEvent).data) as FileConflictData,
              notice: "changed",
            };
          } catch { /* keep the generic notice */ }
          setConflictDecision(null);
          setExternalChange(details);
        }
      } else {
        void fetchContent(filePath, true);
      }
      void fetchGitDiff(filePath);
    });

    es.addEventListener("error", () => {
      setWatching(false);
    });

    es.onerror = () => {
      setWatching(false);
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [active, filePath, fetchContent, fetchGitDiff, sourceSessionId]);

  useEffect(() => {
    if (active) void fetchGitDiff(filePath);
  }, [active, fetchGitDiff, filePath, gitRefreshKey]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const key = `file:${updateBlockerId}`;
    void window.piDesktop?.setUpdateBlocker?.(key, dirty || saving);
    return () => { void window.piDesktop?.setUpdateBlocker?.(key, false); };
  }, [updateBlockerId, dirty, saving]);

  const hasGitDiff = gitDiff?.supported === true && typeof gitDiff.patch === "string";
  const isDeletedDiff = hasGitDiff && gitDiff.status === "deleted";

  useEffect(() => {
    if (!hasGitDiff && displayMode === "diff") setDisplayMode("source");
  }, [displayMode, hasGitDiff]);

  useEffect(() => {
    if (!isDeletedDiff || !esRef.current) return;
    esRef.current.close();
    esRef.current = null;
    setWatching(false);
  }, [isDeletedDiff]);

  // File-tree and linked text files start in edit mode. Explicit callers (the
  // Changes list uses `diff`) may still request another initial view once that
  // view is available. Apply the hint only once so a user's later view choice
  // is not overwritten.
  const initialDisplayModeAppliedRef = useRef(false);
  useEffect(() => {
    initialDisplayModeAppliedRef.current = false;
  }, [filePath]);
  useEffect(() => {
    if (!initialDisplayMode || initialDisplayModeAppliedRef.current) return;
    if (initialDisplayMode === "diff" && !hasGitDiff) return;
    if (initialDisplayMode === "preview" && data?.language !== "markdown" && data?.language !== "html") return;
    initialDisplayModeAppliedRef.current = true;
    setDisplayMode(initialDisplayMode);
  }, [data?.language, initialDisplayMode, hasGitDiff]);

  const updateCursorPosition = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (!textarea) return;
    setCursorPosition(getEditorCursorPosition(textarea.value, textarea.selectionStart));
  }, []);

  const applyEditorValue = useCallback((
    nextValue: string,
    selectionStart: number,
    selectionEnd = selectionStart,
  ) => {
    setDraftContent(nextValue);
    draftContentRef.current = nextValue;
    setSaveError(null);
    requestAnimationFrame(() => {
      const textarea = editorRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
      updateCursorPosition(textarea);
    });
  }, [updateCursorPosition]);

  const saveFile = useCallback(async (force = false) => {
    if (savingRef.current) return;

    const contentToSave = draftContentRef.current;
    if (!force && contentToSave === savedContent) return;

    setSaving(true);
    savingRef.current = true;
    setSaveError(null);

    try {
      const response = await fetch(getFileWriteApiUrl(filePath), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: contentToSave,
          expectedVersion: expectedVersionRef.current,
          ...(force ? { force: true } : {}),
        }),
      });
      const next = await response.json().catch(() => ({})) as Partial<FileData> & FileConflictData;

      if (response.status === 409 || next.code === "FILE_CONFLICT") {
        setConflictDecision(null);
        setExternalChange({
          ...next,
          code: "FILE_CONFLICT",
          notice: "changed",
        });
        return;
      }
      if (!response.ok || next.error) {
        throw new Error(next.error ?? `HTTP ${response.status}`);
      }
      if (typeof next.version !== "string") {
        throw new Error(t("fileEditor.saveMissingVersion"));
      }

      const savedData: FileData = {
        content: typeof next.content === "string" ? next.content : contentToSave,
        language: typeof next.language === "string" ? next.language : (data?.language ?? "text"),
        size: typeof next.size === "number" ? next.size : utf8ByteLength(contentToSave),
        version: next.version,
        mtime: typeof next.mtime === "string" ? next.mtime : new Date().toISOString(),
      };
      setData(savedData);
      setSavedContent(contentToSave);
      setExpectedVersion(savedData.version);
      expectedVersionRef.current = savedData.version;
      dirtyRef.current = draftContentRef.current !== contentToSave;
      setExternalChange(null);
      onSaved?.();
      void fetchGitDiff(filePath);
    } catch (cause: unknown) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [data?.language, fetchGitDiff, filePath, onSaved, savedContent, t]);

  const reloadFromDisk = useCallback(async () => {
    setConflictDecision(null);
    setLoading(true);
    const next = await fetchContent(filePath, true);
    setLoading(false);
    if (next) {
      setExternalChange(null);
      void fetchGitDiff(filePath);
    }
  }, [fetchContent, fetchGitDiff, filePath]);

  const overwriteDisk = useCallback(() => {
    setConflictDecision(null);
    void saveFile(true);
  }, [saveFile]);

  useEffect(() => {
    if (conflictDecision) conflictConfirmRef.current?.focus();
  }, [conflictDecision]);

  const handleEditorKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveFile(false);
      return;
    }
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey) return;

    event.preventDefault();
    const textarea = event.currentTarget;
    const value = textarea.value;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const indent = "  ";

    if (start === end && !event.shiftKey) {
      applyEditorValue(`${value.slice(0, start)}${indent}${value.slice(end)}`, start + indent.length);
      return;
    }

    const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const nextNewline = value.indexOf("\n", end);
    const blockEnd = nextNewline === -1 ? value.length : nextNewline;
    const block = value.slice(blockStart, blockEnd);
    const blockLines = block.split("\n");

    if (event.shiftKey) {
      const removedWidths: number[] = [];
      const updatedBlock = blockLines.map((line) => {
        const match = line.match(/^(?: {1,2}|\t)/);
        const removed = match?.[0].length ?? 0;
        removedWidths.push(removed);
        return line.slice(removed);
      }).join("\n");
      const removedBeforeStart = Math.min(removedWidths[0] ?? 0, start - blockStart);
      const totalRemoved = removedWidths.reduce((total, width) => total + width, 0);
      const nextStart = Math.max(blockStart, start - removedBeforeStart);
      const nextEnd = Math.max(nextStart, end - totalRemoved);
      applyEditorValue(
        `${value.slice(0, blockStart)}${updatedBlock}${value.slice(blockEnd)}`,
        nextStart,
        nextEnd,
      );
      return;
    }

    const updatedBlock = blockLines.map((line) => `${indent}${line}`).join("\n");
    const nextStart = start + indent.length;
    const nextEnd = end + (indent.length * blockLines.length);
    applyEditorValue(
      `${value.slice(0, blockStart)}${updatedBlock}${value.slice(blockEnd)}`,
      nextStart,
      nextEnd,
    );
  }, [applyEditorValue, saveFile]);

  const handleEditorScroll = useCallback((event: ReactUIEvent<HTMLTextAreaElement>) => {
    setEditorScrollTop(event.currentTarget.scrollTop);
  }, []);

  useEffect(() => {
    if (!active || displayMode !== "edit") return;
    const focusFrame = requestAnimationFrame(() => editorRef.current?.focus());
    return () => cancelAnimationFrame(focusFrame);
  }, [active, displayMode]);

  useEffect(() => {
    if (!active || displayMode !== "edit") return;
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key.toLowerCase() !== "s" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      void saveFile(false);
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [active, displayMode, saveFile]);

  const markdownPreview = useMemo(
    () => (data?.language === "markdown" ? normalizeDisplayMath(draftContent) : ""),
    [data?.language, draftContent],
  );
  const markdownPreviewRehypePluginsWithMath = useMarkdownRehypePlugins(markdownPreview, true);

  useEffect(() => {
    const updateSelectedLineRange = () => {
      const root = contentRef.current;
      setSelectedLineRange(
        onMentionLines && displayMode === "source" && root
          ? getSelectedSourceLineRange(root, window.getSelection())
          : null,
      );
    };

    updateSelectedLineRange();
    if (!onMentionLines || displayMode !== "source") return;

    document.addEventListener("selectionchange", updateSelectedLineRange);
    return () => document.removeEventListener("selectionchange", updateSelectedLineRange);
  }, [draftContent, displayMode, onMentionLines]);

  const mentionLineRange = useCallback((lineRange: SelectedLineRange | null) => {
    if (!onMentionLines || !lineRange) return;
    onMentionLines(
      getRelativeFilePath(filePath, cwd),
      lineRange.startLine,
      lineRange.endLine,
    );
  }, [cwd, filePath, onMentionLines]);

  const handleMentionSelectedLines = useCallback(() => {
    mentionLineRange(selectedLineRange);
  }, [mentionLineRange, selectedLineRange]);

  useEffect(() => {
    if (!onMentionLines || displayMode !== "source") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.key.toLowerCase() !== "i" || (!event.metaKey && !event.ctrlKey) || event.altKey || event.shiftKey) return;

      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, [contenteditable='true']")) return;

      const root = contentRef.current;
      const lineRange = root ? getSelectedSourceLineRange(root, window.getSelection()) : null;
      if (!lineRange) return;

      event.preventDefault();
      mentionLineRange(lineRange);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [displayMode, mentionLineRange, onMentionLines]);

  if (loading || (initialDisplayMode === "diff" && gitDiffLoading && !data)) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: "var(--text-base)" }}>
        {t("i18n.loading")}
      </div>
    );
  }

  if (error && !isDeletedDiff) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#f87171", fontSize: "var(--text-base)" }}>
        {error}
      </div>
    );
  }

  if (!data && !isDeletedDiff) return null;

  const language = data?.language ?? "text";
  const content = draftContent;
  const isHtml = language === "html";
  const isMarkdown = language === "markdown";
  const hasPreview = isHtml || isMarkdown;
  const markdownDirectory = getFileDirectory(filePath);
  const lines = content.split("\n");
  const effectiveDisplayMode = isDeletedDiff ? "diff" : displayMode;
  const displayModes: DisplayMode[] = isDeletedDiff
    ? ["diff"]
    : [
        "edit",
        "source",
        ...(hasPreview ? ["preview" as const] : []),
        ...(hasGitDiff ? ["diff" as const] : []),
      ];
  const metadata = isDeletedDiff
    ? t("files.deleted")
    : `${language} · ${t(lines.length === 1 ? "fileEditor.lineCountOne" : "fileEditor.lineCount", { count: lines.length })} · ${formatSize(dirty ? utf8ByteLength(content) : data!.size)}`;
  const externalChangeMessage = externalChange?.notice === "refreshFailed"
    ? t("fileEditor.refreshFailed", { error: externalChange.error ?? t("i18n.unknown") })
    : t("fileEditor.externalChangeBody");

  return (
    <div className={`${editorStyles.container} file-viewer-shell`} style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div
        className="file-viewer-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px",
          borderBottom: "1px solid var(--border)",
          fontSize: "var(--text-xs)",
          color: "var(--text-dim)",
          background: "var(--file-panel-surface, var(--bg))",
          flexShrink: 0,
        }}
      >
        <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
          {getRelativeFilePath(filePath, cwd)}
        </span>

        <span className="file-viewer-meta" title={metadata}>{metadata}</span>
        {!isDeletedDiff && (
          <span
            title={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            aria-label={watching ? t("i18n.liveSync") : t("i18n.notWatching")}
            className="file-viewer-live-indicator"
            style={{
              background: watching ? "#4ade80" : "var(--border)",
              boxShadow: watching ? "0 0 4px #4ade80" : "none",
            }}
          />
        )}

        <div className="file-viewer-controls">
          {displayModes.length > 1 && (
            <div className="file-viewer-mode-switch" aria-label={t("i18n.fileViewMode")}>
              {displayModes.map((mode) => {
                const active = effectiveDisplayMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setDisplayMode(mode)}
                    title={mode === "diff" ? t("i18n.compareHead") : mode === "edit" ? t("fileEditor.editModeTitle") : undefined}
                    aria-label={mode === "edit" ? t("fileEditor.editModeTitle") : t(DISPLAY_MODE_LABEL_KEYS[mode])}
                    aria-pressed={active}
                    className={`file-viewer-mode-button${mode === "edit" ? ` ${editorStyles.editModeButton}` : ""}`}
                    data-active={mode === "edit" && active ? "true" : undefined}
                    style={{
                      background: active ? "var(--bg-selected)" : "transparent",
                      color: active ? "var(--text)" : "var(--text-muted)",
                    }}
                  >
                    {mode === "edit" && (
                      <AliIcon name="edit" size={12} />
                    )}
                    {t(DISPLAY_MODE_LABEL_KEYS[mode])}
                  </button>
                );
              })}
            </div>
          )}

          <div className="file-viewer-actions">
            {effectiveDisplayMode === "source" && (
              <>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleMentionSelectedLines}
                  title={t("i18n.mentionSelectedLines")}
                  aria-label={t("i18n.mentionSelectedLines")}
                  disabled={!selectedLineRange}
                  className="file-viewer-icon-button"
                >
                  <MentionIcon />
                </button>
                <button
                  type="button"
                  onClick={() => setWrapLines((value) => !value)}
                  title={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-label={wrapLines ? t("i18n.disableWrap") : t("i18n.enableWrap")}
                  aria-pressed={wrapLines}
                  className="file-viewer-icon-button"
                  style={{
                    background: wrapLines ? "var(--bg-selected)" : "transparent",
                    color: wrapLines ? "var(--text)" : "var(--text-muted)",
                  }}
                >
                  <AliIcon name="enter" size={14} />
                </button>
              </>
            )}
          </div>

          {!isDeletedDiff && (
            <button
              type="button"
              onClick={() => void saveFile(false)}
              disabled={!dirty || saving}
              className={editorStyles.saveButton}
              title={dirty ? t("fileEditor.saveShortcutTitle") : t("fileEditor.noUnsavedChanges")}
              aria-label={saving ? t("fileEditor.savingFile") : t("fileEditor.saveFile")}
              aria-keyshortcuts="Control+S Meta+S"
            >
              {saving ? (
                <span className={editorStyles.spinner} aria-hidden="true" />
              ) : (
                <AliIcon name="save" size={13} />
              )}
              <span className={editorStyles.saveLabel}>{saving ? t("i18n.saving") : dirty ? t("i18n.save") : t("i18n.saved")}</span>
            </button>
          )}

          {!isDeletedDiff && <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />}
        </div>
      </div>

      {externalChange && !isDeletedDiff && (
        <div
          className={editorStyles.conflictBanner}
          role="alert"
          aria-live="polite"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !conflictDecision) return;
            event.preventDefault();
            setConflictDecision(null);
          }}
        >
          <div className={`${editorStyles.noticeCopy} ${conflictDecision ? editorStyles.confirmationCopy : ""}`}>
            <strong>
              {conflictDecision === "reload"
                ? t("fileEditor.reloadConfirmTitle")
                : conflictDecision === "overwrite"
                  ? t("fileEditor.overwriteConfirmTitle")
                  : t("fileEditor.externalChangeTitle")}
            </strong>
            <span>
              {conflictDecision === "reload"
                ? t("fileEditor.reloadConfirmBody")
                : conflictDecision === "overwrite"
                  ? t("fileEditor.overwriteConfirmBody")
                  : externalChangeMessage}
            </span>
          </div>
          <div className={editorStyles.noticeActions}>
            {conflictDecision ? (
              <>
                <button type="button" onClick={() => setConflictDecision(null)} disabled={saving}>
                  {t("i18n.cancel")}
                </button>
                <button
                  ref={conflictConfirmRef}
                  type="button"
                  className={editorStyles.dangerAction}
                  onClick={conflictDecision === "reload" ? () => void reloadFromDisk() : overwriteDisk}
                  disabled={saving}
                >
                  {conflictDecision === "reload" ? t("fileEditor.confirmReload") : t("fileEditor.confirmOverwrite")}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setExternalChange(null);
                    setDisplayMode("edit");
                    requestAnimationFrame(() => editorRef.current?.focus());
                  }}
                  disabled={saving}
                >
                  {t("fileEditor.keepEditing")}
                </button>
                <button type="button" onClick={() => setConflictDecision("reload")} disabled={saving}>
                  {t("fileEditor.reloadDisk")}
                </button>
                <button type="button" className={editorStyles.dangerAction} onClick={() => setConflictDecision("overwrite")} disabled={saving}>
                  {t("fileEditor.overwrite")}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {saveError && !isDeletedDiff && (
        <div className={editorStyles.errorBanner} role="alert">
          <span><strong>{t("fileEditor.saveFailed")}</strong> {saveError}</span>
          <div className={editorStyles.noticeActions}>
            <button type="button" onClick={() => void saveFile(false)}>{t("fileEditor.tryAgain")}</button>
            <button type="button" onClick={() => setSaveError(null)} aria-label={t("fileEditor.dismissSaveError")}>{t("fileEditor.dismiss")}</button>
          </div>
        </div>
      )}

      {/* Content area */}
      <div
        ref={contentRef}
        className="file-viewer-content"
        style={{
          flex: 1,
          overflow: effectiveDisplayMode === "edit" ? "hidden" : "auto",
          background: "var(--file-panel-surface, var(--bg))",
        }}
      >
        {effectiveDisplayMode === "edit" ? (
          <div className={`${editorStyles.editorShell} file-editor-shell`}>
            <div className={editorStyles.editorBody}>
              <div className={`${editorStyles.lineNumberViewport} file-editor-gutter`} aria-hidden="true">
                <div
                  className={editorStyles.lineNumbers}
                  style={{ transform: `translateY(${-editorScrollTop}px)` }}
                >
                  {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
                </div>
              </div>
              <textarea
                ref={editorRef}
                className={`${editorStyles.textarea} file-editor-textarea`}
                value={draftContent}
                wrap="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={t("fileEditor.editFile", { file: getFileName(filePath) })}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setDraftContent(nextValue);
                  draftContentRef.current = nextValue;
                  setSaveError(null);
                  updateCursorPosition(event.currentTarget);
                }}
                onKeyDown={handleEditorKeyDown}
                onKeyUp={(event) => updateCursorPosition(event.currentTarget)}
                onClick={(event) => updateCursorPosition(event.currentTarget)}
                onSelect={(event) => updateCursorPosition(event.currentTarget)}
                onScroll={handleEditorScroll}
              />
            </div>
            <div className={`${editorStyles.statusBar} file-editor-status`}>
              <span className={dirty ? editorStyles.unsavedStatus : editorStyles.savedStatus}>
                <span className={editorStyles.statusDot} aria-hidden="true" />
                {dirty ? t("fileEditor.unsaved") : t("i18n.saved")}
              </span>
              <span>{t("fileEditor.cursorPosition", { line: cursorPosition.line, column: cursorPosition.column })}</span>
              <span>UTF-8</span>
              <span>{formatSize(utf8ByteLength(draftContent))}</span>
            </div>
          </div>
        ) : effectiveDisplayMode === "diff" && hasGitDiff ? (
          <DiffView patch={gitDiff.patch!} />
        ) : isHtml && effectiveDisplayMode === "preview" ? (
          <iframe
            srcDoc={content}
            sandbox="allow-scripts"
            style={{ width: "100%", height: "100%", border: "none", background: "var(--file-panel-surface, var(--bg))" }}
             title={t("i18n.htmlPreview")}
          />
        ) : isMarkdown && effectiveDisplayMode === "preview" ? (
          <div
            className="markdown-body markdown-file-preview"
            style={{ padding: "24px 32px" }}
          >
            <ReactMarkdown
              remarkPlugins={markdownPreviewRemarkPlugins}
              rehypePlugins={markdownPreviewRehypePluginsWithMath}
              components={{
                code({ className, children, ...props }) {
                  const lang = className?.replace("language-", "").toLowerCase() ?? "";
                  const raw = String(children);
                  const isBlock = className?.includes("language-") || raw.includes("\n");
                  if (isBlock) {
                    if (lang === "mermaid") {
                      return <MermaidBlock code={raw.replace(/\n$/, "")} defaultPreview />;
                    }
                    return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} />;
                  }
                  return (
                    <code className={className} {...props}>
                      {children}
                    </code>
                  );
                },
                pre({ children }) {
                  // Render the code block directly — CodeBlock provides its own wrapping.
                  // For non-mermaid blocks, pass through to default pre rendering.
                  return <>{children}</>;
                },
                a({ href, children, ...props }) {
                  delete props.node;
                  const linkedFile = onOpenFile
                    ? resolveLocalFileHref(href, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  if (!linkedFile || !onOpenFile) {
                    return <a href={href} {...props}>{children}</a>;
                  }

                  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
                    if (event.defaultPrevented || event.button !== 0) return;
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    onOpenFile(linkedFile);
                  };

                  return <a href={href} {...props} onClick={handleClick}>{children}</a>;
                },
                img({ src, alt, ...props }) {
                  delete props.node;
                  const imagePath = typeof src === "string"
                    ? resolveLocalFileHref(src, markdownDirectory, cwd ?? markdownDirectory)
                    : null;
                  const imageSrc = imagePath
                    ? getFileApiUrl(imagePath, "read", sourceSessionId)
                    : src;
                  // Dynamic local paths are served directly by the file API.
                  // eslint-disable-next-line @next/next/no-img-element
                  return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
                },
              }}
            >
              {markdownPreview}
            </ReactMarkdown>
          </div>
        ) : (
          <SyntaxHighlighter
            className={wrapLines ? "file-source-view is-wrapped" : "file-source-view"}
            language={language === "text" ? "plaintext" : language}
            style={isDark ? vscDarkPlus : vs}
            showLineNumbers
            lineNumberStyle={{
              ...FILE_LINE_NUMBER_STYLE,
            }}
            customStyle={{
              margin: 0,
              padding: 0,
              border: 0,
              background: "var(--file-panel-surface, var(--bg))",
              ...FILE_CODE_STYLE,
              width: wrapLines ? "100%" : "max-content",
              minWidth: "100%",
              minHeight: "100%",
              overflow: "visible",
            }}
            codeTagProps={{
              style: {
                fontFamily: "var(--font-mono)",
                overflowWrap: wrapLines ? "anywhere" : "normal",
              },
            }}
            renderer={(rendererProps) => (
              <SourceCodeRenderer {...rendererProps} wrapLines={wrapLines} />
            )}
            wrapLongLines={wrapLines}
          >
            {content}
          </SyntaxHighlighter>
        )}
      </div>
    </div>
  );
}
