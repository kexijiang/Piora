"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MemePicker } from "./MemePicker";
import type { DshPetAction, DshPetStatus } from "@/desktop/src/dsh-pet-types";
import styles from "./DesktopExtensionsSettings.module.css";
import settingsStyles from "./SettingsDialog.module.css";

export function DesktopExtensionsSettings() {
  const { t } = useI18n();
  const [status, setStatus] = useState<DshPetStatus | null>(null);
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const bridge = window.piDesktop?.dshPet;
    setAvailable(Boolean(bridge));
    if (bridge) {
      try { setStatus(await bridge.status()); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(timer);
  }, [load]);
  const busy = pending || Boolean(status && ["installing", "starting", "stopping"].includes(status.phase));
  const perform = async (action: DshPetAction) => {
    if (!window.piDesktop?.dshPet || (busy && !["cancel", "folder"].includes(action))) return;
    setPending(true); setError(null);
    try { setStatus(await window.piDesktop.dshPet.action(action)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const preference = async (key: "autoStart" | "syncTasks", checked: boolean) => {
    if (!window.piDesktop?.dshPet) return;
    setPending(true); setError(null);
    try { setStatus(await window.piDesktop.dshPet.preferences({ [key]: checked })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <section className={`${styles.root} settings-embedded-surface`} data-settings-id="desktopExtensions">
    <h2>{t("desktopExtensions.title")}</h2>
    <p className={styles.description}>{t("desktopExtensions.description")}</p>
    <article className={styles.card}>
      <div className={styles.header}><h3>DSH Meme · {t("memes.title")}</h3><MemePicker /></div>
      <p>{t("memes.empty")}</p>
    </article>
    <article className={styles.card}>
      <div className={styles.header}><div><h3>DSH Pet</h3><p>PC2005-cloud · {status?.version ?? "0.3.8"}</p></div>
        <span role="status">{t(!available ? "desktopExtensions.desktopOnly" : status ? `desktopExtensions.state.${status.phase}` : "common.loading")}</span>
      </div>
      <p>{t("desktopExtensions.petDescription")}</p>
      {status?.progress && <p role="status">{t(`desktopExtensions.progress.${status.progress.stage}`)}
        {status.progress.total ? ` ${Math.floor(status.progress.received / status.progress.total * 100)}%` : ""}</p>}
      <div className={styles.actions}>
        {status && ["installing", "starting"].includes(status.phase) && <button disabled={pending} onClick={() => void perform("cancel")}>{t("common.cancel")}</button>}
        {!status?.installed && <button disabled={!available || busy || !status} onClick={() => void perform("install")}>{t("desktopExtensions.install")}</button>}
        {status?.installed && <>
          <button disabled={busy} onClick={() => void perform(status.phase === "running" ? "stop" : "start")}>{t(status.phase === "running" ? "desktopExtensions.stop" : "desktopExtensions.start")}</button>
          <button disabled={busy || status.phase !== "running"} onClick={() => void perform("settings")}>{t("desktopExtensions.settings")}</button>
          <button disabled={busy} onClick={() => void perform("uninstall")}>{t("desktopExtensions.uninstall")}</button>
        </>}
        <button disabled={!available} onClick={() => void perform("folder")}>{t("desktopExtensions.folder")}</button>
      </div>
      <div className={styles.option}><span>{t("desktopExtensions.autoStart")}</span><button type="button" role="switch" className={settingsStyles.switch}
        aria-label={t("desktopExtensions.autoStart")} aria-checked={status?.autoStart ?? false} disabled={!status?.installed || busy}
        onClick={() => void preference("autoStart", !status?.autoStart)}><span /></button></div>
      <div className={styles.option}><span>{t("desktopExtensions.syncTasks")}</span><button type="button" role="switch" className={settingsStyles.switch}
        aria-label={t("desktopExtensions.syncTasks")} aria-checked={status?.syncTasks ?? true} disabled={!status?.installed || busy}
        onClick={() => void preference("syncTasks", !status?.syncTasks)}><span /></button></div>
      <p className={styles.description}>{t("desktopExtensions.capabilities")}</p>
      <p className={styles.description}>{t("desktopExtensions.firstRun")}</p>
      <p className={styles.description}>{t("desktopExtensions.license")} <a href="https://github.com/PC2005-cloud/dsh-pet" target="_blank" rel="noreferrer">{t("desktopExtensions.source")}</a></p>
      {(error || status?.error) && <p className={styles.error} role="alert">{error || status?.error}</p>}
    </article>
  </section>;
}
