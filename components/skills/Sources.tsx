"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SkillSource, SourceInput } from "@/lib/skill-sources/types";
import { skillsRequest } from "./client";
import styles from "./Skills.module.css";

const blank: SourceInput = { name: "", kind: "git", url: "", enabled: true };
export function SkillSources({ sources, onChanged, initialSourceId }: { sources: SkillSource[]; onChanged: () => Promise<void>; initialSourceId?: string | null }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<SkillSource | null>(() => sources.find(source => source.id === initialSourceId) || null);
  const [form, setForm] = useState<SourceInput | null>(() => editing ? { ...editing, credential: "" } : initialSourceId === null ? { ...blank } : null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const formRef = useRef<HTMLFormElement>(null), formOpen = form !== null;
  useEffect(() => {
    if (!formOpen) return;
    formRef.current?.scrollIntoView({ block: "nearest" });
    const field = editing && editing.kind !== "git" ? 'input[type="password"]' : 'input:not([type="checkbox"]):not(:disabled)';
    formRef.current?.querySelector<HTMLInputElement>(field)?.focus({ preventScroll: true });
  }, [editing, formOpen]);
  async function action(data: unknown, method = "POST", close = false) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await skillsRequest<{ success?: boolean; error?: string }>("/sources", data, method);
      if (result.error) throw new Error(result.error);
      await onChanged(); if (close) setForm(null); else if ((data as { action?: string }).action === "test") setNotice(t("skills.tested"));
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
    finally { setBusy(false); }
  }
  function edit(source: SkillSource | null) { setEditing(source); setForm(source ? { ...source, credential: "" } : { ...blank }); setError(""); setNotice(""); }
  return <>
    <div className={styles.toolbar}><button onClick={() => edit(null)} disabled={busy}>{t("skills.addSource")}</button><span className={styles.muted}>{t("skills.sourceIntro")}</span></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    {form && <form ref={formRef} className={styles.form} onSubmit={e => { e.preventDefault(); void action({ ...form, id: editing?.id }, "POST", true); }}>
      <h3>{editing ? `${t("skills.configure")} · ${editing.name}` : t("skills.addSource")}</h3>
      <label>{t("skills.name")}<input required value={form.name} maxLength={120} disabled={busy} onChange={e => setForm({ ...form, name: e.target.value })}/></label>
      <label>{t("skills.kind")}<select value={form.kind} disabled={busy || editing?.builtin} onChange={e => setForm({ ...form, kind: e.target.value as SourceInput["kind"] })}>
        <option value="git">Git</option><option value="skills-sh">skills.sh v1</option><option value="skillhub">SkillHub</option><option value="clawhub">ClawHub</option>
      </select></label>
      <label>{t("skills.url")}<input required value={form.url} disabled={busy || editing?.builtin} placeholder={form.kind === "git" ? "https://github.com/owner/repo.git" : "https://skills.example.com"} onChange={e => setForm({ ...form, url: e.target.value })}/></label>
      {form.kind === "git" ? <>
        <label>{t("skills.ref")}<input value={form.ref || ""} disabled={busy || editing?.builtin} onChange={e => setForm({ ...form, ref: e.target.value })}/></label>
        <label>{t("skills.subdirectory")}<input value={form.subdirectory || ""} disabled={busy || editing?.builtin} onChange={e => setForm({ ...form, subdirectory: e.target.value })}/></label>
        <p className={styles.muted}>{t("skills.gitAuth")}</p>
      </> : <>
        <label>{t("skills.credential")}<input type="password" autoComplete="new-password" value={form.credential || ""} disabled={busy} onChange={e => setForm({ ...form, credential: e.target.value, clearCredential: false })}/></label>
        <span className={styles.muted}>{t("skills.credentialHint")}</span>
        {editing?.hasCredential && <label><input type="checkbox" checked={!!form.clearCredential} disabled={busy} onChange={e => setForm({ ...form, clearCredential: e.target.checked, credential: "" })}/>{t("skills.clearCredential")}</label>}
      </>}
      {editing?.id === "skillhub" && <p className={styles.muted}>{t("skills.skillhubHint")}</p>}
      <label><input type="checkbox" checked={form.enabled !== false} disabled={busy} onChange={e => setForm({ ...form, enabled: e.target.checked })}/>{t("skills.enabled")}</label>
      <span className={styles.muted}>{t("skills.testBeforeSave")} {editing && !editing.builtin ? t("skills.changedIdentity") : ""}</span>
      <div className={styles.row}><button type="button" disabled={busy} onClick={() => void action({ ...form, id: editing?.id, action: "test" })}>{busy ? t("skills.busy") : t("skills.test")}</button><button className={styles.primary} disabled={busy}>{t("skills.save")}</button><button type="button" disabled={busy} onClick={() => setForm(null)}>{t("skills.cancel")}</button></div>
    </form>}
    <div className={styles.grid}>{sources.map(source => <section key={source.id} className={styles.card}>
      <h3>{source.name} {source.builtin && <span className={styles.badge}>{t("skills.builtin")}</span>}</h3>
      <p className={styles.muted}>{source.url}</p><p className={styles.muted}>{t(`skills.${source.state || "unchecked"}`)} {source.hasCredential && ` · ${t("skills.configured")}`}</p>
      {source.lastRefreshedAt && <p className={styles.muted}>{t("skills.updatedAt")}: {new Date(source.lastRefreshedAt).toLocaleString()}</p>}
      <div className={styles.row}>
        <label><input type="checkbox" checked={source.enabled} disabled={busy} onChange={e => void action({ ...source, enabled: e.target.checked }, "PATCH")}/>{t("skills.enabled")}</label>
        <button disabled={busy} onClick={() => edit(source)}>{t("skills.edit")}</button>
        <button disabled={busy} onClick={() => void action({ id: source.id, action: "test" })}>{t("skills.test")}</button>
        <button disabled={busy || !source.enabled} onClick={() => void action({ id: source.id, action: "refresh" })}>{t("skills.refresh")}</button>
        <button disabled={busy} title={t("skills.deleteHint")} onClick={() => void action({ id: source.id, action: source.builtin ? "restore" : undefined }, source.builtin ? "POST" : "DELETE")}>{t(source.builtin ? "skills.restore" : "skills.delete")}</button>
      </div><p className={styles.muted}>{t("skills.deleteHint")}</p>
    </section>)}</div>
  </>;
}
