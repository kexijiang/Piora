"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SkillInfo, SkillInstallScope } from "@/lib/api-types";
import type { CatalogPage, CatalogSkill, SkillDetail, SkillSource } from "@/lib/skill-sources/types";
import { skillsRequest } from "./client";
import styles from "./Skills.module.css";

export function SkillDiscovery({ sources, installed, cwd, onInstalled, onConfigureSource }: { sources: SkillSource[]; installed: SkillInfo[]; cwd: string; onInstalled: () => Promise<void>; onConfigureSource: (id: string | null) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState(""), [submitted, setSubmitted] = useState(""), [sourceId, setSourceId] = useState("");
  const [pages, setPages] = useState<Record<string, CatalogPage>>({}), [loading, setLoading] = useState<Set<string>>(new Set());
  const [generation, setGeneration] = useState(0), epoch = useRef(0);
  const refreshedGeneration = useRef(0);
  const [selection, setSelection] = useState<CatalogSkill | null>(null), [detail, setDetail] = useState<SkillDetail | null>(null), [detailError, setDetailError] = useState("");
  const [scope, setScope] = useState<SkillInstallScope>("global"), [installing, setInstalling] = useState(false), [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController(), current = ++epoch.current;
    const refresh = generation !== refreshedGeneration.current;
    refreshedGeneration.current = generation;
    const selected = sourceId ? sources.filter(s => s.id === sourceId) : sources;
    setPages({}); setLoading(new Set(selected.map(s => s.id)));
    for (const source of selected) {
      void skillsRequest<{ pages: CatalogPage[] }>("/search", { catalog: true, sourceId: source.id, query: submitted, refresh }, "POST", controller.signal).then(data => {
        if (epoch.current === current) setPages(p => ({ ...p, [source.id]: data.pages[0] }));
      }).catch(e => {
        if (!controller.signal.aborted && epoch.current === current) setPages(p => ({ ...p, [source.id]: { sourceId: source.id, state: "error", items: [], error: String(e.message || e) } }));
      }).finally(() => { if (epoch.current === current) setLoading(p => { const next = new Set(p); next.delete(source.id); return next; }); });
    }
    return () => { controller.abort(); epoch.current = current + 1; };
  }, [sources, sourceId, submitted, generation]);
  useEffect(() => {
    setDetail(null); setDetailError("");
    if (!selection) return;
    const controller = new AbortController();
    void skillsRequest<{ detail: SkillDetail }>("/detail", { sourceId: selection.sourceId, skillId: selection.id }, "POST", controller.signal)
      .then(data => { if (!controller.signal.aborted) setDetail(data.detail); })
      .catch(e => { if (!controller.signal.aborted) setDetailError(String(e.message || e)); });
    return () => controller.abort();
  }, [selection]);
  async function more(id: string) {
    const cursor = pages[id]?.nextCursor, current = epoch.current;
    if (!cursor) return;
    setLoading(p => new Set(p).add(id));
    try {
      const data = await skillsRequest<{ pages: CatalogPage[] }>("/search", { sourceId: id, query: submitted, cursor });
      if (current === epoch.current) setPages(p => ({ ...p, [id]: { ...data.pages[0], items: [...p[id].items, ...data.pages[0].items.filter(item => !p[id].items.some(old => old.id === item.id))] } }));
    } catch (e) { if (current === epoch.current) setPages(p => ({ ...p, [id]: { ...p[id], state: "error", error: String(e) } })); }
    finally { if (current === epoch.current) setLoading(p => { const next = new Set(p); next.delete(id); return next; }); }
  }
  const isInstalled = (item: CatalogSkill, targetScope?: string) => installed.some(s => (!targetScope || s.install?.scope === targetScope) && ((s.install?.sourceId === item.sourceId && s.install.skillId === item.id) || (item.sourceId === "skills-sh" && s.install?.skillsShUrl?.replace(/^https?:\/\//, "") === `skills.sh/${item.id}`)));
  async function install() {
    if (!detail) return;
    setInstalling(true); setDetailError("");
    try { await skillsRequest("/install", { sourceId: detail.sourceId, skillId: detail.id, scope, cwd: cwd || undefined, version: detail.version }); await onInstalled(); setNotice(t("skills.reload")); }
    catch (e) { setDetailError(String(e instanceof Error ? e.message : e)); }
    finally { setInstalling(false); }
  }
  if (selection) return <div className={styles.detail}>
    <div className={styles.row}><button disabled={installing} onClick={() => { setSelection(null); setNotice(""); }}>{t("skills.discover")}</button><h3>{selection.name}</h3></div>
    {detailError && <p className={styles.error} role="alert">{detailError}</p>}
    {!detail && !detailError && <p role="status">{t("skills.loading")}</p>}
    {detail && <>
      <div className={styles.row}><span className={styles.badge}>{sources.find(s => s.id === detail.sourceId)?.name}</span>{detail.publisher && <span>{t("skills.publisher")}: {detail.publisher}</span>}{detail.version && <span>{t("skills.version")}: {detail.version}</span>}{detail.pinned && <span>{t("skills.pinned")}</span>}</div>
      <p>{detail.description}</p>
      <div className={styles.row}><select aria-label={t("skills.global")} value={scope} disabled={installing} onChange={e => setScope(e.target.value as SkillInstallScope)}><option value="global">{t("skills.global")}</option><option value="project" disabled={!cwd}>{t("skills.project")}</option></select><button className={styles.primary} disabled={installing || isInstalled(detail, scope)} onClick={() => void install()}>{installing ? t("skills.busy") : isInstalled(detail, scope) ? t("skills.installedBadge") : t("skills.install")}</button></div>
      {!cwd && <span className={styles.muted}>{t("skills.noProject")}</span>}
      {installed.some(s => s.name === detail.name && s.install?.scope !== scope) && <p className={styles.muted}>{t("skills.shadow")}</p>}
      {notice && <p role="status">{notice}</p>}{detail.url && /^https?:\/\//.test(detail.url) && <a href={detail.url} target="_blank" rel="noreferrer">{t("skills.original")}</a>}
      <section><h3>SKILL.md</h3><pre>{detail.readme}</pre></section>
      {detail.requirements && <section><h3>{t("skills.requirements")}</h3><pre>{detail.requirements}</pre></section>}
      <section><h3>{t("skills.files")} ({detail.files.length})</h3><ul>{detail.files.map(file => <li key={file}>{file}</li>)}</ul></section>
    </>}
  </div>;
  return <>
    <form className={styles.toolbar} onSubmit={e => { e.preventDefault(); setSubmitted(query.trim()); }}>
      <input aria-label={t("skills.search")} placeholder={t("skills.search")} value={query} maxLength={500} onChange={e => setQuery(e.target.value)}/>
      <select aria-label={t("skills.source")} value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">{t("skills.allSources")}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      <button className={styles.primary}>{t("skills.search")}</button><button type="button" onClick={() => setGeneration(n => n + 1)}>{t("skills.refresh")}</button>
      <button type="button" onClick={() => onConfigureSource(null)}>{t("skills.addSource")}</button>
    </form>
    {(sourceId ? sources.filter(s => s.id === sourceId) : sources).map(source => {
      const page = pages[source.id];
      return <section className={styles.group} key={source.id} aria-label={source.name}>
        <h3>{source.name}</h3>{loading.has(source.id) && <p role="status" className={styles.muted}>{t("skills.loading")}</p>}
        {page && page.state !== "ready" && <div className={styles.row}>
          {page.state !== "auth-required" && <p className={page.state === "error" ? styles.error : styles.muted}>{t(`skills.${page.state}`)}{page.error ? ` · ${page.error}` : ""}</p>}
          <button type="button" onClick={() => onConfigureSource(source.id)}>{t(page.state === "auth-required" ? "skills.auth-required" : "skills.configure")}</button>
        </div>}
        {page?.fetchedAt && <p className={styles.muted}>{page.stale ? `${t("skills.cached")} · ` : ""}{t("skills.updatedAt")}: {new Date(page.fetchedAt).toLocaleString()}</p>}
        {page?.state === "ready" && !page.items.length && <p className={styles.muted}>{t("skills.empty")}</p>}
        <div className={styles.grid}>{page?.items.map(item => <button key={item.id} className={`${styles.card} ${styles.cardButton}`} onClick={() => { setSelection(item); setNotice(""); }}>
          <strong>{item.name}</strong>{item.description && <span className={styles.description}>{item.description}</span>}<span className={styles.muted}>{item.publisher}</span>{isInstalled(item) && <span className={styles.badge}>{t("skills.installedBadge")}</span>}
        </button>)}</div>{page?.nextCursor && (page.state === "ready" || page.stale) && <button disabled={loading.has(source.id)} onClick={() => void more(source.id)}>{t("skills.more")}</button>}
      </section>;
    })}
  </>;
}
