"use client";

import type { CollaborationRoom, RoomArtifact, RoomMember } from "@/lib/room-types";
import type { TeamRunState } from "@/lib/team-types";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./RoomWorkspace.module.css";

export function RoomAvatar({ member, name, role, user, small }: { member?: RoomMember; name?: string; role?: RoomMember["profile"]["role"]; user?: boolean; small?: boolean }) {
  const label = name ?? member?.profile.name ?? "π";
  return <span className={`${styles.avatar}${small ? ` ${styles.smallAvatar}` : ""}`} data-role={user ? "user" : role ?? member?.profile.role ?? "participant"} aria-hidden="true">{label.trim().slice(0, 1)}</span>;
}

export function RoomTaskSummary({ run, busy, onDetails, onAction, onAnswer }: {
  run: TeamRunState; busy?: boolean; onDetails: () => void; onAction: (action: "resume" | "cancel") => void; onAnswer: () => void;
}) {
  const { t } = useI18n();
  const tasks = Object.values(run.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  const terminal = ["completed", "failed", "cancelled"].includes(run.phase);
  return <section className={styles.taskSummary} aria-label={run.objective} data-room-task-summary="">
    <span className={styles.taskIcon}><AliIcon name="file" size={22} /></span>
    <div className={styles.taskSummaryBody}>
      <div className={styles.taskTitle}><strong>{run.objective.split("\n")[0]}</strong><span className={styles.badge} data-phase={run.phase}>{t(run.stopRequested ? "roomUx.stopping" : `roomUx.phase.${run.phase}`)}</span></div>
      <small>{tasks.length ? t("roomUx.completedCount", { done, total: tasks.length }) : t("roomUx.waitingPlan")}</small>
      {tasks.length > 0 ? <progress max={tasks.length} value={done} aria-label={t("roomUx.completedCount", { done, total: tasks.length })} /> : null}
    </div>
    <div className={styles.taskSummaryActions}>
      <button type="button" className={styles.primaryButton} onClick={onDetails}>{t("roomUx.viewDetails")}</button>
      {run.phase === "waiting_user" && !run.stopRequested ? <button type="button" onClick={onAnswer}>{t("roomUx.answer")}</button> : null}
      {["interrupted", "failed"].includes(run.phase) && !run.stopRequested ? <button type="button" disabled={busy} onClick={() => onAction("resume")}>{t("roomUx.resume")}</button> : null}
      {!terminal ? <button type="button" disabled={busy} onClick={() => onAction("cancel")}>{t(run.stopRequested ? "roomUx.retryStop" : "roomUx.stop")}</button> : null}
    </div>
  </section>;
}

export function RoomArtifactRows({ artifacts, room, actorSessionId, onSource }: {
  artifacts: RoomArtifact[]; room: CollaborationRoom; actorSessionId: string; onSource?: (artifact: RoomArtifact) => void;
}) {
  const { t } = useI18n();
  if (!artifacts.length) return <p className={styles.detailHint}>{t("roomUx.noArtifacts")}</p>;
  return <div className={styles.artifactList}>{artifacts.map((artifact) => <div key={artifact.id} className={styles.artifactRow}>
    <AliIcon name="file" size={19} />
    <a href={`/api/rooms/${encodeURIComponent(room.id)}/artifacts/${encodeURIComponent(artifact.id)}?sessionId=${encodeURIComponent(actorSessionId)}`}
      download title={t("roomUx.openResult")}><strong>{artifact.name}</strong><small>{artifact.summary.slice(0, 100)}</small></a>
    {onSource ? <button type="button" className={styles.iconButton} onClick={() => onSource(artifact)} aria-label={t("roomUx.viewSource")} title={t("roomUx.viewSource")}><AliIcon name="arrowright" size={16} /></button> : null}
  </div>)}</div>;
}
