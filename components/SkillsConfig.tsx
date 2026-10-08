"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { SkillInfo, SkillsResponse, SkillUpdateResult } from "@/lib/api-types";
import type { SkillSource } from "@/lib/skill-sources/types";
import { SkillDiscovery } from "./skills/Discover";
import { SkillSources } from "./skills/Sources";
import { skillsRequest } from "./skills/client";
import styles from "./skills/Skills.module.css";

export function SkillsConfig({ cwd, onClose, embedded = false }: { cwd: string; onClose: () => void; embedded?: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"discover" | "installed" | "sources">("discover");
  const [sourceEditor, setSourceEditor] = useState<string | null>();
  const [sources, setSources] = useState<SkillSource[]>([]), [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [updates, setUpdates] = useState<Record<string, SkillUpdateResult>>({}), [projectValid, setProjectValid] = useState(false);
  const [diagnostics, setDiagnostics] = useState<SkillsResponse["diagnostics"]>([]);
  const ref = useRef<HTMLDivElement>(null), generation = useRef(0);
  useFocusTrap(ref, !embedded, { onEscape: onClose });
  const loadSources = useCallback(async () => { const data = await skillsRequest<{ sources: SkillSource[] }>("/sources"); setSources(data.sources); }, []);
  const loadSkills = useCallback(async () => {
    const current = ++generation.current;
    try { const data = await skillsRequest<SkillsResponse>(cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""); if (current === generation.current) { setSkills(data.skills); setDiagnostics(data.diagnostics || []); setProjectValid(Boolean(cwd && data.projectResourcesLoaded)); } }
    catch (e) { if (current === generation.current) { setProjectValid(false); setError(String(e instanceof Error ? e.message : e)); } const global = await skillsRequest<SkillsResponse>(""); if (current === generation.current) setSkills(global.skills); }
  }, [cwd]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setUpdates({});
    void Promise.all([loadSkills(), loadSources()]).catch(e => { if (!cancelled) setError(String(e.message || e)); }).finally(() => { if (!cancelled) setLoading(false); });
    const current = generation.current;
    return () => { cancelled = true; generation.current = current + 1; };
  }, [loadSkills, loadSources]);
  const effectiveCwd = projectValid ? cwd : "";
  function configureSource(id: string | null) { setSourceEditor(id); setTab("sources"); }
  async function action(fn: () => Promise<void>) { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); } }
  function key(skill: SkillInfo) { return `${skill.install?.scope}:${skill.install?.package}`; }
  async function check(skill?: SkillInfo) {
    const data = await skillsRequest<{ updates: SkillUpdateResult[] }>("/check", { cwd: effectiveCwd || undefined, package: skill?.install?.package, scope: skill?.install?.scope });
    setUpdates(previous => ({ ...previous, ...Object.fromEntries(data.updates.map(u => [`${u.scope}:${u.package}`, u])) }));
  }
  const content = <div ref={ref} className={`${styles.shell} ${embedded ? styles.embedded : ""}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={t("common.skills")}>
    <header className={styles.header}><div><h2>{t("common.skills")}</h2><span className={styles.muted}>{t("skills.intro")}</span></div>{!embedded && <button onClick={onClose}>{t("skills.close")}</button>}</header>
    <nav className={styles.tabs} role="tablist" aria-label={t("common.skills")}>{(["discover", "installed", "sources"] as const).map(value => <button key={value} role="tab" id={`skills-tab-${value}`} aria-selected={tab === value} aria-controls="skills-panel" onClick={() => { setSourceEditor(undefined); setTab(value); }}>{t(`skills.${value}`)}</button>)}</nav>
    {error && <div role="alert" className={`${styles.notice} ${styles.error}`}>{error}</div>}{notice && <div role="status" className={styles.notice}>{notice}</div>}
    <div className={styles.body} role="tabpanel" id="skills-panel" aria-labelledby={`skills-tab-${tab}`}>
      {loading ? <p role="status">{t("skills.loading")}</p> : tab === "discover" ? <SkillDiscovery sources={sources} installed={skills} cwd={effectiveCwd} onInstalled={loadSkills} onConfigureSource={configureSource}/> : tab === "sources" ? <SkillSources sources={sources} onChanged={loadSources} initialSourceId={sourceEditor}/> : <>
        <div className={styles.toolbar}><button disabled={busy} onClick={() => void action(() => check())}>{busy ? t("skills.busy") : t("skills.check")}</button><button disabled={busy} onClick={() => void action(loadSkills)}>{t("skills.refresh")}</button></div>
        {!skills.length && <p className={styles.muted}>{t("skills.empty")}</p>}
        {diagnostics.map((diagnostic, index) => <p className={styles.muted} key={index}>{diagnostic.message} {diagnostic.path}</p>)}
        <div className={styles.grid}>{skills.map(skill => {
          const install = skill.install, status = updates[key(skill)], scope = install?.scope || (skill.sourceInfo?.scope === "project" ? "project" : "global"), url = install?.sourceUrl || install?.skillsShUrl;
          return <section key={skill.filePath} className={styles.card}>
            <h3>{skill.name}</h3><details><summary>{t("skills.detail")}</summary><p>{skill.description}</p></details><div className={styles.row}><span className={styles.badge}>{t(`skills.${scope}`)}</span>{install && <span className={styles.badge}>{install.source}</span>}</div>
            <p className={styles.muted}>{t("skills.path")}: {skill.filePath}</p>{install?.versionHash && <p className={styles.muted}>{t("skills.version")}: {install.versionHash}</p>}{install?.pinned && <p className={styles.muted}>{t("skills.pinned")}</p>}
            {skills.some(s => s.name === skill.name && s.filePath !== skill.filePath) && <p className={styles.muted}>{t("skills.shadow")}</p>}
            {url && /^https?:\/\//.test(url) && <p><a href={url} target="_blank" rel="noreferrer">{t("skills.original")}</a></p>}
            <label className={styles.row}><input type="checkbox" checked={!skill.disableModelInvocation} disabled={busy} onChange={() => void action(async () => { await skillsRequest("", { filePath: skill.filePath, disableModelInvocation: !skill.disableModelInvocation }, "PATCH"); await loadSkills(); setNotice(t("skills.reload")); })}/>{t("skills.enableSkill")}</label>
            {install && <div className={styles.row}><button disabled={busy} onClick={() => void action(() => check(skill))}>{t("skills.check")}</button>{status?.state === "update-available" && <button disabled={busy} onClick={() => void action(async () => { await skillsRequest("/update", { cwd: effectiveCwd || undefined, scope: install.scope, package: install.package, installId: install.installId }); await loadSkills(); setUpdates(p => { const next = { ...p }; delete next[key(skill)]; return next; }); setNotice(t("skills.reload")); })}>{t("skills.update")}</button>}</div>}
            {status && <p className={status.state === "error" ? styles.error : styles.muted}>{t(status.state === "unsupported" ? "skills.updateUnsupported" : `skills.${status.state}`)}{status.message ? ` · ${status.message}` : ""}</p>}
          </section>;
        })}</div>
      </>}
    </div>
  </div>;
  return embedded ? content : <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>{content}</div>;
}
