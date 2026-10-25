"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CollaborationRoom } from "@/lib/room-types";
import type { TeamAgentRole } from "@/lib/team-types";
import type { SessionInfo } from "@/lib/types";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { DirectoryPicker } from "./DirectoryPicker";
import { RoomAvatar } from "./RoomUi";
import styles from "./RoomSidebarSection.module.css";

type RoomWithSummary = CollaborationRoom & { summary?: { lastMessage?: { content: string; author: string; seq: number }; phase?: string; pending?: boolean } };
type AgentDraft = { name: string; role?: TeamAgentRole; roleDescription?: string };
const initialAgents: AgentDraft[] = [{ name: "成员 1" }, { name: "成员 2" }];
const projectAgents: AgentDraft[] = [{ name: "阿策", role: "coordinator" }, { name: "小研", role: "worker" }, { name: "小审", role: "reviewer" }];
const basename = (path: string) => path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? path;
const creationKey = "piora-room-creation-draft";
const pinKey = "piora-room-pins";

export function RoomSidebarSection({ sessions, selectedSessionId, selectedRoomId, activeProjectRoot, initialRoomId, refreshKey, onSelectRoom, onInitialRestoreDone }: {
  sessions: SessionInfo[]; selectedSessionId: string | null; selectedRoomId: string | null; activeProjectRoot?: string | null;
  initialRoomId?: string | null; refreshKey?: number; onSelectRoom: (room: CollaborationRoom, isRestore?: boolean) => void; onInitialRestoreDone?: () => void;
}) {
  const { t } = useI18n();
  const [rooms, setRooms] = useState<RoomWithSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [cwd, setCwd] = useState("");
  const [template, setTemplate] = useState<"project" | "custom">("custom");
  const [agents, setAgents] = useState<AgentDraft[]>(initialAgents);
  const [reuse, setReuse] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [, setReadVersion] = useState(0);
  const creationId = useRef("");
  const dialogRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  useFocusTrap(dialogRef, open && !picker, { initialFocus: nameRef, onEscape: busy ? undefined : () => setOpen(false) });

  const load = useCallback(async () => {
    const response = await fetch("/api/rooms", { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body.error?.message ?? `HTTP ${response.status}`);
    return body.rooms as RoomWithSummary[] ?? [];
  }, []);
  useEffect(() => {
    let disposed = false;
    const refresh = () => void load().then((next) => {
      if (disposed) return;
      setRooms(next);
      if (initialRoomId && !restored.current) {
        restored.current = true;
        const room = next.find((candidate) => candidate.id === initialRoomId);
        if (room) onSelectRoom(room, true);
        onInitialRestoreDone?.();
      }
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 5_000);
    const read = () => setReadVersion((version) => version + 1);
    window.addEventListener("piora:room-read", read);
    try { const saved = JSON.parse(localStorage.getItem(pinKey) ?? "[]"); if (Array.isArray(saved)) setPins(saved.filter((id) => typeof id === "string")); } catch { /* Empty pin preferences. */ }
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("piora:room-read", read); };
    // Sidebar callbacks are owned by the parent; a refresh must not reset its restore lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey, initialRoomId]);

  const ordered = useMemo(() => [...rooms].sort((a, b) => Number(pins.includes(b.id)) - Number(pins.includes(a.id)) || b.updatedAt - a.updatedAt), [rooms, pins]);
  const openCreate = () => {
    const selected = sessions.find((session) => session.id === selectedSessionId);
    const project = activeProjectRoot ?? selected?.projectRoot ?? selected?.cwd ?? "";
    let saved: { clientCreationId?: string; name?: string; description?: string; cwd?: string; template?: "project" | "custom"; agents?: AgentDraft[] } | undefined;
    try { saved = JSON.parse(localStorage.getItem(creationKey) ?? "null") ?? undefined; } catch { /* Start a fresh form. */ }
    creationId.current = saved?.clientCreationId ?? crypto.randomUUID();
    setCwd(saved?.cwd ?? project); setName(saved?.name ?? (project ? `${basename(project)} 协作群` : "")); setDescription(saved?.description ?? "");
    setTemplate(saved?.template ?? "custom"); setAgents(saved?.agents ?? initialAgents.map((agent) => ({ ...agent })));
    setSelectedIds(selected ? [selected.id] : []); setReuse(false); setError(null); setOpen(true);
  };
  const edit = () => { creationId.current = crypto.randomUUID(); setError(null); };
  const create = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      let project = cwd;
      if (!project) {
        const response = await fetch("/api/default-cwd", { method: "POST" });
        const result = await response.json();
        if (!response.ok || !result.cwd) throw new Error(result.error ?? t("roomUx.invalidProject"));
        project = result.cwd; setCwd(project);
      }
      const title = name.trim() || `${basename(project)} 协作群`;
      const managed = { clientCreationId: creationId.current, name: title, description, cwd: project, template, ...(template === "custom" ? { agents } : {}) };
      // Save the same creation identity before provisioning; retry resumes partial progress.
      try { localStorage.setItem(creationKey, JSON.stringify({ ...managed, agents })); } catch { /* Server receipt still provides idempotency. */ }
      const selected = sessions.filter((session) => selectedIds.includes(session.id));
      const creator = selected.find((session) => session.id === selectedSessionId) ?? selected[0];
      const body = reuse && creator ? { name: title, description, cwd: project, sessionId: creator.id, sessionName: creator.name ?? creator.id.slice(0, 8),
        members: selected.filter((session) => session.id !== creator.id).map((session) => ({ sessionId: session.id, sessionName: session.name ?? session.id.slice(0, 8), cwd: session.cwd, projectRoot: session.projectRoot, role: "participant" })) } : managed;
      const response = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.room) throw new Error(typeof result.error === "string" ? result.error : result.error?.message ?? `HTTP ${response.status}`);
      try { localStorage.removeItem(creationKey); } catch { /* Form will still close. */ }
      setOpen(false); setRooms((previous) => [result.room, ...previous.filter((room) => room.id !== result.room.id)]); onSelectRoom(result.room);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); void load().then(setRooms).catch(() => {}); }
    finally { setBusy(false); }
  };
  const validAgents = agents.length > 0 && agents.length <= 12 && agents.every((agent) => agent.name.trim());
  const roleLabel = (role?: TeamAgentRole) => t(`roomUx.${role === "coordinator" ? "lead" : role ?? "participant"}`);
  const togglePin = (id: string) => {
    const next = pins.includes(id) ? pins.filter((item) => item !== id) : [...pins, id];
    setPins(next); try { localStorage.setItem(pinKey, JSON.stringify(next)); } catch { /* Session-only pinning. */ }
  };

  return <section className={styles.section} aria-label={t("roomUx.groups")}>
    <div className={styles.heading}><span>{t("roomUx.groups")}</span><button type="button" className={styles.addButton} onClick={openCreate} aria-label={t("roomUx.create")} title={t("roomUx.create")}><AliIcon name="plus" size={16} /></button></div>
    <div className={styles.list}>
      {!rooms.length ? <button type="button" className={styles.empty} onClick={openCreate}>{t("roomUx.noGroups")}<AliIcon name="plus" size={13} /></button> : ordered.map((room) => {
        const summary = room.summary; const attention = ["waiting_user", "interrupted", "failed"].includes(summary?.phase ?? "");
        let unread = false;
        try { unread = room.id !== selectedRoomId && (summary?.lastMessage?.seq ?? 0) > Number(localStorage.getItem(`pi-room-read:${room.id}`) ?? 0); } catch { /* No persistent unread state. */ }
        return <div key={room.id} className={`${styles.roomRow}${room.id === selectedRoomId ? ` ${styles.selected}` : ""}`}>
          <button type="button" className={styles.roomMain} onClick={() => onSelectRoom(room)}>
            <span className={styles.roomIcon}><AliIcon name="group-chat" size={19} />{unread ? <i className={styles.unreadDot} aria-label={t("roomUx.unread")} /> : null}</span>
            <span className={styles.roomCopy}><strong>{room.name}</strong><small>{summary?.pending ? t("roomUx.preparing") : attention ? `${t("roomUx.attention")} · ${t(`roomUx.phase.${summary?.phase}`)}` : summary?.lastMessage ? `${summary.lastMessage.author}：${summary.lastMessage.content.replace(/\s+/gu, " ")}` : t("roomUx.noPreview")}</small></span>
            {attention ? <i className={styles.attentionDot} /> : summary?.phase ? <span className={styles.workingDot} /> : null}
          </button>
          <button type="button" className={`${styles.pinButton}${pins.includes(room.id) ? ` ${styles.pinned}` : ""}`} aria-label={`${t(pins.includes(room.id) ? "roomUx.unpin" : "roomUx.pin")} ${room.name}`} onClick={() => togglePin(room.id)}><AliIcon name="bookmark" size={12} /></button>
        </div>;
      })}
    </div>
    {open ? <div className={styles.backdrop} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="room-create-title">
        <header className={styles.dialogHeader}><div><h2 id="room-create-title">{t("roomUx.create")}</h2><p>{t("roomUx.createHint")}</p></div><button type="button" className={styles.closeButton} aria-label={t("roomUx.close")} disabled={busy} onClick={() => setOpen(false)}><AliIcon name="close" size={20} /></button></header>
        <div className={styles.dialogBody}>
          <div className={styles.templates} role="group" aria-label={t("roomUx.projectTeam")}>{(["custom", "project"] as const).map((value) => <button key={value} type="button" aria-pressed={template === value} disabled={busy} onClick={() => { edit(); setTemplate(value); setAgents((value === "project" ? projectAgents : initialAgents).map((agent) => ({ ...agent }))); }}><span className={styles.templateIcon}><AliIcon name={value === "project" ? "messages" : "plus"} size={23} /></span><span><strong>{t(value === "project" ? "roomUx.projectTeam" : "roomUx.custom")}</strong><small>{t(value === "project" ? "roomUx.projectTeamHint" : "roomUx.customHint")}</small></span><i /></button>)}</div>
          <div className={styles.createColumns}>
            <div className={styles.createFields}>
              <label className={styles.field}><span>{t("roomUx.name")}</span><input ref={nameRef} value={name} disabled={busy} maxLength={120} placeholder="Piora 协作群" onChange={(event) => { edit(); setName(event.target.value); }} /></label>
              <div className={styles.field}><span>{t("roomUx.project")}</span><button type="button" className={styles.projectPicker} disabled={busy} onClick={() => setPicker(true)}><AliIcon name="folder-open" size={18} /><span>{cwd ? basename(cwd) : t("roomUx.project")}</span><AliIcon name="chevron-right" style={{ transform: "rotate(90deg)" }} size={15} /></button><small>{cwd || t("roomUx.autoSessions")}</small></div>
              <label className={styles.field}><span>{t("roomUx.description")}</span><textarea value={description} disabled={busy} rows={4} maxLength={2000} placeholder={t("roomUx.descriptionHint")} onChange={(event) => { edit(); setDescription(event.target.value); }} /><small className={styles.counter}>{description.length}/2000</small></label>
              <details className={styles.advancedCreate}><summary>{t("roomUx.advanced")}<AliIcon name="chevron-right" style={{ transform: "rotate(90deg)" }} size={14} /></summary><label className={styles.reuseOption}><input type="checkbox" checked={reuse} disabled={busy || !sessions.length} onChange={(event) => { edit(); setReuse(event.target.checked); }} />{t("roomUx.reuse")}</label>{reuse ? <div className={styles.existingSessions}>{sessions.map((session) => <label key={session.id}><input type="checkbox" checked={selectedIds.includes(session.id)} disabled={busy} onChange={() => { edit(); setSelectedIds((previous) => previous.includes(session.id) ? previous.filter((id) => id !== session.id) : [...previous, session.id]); }} /><span>{session.name || session.firstMessage?.slice(0, 40) || session.id.slice(0, 8)}<small>{session.cwd}</small></span></label>)}</div> : null}</details>
            </div>
            <section className={styles.createMembers}><div className={styles.memberHeading}><h3>{t("roomUx.initialMembers")}</h3><span>{agents.length}</span></div>{agents.map((agent, index) => <div key={index} className={styles.agentRow}>
              <RoomAvatar name={agent.name} role={agent.role} />
              <div className={styles.agentCopy}>{template === "custom" ? <><input aria-label={`${t("roomUx.memberName")} ${index + 1}`} value={agent.name} maxLength={120} disabled={busy} onChange={(event) => { edit(); setAgents((previous) => previous.map((item, i) => i === index ? { ...item, name: event.target.value } : item)); }} /><textarea aria-label={`${t("roomUx.customIdentity")} ${index + 1}`} placeholder={t("roomUx.customIdentityHint")} rows={2} value={agent.roleDescription ?? ""} maxLength={4000} disabled={busy} onChange={(event) => { edit(); setAgents((previous) => previous.map((item, i) => i === index ? { ...item, roleDescription: event.target.value } : item)); }} /></> : <><div><strong>{agent.name}</strong><span className={styles.roleBadge}>{roleLabel(agent.role)}</span></div><small>{t(`roomUx.${agent.role === "coordinator" ? "leadHint" : agent.role === "reviewer" ? "reviewerHint" : "workerHint"}`)}</small></>}</div>
              {template === "custom" ? <button type="button" className={styles.closeButton} disabled={busy || agents.length === 1} aria-label={`${t("roomUx.removeMember")} ${agent.name}`} onClick={() => { edit(); setAgents((previous) => previous.filter((_, i) => i !== index)); }}><AliIcon name="close" size={15} /></button> : null}
            </div>)}<button type="button" className={styles.addMember} disabled={busy || agents.length >= 12} onClick={() => { edit(); setTemplate("custom"); setAgents((previous) => [...previous.map(({ name, roleDescription }) => ({ name, roleDescription })), { name: `${t("roomUx.participant")}${previous.length + 1}` }]); }}><AliIcon name="plus" size={19} />{t("roomUx.addMember")}</button><p className={styles.memberHint}><AliIcon name="info" size={14} />{t("roomUx.autoSessions")}</p>{!validAgents ? <p className={styles.error}>{t("roomUx.coordinatorRequired")}</p> : null}</section>
          </div>
          {busy ? <p className={styles.creating} role="status"><span />{t("roomUx.creating")}</p> : null}{error ? <div className={styles.error} role="alert">{error}</div> : null}
        </div>
        <footer className={styles.dialogActions}><span><AliIcon name="setting" size={17} />{t("roomUx.inheritModel")}</span><button type="button" disabled={busy} onClick={() => setOpen(false)}>{t("roomUx.cancel")}</button><button type="button" className={styles.primary} disabled={busy || !validAgents || (reuse && !selectedIds.length)} onClick={() => void create()}>{t(busy ? "roomUx.creating" : error ? "roomUx.retryCreate" : "roomUx.createGroup")}</button></footer>
      </section>
    </div> : null}
    {picker ? <DirectoryPicker onCancel={() => setPicker(false)} onSelect={(path) => { edit(); setCwd(path); if (!name.trim()) setName(`${basename(path)} 协作群`); setPicker(false); }} /> : null}
    {error && !open ? <div className={styles.inlineError}>{error}</div> : null}
  </section>;
}
