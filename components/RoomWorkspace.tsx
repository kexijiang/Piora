"use client";

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import type { CollaborationRoom, RoomArtifact, RoomMessage, RoomSubmission } from "@/lib/room-types";
import type { TeamRunState } from "@/lib/team-types";
import type { RoomSubmissionInput } from "@/lib/room-submissions";
import { roomConversationEntries } from "@/lib/room-conversation";
import { isCurrentRoomQuestion } from "@/lib/room-question";
import { shouldShowScrollToBottom } from "@/lib/chat-scroll";
import { roomActor, mergeRoomMessages, useRoomData } from "@/hooks/useRoomData";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { AliIcon } from "./AliIcon";
import { LazyMarkdownBody as MarkdownBody } from "./LazyMarkdownBody";
import { CollapsibleUserContent } from "./CollapsibleUserContent";
import { RoomSettingsDialog } from "./RoomSettingsDialog";
import { RoomMessageNavigator } from "./RoomMessageNavigator";
import { RoomActivityMessage } from "./RoomActivityMessage";
import { RoomComposer, type RoomComposerHandle } from "./RoomComposer";
import { RoomAvatar, RoomArtifactRows, RoomTaskSummary } from "./RoomUi";
import { RoomLegacyTasks } from "./RoomLegacyTasks";
import styles from "./RoomWorkspace.module.css";

export interface RoomWorkspaceHandle { guideMember: (sessionId: string | null, prompt?: string) => void }
type Panel = "members" | "tasks" | "artifacts" | "thread";
const terminal = new Set(["completed", "failed", "cancelled"]);

export function RoomWorkspace({ initialRoom, onRoomChange, onRoomDeleted, onOpenBrowser, handleRef }: {
  initialRoom: CollaborationRoom; onRoomChange?: (room: CollaborationRoom) => void;
  onRoomDeleted: (roomId: string) => void; onOpenBrowser: (sessionId: string, options?: { automatic?: boolean }) => void; handleRef?: Ref<RoomWorkspaceHandle>;
}) {
  const { t, locale } = useI18n();
  const data = useRoomData(initialRoom, onRoomChange);
  const { room, messages, activities, runs } = data;
  const actor = roomActor(room);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [overlay, setOverlay] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<false | "overview" | "agents">(false);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLatest, setShowLatest] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const composer = useRef<RoomComposerHandle>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const conversationRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const pinned = useRef(true);
  const currentRoomId = useRef(room.id);
  currentRoomId.current = room.id;
  const columnWidth = useRef(840);
  const getMaxWidth = useCallback(() => Math.max(260, (conversationRef.current?.clientWidth ?? 880) - 48), []);
  const getDefaultWidth = useCallback(() => Math.min(840, getMaxWidth()), [getMaxWidth]);
  const resizer = useResizablePanel({ ariaLabel: "调整群聊正文宽度", cssVariable: "--room-column-width", defaultWidth: 840,
    getDefaultWidth, getMaxWidth, growthDirection: "left", dragScale: 2, followDefaultWidth: true,
    maxWidth: 3200, minWidth: 260, panelRef: conversationRef, storageKey: "pi-room-column-width", widthRef: columnWidth });
  const detailsWidth = useRef(324);
  const getDetailsMaxWidth = useCallback(() => (contentRef.current?.clientWidth ?? 1000) - 400, []);
  const detailsResizer = useResizablePanel({ ariaLabel: t("roomUx.resizeDetails"), cssVariable: "--room-details-width", defaultWidth: 324,
    getMaxWidth: getDetailsMaxWidth, growthDirection: "left", maxWidth: 800, minWidth: 260,
    panelRef: contentRef, storageKey: "pi-room-details-width", widthRef: detailsWidth });
  const reclampDetailsWidth = detailsResizer.reclampWidth;
  useFocusTrap(detailsRef, overlay && panel !== null, { onEscape: () => setPanel(null) });

  const activeRun = runs.find((run) => !terminal.has(run.phase));
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? activeRun ?? runs[0];
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId);
  const working = activities.filter((activity) => activity.status === "working");
  const selecting = [...data.presence.values()].filter(presence => presence.phase === "selection");
  const pendingSelection = data.submissions.find(submission => submission.status === "accepted" && submission.memberSelection && !submission.memberSelection.selectedMemberId);
  const selectingCount = selecting.length || (pendingSelection ? Math.max(1, room.members.length - pendingSelection.memberSelection!.assessments.length) : 0);
  const members = useMemo(() => new Map(room.members.map((member) => [member.binding.sessionId, member])), [room.members]);
  const allArtifacts = useMemo(() => {
    const result = new Map(data.artifacts.map((artifact) => [artifact.id, artifact]));
    for (const run of runs) for (const artifact of Object.values(run.artifacts)) {
      const owner = room.members.find((member) => member.memberId === artifact.memberId);
      result.set(artifact.id, { ...artifact, schemaVersion: 1, sessionId: owner?.binding.sessionId ?? actor });
    }
    return [...result.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [data.artifacts, runs, room.members, actor]);
  const entries = useMemo(() => roomConversationEntries(messages.filter((message) => !message.threadRootId), activities), [messages, activities]);
  const threadRoot = messages.find((message) => message.id === threadId);
  const threadMessages = messages.filter((message) => message.threadRootId === threadId);
  const queued = data.submissions.filter((submission) => submission.status === "queued");

  useImperativeHandle(handleRef, () => ({ guideMember(sessionId, prompt) {
    const member = room.members.find((candidate) => sessionId ? candidate.binding.sessionId === sessionId : candidate.memberId === room.coordination.coordinatorMemberId);
    if (member) composer.current?.mention(member.memberId, prompt);
  } }), [room.members, room.coordination.coordinatorMemberId]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1000px)");
    const update = () => {
      const width = contentRef.current?.clientWidth ?? 0;
      if (width === 0) return; // A hidden workspace must not replace its layout preference.
      setOverlay(media.matches || width < 700);
      reclampDetailsWidth();
    };
    const observer = new ResizeObserver(update);
    if (contentRef.current) observer.observe(contentRef.current);
    update(); media.addEventListener("change", update);
    return () => { observer.disconnect(); media.removeEventListener("change", update); };
  }, [reclampDetailsWidth]);
  useEffect(() => {
    setPanel(null); setSettingsOpen(false); setThreadId(null); setSelectedRunId(null); setError(null); setPendingAction(false); pinned.current = true; messageRefs.current.clear();
  }, [initialRoom.id]);

  const scrollLatest = useCallback(() => {
    const element = viewport.current;
    if (element) { element.scrollTo({ top: element.scrollHeight, behavior: "instant" }); pinned.current = true; setShowLatest(false); }
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = new ResizeObserver(() => { if (pinned.current) scrollLatest(); });
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    return () => resize.disconnect();
  }, [scrollLatest]);
  useEffect(() => {
    if (pinned.current) { const frame = requestAnimationFrame(scrollLatest); return () => cancelAnimationFrame(frame); }
  }, [messages, activities, runs, scrollLatest]);
  useEffect(() => {
    if (document.visibilityState !== "visible" || !messages.length) return;
    try { localStorage.setItem(`pi-room-read:${room.id}`, String(messages.at(-1)!.seq)); window.dispatchEvent(new Event("piora:room-read")); } catch { /* In-memory reading remains usable. */ }
  }, [room.id, messages]);

  const openPanel = (next: Panel) => setPanel((previous) => previous === next ? null : next);
  const openTask = (runId?: string) => { setSelectedRunId(runId ?? activeRun?.id ?? null); setPanel("tasks"); };
  const reply = (message: RoomMessage) => { composer.current?.reply(message); if (overlay) setPanel(null); };
  const openThread = (message: RoomMessage) => { setThreadId(message.threadRootId ?? message.id); setPanel("thread"); };
  const jumpToMessage = (id: string) => {
    const message = messages.find((item) => item.id === id);
    if (message?.threadRootId) { setThreadId(message.threadRootId); setPanel("thread"); return; }
    const element = messageRefs.current.get(id);
    if (element) { pinned.current = false; element.scrollIntoView({ block: "center", behavior: "smooth" }); element.focus({ preventScroll: true }); }
  };
  const answerRun = (run: TeamRunState) => {
    const question = [...messages].reverse().find((message) => isCurrentRoomQuestion(message, run));
    if (question) { reply(question); jumpToMessage(question.id); }
    else openTask(run.id);
  };

  const submit = async (input: RoomSubmissionInput): Promise<RoomSubmission> => {
    const id = room.id;
    const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok || !result.submission) throw new Error(typeof result.error === "string" ? result.error : result.error?.message ?? `HTTP ${response.status}`);
    if (currentRoomId.current === id) {
      if (result.message) data.setMessages((previous) => mergeRoomMessages(previous, [result.message]));
      data.setSubmissions((previous) => [...previous.filter((item) => item.clientPromptId !== result.submission.clientPromptId), result.submission]);
      if (input.replyTo) {
        const parent = messages.find((message) => message.id === input.replyTo);
        if (parent) { setThreadId(parent.threadRootId ?? parent.id); setPanel("thread"); }
      }
      pinned.current = true; void data.refresh();
    }
    return result.submission;
  };

  const mutateRun = async (run: TeamRunState, action: "resume" | "cancel") => {
    if (pendingAction) return;
    const id = room.id; setPendingAction(true); setError(null);
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.id)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: actor, ...(action === "cancel" ? { reason: "用户停止本次团队任务。" } : {}) }),
      });
      const result = await response.json();
      if (!response.ok || !result.run) throw new Error(typeof result.error === "string" ? result.error : result.error?.message ?? `HTTP ${response.status}`);
      if (currentRoomId.current === id) { data.acceptRun(result.run); void data.refresh(); }
    } catch (reason) { if (currentRoomId.current === id) { setError(reason instanceof Error ? reason.message : String(reason)); void data.refresh(); } }
    finally { if (currentRoomId.current === id) setPendingAction(false); }
  };

  const loadOlder = async () => {
    const element = viewport.current;
    if (loadingOlder || !messages.length || !element) return;
    setLoadingOlder(true); pinned.current = false;
    const oldHeight = element.scrollHeight; const oldTop = element.scrollTop; const id = room.id;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(id)}/messages?sessionId=${encodeURIComponent(actor)}&beforeSeq=${messages[0].seq}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (currentRoomId.current !== id) return;
      data.setMessages((previous) => mergeRoomMessages(previous, result.messages ?? []));
      requestAnimationFrame(() => { element.scrollTop = oldTop + element.scrollHeight - oldHeight; });
    } catch (reason) { setError(String(reason)); } finally { setLoadingOlder(false); }
  };

  const artifactSource = (artifact: RoomArtifact) => {
    const run = runs.find((candidate) => candidate.artifacts[artifact.id]);
    const source = messages.find((message) => artifact.taskId && run && message.taskId === artifact.taskId && message.teamRunId === run.id)
      ?? messages.find((message) => run && message.teamRunId === run.id && message.kind === "delivery");
    if (source) jumpToMessage(source.id); else openTask(run?.id);
  };

  const renderMessageBody = (message: RoomMessage, member: (typeof room.members)[number] | undefined, name: string, run: TeamRunState | undefined) => {
    const isQuestion = message.kind === "question" || message.correlationId?.includes(":question:");
    const isDelivery = message.kind === "delivery";
    const isUser = message.author.kind === "user";
    return (isQuestion ? <section className={styles.questionCard}>
          <AliIcon name="alert" size={20} /><div><strong>{t(isCurrentRoomQuestion(message, run) ? "roomUx.question" : "roomUx.questionResolved")}</strong><MarkdownBody cwd={room.projectRoot}>{message.content.replace(/^需要你的回答\s*/u, "")}</MarkdownBody>{run ? <button type="button" className={styles.textButton} onClick={() => openTask(run.id)}>{t("roomUx.relatedTask")}：{run.objective.split("\n")[0]}</button> : null}</div>
          {isCurrentRoomQuestion(message, run) ? <button type="button" className={styles.primaryButton} onClick={() => reply(message)}>{t("roomUx.answer")}</button> : null}
        </section> : message.kind === "handoff" ? <section className={styles.handoffCard}>
          <span className={styles.handoffIdentity}><strong>{name}</strong><AliIcon name="arrowright" size={17} />{message.targetMemberIds?.length ? message.targetMemberIds.map((id) => <strong key={id}>{room.members.find((candidate) => candidate.memberId === id)?.profile.name ?? t("roomUx.participant")}</strong>) : <strong>{t("roomUx.handoff")}</strong>}</span>
          <MarkdownBody cwd={room.projectRoot}>{message.content}</MarkdownBody><button type="button" className={styles.textButton} onClick={() => openTask(message.teamRunId)}>{t("roomUx.viewTask")}</button>
        </section> : isDelivery ? <section className={styles.deliveryCard}><div className={styles.taskTitle}><strong>{t("roomUx.delivery")}</strong><span className={styles.badge} data-phase="completed">{t("roomUx.phase.completed")}</span></div><MarkdownBody cwd={room.projectRoot}>{message.content}</MarkdownBody><RoomArtifactRows artifacts={allArtifacts.filter((artifact) => !run || Boolean(run.artifacts[artifact.id]))} room={room} actorSessionId={actor} onSource={artifactSource} />{run ? <button type="button" className={styles.textButton} onClick={() => openTask(run.id)}>{t("roomUx.verified")}</button> : null}</section>
          : <div className={isUser ? styles.bubble : `${styles.assistantBody} message-assistant-blocks`}>{isUser ? <CollapsibleUserContent message={message} sessionId={actor} /> : <MarkdownBody cwd={room.projectRoot} className="markdown-assistant-message">{message.content}</MarkdownBody>}</div>);
  };

  const renderMessage = (message: RoomMessage, insideThread = false) => {
    const member = members.get(message.author.id);
    const isUser = message.author.kind === "user";
    const name = isUser ? t("roomUx.you") : member?.profile.name ?? message.author.name ?? "Piora";
    const run = runs.find((candidate) => candidate.id === message.teamRunId || message.correlationId?.startsWith(`team:${candidate.id}:`));
    const isQuestion = message.kind === "question" || message.correlationId?.includes(":question:");
    const replies = messages.filter((candidate) => candidate.threadRootId === message.id);
    const parent = message.replyTo ? messages.find((candidate) => candidate.id === message.replyTo) : undefined;
    if (message.author.kind === "system" && !isQuestion) return <div key={message.id} className={styles.systemMessage}>{message.content}</div>;
    return <article key={message.id} ref={(element) => { if (!insideThread) { if (element) messageRefs.current.set(message.id, element); else messageRefs.current.delete(message.id); } }}
      tabIndex={-1} className={styles.message} data-room-message={message.id} data-room-author={isUser ? "user" : "assistant"}>
      <RoomAvatar member={member} name={name} user={isUser} />
      <div className={styles.messageColumn}>
        <div className={styles.messageMeta}><strong>{name}</strong>{member && room.coordination.mode === "team" ? <span className={styles.roleBadge}>{t(`roomUx.${member.profile.role === "coordinator" ? "lead" : member.profile.role}`)}</span> : null}<time dateTime={new Date(message.createdAt).toISOString()}>{new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(message.createdAt)}</time></div>
        {parent && (isUser || insideThread) ? <button type="button" className={styles.quote} onClick={() => jumpToMessage(parent.id)}><AliIcon name="messages" size={13} /><span>{parent.author.name ?? t("roomUx.participant")}：{parent.content.slice(0, 130)}</span></button> : null}
        {renderMessageBody(message, member, name, run)}
        {message.attachments?.length ? <div className={styles.messageAttachments}>{message.attachments.map((file, index) => <a key={`${file.path}:${index}`} href={`/api/rooms/${room.id}/messages/${message.id}/attachments/${index}?sessionId=${encodeURIComponent(actor)}`} target="_blank" rel="noreferrer"><AliIcon name="file" size={16} />{file.name}</a>)}</div> : null}
        <div className={styles.messageActions}>
          {!isQuestion ? <button type="button" onClick={() => reply(message)}><AliIcon name="messages" size={13} />{t("roomUx.reply")}</button> : null}
          {!insideThread && replies.length ? <button type="button" onClick={() => openThread(message)}>{t("roomUx.viewThread", { count: replies.length })}</button> : null}
          {insideThread ? <button type="button" onClick={() => {
            const content = `${t("roomUx.syncGroup")} · ${name}\n\n${message.content}`;
            void submit({ sessionId: actor, clientPromptId: crypto.randomUUID(), content, intent: "share", mentions: [], attachments: [] }).catch((reason) => setError(String(reason)));
          }}>{t("roomUx.syncGroup")}</button> : null}
        </div>
      </div>
    </article>;
  };

  const renderMembers = () => (<div className={styles.memberList}>{room.members.map((member) => {
              const activity = working.find((item) => item.sessionId === member.binding.sessionId);
              return <details key={member.memberId} className={styles.memberCard}><summary><RoomAvatar member={member} /><span><strong>{member.profile.name}</strong><small>{room.coordination.mode === "team" ? `${t(`roomUx.${member.profile.role === "coordinator" ? "lead" : member.profile.role}`)} · ` : ""}{activity?.phase ?? t(`roomUx.${member.binding.status === "ready" ? "ready" : member.binding.status === "provisioning" ? "preparing" : member.binding.status === "missing" ? "missing" : "needsRestart"}`)}</small></span><AliIcon name="chevron-right" size={15} /></summary><p>{member.profile.roleDescription}</p><div className={styles.memberMetadata}><code>{member.profile.modelPolicy.mode === "pinned" ? `${member.profile.modelPolicy.provider}/${member.profile.modelPolicy.modelId}` : t("roomUx.inheritModel")}</code><code>{member.binding.cwd}</code></div><div className={styles.inlineActions}><button type="button" onClick={() => { composer.current?.mention(member.memberId); if (overlay) setPanel(null); }}>{t("roomUx.guide")}</button><button type="button" onClick={() => setSettingsOpen("overview")}>{t("roomUx.settings")}</button></div></details>;
            })}<button type="button" className={styles.textButton} onClick={() => setSettingsOpen("agents")}><AliIcon name="plus" size={15} />{t("roomUx.addMember")}</button></div>);

  const renderTasks = () => (<>
              {selectedRun ? <section className={styles.runDetails}><h3>{selectedRun.objective.length > 90 ? `${selectedRun.objective.slice(0, 90)}…` : selectedRun.objective}</h3>{selectedRun.objective.length > 90 ? <details className={styles.evidence}><summary>{t("roomUx.fullObjective")}</summary><p>{selectedRun.objective}</p></details> : null}<p className={styles.detailHint}>{t("roomUx.ownedBy", { name: coordinator?.profile.name ?? t("roomUx.lead") })}</p><span className={styles.badge} data-phase={selectedRun.phase}>{t(selectedRun.stopRequested ? "roomUx.stopping" : `roomUx.phase.${selectedRun.phase}`)}</span>
                <ol className={styles.taskTimeline}>{Object.values(selectedRun.tasks).map((task, index) => <li key={task.id} data-status={task.status}><span className={styles.taskMarker}>{task.status === "completed" ? <AliIcon name="check" size={14} /> : index + 1}</span><div><strong>{task.title}</strong><small>{room.members.find((member) => member.memberId === task.assignedMemberId)?.profile.name ?? t("roomUx.lead")}</small></div><span>{t(`roomUx.phase.${task.status}`)}</span></li>)}</ol>
                {selectedRun.progressSummary ? <p className={styles.detailHint}>{selectedRun.progressSummary}</p> : null}
                {selectedRun.phase === "waiting_user" ? <button type="button" className={styles.primaryButton} onClick={() => answerRun(selectedRun)}>{t("roomUx.answer")}</button> : null}
                {["interrupted", "failed", "cancelled"].includes(selectedRun.phase) ? <button type="button" disabled={pendingAction || Boolean(selectedRun.stopRequested) || Boolean(activeRun && activeRun.id !== selectedRun.id)} onClick={() => void mutateRun(selectedRun, "resume")}>{t("roomUx.retry")}</button> : null}
                {!terminal.has(selectedRun.phase) ? <button type="button" className={styles.textButton} disabled={pendingAction} onClick={() => void mutateRun(selectedRun, "cancel")}>{t(selectedRun.stopRequested ? "roomUx.retryStop" : "roomUx.stop")}</button> : null}
                {Object.values(selectedRun.evidence).length ? <details className={styles.evidence}><summary>{t("roomUx.verified")}</summary>{Object.values(selectedRun.evidence).map((item) => <p key={item.id}><span className={styles.badge}>{item.source}</span>{item.summary}</p>)}</details> : null}
                <h4>{t("roomUx.artifacts")}</h4><RoomArtifactRows artifacts={allArtifacts.filter((artifact) => Boolean(selectedRun.artifacts[artifact.id]))} room={room} actorSessionId={actor} onSource={artifactSource} />
              </section> : <p className={styles.detailHint}>{t("roomUx.noTasks")}</p>}
              {runs.length > 1 ? <div className={styles.runHistory}>{runs.map((run) => <button key={run.id} type="button" aria-pressed={selectedRun?.id === run.id} onClick={() => setSelectedRunId(run.id)}><span className={styles.badge} data-phase={run.phase}>{t(`roomUx.phase.${run.phase}`)}</span><span>{run.objective.split("\n")[0]}</span></button>)}</div> : null}
              {queued.map((submission) => <div key={submission.clientPromptId} className={styles.queueItem}><span className={styles.badge}>{t("roomUx.queued")}</span><p>{messages.find((message) => message.id === submission.messageId)?.content}</p></div>)}
              {data.tasks.length || room.coordination.mode !== "team" ? <RoomLegacyTasks room={room} tasks={data.tasks} actor={actor} onRefresh={data.refresh} /> : null}
            </>);

  const renderHeader = () => (<header className={`${styles.header} room-workspace-header`}>
      <div className={styles.headerIdentity}><h1>{room.name}</h1><p>{t("roomUx.ownedBy", { name: coordinator?.profile.name ?? t("roomUx.lead") })}<span>·</span>{selectingCount ? <span role="status">{t("roomUx.selectingHandler", { count: selectingCount })}</span> : working.length ? t("roomUx.workingCount", { count: working.length }) : t("roomUx.memberCount", { count: room.members.length })}{data.connection !== "connected" ? <><span>·</span><span role="status">{t(`roomUx.${data.connection}`)}</span></> : null}</p></div>
      <nav className={styles.headerTabs} aria-label={t("roomUx.viewDetails")}>{(["members", "tasks", "artifacts"] as const).map((tab) => <button key={tab} type="button" aria-label={t(`roomUx.${tab}`)} aria-expanded={panel === tab} className={panel === tab ? styles.active : ""} onClick={() => openPanel(tab)}><AliIcon name={tab === "members" ? "user" : tab === "tasks" ? "activity" : "file"} size={17} /><span>{t(`roomUx.${tab}`)}</span>{tab === "tasks" && activeRun?.phase === "waiting_user" ? <i className={styles.attentionDot} /> : null}</button>)}</nav>
      <button type="button" className={styles.iconButton} title={t("roomUx.settings")} aria-label={t("roomUx.settings")} onClick={() => setSettingsOpen("overview")}><AliIcon name="ellipsis" size={20} /></button>
    </header>);

  const renderPinnedGoal = () => room.description?.trim() || activeRun ? (<div className={styles.pinnedGoal}><AliIcon name="bookmark" size={15} /><span>{t("roomUx.goal")}：{room.description?.trim() || activeRun?.objective.split("\n")[0]}</span></div>) : null;

  const renderDetailsResizeHandle = () => overlay ? null : <div {...detailsResizer.separatorProps}
    className={`${styles.detailsResizeHandle}${detailsResizer.isResizing ? ` ${styles.resizing}` : ""}`}
    data-resize-handle="room-details" title={t("layout.resizeHint")} />;
  const renderWorkspace = () => <section className={`${styles.workspace} room-workspace`} aria-label={`${t("roomUx.groups")}：${room.name}`}>
    {renderHeader()}
    {renderPinnedGoal()}
    <div className={styles.content} ref={contentRef}>
      <div className={styles.conversation} ref={conversationRef}>
        {!overlay && !panel ? <div {...resizer.separatorProps} className={styles.columnResizeHandle} data-resize-handle="room-column" data-resize-growth-direction="left" /> : null}
        <div className={styles.messageViewport}>
          <div ref={viewport} className={styles.messages} data-room-message-list="" onScroll={() => {
            const element = viewport.current!; const away = shouldShowScrollToBottom({ scrollHeight: element.scrollHeight, scrollTop: element.scrollTop, clientHeight: element.clientHeight, threshold: 80 }); pinned.current = !away; setShowLatest(away);
          }}>
            <div className={styles.messageInner}>
              {messages.length > 0 && messages[0].seq > 1 ? <button type="button" className={styles.loadOlder} disabled={loadingOlder} onClick={() => void loadOlder()}>{t("roomUx.loadEarlier")}</button> : null}
              {!entries.length ? <div className={styles.emptyState}><span className={styles.emptyIcon}><AliIcon name="messages" size={29} /></span><h2>{t("roomUx.start")}</h2><p>{t("roomUx.startHint")}</p><div className={styles.emptyMembers}>{room.members.map((member) => <button key={member.memberId} type="button" onClick={() => composer.current?.mention(member.memberId)}><RoomAvatar member={member} small /><span>{member.profile.name}</span></button>)}</div></div> : null}
              {entries.map((entry) => entry.kind === "message" ? renderMessage(entry.message) : <RoomActivityMessage key={entry.key} activity={entry.activity} member={members.get(entry.activity.sessionId)} cwd={room.projectRoot}
                hasFinalReply={entry.hasFinalReply} onBrowser={onOpenBrowser} onMention={(name) => { const member = room.members.find((candidate) => candidate.profile.name === name); if (member) composer.current?.mention(member.memberId); }} />)}
              {activeRun ? <RoomTaskSummary run={activeRun} busy={pendingAction} onDetails={() => openTask(activeRun.id)} onAnswer={() => answerRun(activeRun)} onAction={(action) => void mutateRun(activeRun, action)} /> : null}
              {queued.length ? <div className={styles.queueHint}><AliIcon name="timer" size={14} /><span>{t("roomUx.taskQueue")} · {queued.length}</span><button type="button" className={styles.textButton} onClick={() => openTask()}>{t("roomUx.viewDetails")}</button></div> : null}
              {error ? <div className={styles.error} role="alert">{error}</div> : null}
            </div>
          </div>
          {showLatest ? <button type="button" className={styles.scrollToBottom} aria-label={t("roomUx.latest")} onClick={scrollLatest}><AliIcon name="arrowdown" size={17} /></button> : null}
        </div>
        <RoomComposer key={room.id} room={room} actorSessionId={actor} submissions={data.submissions} onSubmit={submit} handleRef={composer} />
      </div>
      {!overlay && messages.length > 4 ? <RoomMessageNavigator messages={messages.filter((message) => !message.threadRootId)} scrollContainer={viewport} messageRefs={messageRefs} /> : null}
      {panel ? <>
        {overlay ? <div className={styles.detailsBackdrop} aria-hidden="true" onClick={() => setPanel(null)} /> : null}
        {renderDetailsResizeHandle()}
        <aside ref={detailsRef} className={`${styles.details}${overlay ? ` ${styles.detailsOverlay}` : ""} room-workspace-details`} role={overlay ? "dialog" : undefined} aria-modal={overlay ? true : undefined} aria-label={t(`roomUx.${panel === "tasks" ? "taskDetails" : panel}`)}>
          <div className={styles.detailsHeader}><h2>{t(`roomUx.${panel === "tasks" ? "taskDetails" : panel}`)}</h2><button type="button" className={styles.iconButton} aria-label={t("roomUx.close")} onClick={() => setPanel(null)}><AliIcon name="close" size={20} /></button></div>
          <div className={styles.detailsScroll}>
            {panel === "members" ? renderMembers() : null}
            {panel === "tasks" ? renderTasks() : null}
            {panel === "artifacts" ? <RoomArtifactRows artifacts={allArtifacts} room={room} actorSessionId={actor} onSource={artifactSource} /> : null}
            {panel === "thread" && threadRoot ? <div className={styles.threadMessages}>{renderMessage(threadRoot, true)}{threadMessages.map((message) => renderMessage(message, true))}<button type="button" className={styles.primaryButton} onClick={() => reply(threadMessages.at(-1) ?? threadRoot)}>{t("roomUx.reply")}</button></div> : null}
          </div>
        </aside>
      </> : null}
    </div>
    {settingsOpen ? <RoomSettingsDialog initialSection={settingsOpen} room={room} onClose={() => setSettingsOpen(false)} onRoomChange={data.acceptRoom} onRoomDeleted={onRoomDeleted} /> : null}
  </section>;
  return renderWorkspace();
}
