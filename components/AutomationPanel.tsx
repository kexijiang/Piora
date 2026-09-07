"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { AutomationDefinition, AutomationNotificationPolicy, AutomationRun, AutomationSummary } from "@/lib/automation-types";
import { AliIcon } from "./AliIcon";
import styles from "./AutomationPanel.module.css";

const SCHEDULES = [
  { id: "5m", rule: "RRULE:FREQ=MINUTELY;INTERVAL=5", labelKey: "automations.schedule.5m" },
  { id: "15m", rule: "RRULE:FREQ=MINUTELY;INTERVAL=15", labelKey: "automations.schedule.15m" },
  { id: "hourly", rule: "RRULE:FREQ=HOURLY;INTERVAL=1", labelKey: "automations.schedule.hourly" },
  { id: "daily", rule: "RRULE:FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0", labelKey: "automations.schedule.daily" },
  { id: "weekdays", rule: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0", labelKey: "automations.schedule.weekdays" },
  { id: "weekly", rule: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;BYHOUR=9;BYMINUTE=0", labelKey: "automations.schedule.weekly" },
] as const;

interface AutomationPanelProps {
  automationId?: string | null;
  sessionId?: string | null;
  sessionName?: string;
  cwd?: string | null;
  embedded?: boolean;
  onSelectAutomation?: (id: string) => void;
  onAutomationChanged?: () => void;
}

interface DetailPayload { automation: AutomationSummary; runs: AutomationRun[]; }

interface Draft {
  kind: "heartbeat" | "cron";
  name: string;
  prompt: string;
  status: "ACTIVE" | "PAUSED";
  scheduleId: string;
  rrule: string;
  notificationPolicy: AutomationNotificationPolicy;
  timezone: string;
}

function timezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function newDraft(canHeartbeat: boolean): Draft {
  return {
    kind: canHeartbeat ? "heartbeat" : "cron",
    name: "",
    prompt: "",
    status: "ACTIVE",
    scheduleId: "5m",
    rrule: SCHEDULES[0].rule,
    notificationPolicy: "important_updates",
    timezone: timezone(),
  };
}

function editDraft(automation: AutomationDefinition): Draft {
  const preset = SCHEDULES.find((item) => item.rule === automation.rrule);
  return {
    kind: automation.kind,
    name: automation.name,
    prompt: automation.prompt,
    status: automation.status,
    scheduleId: preset?.id ?? "custom",
    rrule: automation.rrule,
    notificationPolicy: automation.notificationPolicy,
    timezone: automation.timezone,
  };
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function runLabel(status: AutomationRun["status"], t: (key: string) => string): string {
  return t(`automations.run.${status}`);
}

export function AutomationPanel({ automationId, sessionId, sessionName, cwd, embedded, onSelectAutomation, onAutomationChanged }: AutomationPanelProps) {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<AutomationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(automationId ?? null);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [draft, setDraft] = useState<Draft>(() => newDraft(Boolean(sessionId)));
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const effectiveId = automationId ?? selectedId;
  const loadList = useCallback(async () => {
    const payload = await jsonRequest<{ automations: AutomationSummary[] }>("/api/automations", { cache: "no-store" });
    setItems(payload.automations);
  }, []);
  const loadDetail = useCallback(async (id: string) => {
    const payload = await jsonRequest<DetailPayload>(`/api/automations/${encodeURIComponent(id)}`, { cache: "no-store" });
    setDetail(payload);
    setDraft(editDraft(payload.automation));
  }, []);

  useEffect(() => { if (automationId !== undefined) setSelectedId(automationId); }, [automationId]);
  useEffect(() => { setMenuOpen(false); }, [effectiveId]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadList(), effectiveId ? loadDetail(effectiveId) : Promise.resolve()])
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [effectiveId, loadDetail, loadList]);

  useEffect(() => {
    if (!effectiveId) return;
    const timer = setInterval(() => { void loadDetail(effectiveId).catch(() => undefined); }, 5_000);
    return () => clearInterval(timer);
  }, [effectiveId, loadDetail]);

  const targetDescription = useMemo(() => draft.kind === "heartbeat"
    ? (sessionName || detail?.automation.target.type === "session" && detail.automation.target.sessionName || t("automations.currentChat"))
    : (cwd || detail?.automation.target.type === "project" && detail.automation.target.cwd || t("automations.currentProject")), [cwd, detail, draft.kind, sessionName, t]);

  const select = (id: string) => {
    setCreating(false);
    setSelectedId(id);
    onSelectAutomation?.(id);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const rule = draft.scheduleId === "custom" ? draft.rrule : SCHEDULES.find((item) => item.id === draft.scheduleId)?.rule ?? draft.rrule;
      const target = draft.kind === "heartbeat"
        ? { type: "session" as const, sessionId: sessionId ?? (detail?.automation.target.type === "session" ? detail.automation.target.sessionId : ""), cwd: cwd ?? undefined, sessionName }
        : { type: "project" as const, cwd: cwd ?? (detail?.automation.target.type === "project" ? detail.automation.target.cwd : "") };
      const body = { kind: draft.kind, name: draft.name, prompt: draft.prompt, status: draft.status, rrule: rule, timezone: draft.timezone, target, notificationPolicy: draft.notificationPolicy };
      if (creating || !effectiveId) {
        const created = await jsonRequest<{ automation: AutomationDefinition }>("/api/automations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        setCreating(false);
        setSelectedId(created.automation.id);
        onSelectAutomation?.(created.automation.id);
      } else {
        await jsonRequest(`/api/automations/${encodeURIComponent(effectiveId)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        await loadDetail(effectiveId);
      }
      await loadList();
      onAutomationChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!effectiveId) return;
    setSaving(true);
    setError(null);
    try {
      await jsonRequest(`/api/automations/${encodeURIComponent(effectiveId)}/run`, { method: "POST" });
      await loadDetail(effectiveId);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const toggleStatus = async () => {
    if (!effectiveId || !detail) return;
    setSaving(true);
    setMenuOpen(false);
    setError(null);
    try {
      await jsonRequest(`/api/automations/${encodeURIComponent(effectiveId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: detail.automation.status === "ACTIVE" ? "PAUSED" : "ACTIVE" }),
      });
      await Promise.all([loadDetail(effectiveId), loadList()]);
      onAutomationChanged?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const remove = async () => {
    if (!effectiveId || !window.confirm(t("automations.deleteConfirm"))) return;
    setSaving(true);
    try {
      await jsonRequest(`/api/automations/${encodeURIComponent(effectiveId)}`, { method: "DELETE" });
      setSelectedId(null); setDetail(null); setCreating(false); await loadList(); onAutomationChanged?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  };

  const startCreate = () => {
    setSelectedId(null); setDetail(null); setCreating(true); setDraft(newDraft(Boolean(sessionId))); setError(null);
  };

  if (loading && !detail && items.length === 0) return <div className={styles.state}>{t("automations.loading")}</div>;

  const showingEditor = creating || Boolean(effectiveId && detail);
  return <div className={`${styles.root}${embedded ? ` ${styles.embedded}` : ""}`}>
    <header className={styles.header}>
      <div>
        <h2>{showingEditor ? (creating ? t("automations.new") : detail?.automation.name) : t("automations.title")}</h2>
        {!showingEditor ? <><p>{t("automations.description")}</p><p data-settings-id="automations.notifications">{t("automations.notificationsHint")}</p></> : null}
      </div>
      <div className={styles.headerActions}>
        {showingEditor && embedded ? <button type="button" onClick={() => { setCreating(false); setSelectedId(null); setDetail(null); }}><AliIcon name="arrowleft" size={14} />{t("automations.all")}</button> : null}
        {!showingEditor ? (
          <button
            type="button"
            className={`${styles.primary} ${styles.createButton}`}
            onClick={startCreate}
            data-settings-id="automations.new"
            aria-label={t("automations.new")}
            title={t("automations.new")}
          >
            <AliIcon name="plus" size={14} />
            <span>{t("automations.newShort")}</span>
          </button>
        ) : null}
        {showingEditor && !creating ? <div className={styles.moreWrap}>
          <button type="button" aria-label={t("automations.more")} aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><AliIcon name="ellipsis" size={16} /></button>
          {menuOpen ? <div className={styles.moreMenu} role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void runNow(); }} disabled={saving || detail?.automation.running}>{t("automations.runNow")}</button>
            <button type="button" role="menuitem" onClick={() => void toggleStatus()} disabled={saving}>{detail?.automation.status === "ACTIVE" ? t("automations.pause") : t("automations.resume")}</button>
            <button type="button" role="menuitem" className={styles.menuDanger} onClick={() => { setMenuOpen(false); void remove(); }} disabled={saving}>{t("automations.delete")}</button>
          </div> : null}
        </div> : null}
      </div>
    </header>
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {!showingEditor ? <div className={styles.list}>
      {items.length === 0 ? <div className={styles.empty}><AliIcon name="calendar" size={22} /><strong>{t("automations.empty")}</strong><span>{t("automations.emptyDescription")}</span></div> : items.map((item) => <button className={styles.listItem} type="button" key={item.id} aria-label={`${item.name} · ${item.status === "ACTIVE" ? t("automations.active") : t("automations.paused")} · ${scheduleLabel(item.rrule, t)}`} onClick={() => select(item.id)}>
        <span className={styles.clock}><AliIcon name="calendar" size={16} /></span>
        <span className={styles.listText}><strong>{item.name}</strong><small>{item.status === "ACTIVE" ? t("automations.active") : t("automations.paused")} · {scheduleLabel(item.rrule, t)}</small></span>
        <span className={styles.chevron}>›</span>
      </button>)}
    </div> : <div className={styles.editor}>
      <label className={styles.promptField}>
        <span>{t("automations.name")}</span>
        <input value={draft.name} maxLength={200} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("automations.namePlaceholder")} />
      </label>
      <label className={styles.promptField}>
        <span>{t("automations.prompt")}</span>
        <textarea value={draft.prompt} maxLength={100_000} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder={t("automations.promptPlaceholder")} />
      </label>

      <section className={styles.group}>
        <h3>{t("automations.details")}</h3>
        <label className={styles.row}><span>{t("automations.runIn")}</span><select value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value as Draft["kind"] }))}>
          {sessionId || detail?.automation.target.type === "session" ? <option value="heartbeat">{t("automations.existingChat")}</option> : null}
          {cwd || detail?.automation.target.type === "project" ? <option value="cron">{t("automations.newTask")}</option> : null}
        </select></label>
        <div className={styles.row}><span>{draft.kind === "heartbeat" ? t("automations.chat") : t("automations.project")}</span><strong title={targetDescription}>{targetDescription}</strong></div>
      </section>

      <section className={styles.group}>
        <h3>{t("automations.frequency")}</h3>
        <label className={styles.row}><span>{t("automations.repeat")}</span><select value={draft.scheduleId} onChange={(event) => setDraft((current) => ({ ...current, scheduleId: event.target.value }))}>
          {SCHEDULES.map((item) => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}
          <option value="custom">{t("automations.schedule.custom")}</option>
        </select></label>
        {draft.scheduleId === "custom" ? <label className={styles.ruleField}><span>RRULE</span><textarea value={draft.rrule} onChange={(event) => setDraft((current) => ({ ...current, rrule: event.target.value }))} /></label> : null}
        <label className={styles.row}><span>{t("automations.timezone")}</span><input value={draft.timezone} onChange={(event) => setDraft((current) => ({ ...current, timezone: event.target.value }))} /></label>
        <label data-settings-id="automations.notifications" className={styles.row}><span>{t("automations.notifications")}</span><select value={draft.notificationPolicy} onChange={(event) => setDraft((current) => ({ ...current, notificationPolicy: event.target.value as AutomationNotificationPolicy }))}>
          <option value="important_updates">{t("automations.notifyImportant")}</option><option value="always">{t("automations.notifyAlways")}</option><option value="failed_runs_only">{t("automations.notifyFailed")}</option><option value="never">{t("automations.notifyNever")}</option>
        </select></label>
        <label className={styles.row}><span>{t("automations.status")}</span><select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as Draft["status"] }))}><option value="ACTIVE">{t("automations.active")}</option><option value="PAUSED">{t("automations.paused")}</option></select></label>
      </section>

      {!creating && detail ? <section className={styles.group}>
        <h3>{t("automations.history")}</h3>
        <div className={styles.runSummary}><span>{t("automations.nextRun")}</span><strong>{detail.automation.nextRunAt ? new Date(detail.automation.nextRunAt).toLocaleString(locale) : t("automations.none")}</strong></div>
        {detail.runs.slice(0, 8).map((run) => <div className={styles.run} key={run.id}><span data-status={run.status}>{runLabel(run.status, t)}</span><time>{new Date(run.startedAt ?? run.createdAt).toLocaleString(locale)}</time>{run.error ? <small title={run.error}>{run.error}</small> : null}</div>)}
        {detail.runs.length === 0 ? <div className={styles.noRuns}>{t("automations.noRuns")}</div> : null}
      </section> : null}

      <footer className={styles.footer}>
        {!creating ? <button type="button" onClick={runNow} disabled={saving || detail?.automation.running}>{detail?.automation.running ? t("automations.running") : t("automations.runNow")}</button> : null}
        {!creating ? <button type="button" className={styles.danger} onClick={remove} disabled={saving}>{t("automations.delete")}</button> : null}
        <button type="button" className={styles.primary} onClick={save} disabled={saving || !draft.name.trim() || !draft.prompt.trim()}>{saving ? t("automations.saving") : t("automations.save")}</button>
      </footer>
    </div>}
  </div>;
}

export function scheduleLabel(rrule: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const preset = SCHEDULES.find((item) => item.rule === rrule);
  if (preset) return t(preset.labelKey);
  const minute = /FREQ=MINUTELY(?:;INTERVAL=(\d+))?/.exec(rrule)?.[1];
  if (rrule.includes("FREQ=MINUTELY")) return t("automations.everyMinutes", { count: minute ?? 1 });
  return t("automations.schedule.custom");
}

export function AutomationCard({ automationId, fallbackName, fallbackRrule, onOpen }: { automationId: string; fallbackName?: string; fallbackRrule?: string; onOpen?: (id: string) => void }) {
  const { t } = useI18n();
  const [automation, setAutomation] = useState<AutomationSummary | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void jsonRequest<DetailPayload>(`/api/automations/${encodeURIComponent(automationId)}`, { cache: "no-store" })
      .then((payload) => { if (!cancelled) setAutomation(payload.automation); })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [automationId]);
  return <div className={styles.chatCard}>
    <span className={styles.clock}><AliIcon name="calendar" size={16} /></span>
    <span className={styles.listText}>
      <strong>{automation?.name ?? fallbackName ?? (missing ? t("automations.deleted") : t("automations.loading"))}</strong>
      <small>{automation ? scheduleLabel(automation.rrule, t) : missing ? t("automations.deleted") : fallbackRrule ? scheduleLabel(fallbackRrule, t) : "…"}</small>
    </span>
    <button type="button" disabled={missing} onClick={() => onOpen?.(automationId)}>{t("automations.open")}</button>
  </div>;
}
