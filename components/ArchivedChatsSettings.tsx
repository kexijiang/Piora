"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionFlags } from "@/lib/session-flags";
import { getProjectLabel } from "@/lib/session-project-groups";
import type { SessionInfo } from "@/lib/types";
import { requestSessionDeletion } from "@/lib/session-delete-client";
import { confirmSessionDeletion } from "./confirm-session-deletion";
import { requestConfirmation } from "./ConfirmDialog";
import { AliIcon } from "./AliIcon";
import styles from "./ArchivedChatsSettings.module.css";

interface Props {
  onChanged?: () => void;
  onSessionDeleted?: (session: SessionInfo, sessionIds?: string[]) => void;
}

interface ArchivedGroup {
  projectRoot: string;
  label: string;
  sessions: SessionInfo[];
}

function sessionTitle(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage.trim().slice(0, 100) || session.id.slice(0, 12);
}

function archivedGroups(sessions: SessionInfo[]): ArchivedGroup[] {
  const groups = new Map<string, ArchivedGroup>();
  for (const session of sessions) {
    const projectRoot = session.projectRoot || session.cwd;
    const current = groups.get(projectRoot) ?? {
      projectRoot,
      label: getProjectLabel(projectRoot),
      sessions: [],
    };
    current.sessions.push(session);
    groups.set(projectRoot, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      sessions: group.sessions.toSorted((left, right) => right.modified.localeCompare(left.modified)),
    }))
    .toSorted((left, right) => {
      const modified = (right.sessions[0]?.modified ?? "").localeCompare(left.sessions[0]?.modified ?? "");
      return modified || left.label.localeCompare(right.label);
    });
}

export function ArchivedChatsSettings({ onChanged, onSessionDeleted }: Props) {
  const { locale, t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [busySessionIds, setBusySessionIds] = useState<Set<string>>(() => new Set());
  const [deletingAll, setDeletingAll] = useState(false);

  const loadArchivedChats = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      const [sessionsResponse, flagsResponse] = await Promise.all([
        fetch("/api/sessions", { cache: "no-store", signal }),
        fetch("/api/sessions/flags", { cache: "no-store", signal }),
      ]);
      if (!sessionsResponse.ok) throw new Error(`Sessions HTTP ${sessionsResponse.status}`);
      if (!flagsResponse.ok) throw new Error(`Flags HTTP ${flagsResponse.status}`);
      const [sessionsBody, flagsBody] = await Promise.all([
        sessionsResponse.json() as Promise<{ sessions?: SessionInfo[] }>,
        flagsResponse.json() as Promise<{ flags?: SessionFlags }>,
      ]);
      if (signal?.aborted) return;
      const flags = flagsBody.flags ?? {};
      setSessions((sessionsBody.sessions ?? []).filter((session) => flags[session.id]?.archived));
      setError(null);
    } catch (reason) {
      if (signal?.aborted) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadArchivedChats(controller.signal);
    return () => controller.abort();
  }, [loadArchivedChats]);

  const allGroups = useMemo(() => archivedGroups(sessions), [sessions]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => archivedGroups(sessions.filter((session) => {
    const projectRoot = session.projectRoot || session.cwd;
    if (projectFilter !== "all" && projectRoot !== projectFilter) return false;
    if (!normalizedQuery) return true;
    return `${sessionTitle(session)}\n${session.cwd}\n${getProjectLabel(projectRoot)}`
      .toLocaleLowerCase()
      .includes(normalizedQuery);
  })), [normalizedQuery, projectFilter, sessions]);

  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }), [locale]);

  const setSessionBusy = useCallback((sessionId: string, busy: boolean) => {
    setBusySessionIds((current) => {
      const next = new Set(current);
      if (busy) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const unarchive = useCallback(async (session: SessionInfo) => {
    setSessionBusy(session.id, true);
    try {
      const response = await fetch("/api/sessions/flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: session.id, archived: false }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessions((current) => current.filter((candidate) => candidate.id !== session.id));
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy(session.id, false);
    }
  }, [onChanged, setSessionBusy]);

  const deleteSession = useCallback(async (session: SessionInfo) => {
    let expectedIds: string[] | null;
    try { expectedIds = await confirmSessionDeletion(session.id, sessionTitle(session), t); }
    catch (reason) { setError(String(reason)); return; }
    if (!expectedIds) return;
    setSessionBusy(session.id, true);
    try {
      const result = await requestSessionDeletion(session.id, expectedIds);
      onSessionDeleted?.(session, result.sessionIds);
      await loadArchivedChats();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSessionBusy(session.id, false);
    }
  }, [loadArchivedChats, onChanged, onSessionDeleted, setSessionBusy, t]);

  const deleteAll = useCallback(async () => {
    if (sessions.length === 0 || deletingAll) return;
    setDeletingAll(true);
    let changed = false;
    let failure: string | null = null;
    try {
      const response = await fetch("/api/sessions/deletion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: sessions.map((session) => session.id) }) });
      const preview = await response.json();
      if (!response.ok) throw new Error(preview.error || `HTTP ${response.status}`);
      const confirmed = await requestConfirmation({
        title: t("archive.deleteAllTitle"),
        message: t("trash.confirmAll", { count: preview.count, running: preview.running, unarchived: preview.unarchived }),
        confirmLabel: t("archive.deleteAll"), tone: "danger",
      });
      if (!confirmed) return;
      const deleted = new Set<string>();
      const byId = new Map(sessions.map((session) => [session.id, session]));
      for (const id of preview.rootIds as string[]) {
        const session = byId.get(id);
        if (!session || deleted.has(session.id)) continue;
        const result = await requestSessionDeletion(session.id, preview.sessionIds);
        result.sessionIds.forEach((id) => deleted.add(id));
        changed = true;
        onSessionDeleted?.(session, result.sessionIds);
      }
    } catch (reason) {
      failure = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (changed) { await loadArchivedChats(); onChanged?.(); }
      if (failure) setError(failure);
      setDeletingAll(false);
    }
  }, [deletingAll, loadArchivedChats, onChanged, onSessionDeleted, sessions, t]);

  return (
    <div className={styles.page} aria-busy={loading || deletingAll}>
      <header className={styles.header}>
        <div>
          <h2>{t("archive.title")}</h2>
          <p>{t("archive.description")}</p>
        </div>
        <button className={styles.deleteAllButton} type="button" disabled={sessions.length === 0 || deletingAll} onClick={() => void deleteAll()}>
          <AliIcon name="delete" size={14} />
          {deletingAll ? t("archive.deleting") : t("archive.deleteAll")}
        </button>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <AliIcon name="search" size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("archive.searchPlaceholder")} aria-label={t("archive.searchPlaceholder")} />
        </label>
        <label className={styles.projectFilter}>
          <AliIcon name="folder" size={15} />
          <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} aria-label={t("archive.projectFilter")}>
            <option value="all">{t("archive.allProjects")}</option>
            {allGroups.map((group) => <option key={group.projectRoot} value={group.projectRoot}>{group.label}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <div className={styles.error} role="alert">
          <span>{t("trash.failed", { error })}</span>
          <button type="button" onClick={() => void loadArchivedChats()}>{t("archive.retry")}</button>
        </div>
      ) : null}

      {loading && sessions.length === 0 ? <div className={styles.state} role="status">{t("archive.loading")}</div> : null}
      {!loading && sessions.length === 0 ? <div className={styles.state}><AliIcon name="archive" size={22} /><span>{t("archive.empty")}</span></div> : null}
      {!loading && sessions.length > 0 && groups.length === 0 ? <div className={styles.state}>{t("archive.noMatches")}</div> : null}

      <div className={styles.groups}>
        {groups.map((group) => (
          <section className={styles.group} key={group.projectRoot} aria-labelledby={`archive-project-${group.projectRoot.replace(/[^a-zA-Z0-9_-]/g, "-")}`}>
            <div className={styles.groupHeading}>
              <div><AliIcon name="folder" size={15} /><h3 id={`archive-project-${group.projectRoot.replace(/[^a-zA-Z0-9_-]/g, "-")}`}>{group.label}</h3></div>
              <span>{t("archive.chatCount", { count: group.sessions.length })}</span>
            </div>
            <div className={styles.list}>
              {group.sessions.map((session) => {
                const busy = busySessionIds.has(session.id) || deletingAll;
                return (
                  <article className={styles.row} key={session.id}>
                    <div className={styles.rowCopy}>
                      <div className={styles.rowTitle} title={sessionTitle(session)}>{sessionTitle(session)}</div>
                      <time dateTime={session.modified}>{dateFormatter.format(new Date(session.modified))}</time>
                    </div>
                    <button className={styles.iconButton} type="button" disabled={busy} onClick={() => void deleteSession(session)} title={t("archive.delete")} aria-label={t("archive.deleteChat", { title: sessionTitle(session) })}>
                      <AliIcon name="delete" size={14} />
                    </button>
                    <button className={styles.unarchiveButton} type="button" disabled={busy} onClick={() => void unarchive(session)}>{busy ? t("archive.working") : t("archive.unarchive")}</button>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
