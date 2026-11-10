"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./NewSessionLauncher.module.css";

export function NewSessionLauncher({
  projectLabel,
  projectPath,
  children,
}: {
  projectLabel?: string | null;
  projectPath?: string | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <main className={styles.root} aria-label={t("newSession.ariaLabel")}>
      <section className={`${styles.launcher} chat-column`}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>{t("newSession.eyebrow")}</span>
          <h1>{t("newSession.title")}</h1>
          {projectLabel && projectPath ? (
            <span className={styles.projectPath} title={projectPath}>
              <AliIcon name="folder" size={13} />
              <span>{projectPath}</span>
            </span>
          ) : null}
        </header>
        <div className={styles.composer}>{children}</div>
      </section>
    </main>
  );
}

export function NewSessionContextChip({ label, title }: { label: string; title?: string }) {
  return (
    <span className={styles.contextChip} title={title}>
      <AliIcon name="folder" size={14} />
      <span>{label}</span>
    </span>
  );
}
