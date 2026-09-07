"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref, type RefObject, type ReactNode } from "react";
import {
  getRoomMemberName,
  getRoomMemberRole,
  getRoomMemberSessionId,
  type CollaborationRoom,
  type RoomArtifact,
  type RoomMessage,
  type RoomMember,
  type RoomPresence,
  type RoomTask,
} from "@/lib/room-types";
import type { TaskRunState } from "@/lib/task-run";
import type { TeamRunState, TeamTaskStatus } from "@/lib/team-types";
import { TEAM_DEFAULTS } from "@/lib/team-types";
import { resolveRoomChatTargets } from "@/lib/room-chat-routing";
import { shouldShowScrollToBottom } from "@/lib/chat-scroll";
import { useSendShortcut } from "@/hooks/useSendShortcut";
import { isPlainEnter, matchesSendShortcut } from "@/lib/send-shortcut";
import { AliIcon } from "./AliIcon";
import { MarkdownBody } from "./MarkdownBody";
import { CollapsibleUserContent } from "./CollapsibleUserContent";
import { RoomSettingsDialog } from "./RoomSettingsDialog";
import { RoomMessageNavigator } from "./RoomMessageNavigator";
import { RoomActivityMessage } from "./RoomActivityMessage";
import { mergeRoomActivities, roomConversationEntries } from "@/lib/room-conversation";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import type { RoomActivity } from "@/lib/room-activity";
import styles from "./RoomWorkspace.module.css";

type RoomResponse = {
  room?: CollaborationRoom;
  messages?: RoomMessage[];
  tasks?: RoomTask[];
  taskRuns?: TaskRunState[];
  artifacts?: RoomArtifact[];
  message?: RoomMessage;
  teamRun?: TeamRunState;
  dispatch?: {
    dispatched?: Array<{ sessionId: string; behavior?: string; taskId?: string }>;
    skipped?: Array<{ sessionId?: string; taskId?: string; reason: string }>;
  };
  error?: string;
};

type TeamRunsResponse = { runs?: TeamRunState[]; run?: TeamRunState; error?: { code?: string; message?: string } | string };
type MentionQuery = { start: number; end: number; query: string };
// Interrupted runs are recoverable and must remain visible as an active item;
// hiding them makes the retry action effectively undiscoverable.
const TERMINAL_RUN_PHASES = new Set<TeamRunState["phase"]>(["completed", "failed", "cancelled"]);

function teamStatusLabel(status: TeamTaskStatus): string {
  return ({
    pending: "待规划", ready: "就绪", dispatching: "分派中", queued: "排队中", running: "执行中",
    submitted: "待审查", reviewing: "审查中", changes_requested: "需修改", completed: "完成",
    failed: "失败", blocked: "阻塞", interrupted: "已中断", cancelled: "已取消", skipped: "已跳过",
  })[status];
}

function teamRunPhaseLabel(phase: TeamRunState["phase"]): string {
  return ({
    draft: "准备中", planning: "规划中", running: "执行中", waiting_user: "需要回答",
    reviewing: "审查中", integrating: "整合中", synthesizing: "汇总中", completed: "已完成",
    failed: "失败", interrupted: "已中断", cancelled: "已取消",
  })[phase];
}

function teamRunActivityLabel(phase: TeamRunState["phase"]): string | null {
  return ({
    draft: "已收到目标，正在准备…",
    planning: "正在分析目标并制定任务计划…",
    running: "团队正在执行任务…",
    waiting_user: "智能体需要你的回答，具体问题已发送到群聊",
    reviewing: "正在审查任务结果…",
    integrating: "正在整合各项结果…",
    synthesizing: "正在汇总最终答复…",
    completed: null,
    failed: null,
    interrupted: "运行已中断，可展开详情恢复",
    cancelled: null,
  })[phase];
}

function currentTeamActivity(
  submittingGoal: boolean,
  pendingAction: "resume" | "cancel" | undefined,
  activeRun?: TeamRunState,
): string | null {
  if (submittingGoal) return "已收到目标，正在创建运行…";
  if (pendingAction === "resume") return "正在恢复团队运行…";
  if (pendingAction === "cancel") return "正在取消团队运行…";
  return activeRun ? teamRunActivityLabel(activeRun.phase) : null;
}

function localizedSystemMessage(content: string): string {
  const created = /^Room created by (.+)\.$/u.exec(content);
  if (created) return `${created[1]} 创建了协作空间。`;
  const joined = /^(.+) joined the room\.$/u.exec(content);
  if (joined) return `${joined[1]} 加入了协作空间。`;
  return content
    .replaceAll("Agent", "智能体")
    .replaceAll("Session", "会话")
    .replaceAll("Profile", "配置");
}

function visibleTeamMessage(message: string): string {
  const capabilityMatch = /^No ready Agent satisfies capabilities for:\s*(.+)\.$/u.exec(message);
  if (capabilityMatch) return `系统正在把“${capabilityMatch[1]}”重新分配给可用智能体，你不需要补充任何信息。`;
  return message;
}

function isLegacyCapabilityWait(run: TeamRunState): boolean {
  return run.phase === "waiting_user" && /^No ready Agent satisfies capabilities for:/u.test(run.waitingReason ?? "");
}

function teamRunDisplayPhaseLabel(run: TeamRunState): string {
  return isLegacyCapabilityWait(run) ? "重新分配中" : teamRunPhaseLabel(run.phase);
}

function legacyTaskStatusLabel(status: string): string {
  return ({
    pending: "待处理", leased: "已分配", running: "执行中", completed: "已完成",
    failed: "失败", blocked: "已阻塞", cancelled: "已取消",
  } as Record<string, string>)[status] ?? status;
}

function artifactKindLabel(kind: string): string {
  return ({ patch: "代码变更", commit: "提交", report: "报告", file: "文件" } as Record<string, string>)[kind] ?? kind;
}

function memberName(room: CollaborationRoom, sessionId?: string): string {
  if (!sessionId) return "未分配";
  const member = room.members.find((item) => getRoomMemberSessionId(item) === sessionId);
  return member ? getRoomMemberName(member) : sessionId.slice(0, 8);
}

function preferredRoomSessionId(room: CollaborationRoom): string {
  return room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId)?.binding.sessionId
    ?? room.members[0]?.binding.sessionId
    ?? "";
}

function initials(name?: string): string {
  return (name?.trim().slice(0, 1) || "π").toLocaleUpperCase();
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function roleLabel(role: CollaborationRoom["members"][number]["role"]): string {
  return ({ coordinator: "协调者", planner: "规划者", worker: "执行者", reviewer: "审查者", participant: "参与者" })[role];
}

const RoomMessageList = memo(function RoomMessageList({
  messages,
  members,
  presenceBySession,
  room,
  actorSessionId,
  messagesRef,
  messageRefs,
  teamActivity,
  activeTeamRun,
  activities,
  onBrowser,
  onMention,
  runControls,
}: {
  messages: RoomMessage[];
  members: Map<string, RoomMember>;
  presenceBySession: Map<string, RoomPresence>;
  room: CollaborationRoom;
  actorSessionId: string;
  messagesRef: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<Map<string, HTMLElement>>;
  teamActivity: string | null;
  activeTeamRun?: TeamRunState;
  activities: RoomActivity[];
  onBrowser: (sessionId: string) => void;
  onMention: (name: string) => void;
  runControls: ReactNode;
}) {
  const entries = useMemo(() => roomConversationEntries(messages, activities), [messages, activities]);
  return (
    <div ref={messagesRef} className={styles.messages} aria-live="polite" data-room-message-list="">
      <div>
      {entries.length === 0 ? <div className={styles.emptyState}>
        <span className={styles.groupAvatar}><AliIcon name="messages" size={19} /></span>
        <h2>开始群聊</h2>
        <p>直接发送消息会交给协调者；单独 @成员可直接沟通，同时提及多名成员时由协调者按依赖顺序调度。</p>
      </div> : entries.map((entry) => {
        if (entry.kind === "activity") return <RoomActivityMessage key={entry.key} activity={entry.activity} member={members.get(entry.activity.sessionId)} cwd={room.projectRoot} hasFinalReply={entry.hasFinalReply} onBrowser={onBrowser} onMention={onMention} />;
        const message = entry.message;
        const isPioraQuestion = message.author.kind === "system" && message.author.id === "piora" && message.content.startsWith("需要你的回答");
        const registerMessage = (element: HTMLElement | null) => {
          if (element) messageRefs.current.set(message.id, element);
          else messageRefs.current.delete(message.id);
        };
        if (isPioraQuestion) return <article ref={registerMessage} key={message.id} className={`${styles.message} ${styles.pioraQuestion}`}>
          <span className={styles.avatar}><AliIcon name="messages" size={14} /></span>
          <div className={styles.messageColumn}>
            <div className={styles.messageMeta}><strong>Piora</strong><time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time></div>
            <div className={styles.bubble}><MarkdownBody cwd={room.projectRoot}>{message.content}</MarkdownBody></div>
          </div>
        </article>;
        if (message.author.kind === "system") return <div ref={registerMessage} key={message.id} className={styles.systemMessage}>{localizedSystemMessage(message.content)}</div>;
        const isUser = message.author.kind === "user";
        const member = members.get(message.author.id);
        const author = message.author.name || (member ? getRoomMemberName(member) : message.author.id);
        return <article ref={registerMessage} key={message.id} className={`${styles.message}${isUser ? ` ${styles.userMessage}` : ""}`}>
          {!isUser ? <span className={styles.avatar}>{initials(author)}</span> : null}
          <div className={styles.messageColumn}>
            <div className={styles.messageMeta}>
              <strong>{author}</strong>
              <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
            </div>
            <div className={styles.bubble}>
              {isUser
                ? <CollapsibleUserContent message={message} cwd={room.projectRoot} sessionId={actorSessionId} />
                : <MarkdownBody cwd={room.projectRoot}>{message.content}</MarkdownBody>}
            </div>
          </div>
        </article>;
      })}
      {runControls}
      {presenceBySession.size > 0 || teamActivity ? <div className={styles.processingList} role="status" aria-live="polite">
        {teamActivity && activeTeamRun ? <details className={styles.activityCard}>
          <summary><i aria-hidden="true" /><strong>{teamActivity}</strong><AliIcon name="chevron-right" size={13} /></summary>
          <div><span>{teamRunDisplayPhaseLabel(activeTeamRun)}</span><small>{Object.values(activeTeamRun.tasks).filter((task) => task.status === "completed").length}/{Object.keys(activeTeamRun.tasks).length} 个任务已完成</small></div>
        </details> : teamActivity ? <span><i aria-hidden="true" />Piora：{teamActivity}</span> : null}
        {[...presenceBySession.keys()].map((sessionId) => <span key={sessionId}><i aria-hidden="true" />{memberName(room, sessionId)} 正在处理…</span>)}
      </div> : null}
      </div>
    </div>
  );
});

function RoomComposer({
  room,
  mode,
  draft,
  error,
  busy,
  mentionQuery,
  mentionCandidates,
  mentionIndex,
  textareaRef,
  onModeChange,
  onDraftChange,
  onMentionQueryChange,
  onMentionIndexChange,
  onMention,
  onSyncMentionQuery,
  onSubmit,
}: {
  room: CollaborationRoom;
  mode: "goal" | "message";
  draft: string;
  error: string | null;
  busy: boolean;
  mentionQuery: MentionQuery | null;
  mentionCandidates: Array<{ id: string; name: string; detail: string }>;
  mentionIndex: number;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onModeChange: (mode: "goal" | "message") => void;
  onDraftChange: (value: string) => void;
  onMentionQueryChange: (query: MentionQuery | null) => void;
  onMentionIndexChange: (updater: (current: number) => number) => void;
  onMention: (name: string) => void;
  onSyncMentionQuery: (value: string, caret: number) => void;
  onSubmit: () => void;
}) {
  const { shortcut } = useSendShortcut();
  const composingRef = useRef(false);
  const compositionEndedRef = useRef(0);
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229 || Date.now() - compositionEndedRef.current < 80) return;
    if (mode === "message" && mentionQuery && mentionCandidates.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        onMentionIndexChange((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (event.key === "Tab" || isPlainEnter(event)) {
        event.preventDefault();
        onMention(mentionCandidates[mentionIndex]?.name ?? mentionCandidates[0].name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onMentionQueryChange(null);
        return;
      }
    }
    if (matchesSendShortcut(event, shortcut)) {
      event.preventDefault();
      if (!busy && !event.repeat) onSubmit();
    }
  };
  return (
    <div className={`${styles.composerWrap} room-workspace-composer`}>
      {room.coordination.mode === "team" ? <div className={styles.composerModes} role="group" aria-label="输入模式">
        <button type="button" className={mode === "goal" ? styles.active : ""} onClick={() => onModeChange("goal")}>运行目标</button>
        <button type="button" className={mode === "message" ? styles.active : ""} onClick={() => onModeChange("message")}>群聊消息</button>
      </div> : null}
      {mode === "message" ? <div className={styles.mentions}>
        <button type="button" onClick={() => onMention("所有人")}>@所有人</button>
        {room.members.map((member) => <button key={member.memberId} type="button" onClick={() => onMention(getRoomMemberName(member))}>@{getRoomMemberName(member)}</button>)}
      </div> : null}
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.composer}>
        {mentionQuery && mentionCandidates.length > 0 ? <div className={styles.mentionMenu} role="listbox" aria-label="选择群成员">
          {mentionCandidates.map((candidate, index) => <button
            key={candidate.id}
            type="button"
            role="option"
            aria-selected={index === mentionIndex}
            className={index === mentionIndex ? styles.active : ""}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onMention(candidate.name)}
          ><span>{initials(candidate.name)}</span><strong>@{candidate.name}</strong><small>{candidate.detail}</small></button>)}
        </div> : null}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => { onDraftChange(event.target.value); onSyncMentionQuery(event.target.value, event.target.selectionStart); }}
          onClick={(event) => onSyncMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; compositionEndedRef.current = Date.now(); }}
          placeholder={mode === "goal" ? "直接描述要完成的事情，系统会自动规划和执行" : "发消息，输入 @ 提及群成员"}
          aria-label={mode === "goal" ? "智能体团队运行目标" : "群聊消息"}
          rows={2}
        />
        <button type="button" className={styles.sendButton} disabled={busy || !draft.trim()} onClick={onSubmit} aria-label={mode === "goal" ? "启动智能体团队" : "发送群聊消息"}>
          <AliIcon name="send" size={16} />
        </button>
      </div>
      <div className={styles.composerHint}>{shortcut === "ctrl-enter" ? "Ctrl+Enter 发送 · Enter 换行" : "Enter 发送 · Shift+Enter 换行"} · {mode === "goal" ? "协调者自动规划、分派、审查并汇总" : "单独 @ 直接沟通 · 多成员任务由协调者调度"}</div>
    </div>
  );
}

interface RoomDetailsPanelProps {
  room: CollaborationRoom;
  tasks: RoomTask[];
  taskRuns: Map<string, TaskRunState>;
  teamRuns: TeamRunState[];
  artifacts: RoomArtifact[];
  runningIds: Set<string>;
  busy: boolean;
  pendingRunAction: { runId: string; action: "resume" | "cancel" } | null;
  taskTitle: string;
  taskDescription: string;
  taskAssignee: string;
  onTaskTitleChange: (value: string) => void;
  onTaskDescriptionChange: (value: string) => void;
  onTaskAssigneeChange: (value: string) => void;
  onConfigureCoordinator: () => Promise<void>;
  onCreateTask: () => Promise<void>;
  onDispatchTasks: () => Promise<void>;
  onMutateTeamRun: (run: TeamRunState, action: "resume" | "cancel") => Promise<void>;
  onAnswerTeamRun: (run: TeamRunState) => void;
}

function RoomDetailsPanel(props: RoomDetailsPanelProps) {
  const {
    room, tasks, taskRuns, teamRuns, artifacts, runningIds, busy, pendingRunAction,
    taskTitle, taskDescription, taskAssignee,
    onTaskTitleChange, onTaskDescriptionChange, onTaskAssigneeChange,
    onConfigureCoordinator, onCreateTask, onDispatchTasks, onMutateTeamRun, onAnswerTeamRun,
  } = props;
  return (
    <aside className={`${styles.details} room-workspace-details`} aria-label="群聊详情">
      <section className={styles.detailSection}>
        <div className={styles.detailHeading}><h2>成员</h2><span>{room.members.length}</span></div>
        <div className={styles.memberList}>
          {room.members.map((member) => {
            const sessionId = getRoomMemberSessionId(member);
            return <div key={member.memberId} className={styles.detailMember}>
              <span className={styles.avatar}>{initials(getRoomMemberName(member))}</span>
              <div><strong>{getRoomMemberName(member)}</strong><small>{roleLabel(getRoomMemberRole(member))} · {sessionId.slice(0, 8)}</small></div>
              <span className={`${styles.statusDot}${runningIds.has(sessionId) ? ` ${styles.running}` : ""}`} title={runningIds.has(sessionId) ? "运行中" : "空闲"} />
            </div>;
          })}
        </div>
      </section>

      <section className={styles.detailSection}>
        <div className={styles.detailHeading}><h2>{room.workspace.label}</h2><span>{room.workspace.mode === "managed" ? "托管" : "自定义"}</span></div>
        <button type="button" className={styles.pathButton} title={room.workspace.path} onClick={() => { void navigator.clipboard.writeText(room.workspace.path); }}>
          <AliIcon name="folder-open" size={14} /><span>{room.workspace.path}</span><AliIcon name="copy" size={13} />
        </button>
        <p className={styles.detailHint}>{room.workspace.instructions || "智能体在此交换文件；每位成员另有稳定的私有目录。"}</p>
      </section>

      <section className={styles.detailSection}>
        <div className={styles.detailHeading}><h2>协调与任务</h2><span>{tasks.length}</span></div>
        <div className={styles.coordinationRow}>
          <span>{room.coordination.mode === "team" ? "协调者模式" : "手动模式"}</span>
          <button type="button" disabled={busy} onClick={() => { void onConfigureCoordinator(); }}>{room.coordination.mode === "team" ? "停用" : "启用"}</button>
        </div>
        {room.coordination.mode !== "team" ? <><input value={taskTitle} onChange={(event) => onTaskTitleChange(event.target.value)} placeholder="任务标题" aria-label="任务标题" />
        <textarea value={taskDescription} onChange={(event) => onTaskDescriptionChange(event.target.value)} placeholder="验收标准与上下文" aria-label="验收标准与上下文" rows={2} />
        <div className={styles.taskActions}>
          <select value={taskAssignee} onChange={(event) => onTaskAssigneeChange(event.target.value)} aria-label="任务执行者">
            <option value="">自动分配</option>
            {room.members.map((member) => <option key={member.memberId} value={getRoomMemberSessionId(member)}>{getRoomMemberName(member)}</option>)}
          </select>
          <button type="button" disabled={busy || !taskTitle.trim() || !taskDescription.trim()} onClick={() => { void onCreateTask(); }}>添加</button>
          <button type="button" disabled={busy || tasks.length === 0} onClick={() => { void onDispatchTasks(); }}>调度</button>
        </div></> : null}
        <div className={styles.taskList}>
          {tasks.slice().reverse().slice(0, 8).map((task) => <div key={task.id} className={styles.taskCard}>
            <span data-status={taskRuns.get(task.id)?.phase ?? task.status}>{legacyTaskStatusLabel(taskRuns.get(task.id)?.phase ?? task.status)}</span>
            <strong>{task.title}</strong><small>{memberName(room, task.assignedTo)}</small>
          </div>)}
        </div>
      </section>

      {room.coordination.mode === "team" ? <section className={styles.detailSection}>
        <div className={styles.detailHeading}><h2>团队运行</h2><span>{teamRuns.length}</span></div>
        <div className={styles.teamRunList}>
          {teamRuns.length === 0 ? <p className={styles.detailHint}>在“运行目标”模式提交目标后，任务会自动出现在这里。</p> : teamRuns.slice(0, 8).map((run) => <details key={run.id} className={styles.teamRunCard} open={!TERMINAL_RUN_PHASES.has(run.phase)}>
            <summary><span data-phase={run.phase}>{teamRunDisplayPhaseLabel(run)}</span><strong>{run.objective}</strong><small>{Object.values(run.tasks).filter((task) => task.status === "completed").length}/{Object.keys(run.tasks).length}</small></summary>
            {run.progressSummary ? <p>{run.progressSummary}</p> : null}
            {run.waitingReason ? <div className={run.phase === "waiting_user" && !isLegacyCapabilityWait(run) ? styles.runQuestion : styles.runWarning}>
              {run.phase === "waiting_user" && !isLegacyCapabilityWait(run) ? <strong><AliIcon name="messages" size={14} />智能体需要你回答</strong> : null}
              <p>{visibleTeamMessage(run.waitingReason)}</p>
            </div> : null}
            <div className={styles.teamTaskList}>{Object.values(run.tasks).map((task) => <div key={task.id}><span data-status={task.status}>{teamStatusLabel(task.status)}</span><strong>{task.title}</strong><small>{task.assignedMemberId ? room.members.find((member) => member.memberId === task.assignedMemberId)?.profile.name ?? task.assignedMemberId : "自动分配"}</small></div>)}</div>
            <div className={styles.runActions}>
              {run.phase === "waiting_user" && !isLegacyCapabilityWait(run) ? <button type="button" disabled={busy} onClick={() => onAnswerTeamRun(run)}>在群聊中回答</button> : null}
              {(run.phase === "interrupted" || isLegacyCapabilityWait(run)) ? <button type="button" disabled={busy} onClick={() => { void onMutateTeamRun(run, "resume"); }}>{pendingRunAction?.runId === run.id && pendingRunAction.action === "resume" ? "正在重试…" : "重试运行"}</button> : null}
              {!TERMINAL_RUN_PHASES.has(run.phase) ? <button type="button" disabled={busy} onClick={() => { void onMutateTeamRun(run, "cancel"); }}>{pendingRunAction?.runId === run.id && pendingRunAction.action === "cancel" ? "正在取消…" : "取消运行"}</button> : null}
            </div>
            {run.finalSummary ? <p className={styles.finalSummary}>{run.finalSummary}</p> : null}
          </details>)}
        </div>
      </section> : null}

      {artifacts.length > 0 ? <section className={styles.detailSection}>
        <div className={styles.detailHeading}><h2>公共产物</h2><span>{artifacts.length}</span></div>
        <div className={styles.artifactList}>{artifacts.slice().reverse().slice(0, 8).map((artifact) => <div key={artifact.id}><AliIcon name="file" size={13} /><span><strong>{artifact.name}</strong><small>{artifactKindLabel(artifact.kind)} · {memberName(room, artifact.sessionId)}</small></span></div>)}</div>
      </section> : null}
    </aside>
  );
}

function useRoomScrollNavigation({
  roomId,
  messageCount,
  presenceCount,
  submittingGoal,
  teamRuns,
  activities,
}: {
  roomId: string;
  messageCount: number;
  presenceCount: number;
  submittingGoal: boolean;
  teamRuns: TeamRunState[];
  activities: RoomActivity[];
}) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(true);

  const syncScrollNavigation = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    const shouldShow = shouldShowScrollToBottom({
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      threshold: 80,
    });
    pinnedToBottomRef.current = !shouldShow;
    setShowScrollToBottom(shouldShow);
  }, []);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = messagesRef.current;
    if (!element) return;
    pinnedToBottomRef.current = true;
    setShowScrollToBottom(false);
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const requestScrollToLatest = useCallback(() => {
    forceScrollToBottomRef.current = true;
  }, []);

  useEffect(() => {
    pinnedToBottomRef.current = true;
    forceScrollToBottomRef.current = true;
    setShowScrollToBottom(false);
  }, [roomId]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    element.addEventListener("scroll", syncScrollNavigation, { passive: true });
    syncScrollNavigation();
    return () => element.removeEventListener("scroll", syncScrollNavigation);
  }, [syncScrollNavigation]);

  useEffect(() => {
    const force = forceScrollToBottomRef.current;
    forceScrollToBottomRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      if (force || pinnedToBottomRef.current) scrollToLatest("auto");
      else syncScrollNavigation();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messageCount, presenceCount, scrollToLatest, submittingGoal, syncScrollNavigation, teamRuns, activities]);

  return { messagesRef, requestScrollToLatest, scrollToLatest, showScrollToBottom };
}

export interface RoomWorkspaceHandle { guideMember(sessionId: string | null, prompt?: string): void }

export function RoomWorkspace({
  initialRoom,
  onRoomChange,
  onRoomDeleted,
  onOpenBrowser,
  handleRef,
}: {
  initialRoom: CollaborationRoom;
  onRoomChange?: (room: CollaborationRoom) => void;
  onRoomDeleted: (roomId: string) => void;
  onOpenBrowser: (sessionId: string, options?: { automatic?: boolean }) => void;
  handleRef?: Ref<RoomWorkspaceHandle>;
}) {
  const [room, setRoom] = useState(initialRoom);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [tasks, setTasks] = useState<RoomTask[]>([]);
  const [taskRuns, setTaskRuns] = useState<Map<string, TaskRunState>>(new Map());
  const [teamRuns, setTeamRuns] = useState<TeamRunState[]>([]);
  const [composerMode, setComposerMode] = useState<"goal" | "message">(initialRoom.coordination.mode === "team" ? "goal" : "message");
  const [artifacts, setArtifacts] = useState<RoomArtifact[]>([]);
  const [draft, setDraft] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsOverlay, setDetailsOverlay] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submittingGoal, setSubmittingGoal] = useState(false);
  const [pendingRunAction, setPendingRunAction] = useState<{ runId: string; action: "resume" | "cancel" } | null>(null);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [presenceBySession, setPresenceBySession] = useState<Map<string, RoomPresence>>(new Map());
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [activities, setActivities] = useState<RoomActivity[]>([]);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const columnWidthRef = useRef(840);
  const getColumnMaxWidth = useCallback(() => Math.max(320, (conversationRef.current?.clientWidth ?? 880) - 40), []);
  const getDefaultColumnWidth = useCallback(() => Math.min(840, getColumnMaxWidth()), [getColumnMaxWidth]);
  const columnResizer = useResizablePanel({
    ariaLabel: "调整群聊正文宽度", cssVariable: "--room-column-width", defaultWidth: 840,
    getDefaultWidth: getDefaultColumnWidth, getMaxWidth: getColumnMaxWidth,
    growthDirection: "left", dragScale: 2, followDefaultWidth: true,
    maxWidth: 3200, minWidth: 320, panelRef: conversationRef,
    storageKey: "pi-room-column-width", widthRef: columnWidthRef,
  });
  const openMemberBrowser = useCallback((sessionId: string) => {
    setSelectedActivityId(sessionId);
    onOpenBrowser(sessionId);
  }, [onOpenBrowser]);
  const openedBrowserRuns = useRef(new Set<string>());
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoResumeAttemptsRef = useRef(new Set<string>());
  const { messagesRef, requestScrollToLatest, scrollToLatest, showScrollToBottom } = useRoomScrollNavigation({
    roomId: initialRoom.id,
    messageCount: messages.length,
    presenceCount: presenceBySession.size,
    submittingGoal,
    teamRuns,
    activities,
  });
  const actorSessionId = preferredRoomSessionId(room);
  const initialRoomId = initialRoom.id;
  const initialRoomMode = initialRoom.coordination.mode;
  const initialActorSessionId = preferredRoomSessionId(initialRoom);

  useImperativeHandle(handleRef, () => ({
    guideMember(sessionId, prompt) {
      const member = room.members.find((item) => item.binding.sessionId === sessionId);
      setComposerMode("message");
      setDraft((current) => `${member ? `@${getRoomMemberName(member)} ` : ""}${prompt?.trim() || current}`);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    },
  }), [room.members]);

  useEffect(() => {
    const browserActivity = activities.find((item) => item.status === "working" && item.browser && !openedBrowserRuns.current.has(item.runId));
    if (!browserActivity) return;
    openedBrowserRuns.current.add(browserActivity.runId);
    // A manually selected member keeps focus when several agents browse at once.
    if (selectedActivityId && selectedActivityId !== browserActivity.sessionId) return;
    onOpenBrowser(browserActivity.sessionId, { automatic: true });
  }, [activities, onOpenBrowser, selectedActivityId]);

  const updateRoom = useCallback((nextRoom: CollaborationRoom) => {
    setRoom(nextRoom);
    onRoomChange?.(nextRoom);
  }, [onRoomChange]);

  useEffect(() => {
    setRoom(initialRoom);
  }, [initialRoom]);

  useEffect(() => {
    setMessages([]);
    setActivities([]);
    setSelectedActivityId(null);
    openedBrowserRuns.current.clear();
    setTasks([]);
    setTaskRuns(new Map());
    setTeamRuns([]);
    setComposerMode(initialRoomMode === "team" ? "goal" : "message");
    setArtifacts([]);
    setPresenceBySession(new Map());
    setMentionQuery(null);
    setDraft("");
    setError(null);
    setConnectionState("connecting");
    messageRefs.current.clear();
    const events = new EventSource(`/api/rooms/${encodeURIComponent(initialRoomId)}/events?sessionId=${encodeURIComponent(initialActorSessionId)}`);
    events.onopen = () => {
      setConnectionState("connected");
      setError(null);
    };
    events.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as RoomResponse & { type?: string; activities?: RoomActivity[]; presence?: RoomPresence; task?: RoomTask; taskRun?: TaskRunState; artifact?: RoomArtifact };
        if (data.type === "snapshot") {
          if (data.room) updateRoom(data.room);
          setMessages(data.messages ?? []);
          setTasks(data.tasks ?? []);
          setTaskRuns(new Map((data.taskRuns ?? []).map((taskRun) => [taskRun.taskId, taskRun])));
          setArtifacts(data.artifacts ?? []);
        } else if (data.type === "activity") {
          setActivities((current) => mergeRoomActivities(current, data.activities ?? []));
          setRunningIds(new Set((data.activities ?? []).filter((item) => item.status === "working").map((item) => item.sessionId)));
          setPresenceBySession((current) => {
            const next = new Map([...current].filter(([id, value]) =>
              (data.activities ?? []).some((item) => item.sessionId === id && item.status === "working") || Date.now() - value.updatedAt < 15_000));
            return next.size === current.size ? current : next;
          });
        } else if (data.type === "room" && data.room) {
          updateRoom(data.room);
        } else if (data.type === "message" && data.message) {
          setMessages((current) => current.some((item) => item.id === data.message?.id) ? current : [...current, data.message!].slice(-500));
        } else if (data.type === "presence" && data.presence) {
          setPresenceBySession((current) => {
            const next = new Map(current);
            if (data.presence?.status === "processing") next.set(data.presence.sessionId, data.presence);
            else next.delete(data.presence!.sessionId);
            return next;
          });
        } else if (data.type === "task" && data.task) {
          setTasks((current) => [...current.filter((item) => item.id !== data.task?.id), data.task!].sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt));
          if (data.taskRun) setTaskRuns((current) => new Map(current).set(data.taskRun!.taskId, data.taskRun!));
        } else if (data.type === "artifact" && data.artifact) {
          setArtifacts((current) => current.some((item) => item.id === data.artifact?.id) ? current : [...current, data.artifact!]);
          if (data.taskRun) setTaskRuns((current) => new Map(current).set(data.taskRun!.taskId, data.taskRun!));
        }
      } catch {
        // Ignore malformed frames and let EventSource continue reconnecting.
      }
    };
    events.onerror = () => setConnectionState("reconnecting");
    return () => events.close();
  }, [initialRoomId, initialRoomMode, initialActorSessionId, updateRoom]);

  useEffect(() => {
    let cancelled = false;
    const loadRuns = () => void fetch(`/api/rooms/${encodeURIComponent(room.id)}/runs?sessionId=${encodeURIComponent(actorSessionId)}`, { cache: "no-store" })
      .then(async (response) => ({ response, data: await response.json() as TeamRunsResponse }))
      .then(({ response, data }) => {
        if (!cancelled && response.ok) setTeamRuns(data.runs ?? []);
      })
      .catch(() => {});
    loadRuns();
    const timer = window.setInterval(loadRuns, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [room.id, actorSessionId]);

  const activeTeamRunId = teamRuns.find((run) => !TERMINAL_RUN_PHASES.has(run.phase))?.id;
  useEffect(() => {
    if (!activeTeamRunId || !actorSessionId) return;
    const base = `/api/rooms/${encodeURIComponent(room.id)}/runs/${encodeURIComponent(activeTeamRunId)}`;
    const replaceRun = (run: TeamRunState) => setTeamRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)].sort((left, right) => right.updatedAt - left.updatedAt));
    const refresh = () => void fetch(`${base}?sessionId=${encodeURIComponent(actorSessionId)}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { run?: TeamRunState } | null) => { if (data?.run) replaceRun(data.run); })
      .catch(() => {});
    const source = new EventSource(`${base}/events?sessionId=${encodeURIComponent(actorSessionId)}`);
    source.addEventListener("snapshot", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { run?: TeamRunState };
        if (data.run) replaceRun(data.run);
      } catch { /* EventSource reconnect will restore a valid snapshot. */ }
    });
    source.addEventListener("team.event", refresh);
    source.onerror = refresh;
    return () => source.close();
  }, [room.id, actorSessionId, activeTeamRunId]);

  const activeTeamRun = teamRuns.find((run) => !TERMINAL_RUN_PHASES.has(run.phase));
  const pendingTeamRun = pendingRunAction ? teamRuns.find((run) => run.id === pendingRunAction.runId) : undefined;
  const displayedTeamRun = activeTeamRun ?? pendingTeamRun;
  const teamActivity = currentTeamActivity(submittingGoal, pendingRunAction?.action, activeTeamRun);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 820px)");
    const syncLayout = () => {
      setDetailsOverlay(media.matches);
      if (media.matches) setDetailsOpen(false);
    };
    syncLayout();
    media.addEventListener("change", syncLayout);
    return () => media.removeEventListener("change", syncLayout);
  }, []);

  const postAction = useCallback(async (body: Record<string, unknown>): Promise<RoomResponse> => {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json() as RoomResponse;
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    if (data.room) updateRoom(data.room);
    return data;
  }, [room.id, updateRoom]);

  const sendMessage = async () => {
    const content = draft.trim();
    const sender = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId) ?? room.members[0];
    if (!content || !sender || busy) return;
    requestScrollToLatest();
    if (new TextEncoder().encode(content).byteLength > TEAM_DEFAULTS.maxInputBytes) {
      setError("内容超过 256 KiB，请缩短后重试。");
      return;
    }
    setBusy(true);
    setError(null);
    setDraft("");
    setMentionQuery(null);
    const targetSessionIds = resolveRoomChatTargets(room, content);
    setPresenceBySession((current) => {
      const next = new Map(current);
      for (const sessionId of targetSessionIds) {
        next.set(sessionId, { sessionId, messageId: `pending-${Date.now()}`, status: "processing", updatedAt: Date.now() });
      }
      return next;
    });
    try {
      const data = await postAction({
        action: "chat",
        sessionId: getRoomMemberSessionId(sender),
        sessionName: "你",
        authorKind: "user",
        content,
        targetSessionIds,
      });
      if (data.teamRun) {
        setTeamRuns((current) => [data.teamRun!, ...current.filter((run) => run.id !== data.teamRun!.id)]
          .sort((left, right) => right.updatedAt - left.updatedAt));
        setPresenceBySession((current) => {
          const next = new Map(current);
          for (const sessionId of targetSessionIds) next.delete(sessionId);
          return next;
        });
      }
      const skipped = data.dispatch?.skipped ?? [];
      if (skipped.length > 0) {
        setError(skipped.map((item) => `${memberName(room, item.sessionId)}：${item.reason}`).join("；"));
        setPresenceBySession((current) => {
          const next = new Map(current);
          for (const item of skipped) if (item.sessionId) next.delete(item.sessionId);
          return next;
        });
      }
    } catch (reason) {
      setDraft(content);
      setPresenceBySession((current) => {
        const next = new Map(current);
        for (const sessionId of targetSessionIds) next.delete(sessionId);
        return next;
      });
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const createTeamRun = async () => {
    const objective = draft.trim();
    const sender = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId) ?? room.members[0];
    if (!objective || !sender || busy) return;
    requestScrollToLatest();
    if (new TextEncoder().encode(objective).byteLength > TEAM_DEFAULTS.maxInputBytes) {
      setError("目标超过 256 KiB，请缩短后重试。");
      return;
    }
    setBusy(true);
    setSubmittingGoal(true);
    setError(null);
    setDraft("");
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ objective, sessionId: sender.binding.sessionId, idempotencyKey: crypto.randomUUID() }),
      });
      const data = await response.json() as TeamRunsResponse;
      if (!response.ok || !data.run) {
        const detail = typeof data.error === "string" ? data.error : data.error?.message;
        throw new Error(detail ?? `HTTP ${response.status}`);
      }
      setTeamRuns((current) => [data.run!, ...current.filter((run) => run.id !== data.run!.id)]);
      setDraft("");
    } catch (reason) {
      setDraft(objective);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmittingGoal(false);
      setBusy(false);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  const mutateTeamRun = useCallback(async (run: TeamRunState, action: "resume" | "cancel") => {
    if (busy) return;
    setBusy(true);
    setPendingRunAction({ runId: run.id, action });
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/runs/${encodeURIComponent(run.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "cancel"
          ? { sessionId: actorSessionId, reason: "用户从团队运行详情中取消。" }
          : { sessionId: actorSessionId }),
      });
      const data = await response.json() as TeamRunsResponse;
      if (!response.ok || !data.run) throw new Error(typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${response.status}`);
      setTeamRuns((current) => [data.run!, ...current.filter((candidate) => candidate.id !== data.run!.id)].sort((left, right) => right.updatedAt - left.updatedAt));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPendingRunAction(null);
      setBusy(false);
    }
  }, [actorSessionId, busy, room.id]);

  useEffect(() => {
    const legacyWait = teamRuns.find((run) => isLegacyCapabilityWait(run));
    if (!legacyWait || busy || autoResumeAttemptsRef.current.has(legacyWait.id)) return;
    autoResumeAttemptsRef.current.add(legacyWait.id);
    void mutateTeamRun(legacyWait, "resume");
  }, [busy, mutateTeamRun, teamRuns]);

  const answerTeamRun = (run: TeamRunState) => {
    const task = Object.values(run.tasks).find((candidate) => candidate.status === "blocked");
    setDetailsOpen(false);
    setComposerMode("message");
    setDraft((current) => current || (task ? `关于“${task.title}”：` : "我的回答："));
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const submitComposer = () => composerMode === "goal" && room.coordination.mode === "team" ? createTeamRun() : sendMessage();

  const syncMentionQuery = (value: string, caret: number) => {
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(value.slice(0, caret));
    if (!match) {
      setMentionQuery(null);
      return;
    }
    const start = caret - match[1].length - 1;
    setMentionQuery({ start, end: caret, query: match[1] });
    setMentionIndex(0);
  };

  const mentionCandidates = useMemo(() => {
    const candidates = [
      { id: "all", name: "所有人", detail: "通知全部成员" },
      ...room.members.map((member) => ({
        id: getRoomMemberSessionId(member),
        name: getRoomMemberName(member),
        detail: roleLabel(getRoomMemberRole(member)),
      })),
    ];
    const query = mentionQuery?.query.trim().toLocaleLowerCase() ?? "";
    return query ? candidates.filter((candidate) => candidate.name.toLocaleLowerCase().includes(query)) : candidates;
  }, [mentionQuery?.query, room.members]);

  const mention = (name: string) => {
    setComposerMode("message");
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? draft.length;
    const range = mentionQuery ?? { start: caret, end: caret, query: "" };
    const prefix = draft.slice(0, range.start);
    const needsSpace = prefix.length > 0 && !/\s$/u.test(prefix);
    const replacement = `${needsSpace ? " " : ""}@${name} `;
    const next = `${prefix}${replacement}${draft.slice(range.end)}`;
    const nextCaret = prefix.length + replacement.length;
    setDraft(next);
    setMentionQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const createTask = async () => {
    if (!taskTitle.trim() || !taskDescription.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const sender = actorSessionId;
      if (!sender) throw new Error("房间没有可用成员。");
      await postAction({
        action: "create_task",
        sessionId: sender,
        title: taskTitle.trim(),
        description: taskDescription.trim(),
        assignedTo: taskAssignee || undefined,
        dedupeKey: taskTitle.trim().toLocaleLowerCase(),
      });
      setTaskTitle("");
      setTaskDescription("");
      setTaskAssignee("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const configureCoordinator = async () => {
    const sender = actorSessionId;
    if (!sender) return;
    setBusy(true);
    try {
      await postAction({
        action: "configure",
        sessionId: sender,
        mode: room.coordination.mode === "team" ? "manual" : "team",
        maxConcurrency: room.coordination.maxConcurrency,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const dispatchTasks = async () => {
    const sender = actorSessionId;
    if (!sender) return;
    setBusy(true);
    setError(null);
    try {
      const data = await postAction({ action: "dispatch", sessionId: sender });
      const skipped = data.dispatch?.skipped ?? [];
      if (skipped.length > 0) {
        setError(skipped.map((item) => {
          const task = tasks.find((candidate) => candidate.id === item.taskId);
          return `${task ? `任务“${task.title}”` : "任务"}：${item.reason}`;
        }).join("；"));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const memberMap = useMemo(() => new Map(room.members.map((member) => [getRoomMemberSessionId(member), member])), [room.members]);

  const runControls = displayedTeamRun ? <div className={styles.teamProgress} role="status">
        <div><strong>{teamRunDisplayPhaseLabel(displayedTeamRun)}</strong><span>{displayedTeamRun.objective}</span></div>
        <progress max={Math.max(1, Object.keys(displayedTeamRun.tasks).length)} value={Object.values(displayedTeamRun.tasks).filter((task) => task.status === "completed").length} aria-label="团队任务进度" />
        <button type="button" onClick={() => setDetailsOpen(true)}>任务与产物</button>
        {displayedTeamRun.phase === "waiting_user" ? <button type="button" onClick={() => answerTeamRun(displayedTeamRun)}>回答问题</button> : null}
        {displayedTeamRun.phase === "interrupted" ? <button type="button" disabled={busy} onClick={() => { void mutateTeamRun(displayedTeamRun, "resume"); }}>恢复</button> : null}
        {!TERMINAL_RUN_PHASES.has(displayedTeamRun.phase) ? <button type="button" disabled={busy} onClick={() => { void mutateTeamRun(displayedTeamRun, "cancel"); }}>停止团队</button> : null}
      </div> : null;

  return (
    <section className={`${styles.workspace} room-workspace`} aria-label={`群聊：${room.name}`}>
      <header className={`${styles.header} room-workspace-header`}>
        <div className={styles.headerIdentity}>
          <span className={styles.groupAvatar} aria-hidden="true"><AliIcon name="messages" size={17} /></span>
          <div>
            <h1>{room.name}</h1>
            <p>{room.members.length} 位成员 · {connectionState === "connected" ? "实时连接" : connectionState === "connecting" ? "正在连接" : "正在重连"}</p>
          </div>
        </div>
        <div className={styles.headerMembers} aria-label="群成员">
          {room.members.slice(0, 5).map((member) => (
            <span key={member.memberId} className={styles.miniAvatar} title={getRoomMemberName(member)}>{initials(getRoomMemberName(member))}</span>
          ))}
        </div>
        <button type="button" className={styles.detailsButton} onClick={() => setSettingsOpen(true)} aria-label="协作空间设置">
          <AliIcon name="edit" size={15} />
        </button>
        <button
          type="button"
          className={`${styles.detailsButton}${detailsOpen ? ` ${styles.active}` : ""}`}
          onClick={() => setDetailsOpen((current) => !current)}
          aria-expanded={detailsOpen}
          aria-label={activeTeamRun ? `团队运行状态：${teamRunDisplayPhaseLabel(activeTeamRun)}` : "群聊与团队状态"}
        >
          <AliIcon name="activity" size={16} />
          {activeTeamRun ? <span
            className={styles.runStatusDot}
            data-attention={["waiting_user", "interrupted"].includes(activeTeamRun.phase) ? "true" : "false"}
            aria-hidden="true"
          /> : null}
        </button>
      </header>



      <div className={styles.content}>
        <div ref={conversationRef} className={styles.conversation}>
          {!detailsOverlay ? <div {...columnResizer.separatorProps} className={styles.columnResizeHandle} data-resize-handle="room-column" data-resize-growth-direction="left" title="拖动调整群聊宽度，双击恢复默认" /> : null}
          <div className={styles.messageViewport}>
            <RoomMessageList
              messages={messages}
              members={memberMap}
              presenceBySession={presenceBySession}
              room={room}
              actorSessionId={actorSessionId}
              messagesRef={messagesRef}
              messageRefs={messageRefs}
              teamActivity={teamActivity}
              activeTeamRun={displayedTeamRun}
              activities={activities}
              onBrowser={openMemberBrowser}
              onMention={mention}
              runControls={runControls}
            />
            {showScrollToBottom ? <div className={styles.scrollToBottomLayer}>
              <button type="button" className={styles.scrollToBottom} onClick={() => scrollToLatest()} aria-label="滚动到最新消息" title="滚动到最新消息">
                <AliIcon name="arrowdown" size={16} />
              </button>
            </div> : null}
          </div>

          <RoomComposer
            room={room}
            mode={composerMode}
            draft={draft}
            error={error}
            busy={busy}
            mentionQuery={mentionQuery}
            mentionCandidates={mentionCandidates}
            mentionIndex={mentionIndex}
            textareaRef={textareaRef}
            onModeChange={setComposerMode}
            onDraftChange={setDraft}
            onMentionQueryChange={setMentionQuery}
            onMentionIndexChange={setMentionIndex}
            onMention={mention}
            onSyncMentionQuery={syncMentionQuery}
            onSubmit={() => { void submitComposer(); }}
          />
        </div>

        {!detailsOverlay ? <RoomMessageNavigator messages={messages} scrollContainer={messagesRef} messageRefs={messageRefs} /> : null}

        {detailsOpen ? <>
          {detailsOverlay ? <button type="button" className={styles.detailsBackdrop} aria-label="关闭群聊详情" onClick={() => setDetailsOpen(false)} /> : null}
          <RoomDetailsPanel
            room={room}
            tasks={tasks}
            taskRuns={taskRuns}
            teamRuns={teamRuns}
            artifacts={artifacts}
            runningIds={runningIds}
            busy={busy}
            pendingRunAction={pendingRunAction}
            taskTitle={taskTitle}
            taskDescription={taskDescription}
            taskAssignee={taskAssignee}
            onTaskTitleChange={setTaskTitle}
            onTaskDescriptionChange={setTaskDescription}
            onTaskAssigneeChange={setTaskAssignee}
            onConfigureCoordinator={configureCoordinator}
            onCreateTask={createTask}
            onDispatchTasks={dispatchTasks}
            onMutateTeamRun={mutateTeamRun}
            onAnswerTeamRun={answerTeamRun}
          />
        </> : null}
      </div>
      {settingsOpen ? <RoomSettingsDialog room={room} onClose={() => setSettingsOpen(false)} onRoomChange={updateRoom} onRoomDeleted={onRoomDeleted} /> : null}
    </section>
  );
}
