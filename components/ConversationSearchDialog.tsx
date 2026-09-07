"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import type { ConversationArchiveFilter, ConversationSearchResponse, ConversationSearchResult } from "@/lib/conversation-search";
import { filterFileEntries } from "@/lib/file-fuzzy";
import { getProjectLabel } from "@/lib/session-project-groups";
import { filterSettingsSearchItems, SETTINGS_SEARCH_ITEMS, type SettingsKey, type SettingsSearchItem } from "@/lib/settings-search";
import type { SessionInfo } from "@/lib/types";
import type { SessionFlags } from "@/lib/session-flags";
import { matchesConversationFilter } from "@/lib/conversation-search-filter";
import { AliIcon } from "./AliIcon";
import styles from "./ConversationSearchDialog.module.css";

interface Props {
  sessions: SessionInfo[];
  flags: SessionFlags;
  hasProject: boolean;
  onClose: () => void;
  onSelect: (session: SessionInfo, entryId: string) => void;
  onSelectSession: (session: SessionInfo) => void;
  onOpenSettings: (key: SettingsKey, itemId?: string) => void;
}

interface ChatResultRow {
  id: string;
  result: ConversationSearchResult;
}

function HighlightedSnippet({ result }: { result: ConversationSearchResult }) {
  const start = Math.max(0, Math.min(result.snippet.length, result.matchStart));
  const end = Math.max(start, Math.min(result.snippet.length, start + result.matchLength));
  return <>
    {result.snippet.slice(0, start)}
    <mark>{result.snippet.slice(start, end)}</mark>
    {result.snippet.slice(end)}
  </>;
}

function sessionTitle(session: SessionInfo, fallback: string): string {
  return session.name?.trim() || session.firstMessage.trim() || fallback;
}

function sessionProjectKey(session: SessionInfo): string {
  return session.projectless ? "__projectless__" : session.projectRoot ?? session.cwd;
}

export function ConversationSearchDialog({ sessions, flags, hasProject, onClose, onSelect, onSelectSession, onOpenSettings }: Props) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [project, setProject] = useState("");
  const [archive, setArchive] = useState<ConversationArchiveFilter>("all");
  const [response, setResponse] = useState<ConversationSearchResponse>({ results: [], durationMs: 0, truncated: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmedQuery = query.trim();
  const hasDesktop = typeof window !== "undefined" && Boolean(window.piDesktop);
  useFocusTrap(dialogRef, true, { initialFocus: inputRef, onEscape: onClose });

  const projects = useMemo(() => {
    const entries = new Map<string, string>();
    for (const session of sessions) {
      const key = sessionProjectKey(session);
      entries.set(key, session.projectless ? t("conversationSearch.projectless") : getProjectLabel(key));
    }
    return [...entries].sort((left, right) => left[1].localeCompare(right[1], locale));
  }, [locale, sessions, t]);

  const recentSessions = useMemo(() => sessions.filter((session) => matchesConversationFilter(session, flags, archive, project))
    .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified))
    .slice(0, 9), [sessions, flags, archive, project]);

  const titleMatches = useMemo(() => {
    if (!trimmedQuery) return [];
    const candidates = sessions.filter((session) => matchesConversationFilter(session, flags, archive, project));
    const indexed = candidates.map((session, index) => ({
      path: `${sessionTitle(session, t("conversationSearch.untitled"))} ${session.firstMessage}`,
      isDir: false,
      index,
    }));
    return filterFileEntries(indexed, trimmedQuery, 8).map((match) => candidates[(match as typeof indexed[number]).index]);
  }, [archive, project, sessions, flags, t, trimmedQuery]);

  const settingsResults = useMemo(() => filterSettingsSearchItems(trimmedQuery, t, {
    hasProject,
    hasDesktop,
    limit: trimmedQuery ? 12 : 6,
  }), [hasProject, hasDesktop, t, trimmedQuery]);

  const chatResultRows = useMemo<ChatResultRow[]>(() => response.results.map((result, index) => ({
    id: `message:${result.sessionId}:${result.entryId}:${index}`,
    result,
  })), [response.results]);

  const displayedSessions = trimmedQuery ? titleMatches : recentSessions;
  const rowIds = useMemo(() => [
    ...displayedSessions.map((session) => `session:${session.id}`),
    ...chatResultRows.map((row) => row.id),
    ...settingsResults.map((item) => `setting:${item.id}`),
  ], [chatResultRows, displayedSessions, settingsResults]);

  useEffect(() => {
    if (!trimmedQuery) {
      setResponse({ results: [], durationMs: 0, truncated: false });
      setLoading(false);
      setError(null);
      return;
    }
    setResponse({ results: [], durationMs: 0, truncated: false });
    setLoading(false);
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      const params = new URLSearchParams({ q: trimmedQuery, archive, limit: "100" });
      if (project) params.set("project", project);
      try {
        const searchResponse = await fetch(`/api/sessions/search?${params}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = await searchResponse.json().catch(() => ({})) as ConversationSearchResponse & { error?: string };
        if (!searchResponse.ok) throw new Error(payload.error || `HTTP ${searchResponse.status}`);
        if (controller.signal.aborted) return;
        setResponse(payload);
      } catch (searchError) {
        if (controller.signal.aborted) return;
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [archive, project, trimmedQuery]);

  useEffect(() => { setActiveIndex(0); }, [archive, project, trimmedQuery]);
  useEffect(() => {
    if (activeIndex >= rowIds.length) setActiveIndex(Math.max(0, rowIds.length - 1));
  }, [activeIndex, rowIds.length]);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>(`[data-search-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, []);

  const openMessageResult = (result: ConversationSearchResult) => {
    const session = sessions.find((candidate) => candidate.id === result.sessionId);
    if (!session) {
      setError(t("conversationSearch.sessionMissing"));
      return;
    }
    onSelect(session, result.entryId);
    onClose();
  };

  const openSession = (session: SessionInfo) => {
    onSelectSession(session);
    onClose();
  };

  const openSetting = (item: SettingsSearchItem) => {
    onOpenSettings(item.section, item.id);
    onClose();
  };

  const activateRow = (rowId: string | undefined) => {
    if (!rowId) return;
    if (rowId.startsWith("session:")) {
      const session = displayedSessions.find((candidate) => `session:${candidate.id}` === rowId);
      if (session) openSession(session);
      return;
    }
    if (rowId.startsWith("message:")) {
      const row = chatResultRows.find((candidate) => candidate.id === rowId);
      if (row) openMessageResult(row.result);
      return;
    }
    const setting = settingsResults.find((candidate) => `setting:${candidate.id}` === rowId);
    if (setting) openSetting(setting);
  };

  const sectionLabel = (item: SettingsSearchItem): string => {
    const section = SETTINGS_SEARCH_ITEMS.find((candidate) => candidate.id === item.section);
    return section ? t(section.labelKey) : t("sidebar.settings");
  };

  const getRowIndex = (rowId: string): number => rowIds.indexOf(rowId);
  const totalMatches = titleMatches.length + response.results.length + settingsResults.length;

  return createPortal(
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("conversationSearch.title")}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).tagName === "SELECT" || event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => event.key === "ArrowDown"
              ? Math.min(Math.max(0, rowIds.length - 1), current + 1)
              : Math.max(0, current - 1));
          }
          if (event.key === "Enter") {
            event.preventDefault();
            activateRow(rowIds[activeIndex]);
          }
        }}
      >
        <label className={styles.searchBox}>
          <AliIcon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("conversationSearch.placeholder")}
            aria-label={t("conversationSearch.placeholder")}
            aria-controls="unified-search-results"
            aria-activedescendant={rowIds[activeIndex] ? `unified-search-row-${activeIndex}` : undefined}
          />
          {loading ? <AliIcon className="animate-spin" name="reload" size={14} /> : null}
          <kbd>Esc</kbd>
        </label>

        {trimmedQuery ? <div className={styles.filters}>
          <select value={project} onChange={(event) => setProject(event.target.value)} aria-label={t("conversationSearch.projectFilter")}>
            <option value="">{t("conversationSearch.allProjects")}</option>
            {projects.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
          <select value={archive} onChange={(event) => setArchive(event.target.value as ConversationArchiveFilter)} aria-label={t("conversationSearch.archiveFilter")}>
            <option value="all">{t("conversationSearch.allChats")}</option>
            <option value="active">{t("conversationSearch.activeChats")}</option>
            <option value="archived">{t("conversationSearch.archivedChats")}</option>
          </select>
        </div> : null}

        <div className={styles.results} id="unified-search-results">
          {displayedSessions.length > 0 ? <section>
            <div className={styles.groupLabel}>{t(trimmedQuery ? "conversationSearch.groupChats" : "conversationSearch.groupRecent")}</div>
            {displayedSessions.map((session) => {
              const rowId = `session:${session.id}`;
              const rowIndex = getRowIndex(rowId);
              const projectKey = sessionProjectKey(session);
              return <button
                id={`unified-search-row-${rowIndex}`}
                key={rowId}
                type="button"
                className={styles.row}
                data-active={rowIndex === activeIndex}
                data-search-index={rowIndex}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => openSession(session)}
              >
                <span className={styles.rowIcon}><AliIcon name="message" size={15} /></span>
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{sessionTitle(session, t("conversationSearch.untitled"))}</span>
                  {trimmedQuery ? <span className={styles.rowDescription}>{session.firstMessage}</span> : null}
                </span>
                <span className={styles.rowMeta}>{session.projectless ? t("conversationSearch.projectless") : getProjectLabel(projectKey)}</span>
              </button>;
            })}
          </section> : null}

          {chatResultRows.length > 0 ? <section>
            <div className={styles.groupLabel}>{t("conversationSearch.groupMessages")}</div>
            {chatResultRows.map(({ id, result }) => {
              const rowIndex = getRowIndex(id);
              return <button
                id={`unified-search-row-${rowIndex}`}
                key={id}
                type="button"
                className={`${styles.row} ${styles.messageRow}`}
                data-active={rowIndex === activeIndex}
                data-search-index={rowIndex}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => openMessageResult(result)}
              >
                <span className={styles.rowIcon}><AliIcon name="message" size={15} /></span>
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{result.title}</span>
                  <span className={styles.snippet}><HighlightedSnippet result={result} /></span>
                </span>
                <span className={styles.rowMeta}>{result.projectLabel}</span>
              </button>;
            })}
          </section> : null}

          {settingsResults.length > 0 ? <section>
            <div className={styles.groupLabel}>{t("conversationSearch.groupSettings")}</div>
            {settingsResults.map((item) => {
              const rowId = `setting:${item.id}`;
              const rowIndex = getRowIndex(rowId);
              return <button
                id={`unified-search-row-${rowIndex}`}
                key={rowId}
                type="button"
                className={styles.row}
                data-active={rowIndex === activeIndex}
                data-search-index={rowIndex}
                onMouseEnter={() => setActiveIndex(rowIndex)}
                onClick={() => openSetting(item)}
              >
                <span className={styles.rowIcon}><AliIcon name="setting" size={15} /></span>
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{t(item.labelKey)}</span>
                  {item.descriptionKey ? <span className={styles.rowDescription}>{t(item.descriptionKey)}</span> : null}
                </span>
                <span className={styles.rowMeta}>{sectionLabel(item)}</span>
              </button>;
            })}
          </section> : null}

          {!loading && !error && trimmedQuery && totalMatches === 0 ? (
            <div className={styles.empty}><AliIcon name="search" size={22} /><span>{t("conversationSearch.noResults")}</span></div>
          ) : null}
        </div>

        <footer className={styles.footer} role="status" aria-live="polite">
          <span>{error
            ? t("conversationSearch.failed", { error })
            : trimmedQuery
              ? loading
                ? t("conversationSearch.searching")
                : t("conversationSearch.unifiedResultCount", { count: totalMatches })
              : t("conversationSearch.keyboardHint")}</span>
          <span>{t(response.truncated ? "conversationSearch.truncated" : "conversationSearch.order")}</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
