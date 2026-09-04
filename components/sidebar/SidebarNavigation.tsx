"use client";

import type { Dispatch, RefObject, SetStateAction } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getProjectLabel, type SessionProjectGroup } from "@/lib/session-project-groups";
import { AliIcon } from "../AliIcon";
import styles from "../SessionSidebar.module.css";

interface Props {
  onOpenConversationSearch?: () => void;
  primaryActionRef: RefObject<HTMLButtonElement | null>;
  onOpenSettings?: () => void;
  selectedCwd: string | null;
  selectedCwdProp?: string | null;
  projectGroups: SessionProjectGroup[];
  pinnedProjectGroups: SessionProjectGroup[];
  projectAliases: Record<string, string>;
  setSelectedCwd: Dispatch<SetStateAction<string | null>>;
  setCollapsedProjectKeys: Dispatch<SetStateAction<Set<string>>>;
  handleNewSessionInProject: (cwd: string) => void;
  onRequestNewSession?: () => void;
  handleDefaultCwd: () => Promise<void>;
  togglePinnedProject: (root: string) => void;
}

export function SidebarNavigation(props: Props) {
  const { t } = useI18n();
  const { onOpenConversationSearch, primaryActionRef, onOpenSettings, selectedCwd, selectedCwdProp, projectGroups, pinnedProjectGroups, projectAliases, setSelectedCwd, setCollapsedProjectKeys, handleNewSessionInProject, onRequestNewSession, handleDefaultCwd, togglePinnedProject } = props;
  return <>
      <div className={styles.brandRow}>
        <button type="button" className={styles.brandButton} aria-label={t("sidebar.appMenu")}>
          <span className={styles.brandMark} aria-hidden="true">π</span>
          <span>Piora</span>
        </button>
        <div className={styles.brandActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={onOpenSettings}
            title={t("sidebar.settings")}
            aria-label={t("sidebar.settings")}
          >
            <AliIcon name="setting" size={15} />
          </button>
        </div>
      </div>

      <nav className={styles.primaryNav} aria-label={t("sidebar.primaryNavigation")}>
        <button
          ref={primaryActionRef}
          type="button"
          className={styles.navButton}
          onClick={() => {
            if (onRequestNewSession) {
              onRequestNewSession();
              return;
            }
            const cwd = selectedCwd ?? selectedCwdProp ?? projectGroups[0]?.preferredCwd;
            if (cwd) handleNewSessionInProject(cwd);
            else void handleDefaultCwd();
          }}
        >
          <AliIcon name="compose" size={16} />
          <span>{t("sidebar.newChat")}</span>
        </button>
        <button type="button" className={styles.navButton} onClick={onOpenConversationSearch}>
          <AliIcon name="search" size={15} />
          <span>{t("sidebar.searchChats")}</span>
        </button>
      </nav>

      {pinnedProjectGroups.length > 0 && (
        <div>
          <div className={styles.sectionLabel}>{t("sidebar.pinned")}</div>
          <div className={styles.pinnedList}>
            {pinnedProjectGroups.map((group) => (
              <div className={styles.pinnedRow} key={group.projectRoot}>
                <button
                  type="button"
                  className={styles.pinnedMain}
                  title={group.projectRoot}
                  onClick={() => {
                    setSelectedCwd(group.preferredCwd);
                    setCollapsedProjectKeys((previous) => {
                      const next = new Set(previous);
                      next.delete(group.key);
                      return next;
                    });
                  }}
                >
                  <AliIcon name="folder" size={15} />
                  <span className={styles.ellipsis}>{projectAliases[group.projectRoot] ?? getProjectLabel(group.projectRoot)}</span>
                </button>
                <button
                  type="button"
                  className={`${styles.rowAction} ${styles.pinnedUnpin}`}
                  onClick={() => togglePinnedProject(group.projectRoot)}
                  title={t("sidebar.unpinProject")}
                  aria-label={t("sidebar.unpinProject")}
                >
                  <AliIcon name="pushpin" size={13} style={{ color: "var(--accent)" }} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
  </>;
}
