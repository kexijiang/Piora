"use client";
import { requestGitStatus } from "@/lib/git-status-client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { GitFileDiffResponse, GitStatusResponse } from "@/lib/git-types";
import { parseUnifiedDiff, type Hunk } from "@/lib/diff-parse";
import { buildPatchForHunk } from "@/lib/hunk-patch";
import { isCommitKeyboardShortcut } from "@/lib/review-keyboard";
import { DiffView } from "../DiffView";
import { AliIcon } from "../AliIcon";
import { requestConfirmation } from "../ConfirmDialog";
import { getFileIcon } from "../FileIcons";
import { ChangeList, type ChangeGroup, type ChangeListItem } from "./ChangeList";
import styles from "./WorkspacePanel.module.css";

interface Props {
  cwd: string | null;
  refreshKey: number;
  onRefresh: () => void;
  onOpenFile: (path: string) => void;
}

type ReviewScope = "all" | ChangeGroup;
type DiffMode = "unified" | "split";
type GitBranchesState = { currentBranch: string | null; branches: string[] };

const EMPTY_STATUS: GitStatusResponse = { isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 };

function createItems(status: GitStatusResponse): ChangeListItem[] {
  const staged: ChangeListItem[] = [];
  const unstaged: ChangeListItem[] = [];
  const untracked: ChangeListItem[] = [];
  for (const file of status.files) {
    if (file.indexStatus !== " " && file.indexStatus !== "?") staged.push({ key: `staged:${file.filePath}`, group: "staged", file });
    if (file.worktreeStatus === "?") untracked.push({ key: `untracked:${file.filePath}`, group: "untracked", file });
    else if (file.worktreeStatus !== " ") unstaged.push({ key: `unstaged:${file.filePath}`, group: "unstaged", file });
  }
  return [...staged, ...unstaged, ...untracked];
}

export function ReviewPanel(props: Props) {
  // Project changes discard selection, request subscriptions, and drafts together.
  return <ProjectReviewPanel key={props.cwd ?? "empty"} {...props} />;
}

function ProjectReviewPanel({ cwd, refreshKey, onRefresh, onOpenFile }: Props) {
  const { t } = useI18n();
  const [status, setStatus] = useState<GitStatusResponse>(EMPTY_STATUS);
  const [diffs, setDiffs] = useState<Record<string, GitFileDiffResponse>>({});
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(() => new Set());
  const [loadingContextKeys, setLoadingContextKeys] = useState<Set<string>>(() => new Set());
  const [reviewedKeys, setReviewedKeys] = useState<Set<string>>(() => new Set());
  const [reviewedStorageRoot, setReviewedStorageRoot] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ReviewScope>("all");
  const [mode, setMode] = useState<DiffMode>("unified");
  const [branchState, setBranchState] = useState<GitBranchesState>({ currentBranch: null, branches: [] });
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [showCommit, setShowCommit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const commitMessageRef = useRef<HTMLTextAreaElement>(null);
  const diffsRef = useRef(diffs);
  const loadingDiffsRef = useRef(loadingDiffs);
  const diffGenerationRef = useRef(0);
  const statusRequestRef = useRef<AbortController | null>(null);
  const branchesRequestRef = useRef<AbortController | null>(null);
  useEffect(() => () => {
    statusRequestRef.current?.abort();
    branchesRequestRef.current?.abort();
    diffGenerationRef.current += 1;
  }, []);
  diffsRef.current = diffs;
  loadingDiffsRef.current = loadingDiffs;

  const items = useMemo(() => createItems(status), [status]);
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => (scope === "all" || item.group === scope)
      && (!needle || item.file.filePath.toLocaleLowerCase().includes(needle)));
  }, [items, query, scope]);
  const selectedItem = useMemo(
    () => filteredItems.find((item) => item.key === activeKey) ?? filteredItems[0] ?? null,
    [activeKey, filteredItems],
  );
  const selectedIndex = selectedItem ? filteredItems.findIndex((item) => item.key === selectedItem.key) : -1;
  const reviewedCount = useMemo(
    () => items.reduce((count, item) => count + Number(reviewedKeys.has(item.key)), 0),
    [items, reviewedKeys],
  );
  const stagedItems = useMemo(() => items.filter((item) => item.group === "staged"), [items]);
  const worktreeItems = useMemo(() => items.filter((item) => item.group !== "staged"), [items]);

  useEffect(() => {
    const prefill = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string | null; message?: string }>).detail;
      if (detail?.cwd !== cwd || !detail.message?.trim()) return;
      setCommitMessage(detail.message.trim());
      setShowCommit(true);
      requestAnimationFrame(() => commitMessageRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("piora:prefill-commit-message", prefill);
    const focusCommit = () => {
      setShowCommit(true);
      requestAnimationFrame(() => commitMessageRef.current?.focus({ preventScroll: true }));
    };
    window.addEventListener("piora:focus-review-commit", focusCommit);
    return () => {
      window.removeEventListener("piora:prefill-commit-message", prefill);
      window.removeEventListener("piora:focus-review-commit", focusCommit);
    };
  }, [cwd]);

  const loadStatus = useCallback(async () => {
    statusRequestRef.current?.abort();
    const controller = new AbortController();
    statusRequestRef.current = controller;
    if (!cwd) { setStatus(EMPTY_STATUS); return; }
    setLoading(true); setError(null);
    try {
      const data = await requestGitStatus(cwd, { signal: controller.signal });
      diffGenerationRef.current += 1;
      setStatus(data);
      setDiffs({});
      setLoadingDiffs(new Set());
      setLoadingContextKeys(new Set());
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [cwd]);

  useEffect(() => { void loadStatus(); }, [loadStatus, refreshKey]);

  const loadBranches = useCallback(async () => {
    branchesRequestRef.current?.abort();
    const controller = new AbortController();
    branchesRequestRef.current = controller;
    if (!cwd) { setBranchState({ currentBranch: null, branches: [] }); return; }
    try {
      const response = await fetch(`/api/git/branches?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as GitBranchesState & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (controller.signal.aborted) return;
      setBranchState(data);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [cwd]);

  useEffect(() => {
    if (!status.repositoryRoot) return;
    void loadBranches();
  }, [loadBranches, status.branch, status.repositoryRoot]);

  useEffect(() => {
    if (!status.repositoryRoot) return;
    try {
      const saved = JSON.parse(localStorage.getItem(`piora:reviewed:${status.repositoryRoot}`) ?? "[]") as unknown;
      setReviewedKeys(new Set(Array.isArray(saved) ? saved.filter((key): key is string => typeof key === "string") : []));
    } catch { setReviewedKeys(new Set()); }
    setReviewedStorageRoot(status.repositoryRoot);
  }, [status.repositoryRoot]);

  useEffect(() => {
    if (!status.repositoryRoot || reviewedStorageRoot !== status.repositoryRoot) return;
    localStorage.setItem(`piora:reviewed:${status.repositoryRoot}`, JSON.stringify([...reviewedKeys]));
  }, [reviewedKeys, reviewedStorageRoot, status.repositoryRoot]);

  useEffect(() => {
    if (!cwd) return;
    const missing = selectedItem
      && !diffsRef.current[selectedItem.key]
      && !loadingDiffsRef.current.has(selectedItem.key)
      ? [selectedItem]
      : [];
    if (missing.length === 0) return;
    const generation = diffGenerationRef.current;
    setLoadingDiffs((current) => new Set([...current, ...missing.map((item) => item.key)]));
    void Promise.all(missing.map(async (item) => {
      try {
        const response = await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(item.file.filePath)}&scope=${item.group === "staged" ? "staged" : "worktree"}`, { cache: "no-store" });
        const data = await response.json() as GitFileDiffResponse & { error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        if (generation === diffGenerationRef.current) setDiffs((current) => ({ ...current, [item.key]: data }));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoadingDiffs((current) => { const next = new Set(current); next.delete(item.key); return next; });
      }
    }));
  }, [cwd, selectedItem]);

  const expandContext = useCallback(async (item: ChangeListItem) => {
    if (!cwd || loadingContextKeys.has(item.key)) return;
    const generation = diffGenerationRef.current;
    setLoadingContextKeys((current) => new Set(current).add(item.key));
    setError(null);
    try {
      const response = await fetch(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(item.file.filePath)}&scope=${item.group === "staged" ? "staged" : "worktree"}&context=all`, { cache: "no-store" });
      const data = await response.json() as GitFileDiffResponse & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (generation === diffGenerationRef.current) {
        setDiffs((current) => ({ ...current, [item.key]: data }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingContextKeys((current) => { const next = new Set(current); next.delete(item.key); return next; });
    }
  }, [cwd, loadingContextKeys]);

  const mutate = useCallback(async (action: "stage" | "unstage" | "revert", targetItems: ChangeListItem[], options?: { hunk?: Hunk }) => {
    if (!cwd || targetItems.length === 0 || busy) return;
    const root = (typeof status.repositoryRoot === "string" ? status.repositoryRoot : (cwd ?? "")).replace(/\\/g, "/").replace(/\/$/, "");
    const relativePaths = [...new Set(targetItems.map((item) => {
      const rawPath = typeof item.file?.filePath === "string" ? item.file.filePath : "";
      const normalized = rawPath.replace(/\\/g, "/");
      return normalized.toLocaleLowerCase().startsWith(`${root.toLocaleLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
    }).filter((path) => path.length > 0))];
    const body: Record<string, unknown> = { cwd, paths: relativePaths };
    const itemDiff = targetItems.length === 1 ? diffs[targetItems[0].key] : undefined;
    if (action === "revert") {
      const changedLines = options?.hunk?.lines.filter((line) => line.kind === "added" || line.kind === "removed").length
        ?? (itemDiff?.patch ? parseUnifiedDiff(itemDiff.patch).lineCount : targetItems.reduce((sum, item) => sum + (item.file.additions ?? 0) + (item.file.deletions ?? 0), 0));
      if (!await requestConfirmation({
        title: t("review.revertTitle"),
        message: t("review.confirmRevert", { count: changedLines }),
        confirmLabel: t("review.revert"),
        tone: "danger",
      })) return;
    }
    if (action === "revert" || options?.hunk) {
      const hashResponse = await fetch("/api/git/diff-hash", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, paths: relativePaths }) });
      const hashData = await hashResponse.json() as { diffHash?: string; error?: string };
      if (!hashResponse.ok || !hashData.diffHash) { setError(hashData.error || "Unable to verify diff"); return; }
      body.diffHash = hashData.diffHash;
      if (options?.hunk && itemDiff?.patch) body.patch = buildPatchForHunk(itemDiff.patch, options.hunk);
    }
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/git/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { error?: string; stale?: boolean };
      if (!response.ok) throw new Error(data.stale ? t("review.stale") : data.error || `HTTP ${response.status}`);
      setToast(t(`review.${action}Done`));
      onRefresh();
      window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } }));
      await loadStatus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [busy, cwd, diffs, loadStatus, onRefresh, status.repositoryRoot, t]);

  const push = useCallback(async () => {
    if (!cwd || busy) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setToast(t("review.pushDone"));
      setShowCommit(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [busy, cwd, t]);

  const commit = useCallback(async (pushAfterCommit = false) => {
    if (!cwd || busy) return;
    const resolvedMessage = commitMessage.trim() || t("review.generatedCommitMessage", { count: status.files.length });
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/git/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, message: resolvedMessage, amend, includeUnstaged }) });
      const data = await response.json() as { sha?: string; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const shortSha = data.sha?.slice(0, 8) ?? "";
      if (pushAfterCommit) {
        const pushResponse = await fetch("/api/git/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }) });
        const pushData = await pushResponse.json() as { error?: string };
        if (!pushResponse.ok) {
          setToast(t("review.commitDone", { sha: shortSha }));
          setCommitMessage(""); setShowCommit(false);
          onRefresh();
          window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } }));
          await loadStatus();
          setError(t("review.commitPushFailed", { error: pushData.error || `HTTP ${pushResponse.status}` }));
          return;
        }
      }
      setToast(t(pushAfterCommit ? "review.commitPushDone" : "review.commitDone", { sha: shortSha }));
      setCommitMessage(""); setShowCommit(false);
      onRefresh(); window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } })); await loadStatus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [amend, busy, commitMessage, cwd, includeUnstaged, loadStatus, onRefresh, status.files.length, t]);

  const toggleReviewed = (key: string) => setReviewedKeys((current) => toggleSet(current, key));

  const switchBranch = useCallback(async (branch: string) => {
    if (!cwd || branch === branchState.currentBranch || switchingBranch) return;
    if (items.length > 0 && !await requestConfirmation({
      title: t("review.switchBranchTitle"),
      message: t("review.switchBranchConfirm", { branch }),
      confirmLabel: t("review.switchBranch"),
    })) return;
    setSwitchingBranch(branch);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, branch }),
      });
      const data = await response.json() as GitBranchesState & { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      branchesRequestRef.current?.abort();
      setBranchState(data);
      setToast(t("review.branchSwitched", { branch }));
      onRefresh();
      window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } }));
      await loadStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setSwitchingBranch(null);
    }
  }, [branchState.currentBranch, cwd, items.length, loadStatus, onRefresh, switchingBranch, t]);

  const commitControl = <CommitControl
    open={showCommit}
    onOpenChange={setShowCommit}
    branch={branchState.currentBranch ?? status.branch ?? t("review.workingTree")}
    commitMessage={commitMessage}
    setCommitMessage={setCommitMessage}
    commitMessageRef={commitMessageRef}
    includeUnstaged={includeUnstaged}
    setIncludeUnstaged={setIncludeUnstaged}
    amend={amend}
    setAmend={setAmend}
    stagedCount={stagedItems.length}
    worktreeCount={worktreeItems.length}
    additions={status.additions}
    deletions={status.deletions}
    busy={busy}
    onCommit={(pushAfterCommit) => void commit(pushAfterCommit)}
    onPush={() => void push()}
    t={t}
  />;

  if (!cwd) return <ReviewEmpty message={t("review.selectProject")} />;
  if (loading && status.files.length === 0) return <ReviewEmpty message={t("review.loading")} loading />;
  if (!status.isGitRepository) return <ReviewEmpty message={error || t("review.notGit")} />;
  if (items.length === 0) return <div className={styles.reviewRoot}><ReviewTopBar status={status} mode={mode} setMode={setMode} busy={busy} onRefresh={loadStatus} branches={branchState.branches} currentBranch={branchState.currentBranch} switchingBranch={switchingBranch} onSwitchBranch={switchBranch} commitControl={commitControl} reviewedCount={0} totalCount={0} t={t} /><ReviewEmpty message={error || toast || t("review.clean")} /></div>;

  const scopeCounts: Record<ReviewScope, number> = {
    all: items.length,
    staged: stagedItems.length,
    unstaged: items.filter((item) => item.group === "unstaged").length,
    untracked: items.filter((item) => item.group === "untracked").length,
  };
  const selectedDiff = selectedItem ? diffs[selectedItem.key] : undefined;
  const selectRelativeFile = (offset: number) => {
    const nextItem = filteredItems[selectedIndex + offset];
    if (nextItem) setActiveKey(nextItem.key);
  };

  return <div className={styles.reviewRoot} aria-busy={busy}>
    <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
      {activeKey ? t("review.selectedChange", { path: items.find((item) => item.key === activeKey)?.file.filePath ?? "" }) : t("review.noSelectedChange")}
    </div>
    <ReviewTopBar status={status} mode={mode} setMode={setMode} busy={busy} onRefresh={loadStatus} branches={branchState.branches} currentBranch={branchState.currentBranch} switchingBranch={switchingBranch} onSwitchBranch={switchBranch} t={t}
      commitControl={commitControl} reviewedCount={reviewedCount} totalCount={items.length} />

    <div className={styles.reviewWorkbench}>
      <aside className={styles.reviewNavigator} aria-label={t("review.changesTree")}>
        <div className={styles.reviewNavigatorSummary}>
          <div>
            <strong>{t("review.filesChanged", { count: items.length })}</strong>
            <span className={styles.lineStats}><span className={styles.additions}>+{status.additions}</span><span className={styles.deletions}>−{status.deletions}</span></span>
          </div>
          <div className={styles.reviewProgressRow}>
            <span>{t("review.progress", { reviewed: reviewedCount, total: items.length })}</span>
            <span>{Math.round((reviewedCount / Math.max(1, items.length)) * 100)}%</span>
          </div>
          <div className={styles.reviewProgressTrack} aria-hidden="true"><span style={{ width: `${(reviewedCount / Math.max(1, items.length)) * 100}%` }} /></div>
        </div>
        <div className={styles.reviewFilters}>
          <label className={styles.reviewSearch}>
            <AliIcon name="search" size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("review.searchPlaceholder")} aria-label={t("review.searchPlaceholder")} />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label={t("review.clearSearch")}><AliIcon name="close" size={12} /></button> : null}
          </label>
          <div className={styles.scopeTabs} role="group" aria-label={t("review.filterLabel")}>
            {(["all", "unstaged", "staged", "untracked"] as const).map((value) => <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>{t(`review.filter.${value}`)}<span>{scopeCounts[value]}</span></button>)}
          </div>
        </div>
        {filteredItems.length ? <ChangeList
          items={filteredItems}
          selectedKey={selectedItem?.key ?? null}
          checkedKeys={reviewedKeys}
          onSelect={(item) => setActiveKey(item.key)}
          onToggle={(item) => toggleReviewed(item.key)}
        /> : <div className={styles.reviewNoResults}>{t("review.noMatches")}</div>}
      </aside>

      <main className={styles.reviewDetail} role="region" aria-label={t("review.diffRegion")}>
        {selectedItem ? <>
          <FileReviewHeader
            item={selectedItem}
            reviewed={reviewedKeys.has(selectedItem.key)}
            busy={busy}
            onReview={() => toggleReviewed(selectedItem.key)}
            onOpen={() => onOpenFile(selectedItem.file.filePath)}
            onStage={() => void mutate(selectedItem.group === "staged" ? "unstage" : "stage", [selectedItem])}
            onRevert={() => void mutate("revert", [selectedItem])}
            t={t}
          />
          <div className={styles.reviewDiffViewport}>
            {selectedDiff?.supported && selectedDiff.patch ? <DiffView className={styles.reviewDiff} patch={selectedDiff.patch} filePath={selectedItem.file.filePath} mode={mode} showFileHeader={false} totalLines={selectedDiff.totalLines} contextLoading={loadingContextKeys.has(selectedItem.key)} onExpandContext={() => void expandContext(selectedItem)} onOpenFile={(path) => onOpenFile(path)} hunkActions={(hunk) => <span className={styles.hunkActions} onClick={(event) => event.stopPropagation()}><button type="button" disabled={busy} onClick={() => void mutate(selectedItem.group === "staged" ? "unstage" : "stage", [selectedItem], { hunk })}>{selectedItem.group === "staged" ? t("review.unstageHunk") : t("review.stageHunk")}</button>{selectedItem.group !== "staged" ? <button type="button" className={styles.danger} disabled={busy} onClick={() => void mutate("revert", [selectedItem], { hunk })}>{t("review.revertHunk")}</button> : null}</span>} />
              : loadingDiffs.has(selectedItem.key) ? <ReviewFileLoading t={t} /> : <ReviewEmpty message={t("review.diffUnavailable")} compact />}
          </div>
          <div className={styles.reviewFileFooter}>
            <button type="button" disabled={selectedIndex <= 0} onClick={() => selectRelativeFile(-1)}><AliIcon name="arrowup" size={12} />{t("review.previousFile")}</button>
            <span>{t("review.filePosition", { current: selectedIndex + 1, total: filteredItems.length })}</span>
            <button type="button" className={reviewedKeys.has(selectedItem.key) ? styles.reviewedAction : undefined} aria-pressed={reviewedKeys.has(selectedItem.key)} onClick={() => toggleReviewed(selectedItem.key)}><AliIcon name="check" size={12} />{reviewedKeys.has(selectedItem.key) ? t("review.markUnreviewed") : t("review.markReviewed")}</button>
            <button type="button" disabled={selectedIndex >= filteredItems.length - 1} onClick={() => selectRelativeFile(1)}>{t("review.nextFile")}<AliIcon name="arrowdown" size={12} /></button>
          </div>
        </> : <ReviewEmpty message={t("review.noMatches")} />}
      </main>
    </div>

    <footer className={styles.reviewFooter}>
      <div className={styles.reviewFooterBar}>
        <span>{stagedItems.length ? t("review.readyToCommit", { count: stagedItems.length }) : t("review.nothingStaged")}</span>
        <div>
          {worktreeItems.length ? <button type="button" disabled={busy} onClick={() => void mutate("stage", worktreeItems)}>{t("review.stageAll")}</button> : null}
          <button className={styles.primaryAction} type="button" disabled={busy} onClick={() => { setShowCommit(true); requestAnimationFrame(() => commitMessageRef.current?.focus({ preventScroll: true })); }}><AliIcon name="check" size={13} />{t("review.commitOrPush")}</button>
        </div>
      </div>
      {error ? <div role="alert" className={styles.error}>{error}</div> : null}
      {toast ? <div role="status" className={styles.toast}>{toast}</div> : null}
    </footer>
  </div>;
}

function ReviewTopBar({ status, mode, setMode, busy, onRefresh, branches, currentBranch, switchingBranch, onSwitchBranch, commitControl, reviewedCount, totalCount, t }: {
  status: GitStatusResponse;
  mode: DiffMode;
  setMode: (mode: DiffMode) => void;
  busy: boolean;
  onRefresh: () => void | Promise<void>;
  branches: string[];
  currentBranch: string | null;
  switchingBranch: string | null;
  onSwitchBranch: (branch: string) => void | Promise<void>;
  commitControl?: ReactNode;
  reviewedCount: number;
  totalCount: number;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!branchMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!branchPickerRef.current?.contains(event.target as Node)) setBranchMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBranchMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [branchMenuOpen]);

  return <header className={styles.reviewToolbar}>
    <div ref={branchPickerRef} className={styles.branchPicker}>
      <button type="button" className={styles.reviewHeading} aria-haspopup="listbox" aria-expanded={branchMenuOpen} disabled={busy || branches.length === 0} onClick={() => setBranchMenuOpen((open) => !open)}>
        <span className={styles.branchBadge}><AliIcon name="branches" size={13} /></span>
        <span><b>{switchingBranch ?? currentBranch ?? status.branch ?? t("review.workingTree")}</b><small>{switchingBranch ? t("review.switchingBranch") : t("review.changes", { count: status.files.length })}</small></span>
        <AliIcon name={branchMenuOpen ? "arrowup" : "arrowdown"} size={11} />
      </button>
      {branchMenuOpen ? <div className={styles.branchMenu} role="listbox" aria-label={t("review.branchMenu")}>
        {branches.map((branch) => <button key={branch} type="button" role="option" aria-selected={branch === currentBranch} onClick={() => { setBranchMenuOpen(false); void onSwitchBranch(branch); }}>
          <AliIcon name={branch === currentBranch ? "check" : "branches"} size={12} />
          <span>{branch}</span>
        </button>)}
      </div> : null}
    </div>
    <div className={styles.reviewToolbarActions}>
      {totalCount > 0 ? <span className={styles.reviewToolbarProgress}>{t("review.progress", { reviewed: reviewedCount, total: totalCount })}</span> : null}
      <div className={styles.reviewViewToggle} role="group" aria-label={t("review.viewMode")}>
        <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>{t("review.view.unified")}</button>
        <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>{t("review.view.split")}</button>
      </div>
      <button type="button" className={styles.iconAction} onClick={() => void onRefresh()} disabled={busy} title={t("review.refresh")} aria-label={t("review.refresh")}><AliIcon name="reload" size={14} /></button>
      {commitControl}
    </div>
  </header>;
}

function CommitControl({
  open,
  onOpenChange,
  branch,
  commitMessage,
  setCommitMessage,
  commitMessageRef,
  includeUnstaged,
  setIncludeUnstaged,
  amend,
  setAmend,
  stagedCount,
  worktreeCount,
  additions,
  deletions,
  busy,
  onCommit,
  onPush,
  t,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: string;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  commitMessageRef: RefObject<HTMLTextAreaElement | null>;
  includeUnstaged: boolean;
  setIncludeUnstaged: (include: boolean) => void;
  amend: boolean;
  setAmend: (amend: boolean) => void;
  stagedCount: number;
  worktreeCount: number;
  additions: number;
  deletions: number;
  busy: boolean;
  onCommit: (pushAfterCommit: boolean) => void;
  onPush: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canCommit = stagedCount > 0 || (includeUnstaged && worktreeCount > 0) || amend;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onOpenChange, open]);

  return <div ref={rootRef} className={styles.commitControl}>
    <button type="button" className={styles.commitTrigger} aria-haspopup="dialog" aria-expanded={open} disabled={busy} onClick={() => {
      onOpenChange(!open);
      if (!open) requestAnimationFrame(() => commitMessageRef.current?.focus({ preventScroll: true }));
    }}><AliIcon name="branches" size={13} /><span>{t("review.commitOrPush")}</span><AliIcon name={open ? "arrowup" : "arrowdown"} size={10} /></button>
    {open ? <div className={styles.commitPopover} role="dialog" aria-label={t("review.commitOrPush")}>
      <div className={styles.commitBranch}><AliIcon name="branches" size={12} /><b>{branch}</b></div>
      <textarea ref={commitMessageRef} value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} onKeyDown={(event) => {
        if (!isCommitKeyboardShortcut(event.nativeEvent) || !canCommit) return;
        event.preventDefault();
        onCommit(false);
      }} placeholder={t("review.commitMessagePlaceholder")} aria-label={t("review.commitMessage")} aria-describedby="review-commit-shortcut" rows={4} />
      <span id="review-commit-shortcut" className={styles.srOnly}>{t("review.commitShortcut")}</span>
      {worktreeCount > 0 ? <label className={styles.includeUnstagedToggle}><input type="checkbox" checked={includeUnstaged} onChange={(event) => setIncludeUnstaged(event.target.checked)} />{t("review.includeUnstaged")}<span className={styles.commitStats}><span className={styles.additions}>+{additions}</span><span className={styles.deletions}>-{deletions}</span></span></label> : null}
      <label className={styles.amendToggle}><input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />{t("review.amend")}</label>
      <div className={styles.commitMenuActions}>
        <button type="button" disabled={busy || !canCommit} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => onCommit(false)}><AliIcon name="check" size={13} />{t("review.commitOnly")}<kbd>Ctrl+↵</kbd></button>
        <button type="button" disabled={busy || !canCommit} onClick={() => onCommit(true)}><AliIcon name="cloud-upload" size={13} />{t("review.commitAndPush")}</button>
        <button type="button" disabled={busy} onClick={onPush}><AliIcon name="upload" size={13} />{t("review.pushOnly")}</button>
      </div>
    </div> : null}
  </div>;
}

function FileReviewHeader({ item, reviewed, busy, onReview, onOpen, onStage, onRevert, t }: { item: ChangeListItem; reviewed: boolean; busy: boolean; onReview: () => void; onOpen: () => void; onStage: () => void; onRevert: () => void; t: ReturnType<typeof useI18n>["t"] }) {
  const { name, parent } = splitPath(item.file.filePath);
  return <header className={styles.reviewFileHeader}>
    <span className={styles.reviewFileIcon}>{getFileIcon(name, 14)}</span>
    <div className={styles.reviewFileIdentity} title={item.file.filePath}><b>{name}</b>{parent ? <small>{parent}/</small> : null}</div>
    <span className={styles.fileGroupBadge} data-group={item.group}>{t(`review.group.${item.group}`)}</span>
    <span className={styles.lineStats}><span className={styles.additions}>+{item.file.additions ?? 0}</span><span className={styles.deletions}>-{item.file.deletions ?? 0}</span></span>
    <div className={styles.fileActions}>
      <button type="button" className={`${styles.reviewCheck} ${reviewed ? styles.reviewCheckDone : ""}`} onClick={onReview} title={reviewed ? t("review.markUnreviewed") : t("review.markReviewed")} aria-label={reviewed ? t("review.markUnreviewed") : t("review.markReviewed")} aria-pressed={reviewed}><AliIcon name="check" size={11} /></button>
      <button type="button" disabled={busy} onClick={onStage} title={item.group === "staged" ? t("review.unstage") : t("review.stage")} aria-label={item.group === "staged" ? t("review.unstage") : t("review.stage")}><AliIcon name={item.group === "staged" ? "minus" : "plus"} size={13} /></button>
      {item.group !== "staged" ? <button type="button" className={styles.danger} disabled={busy} onClick={onRevert} title={t("review.revert")} aria-label={t("review.revert")}><AliIcon name="history" size={13} /></button> : null}
      <button type="button" className={styles.openFileAction} onClick={onOpen} title={t("diff.openFile")} aria-label={t("diff.openFile")}><AliIcon name="external-link" size={13} /></button>
    </div>
  </header>;
}

function ReviewFileLoading({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  return <div className={styles.reviewFileLoading}><AliIcon name="reload" size={14} /><span>{t("review.loadingDiff")}</span></div>;
}

function ReviewEmpty({ message, loading = false, compact = false }: { message: string; loading?: boolean; compact?: boolean }) {
  if (loading) return <div className={styles.reviewLoading} role="status">
    <span className={styles.reviewLoadingSpinner} aria-hidden="true"><AliIcon name="reload" size={14} /></span>
    <span>{message}</span>
  </div>;
  return <div className={`${styles.reviewEmpty} ${compact ? styles.reviewEmptyCompact : ""}`}>
    <span className={styles.emptyIcon} aria-hidden="true"><AliIcon name="diff" size={17} /></span>
    <span>{message}</span>
  </div>;
}

function splitPath(path: string): { name: string; parent: string } {
  const parts = path.replace(/\\/g, "/").split("/");
  const name = parts.pop() ?? path;
  const parentParts = parts.filter(Boolean);
  return { name, parent: parentParts.length > 2 ? `…/${parentParts.slice(-2).join("/")}` : parentParts.join("/") };
}

function toggleSet(current: Set<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key); else next.add(key);
  return next;
}
