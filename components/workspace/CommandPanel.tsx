"use client";
import { useI18n } from "@/hooks/useI18n";
import { SmartShellPanel, type SmartShellPanelProps } from "./SmartShellPanel";
import styles from "./SmartShell.module.css";

export function CommandPanel({ cwd, ...props }: Omit<SmartShellPanelProps, "cwd"> & { cwd?: string | null }) {
  const { t } = useI18n();
  return cwd ? <SmartShellPanel key={cwd} cwd={cwd} {...props} /> : <section className={styles.root}><div className={styles.empty}>{t("shell.noWorkspace")}</div></section>;
}
