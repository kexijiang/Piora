"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { shellRequest } from "@/lib/shell/client";
import type { HistorySource, ShellProfile, ShellSettings } from "@/lib/shell/types";
import { ShellModelSelect } from "./workspace/ShellModelSelect";
import styles from "./workspace/SmartShell.module.css";

export function SmartShellSettings({ cwd }: { cwd?: string }) {
  const { t } = useI18n(); const [settings, setSettings] = useState<ShellSettings | null>(null); const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [discovered, setDiscovered] = useState<HistorySource[]>([]); const [status, setStatus] = useState<HistorySource[]>([]); const [error, setError] = useState(""); const [saved, setSaved] = useState(false); const [busy, setBusy] = useState(false);
  const [addingSource, setAddingSource] = useState(false);
  const revision = useRef(0);
  const [sourcePath, setSourcePath] = useState(""); const [sourceKind, setSourceKind] = useState<HistorySource["kind"]>("powershell");
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([shellRequest<ShellSettings>("settings", undefined, { signal: controller.signal }), shellRequest<{ profiles: ShellProfile[] }>("profiles", undefined, { signal: controller.signal }), shellRequest<{ discovered: HistorySource[]; status: HistorySource[] }>("history/sources", undefined, { signal: controller.signal })]).then(([settings, profiles, sources]) => { setSettings(settings); setProfiles(profiles.profiles); setDiscovered(sources.discovered); setStatus(sources.status); }).catch(cause => { if (!controller.signal.aborted) setError(String(cause)); });
    return () => controller.abort();
  }, []);
  const change = (patch: Partial<ShellSettings>) => { revision.current++; setSettings(value => value ? { ...value, ...patch } : value); setSaved(false); };
  const save = async (sync = false) => {
    if (!settings || busy) return; setBusy(true); setError("");
    const submittedRevision = revision.current;
    try {
      const result = await shellRequest<ShellSettings>("settings", settings);
      if (revision.current === submittedRevision) { setSettings(result); setSaved(true); }
      if (sync) setStatus((await shellRequest<{ sources: HistorySource[] }>("history/sync", {})).sources);
    } catch (cause) { setError(String(cause)); } finally { setBusy(false); }
  };
  const sources = [...new Map([...discovered, ...settings?.sources || []].map(source => [source.id, source])).values()];
  return <div className={styles.settings}>
    <header><h2>{t("shell.title")}</h2><p>{t("shell.description")}</p></header>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {settings ? <>
      <section className={styles.settingsSection} data-settings-id="shell.model">
        <h3>{t("shell.modelSection")}</h3>
        <div className={styles.field}><label>{t("shell.model")}</label><ShellModelSelect cwd={cwd} value={settings.model} onChange={model => change({ model })} /></div>
        <p>{t("shell.modelHint")}</p>
      </section>
      <section className={styles.settingsSection}>
        <h3>{t("shell.terminalSection")}</h3>
        <label className={styles.field}>{t("shell.defaultShell")}<select value={settings.executable || ""} onChange={event => change({ executable: event.target.value || null })}><option value="">{t("shell.detectShell")}</option>{settings.executable && !profiles.some(profile => profile.executable === settings.executable) ? <option value={settings.executable}>{settings.executable}</option> : null}{profiles.map(profile => <option key={profile.executable} value={profile.executable}>{profile.label} · {profile.executable}</option>)}</select></label>
        <p>{t("shell.settingsHint")}</p>
      </section>
      <section className={styles.settingsSection} data-settings-id="shell.history">
        <h3>{t("shell.history")}</h3>
        <div className={styles.settingRow}><div><strong>{t("shell.systemHistory")}</strong><p>{t("shell.systemHistoryHint")}</p></div><button type="button" role="switch" aria-label={t("shell.systemHistory")} aria-checked={settings.importSystemHistory} className={styles.switch} onClick={() => change({ importSystemHistory: !settings.importSystemHistory })} /></div>
        <div className={styles.settingRow}><div><strong>{t("shell.piHistory")}</strong><p>{t("shell.piHistoryHint")}</p></div><button type="button" role="switch" aria-label={t("shell.piHistory")} aria-checked={settings.importPiHistory} className={styles.switch} onClick={() => change({ importPiHistory: !settings.importPiHistory })} /></div>
        <div className={styles.sectionHeading}><strong>{t("shell.sources")}</strong><button disabled={busy} onClick={() => void save(true)}>{t("shell.sync")}</button></div>
        {sources.length ? <div className={styles.sourceTable}>{sources.map(source => {
          const live = status.find(item => item.id === source.id);
          const automatic = discovered.some(item => item.id === source.id);
          return <div key={source.id} className={styles.source}>
            <div className={styles.sectionHeading}>
              <label><input type="checkbox" checked={source.enabled} onChange={event => change({ sources: [...settings.sources.filter(item => item.id !== source.id), { ...source, enabled: event.target.checked }] })} />{source.kind === "powershell" ? "PowerShell" : source.kind === "zsh" ? "Zsh" : "Bash"}</label>
              {!automatic ? <button type="button" title={t("shell.removeSourceHint")} onClick={() => change({ sources: settings.sources.filter(item => item.id !== source.id) })}>{t("shell.removeSource")}</button> : null}
            </div>
            <code>{source.path}</code><small>{t("shell.count")}: {live?.imported ?? 0} · {t("shell.updated")}: {live?.updatedAt ? new Date(live.updatedAt).toLocaleString() : "—"}</small>
            {live?.error ? <div className={styles.error}>{live.error}</div> : null}
          </div>;
        })}</div> : null}
        <button type="button" className={styles.addSource} aria-expanded={addingSource} onClick={() => setAddingSource(value => !value)}>+ {t("shell.addSource")}</button>
        {addingSource ? <form onSubmit={event => { event.preventDefault(); if (sourcePath.trim()) { change({ sources: [...settings.sources, { id: `custom:${crypto.randomUUID()}`, path: sourcePath.trim(), kind: sourceKind, enabled: true }] }); setSourcePath(""); setAddingSource(false); } }}><div className={styles.inlineInput}><input type="text" aria-label={t("shell.sourcePath")} placeholder={t("shell.sourcePath")} value={sourcePath} onChange={event => setSourcePath(event.target.value)} /></div><div className={styles.inlineInput}><select aria-label={t("shell.sources")} value={sourceKind} onChange={event => setSourceKind(event.target.value as HistorySource["kind"])}><option value="powershell">PowerShell</option><option value="bash">Bash / Git Bash</option><option value="zsh">Zsh</option></select><button type="submit">{t("shell.add")}</button></div></form> : null}
        <p>{t("shell.historyHint")}</p>
      </section>
      <footer className={styles.settingsFooter}><small role="status">{t(saved ? "shell.saved" : "shell.saveHint")}</small><button className={styles.primary} disabled={busy} onClick={() => void save()}>{t("shell.save")}</button></footer>
    </> : <p>{t("shell.connecting")}</p>}
  </div>;
}
