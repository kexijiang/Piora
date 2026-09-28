"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import vs from "react-syntax-highlighter/dist/esm/styles/prism/vs";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { parseUnifiedDiff, type DiffFile, type DiffLine, type Hunk } from "@/lib/diff-parse";
import { DIFF_PROGRESSIVE_THRESHOLD, DIFF_RENDER_BATCH, getDiffRenderWindow, getNextDiffRenderCount } from "@/lib/diff-progressive";
import { AliIcon } from "./AliIcon";
import { LazySyntaxHighlighter as SyntaxHighlighter } from "./LazySyntaxHighlighter";
import styles from "./DiffView.module.css";

export interface DiffViewProps {
  patch: string;
  className?: string;
  filePath?: string;
  language?: string;
  mode?: "unified" | "split";
  contextLines?: number;
  collapsed?: boolean;
  showFileHeader?: boolean;
  hunkActions?: (hunk: Hunk) => ReactNode;
  onOpenFile?: (path: string, line: number) => void;
  onExpandContext?: () => void;
  contextLoading?: boolean;
  totalLines?: number;
  /** One-based row in the parsed patch, including removed rows. */
  revealDiffLine?: { line: number; key: number } | null;
}

const HIGHLIGHT_LIMIT = 600;

export function DiffView({
  patch,
  className,
  filePath,
  language,
  mode = "unified",
  contextLines = 3,
  collapsed = false,
  showFileHeader = true,
  hunkActions,
  onOpenFile,
  onExpandContext,
  contextLoading = false,
  totalLines,
  revealDiffLine,
}: DiffViewProps) {
  const { t } = useI18n();
  const parsed = useMemo(() => parseUnifiedDiff(patch), [patch]);
  const [renderBudget, setRenderBudget] = useState(() => ({ patch, lines: DIFF_RENDER_BATCH }));
  const [collapsedHunks, setCollapsedHunks] = useState<Set<string>>(() => new Set());
  const requestedLines = parsed.lineCount <= DIFF_PROGRESSIVE_THRESHOLD
    ? parsed.lineCount
    : renderBudget.patch === patch ? renderBudget.lines : DIFF_RENDER_BATCH;
  const renderWindow = getDiffRenderWindow(parsed.lineCount, Math.max(requestedLines, revealDiffLine?.line ?? 0));
  const limited = renderWindow.remaining > 0;
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const appliedRevealRef = useRef<typeof revealDiffLine>(null);
  let remaining = renderWindow.endIndex;

  const loadMore = useCallback(() => {
    startTransition(() => {
      setRenderBudget((current) => ({
        patch,
        lines: getNextDiffRenderCount(current.patch === patch ? current.lines : DIFF_RENDER_BATCH, parsed.lineCount),
      }));
    });
  }, [parsed.lineCount, patch]);

  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!limited || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMore();
    }, { rootMargin: "240px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [limited, loadMore]);

  useEffect(() => {
    setCollapsedHunks(new Set());
  }, [patch]);

  useEffect(() => {
    if (!revealDiffLine) return;
    setRenderBudget((current) => ({ patch, lines: Math.max(current.patch === patch ? current.lines : DIFF_RENDER_BATCH, revealDiffLine.line) }));
    let offset = 0;
    for (const [fileIndex, file] of parsed.files.entries()) {
      for (const [hunkIndex, hunk] of file.hunks.entries()) {
        if (revealDiffLine.line > offset && revealDiffLine.line <= offset + hunk.lines.length) {
          const key = `${fileIndex}:${hunkIndex}`;
          setCollapsedHunks((current) => {
            if (!current.has(key)) return current;
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          return;
        }
        offset += hunk.lines.length;
      }
    }
  }, [parsed, patch, revealDiffLine]);

  useEffect(() => {
    if (!revealDiffLine || appliedRevealRef.current === revealDiffLine) return;
    const frame = requestAnimationFrame(() => {
      const target = rootRef.current?.querySelector<HTMLElement>(`[data-diff-line="${revealDiffLine.line}"]`) ?? null;
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      appliedRevealRef.current = revealDiffLine;
    });
    return () => cancelAnimationFrame(frame);
  }, [revealDiffLine, renderWindow.endIndex, collapsedHunks]);

  if (parsed.files.length === 0) return <div className={styles.notice}>{t("diff.empty")}</div>;

  return (
    <div ref={rootRef} className={`${styles.root}${className ? ` ${className}` : ""}`} data-context-lines={contextLines}>
      {parsed.files.map((file, fileIndex) => {
        if (remaining <= 0) return null;
        const displayPath = filePath ?? bestPath(file);
        return (
          <section key={`${displayPath}-${fileIndex}`}>
            {showFileHeader ? <div className={styles.fileHeader}>
              <span className={styles.filePath} title={displayPath}>{displayPath || t("diff.unknownFile")}</span>
              <span className={styles.fileStatus}>{t(`diff.status.${file.status}`)}</span>
              {displayPath && onOpenFile && (
                <button className={styles.button} type="button" onClick={() => onOpenFile(displayPath, firstLine(file))} title={t("diff.openFile")} aria-label={t("diff.openFile")}>
                  <AliIcon name="file" size={13} />
                </button>
              )}
              <button className={styles.button} type="button" onClick={() => void navigator.clipboard.writeText(patch)} title={t("diff.copy")} aria-label={t("diff.copy")}>
                <AliIcon name="copy" size={13} />
              </button>
            </div> : null}
            {file.binary ? <div className={styles.notice}>{t("diff.binary")}</div> : file.hunks.map((hunk, hunkIndex) => {
              if (remaining <= 0) return null;
              const key = `${fileIndex}:${hunkIndex}`;
              const isCollapsed = collapsed || collapsedHunks.has(key);
              const previousHunk = file.hunks[hunkIndex - 1];
              const hiddenBefore = previousHunk
                ? Math.max(0, hunk.oldStart - (previousHunk.oldStart + previousHunk.oldCount))
                : Math.max(0, Math.min(hunk.oldStart, hunk.newStart) - 1);
              const isLastHunk = hunkIndex === file.hunks.length - 1;
              const displayedEnd = file.status === "deleted"
                ? hunk.oldStart + hunk.oldCount - 1
                : hunk.newStart + hunk.newCount - 1;
              const hiddenAfter = isLastHunk && totalLines !== undefined
                ? Math.max(0, totalLines - displayedEnd)
                : 0;
              const expandsContext = hiddenBefore > 0 && Boolean(onExpandContext);
              const lines = hunk.lines.slice(0, remaining);
              const lineOffset = renderWindow.endIndex - remaining;
              remaining -= lines.length;
              return (
                <div key={key}>
                  <div className={styles.hunk}>
                    <button
                      type="button"
                      className={styles.hunkToggle}
                      title={hunk.header}
                      disabled={expandsContext && contextLoading}
                      onClick={() => {
                        if (expandsContext) onExpandContext?.();
                        else setCollapsedHunks((current) => toggleSet(current, key));
                      }}
                      aria-expanded={expandsContext ? false : !isCollapsed}
                    ><span className={styles.hunkChevron} aria-hidden="true"><AliIcon name={contextLoading && expandsContext ? "reload" : "chevron-right"} size={12} /></span>{contextLoading && expandsContext ? t("diff.loadingContext") : hiddenBefore > 0 ? t("diff.unchangedLines", { count: hiddenBefore }) : t("diff.changeBlock", { index: hunkIndex + 1 })}</button>
                    {hunkActions?.(hunk)}
                  </div>
                  {!isCollapsed && (mode === "split"
                    ? <SplitLines lines={lines} lineOffset={lineOffset} revealedLine={revealDiffLine?.line} language={language ?? languageFor(displayPath)} highlight={parsed.lineCount <= HIGHLIGHT_LIMIT} />
                    : <UnifiedLines lines={lines} lineOffset={lineOffset} revealedLine={revealDiffLine?.line} language={language ?? languageFor(displayPath)} highlight={parsed.lineCount <= HIGHLIGHT_LIMIT} />)}
                  {hiddenAfter > 0 && onExpandContext ? <button type="button" className={styles.contextGap} disabled={contextLoading} onClick={onExpandContext} aria-label={t("diff.expandUnchangedLines", { count: hiddenAfter })}><AliIcon name={contextLoading ? "reload" : "chevron-right"} size={12} />{contextLoading ? t("diff.loadingContext") : t("diff.unchangedLines", { count: hiddenAfter })}</button> : null}
                </div>
              );
            })}
          </section>
        );
      })}
      {limited ? <div className={styles.limit}><button ref={loadMoreRef} type="button" className={styles.loadMore} onClick={loadMore}>{t("diff.loadMore", { shown: renderWindow.endIndex, total: parsed.lineCount })}</button></div> : null}
    </div>
  );
}

function UnifiedLines({ lines, lineOffset, revealedLine, language, highlight }: { lines: DiffLine[]; lineOffset: number; revealedLine?: number; language: string; highlight: boolean }) {
  return <>{lines.map((line, index) => <UnifiedLine key={index} line={line} position={lineOffset + index + 1} revealed={lineOffset + index + 1 === revealedLine} language={language} highlight={highlight} />)}</>;
}

function UnifiedLine({ line, position, revealed, language, highlight }: { line: DiffLine; position: number; revealed: boolean; language: string; highlight: boolean }) {
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : line.kind === "meta" ? "\\" : " ";
  return (
    <div className={`${styles.line} ${styles[line.kind]}`} data-diff-line={position} data-revealed={revealed || undefined}>
      <span className={styles.lineNumber}>{line.oldLine ?? ""}</span>
      <span className={styles.lineNumber}>{line.newLine ?? ""}</span>
      <span className={styles.marker}>{marker}</span>
      <Code text={line.text} language={language} highlight={highlight} className={styles.code} />
    </div>
  );
}

function SplitLines({ lines, lineOffset, revealedLine, language, highlight }: { lines: DiffLine[]; lineOffset: number; revealedLine?: number; language: string; highlight: boolean }) {
  const rows = pairLines(lines);
  const positions = new Map(lines.map((line, index) => [line, lineOffset + index + 1]));
  return <div className={styles.splitGrid}>{rows.flatMap((row, index) => [
    <SplitCell key={`l-${index}`} line={row.left} position={row.left ? positions.get(row.left) : undefined} revealed={!!row.left && positions.get(row.left) === revealedLine} side="left" language={language} highlight={highlight} />,
    <SplitCell key={`r-${index}`} line={row.right} position={row.right ? positions.get(row.right) : undefined} revealed={!!row.right && positions.get(row.right) === revealedLine} side="right" language={language} highlight={highlight} />,
  ])}</div>;
}

function SplitCell({ line, position, revealed, side, language, highlight }: { line: DiffLine | null; position?: number; revealed: boolean; side: "left" | "right"; language: string; highlight: boolean }) {
  if (!line) return <div className={`${styles.splitCell} ${styles.empty}`}><span className={styles.lineNumber} /><span /><span /></div>;
  const lineNumber = side === "left" ? line.oldLine : line.newLine;
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return <div className={`${styles.splitCell} ${styles[line.kind]}`} data-diff-line={position} data-revealed={revealed || undefined}><span className={styles.lineNumber}>{lineNumber ?? ""}</span><span className={styles.marker}>{marker}</span><Code text={line.text} language={language} highlight={highlight} className={styles.splitCode} /></div>;
}

function Code({ text, language, highlight, className }: { text: string; language: string; highlight: boolean; className: string }) {
  const { isDark } = useTheme();
  if (!highlight || !text) return <code className={className}>{text || "\u00a0"}</code>;
  return <SyntaxHighlighter language={language} style={isDark ? vscDarkPlus : vs} PreTag="span" CodeTag="span" customStyle={{ margin: 0, padding: 0, background: "transparent", overflow: "visible" }} codeTagProps={{ className }}>{text}</SyntaxHighlighter>;
}

function pairLines(lines: DiffLine[]): Array<{ left: DiffLine | null; right: DiffLine | null }> {
  const rows: Array<{ left: DiffLine | null; right: DiffLine | null }> = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index++) rows.push({ left: removed[index] ?? null, right: added[index] ?? null });
    removed = []; added = [];
  };
  for (const line of lines) {
    if (line.kind === "removed") removed.push(line);
    else if (line.kind === "added") added.push(line);
    else { flush(); rows.push({ left: line, right: line }); }
  }
  flush();
  return rows;
}

function bestPath(file: DiffFile): string { return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath ?? ""; }
function firstLine(file: DiffFile): number { return file.hunks[0]?.newStart || file.hunks[0]?.oldStart || 1; }
function languageFor(path: string): string { return path.split(".").pop()?.toLowerCase() || "text"; }
function toggleSet(current: Set<string>, key: string): Set<string> { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; }
