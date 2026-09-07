"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { buildSessionTree } from "@/lib/session-project-groups";
import type { SessionFlags } from "@/lib/session-flags";
import type { SessionInfo } from "@/lib/types";
import { AliIcon } from "../AliIcon";
import styles from "../SessionSidebar.module.css";
import { TaskList } from "./TaskList";
import type { SessionMoveTarget } from "./TaskContextMenu";

interface Props {
  sessions: SessionInfo[];
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  moveTargets: SessionMoveTarget[];
  sessionFlags: SessionFlags;
  onNewChat: () => void;
  onSelectSession: (session: SessionInfo) => void;
  onRenamed: () => void;
  onSessionDeleted: (session: SessionInfo, sessionIds?: string[]) => void;
  onFlagChange: (session: SessionInfo, patch: { pinned?: boolean; archived?: boolean }) => void;
  onDuplicate: (session: SessionInfo) => void;
  onMarkUnread: (session: SessionInfo) => void;
  onMoveSession: (session: SessionInfo, target: SessionMoveTarget) => Promise<void>;
  sessionOrder: readonly string[];
  onReorderSessions: (sourceId: string, targetId: string, position: "before" | "after") => void;
}

export function SidebarChatArea({
  sessions,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  moveTargets,
  sessionFlags,
  onNewChat,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  onFlagChange,
  onDuplicate,
  onMarkUnread,
  onMoveSession,
  sessionOrder,
  onReorderSessions,
}: Props) {
  const { t } = useI18n();
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);

  return (
    <section className={styles.chatSection} aria-label={t("sidebar.chats")}>
      <div className={`${styles.sectionLabel} ${styles.projectsHeader}`}>
        <span>{t("sidebar.chats")}</span>
        <div className={styles.sectionLabelActions}>
          <button
            type="button"
            className={styles.rowAction}
            onClick={onNewChat}
            title={t("sidebar.newProjectlessChat")}
            aria-label={t("sidebar.newProjectlessChat")}
          >
            <AliIcon name="plus" size={12} />
          </button>
        </div>
      </div>
      <div className={styles.chatSessionList} data-session-drag-scroll>
        {tree.length > 0 ? (
          <TaskList
            nodes={tree}
            selectedSessionId={selectedSessionId}
            runningSessionIds={runningSessionIds}
            unreadSessionIds={unreadSessionIds}
            moveTargets={moveTargets}
            flags={sessionFlags}
            onSelectSession={onSelectSession}
            onRenamed={onRenamed}
            onSessionDeleted={onSessionDeleted}
            onFlagChange={onFlagChange}
            onDuplicate={onDuplicate}
            onMarkUnread={onMarkUnread}
            onMoveSession={onMoveSession}
            scope="projectless"
            sessionOrder={sessionOrder}
            onReorderSessions={onReorderSessions}
          />
        ) : (
          <p className={styles.chatEmpty}>{t("sidebar.noProjectlessChats")}</p>
        )}
      </div>
    </section>
  );
}
