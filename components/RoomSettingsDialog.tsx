"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import {
  getRoomMemberName,
  getRoomMemberSessionId,
  type CollaborationRoom,
  type RoomAuditEntry,
  type RoomMember,
  type RoomMemberRole,
} from "@/lib/room-types";
import type { TeamAgentProfile, TeamThinkingLevel } from "@/lib/team-types";
import type { SessionInfo } from "@/lib/types";
import { AliIcon } from "./AliIcon";
import { AITextAreaField } from "./AITextAreaField";
import { requestConfirmation } from "./ConfirmDialog";
import styles from "./RoomSettingsDialog.module.css";

type Section = "overview" | "agents" | "workspace" | "coordination";
type MemberDraft = TeamAgentProfile & { sessionId: string; capabilitiesText: string; personalityText: string; constraintsText: string; toolNamesText: string; skillNamesText: string };

const roleOptions: Array<{ value: RoomMemberRole; label: string; detail: string }> = [
  { value: "coordinator", label: "协调者", detail: "负责拆解、分派和最终决策" },
  { value: "planner", label: "规划者", detail: "负责方案、依赖和风险识别" },
  { value: "worker", label: "执行者", detail: "负责实现和交付任务" },
  { value: "reviewer", label: "审查者", detail: "负责验证、评审和质量门禁" },
  { value: "participant", label: "参与者", detail: "按需参与讨论和协作" },
];

const auditTimeFormatter = new Intl.DateTimeFormat(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const thinkingLevelOptions: Array<{ value: TeamThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" }, { value: "minimal", label: "最少" }, { value: "low", label: "较低" },
  { value: "medium", label: "中等" }, { value: "high", label: "较高" }, { value: "xhigh", label: "很高" },
  { value: "max", label: "最高" },
];

function bindingStatusLabel(status: RoomMember["binding"]["status"]): string {
  return ({ ready: "可用", needs_restart: "需要重启", unavailable: "不可用", provisioning: "正在创建", missing: "会话缺失" })[status];
}

function sessionName(session: SessionInfo): string {
  return session.name?.trim() || session.firstMessage?.trim().slice(0, 64) || session.id.slice(0, 8);
}

function sessionLabel(session: SessionInfo): string {
  const project = session.projectRoot ?? session.cwd;
  return `${sessionName(session)} · ${session.worktreeBranch ?? project}`;
}

function localizedAuditSummary(summary: string): string {
  return summary
    .replaceAll("Agent", "智能体")
    .replaceAll("Session", "会话")
    .replaceAll("Profile", "配置");
}

function actorSessionId(room: CollaborationRoom): string | undefined {
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  return coordinator ? getRoomMemberSessionId(coordinator) : room.members[0] ? getRoomMemberSessionId(room.members[0]) : undefined;
}

export function RoomSettingsDialog({
  room,
  onClose,
  onRoomChange,
  onRoomDeleted,
}: {
  room: CollaborationRoom;
  onClose: () => void;
  onRoomChange: (room: CollaborationRoom) => void;
  onRoomDeleted: (roomId: string) => void;
}) {
  const [section, setSection] = useState<Section>("overview");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [audit, setAudit] = useState<RoomAuditEntry[]>([]);
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description ?? "");
  const [workspaceMode, setWorkspaceMode] = useState(room.workspace.mode);
  const [workspacePath, setWorkspacePath] = useState(room.workspace.path);
  const [workspaceLabel, setWorkspaceLabel] = useState(room.workspace.label);
  const [workspaceInstructions, setWorkspaceInstructions] = useState(room.workspace.instructions ?? "");
  const [memberDrafts, setMemberDrafts] = useState<Record<string, MemberDraft>>({});
  const [newSessionId, setNewSessionId] = useState("");
  const [newRole, setNewRole] = useState<RoomMemberRole>("worker");
  const [newName, setNewName] = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  const [coordinationMode, setCoordinationMode] = useState(room.coordination.mode);
  const [coordinatorId, setCoordinatorId] = useState(actorSessionId(room) ?? "");
  const [maxConcurrency, setMaxConcurrency] = useState(room.coordination.maxConcurrency);
  const [leaseMinutes, setLeaseMinutes] = useState(Math.round(room.coordination.leaseDurationMs / 60_000));
  const [removeConfirmId, setRemoveConfirmId] = useState<string | null>(null);
  const [advancedMemberIds, setAdvancedMemberIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useFocusTrap(dialogRef, true, { onEscape: busy ? undefined : onClose });

  useEffect(() => {
    setName(room.name);
    setDescription(room.description ?? "");
    setWorkspaceMode(room.workspace.mode);
    setWorkspacePath(room.workspace.path);
    setWorkspaceLabel(room.workspace.label);
    setWorkspaceInstructions(room.workspace.instructions ?? "");
    setCoordinationMode(room.coordination.mode);
    setCoordinatorId(actorSessionId(room) ?? "");
    setMaxConcurrency(room.coordination.maxConcurrency);
    setLeaseMinutes(Math.round(room.coordination.leaseDurationMs / 60_000));
    setMemberDrafts(Object.fromEntries(room.members.map((member) => [member.memberId, {
      ...structuredClone(member.profile),
      sessionId: member.binding.sessionId,
      capabilitiesText: member.profile.capabilities.join(", "),
      personalityText: member.profile.personality.join("\n"),
      constraintsText: member.profile.constraints.join("\n"),
      toolNamesText: member.profile.toolPolicy.mode === "allowlist" ? member.profile.toolPolicy.toolNames.join(", ") : "",
      skillNamesText: member.profile.skillPolicy.mode === "allowlist" ? member.profile.skillPolicy.skillNames.join(", ") : "",
    }])));
  }, [room]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/sessions", { cache: "no-store" }).then(async (response) => {
        const data = await response.json() as { sessions?: SessionInfo[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        return data.sessions ?? [];
      }),
      fetch(`/api/rooms/${encodeURIComponent(room.id)}`, { cache: "no-store" }).then(async (response) => {
        const data = await response.json() as { audit?: RoomAuditEntry[]; error?: string };
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        return data.audit ?? [];
      }),
    ])
      .then(([nextSessions, nextAudit]) => {
        if (cancelled) return;
        setSessions(nextSessions);
        setAudit(nextAudit);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [room]);

  const availableSessions = useMemo(() => {
    const bound = new Set(room.members.map(getRoomMemberSessionId));
    return sessions.filter((session) => !bound.has(session.id));
  }, [room.members, sessions]);

  const postAction = async (action: Record<string, unknown>, successMessage: string) => {
    const actor = actorSessionId(room);
    if (!actor) throw new Error("房间没有可用的协调者会话。");
    setBusy(String(action.action));
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...action, sessionId: actor }),
      });
      const data = await response.json() as { room?: CollaborationRoom; error?: string };
      if (!response.ok || !data.room) throw new Error(data.error ?? `HTTP ${response.status}`);
      onRoomChange(data.room);
      setSaved(successMessage);
      return data.room;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(null);
    }
  };

  const saveOverview = () => void postAction({ action: "update_room", title: name, description }, "群聊资料已保存").catch(() => {});

  const deleteCurrentRoom = async () => {
    const confirmed = await requestConfirmation({
      title: "删除群聊",
      message: `确定删除“${room.name}”吗？群聊消息、任务、共享产物和配置记录都会被永久删除。`,
      confirmLabel: "删除群聊",
      tone: "danger",
    });
    if (!confirmed) return;
    const actor = actorSessionId(room);
    if (!actor) {
      setError("群聊没有可用的协调者 Session，无法删除。");
      return;
    }
    setBusy("delete_room");
    setError(null);
    setSaved(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}?sessionId=${encodeURIComponent(actor)}`, {
        method: "DELETE",
      });
      const data = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || !data.success) throw new Error(data.error ?? `HTTP ${response.status}`);
      onRoomDeleted(room.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const saveWorkspace = () => void postAction({
    action: "update_workspace",
    workspaceMode,
    workspacePath: workspacePath.trim(),
    workspaceLabel,
    instructions: workspaceInstructions,
  }, "共享工作区已更新").catch(() => {});

  const chooseWorkspacePath = async () => {
    const selected = await window.piDesktop?.selectDirectory?.();
    if (!selected) return;
    setWorkspaceMode("custom");
    setWorkspacePath(selected);
  };

  const saveMember = (member: RoomMember) => {
    const draft = memberDrafts[member.memberId];
    if (!draft) return;
    const session = sessions.find((candidate) => candidate.id === draft.sessionId);
    void postAction({
      action: "update_member",
      memberId: member.memberId,
      targetSessionId: draft.sessionId,
      sessionName: draft.name,
      instructions: draft.roleDescription,
      role: draft.role,
      cwd: session?.cwd ?? member.binding.cwd,
      projectRoot: session ? (session.projectRoot ?? session.cwd) : member.binding.projectRoot,
    }, `${draft.name || "智能体"} 已更新`).then(async (updatedRoom) => {
      const updated = updatedRoom.members.find((candidate) => candidate.memberId === member.memberId);
      if (!updated) throw new Error("更新后的智能体不存在。");
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/agents/${encodeURIComponent(member.memberId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: actorSessionId(updatedRoom),
          expectedRevision: updated.profile.revision,
          patch: {
            name: draft.name,
            role: draft.role,
            roleDescription: draft.roleDescription,
            systemPrompt: draft.systemPrompt,
            personality: draft.personalityText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean),
            capabilities: draft.capabilitiesText.split(/[,\n]/u).map((value) => value.trim()).filter(Boolean),
            constraints: draft.constraintsText.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean),
            modelPolicy: draft.modelPolicy,
            toolPolicy: draft.toolPolicy.mode === "allowlist" ? { mode: "allowlist", toolNames: draft.toolNamesText.split(/[,\n]/u).map((value) => value.trim()).filter(Boolean) } : { mode: "inherit" },
            skillPolicy: draft.skillPolicy.mode === "allowlist" ? { mode: "allowlist", skillNames: draft.skillNamesText.split(/[,\n]/u).map((value) => value.trim()).filter(Boolean) } : { mode: "inherit" },
            workspacePolicy: draft.workspacePolicy,
            memoryPolicy: draft.memoryPolicy,
          },
        }),
      });
      const data = await response.json() as { room?: CollaborationRoom; error?: { message?: string } | string };
      if (!response.ok || !data.room) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${response.status}`);
      onRoomChange(data.room);
      setSaved(`${draft.name || "智能体"} 的完整配置已保存`);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const addAgent = () => {
    const session = sessions.find((candidate) => candidate.id === newSessionId);
    if (!session) return;
    void postAction({
      action: "add_member",
      targetSessionId: session.id,
      sessionName: newName.trim() || sessionName(session),
      instructions: newInstructions,
      role: newRole,
      cwd: session.cwd,
      projectRoot: session.projectRoot ?? session.cwd,
    }, "智能体已加入协作空间").then(() => {
      setNewSessionId("");
      setNewName("");
      setNewInstructions("");
    }).catch(() => {});
  };

  const createManagedAgent = async () => {
    const actor = actorSessionId(room);
    if (!actor || !newName.trim()) return;
    setBusy("provision_agent");
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: actor, role: newRole, name: newName.trim(), roleDescription: newInstructions }),
      });
      const data = await response.json() as { room?: CollaborationRoom; error?: { message?: string } | string };
      if (!response.ok || !data.room) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${response.status}`);
      onRoomChange(data.room);
      setNewSessionId("");
      setNewName("");
      setNewInstructions("");
      setSaved("托管智能体与独立会话已创建");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const removeAgent = (member: RoomMember) => {
    if (removeConfirmId !== member.memberId) {
      setRemoveConfirmId(member.memberId);
      return;
    }
    void postAction({ action: "leave", targetSessionId: getRoomMemberSessionId(member) }, `${getRoomMemberName(member) || "智能体"} 已移出`).then(() => {
      setRemoveConfirmId(null);
    }).catch(() => {});
  };

  const reconfigureAgent = async (member: RoomMember) => {
    const actor = actorSessionId(room);
    if (!actor) return;
    setBusy("reconfigure_agent");
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/agents/${encodeURIComponent(member.memberId)}/reconfigure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: actor, expectedProfileRevision: member.profile.revision }),
      });
      const data = await response.json() as { room?: CollaborationRoom; error?: { message?: string } | string };
      if (!response.ok || !data.room) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${response.status}`);
      onRoomChange(data.room);
      setSaved(`${member.profile.name} 已按配置重新初始化`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const saveCoordination = () => void postAction({
    action: "configure",
    mode: coordinationMode,
    targetSessionId: coordinatorId,
    maxConcurrency,
    leaseDurationMs: leaseMinutes * 60_000,
  }, "编排策略已保存").catch(() => {});

  const updateDraft = (memberId: string, patch: Partial<MemberDraft>) => {
    setMemberDrafts((current) => ({ ...current, [memberId]: { ...current[memberId], ...patch } }));
  };

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="room-settings-title">
        <header className={styles.header}>
          <div><h2 id="room-settings-title">协作空间设置</h2><p>{room.name}</p></div>
          <button type="button" onClick={onClose} aria-label="关闭协作空间设置" disabled={Boolean(busy)}><AliIcon name="close" size={16} /></button>
        </header>
        <div className={styles.body}>
          <nav className={styles.nav} aria-label="协作空间设置分类">
            {([
              ["overview", "概览", "message"],
              ["agents", "智能体", "robot"],
              ["workspace", "工作区", "folder-open"],
              ["coordination", "编排", "workflow"],
            ] as const).map(([key, label, icon]) => (
              <button key={key} type="button" className={section === key ? styles.active : ""} onClick={() => { setSection(key); setError(null); setSaved(null); }}>
                <AliIcon name={icon} size={15} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <div className={styles.content}>
            {section === "overview" ? (
              <div className={styles.page}>
                <div className={styles.pageHeading}><h3>概览</h3><p>定义这个多智能体团队共同解决什么问题。</p></div>
                <label className={styles.field}><span>群聊名称</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
                <AITextAreaField label="团队说明" help="说明团队要解决什么、不能做什么，以及怎样算完成；写几个关键词也可以，再用 AI 补全。" purpose="团队说明" value={description} onChange={setDescription} cwd={room.projectRoot} rows={5} maxLength={2_000} placeholder="例如：审计项目、修复问题、测试通过并出报告" />
                <div className={styles.metadata}><span>项目</span><code>{room.projectRoot ?? "未绑定项目"}</code><span>协作空间编号</span><code>{room.id}</code></div>
                <section className={styles.auditList}>
                  <h4>最近变更</h4>
                  {audit.length === 0 ? <p>暂无配置变更。</p> : audit.slice(-6).reverse().map((entry) => (
                    <div key={entry.id}><span>{localizedAuditSummary(entry.summary)}</span><time dateTime={new Date(entry.createdAt).toISOString()}>{auditTimeFormatter.format(entry.createdAt)}</time></div>
                  ))}
                </section>
                <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(busy) || !name.trim()} onClick={saveOverview}>保存概览</button></div>
                <section className={styles.dangerZone}>
                  <div><h4>删除群聊</h4><p>永久删除群聊消息、任务、共享产物和所有协作配置。</p></div>
                  <button type="button" disabled={Boolean(busy)} onClick={() => { void deleteCurrentRoom(); }}>
                    {busy === "delete_room" ? "删除中…" : "删除群聊"}
                  </button>
                </section>
              </div>
            ) : null}

            {section === "agents" ? (
              <div className={styles.page}>
                <div className={styles.pageHeading}><h3>智能体团队</h3><p>常用设置保持精简；需要时再展开单个智能体的高级配置。</p></div>
                <div className={styles.agentList}>
                  {room.members.map((member) => {
                    const draft = memberDrafts[member.memberId];
                    if (!draft) return null;
                    const selected = sessions.find((session) => session.id === draft.sessionId);
                    return (
                      <article key={member.memberId} className={styles.agentCard}>
                        <div className={styles.agentIdentity}><span>{(draft.name || "智").slice(0, 1).toLocaleUpperCase()}</span><div><strong>{draft.name || "未命名智能体"}</strong><small>{selected?.worktreeBranch ?? selected?.cwd ?? member.binding.cwd ?? draft.sessionId} · {member.binding.managedByPiora ? `托管/${bindingStatusLabel(member.binding.status)}` : "复用会话"}</small></div></div>
                        <div className={styles.agentGrid}>
                          <label className={styles.field}><span>显示名称</span><input value={draft.name ?? ""} onChange={(event) => updateDraft(member.memberId, { name: event.target.value })} /></label>
                          <label className={styles.field}><span>团队角色</span><select value={draft.role} onChange={(event) => updateDraft(member.memberId, { role: event.target.value as RoomMemberRole })}>{roleOptions.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
                          <label className={`${styles.field} ${styles.full}`}><span>绑定会话</span><select value={draft.sessionId} onChange={(event) => updateDraft(member.memberId, { sessionId: event.target.value })}>{sessions.filter((session) => session.id === getRoomMemberSessionId(member) || !room.members.some((candidate) => getRoomMemberSessionId(candidate) === session.id)).map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}</select></label>
                          <AITextAreaField className={styles.full} label="角色职责" help="写清这个智能体负责什么、交付什么、遇到什么情况需要交给别人；简短描述后可用 AI 补全。" purpose={`${draft.name || "智能体"}的角色职责`} value={draft.roleDescription} onChange={(value) => updateDraft(member.memberId, { roleDescription: value })} cwd={room.projectRoot} rows={3} placeholder="例如：实现功能并补测试，完成后交给审查者复核" />
                          <div className={`${styles.cardActions} ${styles.full}`}><button type="button" onClick={() => setAdvancedMemberIds((current) => { const next = new Set(current); if (next.has(member.memberId)) next.delete(member.memberId); else next.add(member.memberId); return next; })}>{advancedMemberIds.has(member.memberId) ? "收起高级设置" : "显示高级设置"}</button></div>
                          {advancedMemberIds.has(member.memberId) ? <>
                          <AITextAreaField className={styles.full} label="智能体系统提示词" help="仅追加到该智能体的团队任务中，用于约束长期行为；普通会话不受影响。" purpose={`${draft.name || "智能体"}的系统提示词`} value={draft.systemPrompt} onChange={(value) => updateDraft(member.memberId, { systemPrompt: value })} cwd={room.projectRoot} rows={5} placeholder="例如：优先阅读项目规范，修改后必须运行相关测试" />
                          <label className={`${styles.field} ${styles.full}`}><span>擅长能力（逗号分隔）</span><input value={draft.capabilitiesText} onChange={(event) => updateDraft(member.memberId, { capabilitiesText: event.target.value })} /></label>
                          <AITextAreaField className={styles.full} label="工作风格（每行一项）" help="描述沟通和执行偏好，例如先验证再修改、结论附证据；每行一项。" purpose={`${draft.name || "智能体"}的工作风格列表`} value={draft.personalityText} onChange={(value) => updateDraft(member.memberId, { personalityText: value })} cwd={room.projectRoot} rows={3} placeholder="例如：结论先行\n每个修改附测试证据" />
                          <AITextAreaField className={styles.full} label="限制条件（每行一项）" help="写出明确不可违反的边界，例如禁止改某目录、不得跳过测试；每行一项。" purpose={`${draft.name || "智能体"}的限制条件列表`} value={draft.constraintsText} onChange={(value) => updateDraft(member.memberId, { constraintsText: value })} cwd={room.projectRoot} rows={3} placeholder="例如：不要覆盖用户已有修改\n不得未经验证宣称完成" />
                          <label className={styles.field}><span>模型策略</span><select value={draft.modelPolicy.mode} onChange={(event) => updateDraft(member.memberId, { modelPolicy: event.target.value === "session" ? { mode: "session" } : { mode: "pinned", provider: "", modelId: "", thinkingLevel: "medium" } })}><option value="session">沿用会话</option><option value="pinned">固定模型</option></select></label>
                          <label className={styles.field}><span>工作区策略</span><select value={draft.workspacePolicy.mode} onChange={(event) => updateDraft(member.memberId, { workspacePolicy: { ...draft.workspacePolicy, mode: event.target.value as TeamAgentProfile["workspacePolicy"]["mode"] } })}><option value="shared">共享</option><option value="dedicated_worktree">独立工作树</option><option value="read_only">只读</option></select></label>
                          {draft.modelPolicy.mode === "pinned" ? <><label className={styles.field}><span>模型服务商</span><input value={draft.modelPolicy.provider} onChange={(event) => updateDraft(member.memberId, { modelPolicy: { mode: "pinned", provider: event.target.value, modelId: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.modelId : "", thinkingLevel: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.thinkingLevel : "medium" } })} /></label><label className={styles.field}><span>模型编号</span><input value={draft.modelPolicy.modelId} onChange={(event) => updateDraft(member.memberId, { modelPolicy: { mode: "pinned", provider: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.provider : "", modelId: event.target.value, thinkingLevel: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.thinkingLevel : "medium" } })} /></label><label className={styles.field}><span>思考强度</span><select value={draft.modelPolicy.thinkingLevel} onChange={(event) => updateDraft(member.memberId, { modelPolicy: { mode: "pinned", provider: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.provider : "", modelId: draft.modelPolicy.mode === "pinned" ? draft.modelPolicy.modelId : "", thinkingLevel: event.target.value as TeamThinkingLevel } })}>{thinkingLevelOptions.map((level) => <option key={level.value} value={level.value}>{level.label}</option>)}</select></label></> : null}
                          <label className={styles.field}><span>工具策略</span><select value={draft.toolPolicy.mode} onChange={(event) => updateDraft(member.memberId, { toolPolicy: event.target.value === "inherit" ? { mode: "inherit" } : { mode: "allowlist", toolNames: [] } })}><option value="inherit">继承</option><option value="allowlist">仅允许指定工具</option></select></label>
                          <label className={styles.field}><span>技能策略</span><select value={draft.skillPolicy.mode} onChange={(event) => updateDraft(member.memberId, { skillPolicy: event.target.value === "inherit" ? { mode: "inherit" } : { mode: "allowlist", skillNames: [] } })}><option value="inherit">继承</option><option value="allowlist">仅允许指定技能</option></select></label>
                          {draft.toolPolicy.mode === "allowlist" ? <label className={`${styles.field} ${styles.full}`}><span>允许工具（逗号分隔）</span><input value={draft.toolNamesText} onChange={(event) => updateDraft(member.memberId, { toolNamesText: event.target.value })} /></label> : null}
                          {draft.skillPolicy.mode === "allowlist" ? <label className={`${styles.field} ${styles.full}`}><span>允许技能（逗号分隔）</span><input value={draft.skillNamesText} onChange={(event) => updateDraft(member.memberId, { skillNamesText: event.target.value })} /></label> : null}
                          </> : null}
                        </div>
                        <div className={styles.cardActions}><button type="button" disabled={Boolean(busy)} onClick={() => removeAgent(member)}>{removeConfirmId === member.memberId ? "再次点击确认移出" : "移出"}</button>{member.binding.managedByPiora && member.binding.status === "needs_restart" ? <button type="button" disabled={Boolean(busy)} onClick={() => { void reconfigureAgent(member); }}>应用配置</button> : null}<button type="button" className={styles.primary} disabled={Boolean(busy) || !draft.name?.trim()} onClick={() => saveMember(member)}>保存智能体</button></div>
                      </article>
                    );
                  })}
                </div>
                <section className={styles.addAgent}>
                  <div><h4>添加智能体</h4><p>只需填写名称即可创建，其余设置会使用稳妥的默认值。</p></div>
                  <label className={styles.field}><span>显示名称</span><input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：代码实现" /></label>
                  <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(busy) || !newName.trim()} onClick={() => { void createManagedAgent(); }}>创建智能体</button></div>
                  {busy === "provision_agent" ? <p role="status">正在准备工作目录与会话，项目文件较多时可能需要几分钟。</p> : null}
                  <details className={styles.advancedAdd}>
                    <summary>更多选项</summary>
                    <div className={styles.advancedAddBody}>
                      <label className={styles.field}><span>团队角色</span><select value={newRole} onChange={(event) => setNewRole(event.target.value as RoomMemberRole)}>{roleOptions.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
                      <AITextAreaField label="职责与约束" help="概括新智能体负责的工作、交付物和边界；只写几个关键词也可以。" purpose="新智能体的职责与约束" value={newInstructions} onChange={setNewInstructions} cwd={room.projectRoot} rows={3} placeholder="例如：测试与质量门禁" />
                      <label className={styles.field}><span>复用已有会话</span><select value={newSessionId} onChange={(event) => { const id = event.target.value; setNewSessionId(id); const session = sessions.find((candidate) => candidate.id === id); if (session) setNewName(sessionName(session)); }}><option value="">选择会话</option>{availableSessions.map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}</select></label>
                      <div className={styles.actions}><button type="button" disabled={Boolean(busy) || !newSessionId || !newName.trim()} onClick={addAgent}>复用所选会话</button></div>
                    </div>
                  </details>
                </section>
              </div>
            ) : null}

            {section === "workspace" ? (
              <div className={styles.page}>
                <div className={styles.pageHeading}><h3>共享工作区</h3><p>智能体在这里交换文件；消息、任务与审计仍由 Piora 独立托管。</p></div>
                <div className={styles.segmented}><button type="button" className={workspaceMode === "managed" ? styles.selected : ""} onClick={() => setWorkspaceMode("managed")}>Piora 托管</button><button type="button" className={workspaceMode === "custom" ? styles.selected : ""} onClick={() => setWorkspaceMode("custom")}>项目内目录</button></div>
                <label className={styles.field}><span>工作区名称</span><input value={workspaceLabel} onChange={(event) => setWorkspaceLabel(event.target.value)} /></label>
                <label className={styles.field}><span>目录</span><div className={styles.pathField}><input value={workspacePath} onChange={(event) => { setWorkspacePath(event.target.value); setWorkspaceMode("custom"); }} aria-describedby="workspace-path-help" /><button type="button" onClick={() => { void chooseWorkspacePath(); }}>浏览…</button></div><small id="workspace-path-help">编辑目录会切换为自定义模式；目录必须位于任一群成员的项目内，保存时会自动创建。</small></label>
                <AITextAreaField label="协作约定" help="约定文件放哪里、如何命名、怎样交付，以及哪些范围禁止覆盖；团队成员会共同遵守。" purpose="多智能体共享工作区的协作约定" value={workspaceInstructions} onChange={setWorkspaceInstructions} cwd={room.projectRoot} rows={6} placeholder="例如：每个任务写独立报告，不覆盖其他成员目录" />
                <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(busy) || !workspaceLabel.trim() || (workspaceMode === "custom" && !workspacePath.trim())} onClick={saveWorkspace}>保存工作区</button></div>
              </div>
            ) : null}

            {section === "coordination" ? (
              <div className={styles.page}>
                <div className={styles.pageHeading}><h3>任务编排</h3><p>控制谁负责协调、同时运行多少任务，以及失联任务何时自动释放。</p></div>
                <label className={styles.field}><span>运行模式</span><select value={coordinationMode} onChange={(event) => setCoordinationMode(event.target.value as "manual" | "team")}><option value="manual">手动协作</option><option value="team">协调者编排</option></select></label>
                <label className={styles.field}><span>协调智能体</span><select value={coordinatorId} onChange={(event) => setCoordinatorId(event.target.value)}>{room.members.map((member) => <option key={member.memberId} value={getRoomMemberSessionId(member)}>{getRoomMemberName(member)}</option>)}</select></label>
                <div className={styles.agentGrid}><label className={styles.field}><span>最大并发</span><input type="number" min={1} max={16} value={maxConcurrency} onChange={(event) => setMaxConcurrency(Number(event.target.value))} /></label><label className={styles.field}><span>任务租约（分钟）</span><input type="number" min={1} max={60} value={leaseMinutes} onChange={(event) => setLeaseMinutes(Number(event.target.value))} /></label></div>
                <div className={styles.roleGuide}>{roleOptions.map((role) => <div key={role.value}><strong>{role.label}</strong><span>{role.detail}</span></div>)}</div>
                <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(busy) || !coordinatorId} onClick={saveCoordination}>保存编排策略</button></div>
              </div>
            ) : null}
            {error ? <div className={styles.error} role="alert">{error}</div> : null}
            {saved ? <div className={styles.saved} role="status"><AliIcon name="check" size={14} />{saved}</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
