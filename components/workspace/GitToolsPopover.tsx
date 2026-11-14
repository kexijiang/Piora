"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { rememberWorktreeMetadata, useWorktrees, type WorktreeEntry } from "@/hooks/useWorktrees";
import type { GitStatusResponse } from "@/lib/git-types";
import { getTrackedGitLineStats } from "@/lib/git-line-stats";
import { AliIcon } from "../AliIcon";
import { GitToolsIcon } from "./GitToolsIcon";
import styles from "./GitToolsPopover.module.css";

interface Props {
  cwd: string;
  status: GitStatusResponse;
  onOpenChanges(): void;
  onOpenCommit(): void;
  onSelectWorktree(path: string): void;
}

function samePath(left: string, right: string) {
  const normalize = (path: string) => {
    const value = path.replace(/\\/g, "/").replace(/\/$/, "");
    return /^[a-z]:|^\/\//i.test(value) ? value.toLowerCase() : value;
  };
  return normalize(left) === normalize(right);
}

export function GitToolsPopover(props: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const stats = getTrackedGitLineStats(props.status);
  return <div className={styles.anchor}>
    <button ref={trigger} className={`topbar-control ${styles.trigger}`} type="button" aria-label={t("gitTools.title")} title={t("gitTools.title")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} onClick={() => setOpen(value => !value)}>
      <GitToolsIcon name="branch" className={styles.leadingIcon} /><span className={styles.triggerText}>{t("gitTools.title")}</span>
      <span className={styles.stats}><span className={styles.add}>+{stats.additions}</span><span className={styles.remove}>−{stats.deletions}</span></span>
    </button>
    {open && createPortal(<GitToolsContent {...props} id={dialogId} trigger={trigger} onClose={() => setOpen(false)} />, document.body)}
  </div>;
}

function GitToolsContent({ cwd, status, onOpenChanges, onOpenCommit, onSelectWorktree, onClose, trigger, id }: Props & {
  id: string; onClose(): void; trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 60, left: 12 });
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ tree: WorktreeEntry; dirty: boolean } | null>(null);
  const { state, loading, error, refresh } = useWorktrees(cwd);
  const currentRoot = status.repositoryRoot ?? cwd;
  const stats = getTrackedGitLineStats(status);
  const current = state?.worktrees.find(tree => samePath(tree.path, currentRoot));
  const matches = state?.worktrees.filter(tree => `${tree.branch ?? ""} ${tree.path}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useFocusTrap(panel, true, { onEscape: onClose });
  useLayoutEffect(() => {
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ top: rect.bottom + 8, left: Math.max(12, Math.min(rect.right - 328, window.innerWidth - 340)) });
    };
    place(); window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [trigger]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onClose, trigger]);

  const mutate = useCallback(async (method: "POST" | "DELETE", payload: Record<string, unknown>) => {
    if (busyRef.current || !state) return;
    busyRef.current = true; setBusy(true); setMutationError(null);
    try {
      const response = await fetch("/api/worktrees", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: state.projectRoot, ...payload }) });
      const data = await response.json();
      if (!alive.current) return;
      if (!response.ok) {
        if (method === "DELETE" && data.dirty && !payload.force) { setRemoving(value => value ? { ...value, dirty: true } : null); return; }
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      if (method === "POST") {
        if (typeof data.path !== "string") throw new Error(t("gitTools.createFailed"));
        rememberWorktreeMetadata({ ...state, forCwd: data.path, worktrees: [...state.worktrees.filter(tree => !samePath(tree.path, data.path)), { path: data.path, branch: String(payload.branch), isMain: false }] });
        onSelectWorktree(data.path); onClose();
      } else { setRemoving(null); refresh(); }
      window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } }));
    } catch (cause) { if (alive.current) setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }, [cwd, onClose, onSelectWorktree, refresh, state, t]);

  const openChanges = () => { onClose(); onOpenChanges(); };
  return <div ref={panel} id={id} role="dialog" aria-label={t("gitTools.title")} className={styles.panel} style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 12}px)` }} data-git-tools>
    <div className={styles.header}>
      <span className={styles.title}>{t("gitTools.title")}</span>
      <button type="button" className={styles.iconButton} aria-label={t("gitTools.refresh")} disabled={loading || busy} onClick={() => { refresh(); window.dispatchEvent(new CustomEvent("piora:git-status-changed", { detail: { cwd } })); }}><AliIcon name="reload" size={14} /></button>
      <button type="button" className={styles.iconButton} aria-label={t("gitTools.expand")} onClick={openChanges}><AliIcon name="expand" size={14} /></button>
      <button type="button" className={styles.iconButton} aria-label={t("gitTools.close")} onClick={onClose}><AliIcon name="close" size={14} /></button>
    </div>
    <button className={styles.row} type="button" onClick={openChanges}><GitToolsIcon name="changes" className={styles.leadingIcon} /><span className={styles.label}>{t("gitTools.changes")}</span><span className={styles.stats}><span className={styles.add}>+{stats.additions}</span><span className={styles.remove}>−{stats.deletions}</span></span></button>
    <button className={styles.row} type="button" aria-expanded={expanded} aria-controls={`${id}-worktrees`} onClick={() => setExpanded(value => !value)} title={currentRoot}>
      <GitToolsIcon name="branch" className={styles.leadingIcon} /><span className={styles.label}>{status.branch || current?.branch || t("gitTools.detached")}</span><AliIcon name="chevron-right" size={12} style={{ transform: expanded ? "rotate(-90deg)" : "rotate(90deg)" }} />
    </button>
    <button className={styles.row} type="button" onClick={() => { onClose(); onOpenCommit(); }}><GitToolsIcon name="push" className={styles.leadingIcon} /><span className={styles.label}>{t("review.commitOrPush")}</span></button>
    {expanded && <section id={`${id}-worktrees`} className={styles.section} aria-label={t("gitTools.worktrees")}>
      <div className={styles.caption}>{t("gitTools.worktrees")}{state ? ` · ${state.worktrees.length}` : ""}</div>
      {(state?.worktrees.length ?? 0) >= 8 && <div className={styles.form}><input className={styles.input} aria-label={t("sidebar.filterWorktrees")} placeholder={t("sidebar.filterWorktrees")} value={query} onChange={event => setQuery(event.target.value)} /></div>}
      {loading && !state && <p className={styles.caption} role="status">{t("gitTools.loading")}</p>}
      <div className={styles.list}>
        {matches.map(tree => {
          const selected = samePath(tree.path, currentRoot);
          return <div key={tree.path} className={styles.checkoutRow}>
            <button className={styles.checkout} type="button" aria-current={selected ? "true" : undefined} disabled={busy} title={tree.path} onClick={() => { if (!selected) onSelectWorktree(tree.path); onClose(); }}>
              {selected ? <AliIcon name="check" size={16} className={styles.leadingIcon} /> : <GitToolsIcon name="branch" className={styles.leadingIcon} />}
              <span className={styles.checkoutText}><span className={styles.branch}><span className={styles.label}>{tree.branch || t("gitTools.detached")}</span>{tree.isMain && <span className={styles.tag}>{t("sidebar.main")}</span>}</span><span className={styles.checkoutPath}>{tree.path}</span></span>
            </button>
            {!tree.isMain && <button className={styles.iconButton} type="button" disabled={busy || selected} aria-label={t("sidebar.removeWorktreeTitle", { path: tree.path })} title={selected ? t("gitTools.leaveBeforeRemove") : t("sidebar.removeWorktreeTitle", { path: tree.path })} onClick={() => { setRemoving({ tree, dirty: false }); setMutationError(null); }}><AliIcon name="delete" size={13} /></button>}
          </div>;
        })}
        {state && !matches.length && <p className={styles.caption}>{t("sidebar.noMatchingWorktrees")}</p>}
      </div>
      <p className={styles.caption}>{t("gitTools.switchHint")}</p>
      {removing && <div className={styles.confirm} role="alert">
        <span>{t(removing.dirty ? "gitTools.dirtyWarning" : "gitTools.removeWarning")}</span><span className={styles.path} title={removing.tree.path}>{removing.tree.branch ?? removing.tree.path}</span>
        <div className={styles.actions}><button className={styles.action} disabled={busy} onClick={() => setRemoving(null)}>{t("sidebar.cancel")}</button><button className={`${styles.action} ${styles.remove}`} disabled={busy} onClick={() => void mutate("DELETE", { path: removing.tree.path, force: removing.dirty })}>{t(removing.dirty ? "gitTools.forceRemove" : "gitTools.remove")}</button></div>
      </div>}
      {creating ? <form className={styles.form} onSubmit={event => { event.preventDefault(); if (branch.trim()) void mutate("POST", { branch: branch.trim() }); }}>
        <label htmlFor={`${id}-branch`}>{t("gitTools.branchName")}</label><input id={`${id}-branch`} autoFocus className={styles.input} placeholder="codex/my-task" value={branch} disabled={busy} onChange={event => setBranch(event.target.value)} />
        <span className={styles.caption}>{t("gitTools.createHint")}</span><div className={styles.actions}><button className={styles.action} type="button" disabled={busy} onClick={() => setCreating(false)}>{t("sidebar.cancel")}</button><button className={`${styles.action} ${styles.primary}`} type="submit" disabled={busy || !branch.trim()}>{t(busy ? "gitTools.creating" : "gitTools.create")}</button></div>
      </form> : <button className={styles.row} type="button" disabled={busy || !state?.isGit} onClick={() => { setCreating(true); setRemoving(null); setMutationError(null); }}><AliIcon name="plus" size={14} />{t("sidebar.newWorktree")}</button>}
    </section>}
    {(error || mutationError) && <p className={styles.error} role="alert">{mutationError || error}</p>}
    <div className={`${styles.section} ${styles.caption}`}><div>{t(current?.isMain ? "gitTools.mainCheckout" : "gitTools.currentCheckout")}</div><div className={styles.path} title={currentRoot}>{currentRoot}</div></div>
  </div>;
}
