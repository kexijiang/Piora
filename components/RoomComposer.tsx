"use client";

import { useEffect, useImperativeHandle, useRef, useState, type Ref, type KeyboardEvent } from "react";
import { clearDraft, deferDraftPersistence, getDraft, hydrateDraft, setDraft, type ChatDraft } from "@/lib/draft-store";
import { confirmPendingPrompts, readPendingPrompts, savePendingPrompt, type PendingPrompt } from "@/lib/prompt-recovery";
import { storeBrowserFiles } from "@/lib/file-attachments";
import { adjustRoomMentions } from "@/lib/room-composer";
import { matchesSendShortcut, isPlainEnter } from "@/lib/send-shortcut";
import { formatShortcutBinding } from "@/lib/keyboard-shortcuts";
import type { CollaborationRoom, RoomMessage, RoomSubmission } from "@/lib/room-types";
import type { RoomSubmissionInput } from "@/lib/room-submissions";
import { useSendShortcut } from "@/hooks/useSendShortcut";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import { RoomAvatar } from "./RoomUi";
import styles from "./RoomWorkspace.module.css";

export interface RoomComposerHandle {
  mention: (memberId: string, prompt?: string) => void;
  reply: (message: RoomMessage) => void;
}

function recoveryRecord(scope: string, draft: ChatDraft, actorSessionId: string): PendingPrompt {
  const id = crypto.randomUUID();
  return { id, scope, message: { role: "user", content: draft.value, timestamp: Date.now(), clientPromptId: id },
    draft: { ...draft, roomInput: { intent: "auto", mentions: [], ...draft.roomInput, sessionId: draft.roomInput?.sessionId ?? actorSessionId } } };
}

function submissionInput(record: PendingPrompt, actorSessionId: string): RoomSubmissionInput {
  const input = record.draft.roomInput;
  return { sessionId: input?.sessionId ?? actorSessionId, clientPromptId: record.id, content: record.draft.value,
    intent: input?.intent ?? "auto", mentions: input?.mentions ?? [], replyTo: input?.reply?.id,
    attachments: record.draft.files.filter((file) => file.path).map((file) => ({ name: file.name, path: file.path! })) };
}

function receiptLabel(response: RoomSubmission, intent: RoomSubmissionInput["intent"]) {
  if (response.status === "queued") return "roomUx.queued";
  if (response.teamRunId && intent === "auto") return "roomUx.supplemented";
  return response.status === "delivered" ? "roomUx.delivered" : "roomUx.accepted";
}

const isConfirmed = (response: RoomSubmission) => response.status === "delivered" || response.status === "queued";

function isRecoveryDraft(draft: ChatDraft, record: PendingPrompt, actor: string): boolean {
  return JSON.stringify(submissionInput({ ...record, draft }, actor)) === JSON.stringify(submissionInput(record, actor))
    && JSON.stringify(draft.images) === JSON.stringify(record.draft.images);
}

export function RoomComposer({ room, actorSessionId, submissions, onSubmit, handleRef }: {
  room: CollaborationRoom; actorSessionId: string; submissions: RoomSubmission[];
  onSubmit: (input: RoomSubmissionInput) => Promise<RoomSubmission>; handleRef?: Ref<RoomComposerHandle>;
}) {
  const { t } = useI18n();
  const { shortcut, newlineShortcut } = useSendShortcut();
  const scope = `room:${room.id}`;
  const [draft, updateDraft] = useState<ChatDraft>(() => getDraft(scope) ?? { value: "", images: [], files: [] });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPrompt[]>([]);
  const [query, setQuery] = useState<{ start: number; end: number; text: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = useRef(draft);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const revision = useRef(0);
  const sending = useRef(false);
  const composing = useRef(false);
  const compositionEnded = useRef(0);
  const roomInput = draft.roomInput ?? { intent: "auto" as const, mentions: [] };
  const commit = (next: ChatDraft) => { current.current = next; revision.current++; updateDraft(next); setDraft(scope, next); };
  const focus = () => window.requestAnimationFrame(() => textarea.current?.focus());

  useEffect(() => {
    let disposed = false;
    const version = revision.current;
    void hydrateDraft(scope).then((saved) => {
      if (!disposed && revision.current === version && saved) { current.current = saved; updateDraft(saved); }
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    void readPendingPrompts(scope).then((records) => { if (!disposed) setPending(records); }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [scope]);

  useEffect(() => {
    const ids = new Set(submissions.filter((item) => item.status === "delivered" || item.status === "queued").map((item) => item.clientPromptId));
    const confirmed = pending.filter((item) => ids.has(item.id)).map((item) => item.id);
    if (!confirmed.length) return;
    let disposed = false;
    void confirmPendingPrompts(confirmed).then(() => { if (!disposed) setPending((previous) => previous.filter((item) => !ids.has(item.id))); }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [submissions, pending]);

  const insertMention = (memberId: string, prompt?: string) => {
    const selected = room.members.find((member) => member.memberId === memberId);
    const name = selected?.profile.name ?? t("roomUx.all");
    const before = current.current;
    const range = query ?? { start: textarea.current?.selectionStart ?? before.value.length, end: textarea.current?.selectionEnd ?? before.value.length };
    const prefix = before.value.slice(0, range.start);
    const spacing = prefix.length && !/\s$/u.test(prefix) ? " " : "";
    const token = `@${name}`;
    const replacement = `${spacing}${token} ${prompt ?? ""}`;
    const value = prefix + replacement + before.value.slice(range.end);
    const start = prefix.length + spacing.length;
    const mentions = adjustRoomMentions(before.value, value, before.roomInput?.mentions ?? []);
    if (selected) mentions.push({ memberId, start, end: start + token.length });
    commit({ ...before, value, roomInput: { ...before.roomInput, intent: "auto", mentions } });
    setQuery(null);
    window.requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(prefix.length + replacement.length, prefix.length + replacement.length); });
  };

  useImperativeHandle(handleRef, () => ({
    mention: insertMention,
    reply(message) {
      commit({ ...current.current, roomInput: { intent: message.kind === "question" || message.correlationId?.includes(":question:") ? "answer" : "auto", mentions: current.current.roomInput?.mentions ?? [], reply: message } });
      focus();
    },
  }));

  const syncQuery = (value: string, caret: number) => {
    const match = /(?:^|\s)@([^@\n]*)$/u.exec(value.slice(0, caret));
    setQuery(match ? { start: caret - match[1].length - 1, end: caret, text: match[1] } : null);
    setMentionIndex(0);
  };
  const candidates = [
    { id: "all", name: t("roomUx.all"), detail: t("roomUx.allHint"), member: undefined },
    ...room.members.map((member) => ({ id: member.memberId, name: member.profile.name, detail: t(`roomUx.${member.profile.role === "coordinator" ? "lead" : member.profile.role}`), member })),
  ].filter((candidate) => !query?.text || candidate.name.toLocaleLowerCase().includes(query.text.toLocaleLowerCase()));

  const send = async (recovery?: PendingPrompt) => {
    if (sending.current || uploading) return;
    const original = recovery?.draft ?? current.current;
    if (!original.value.trim() && !original.files.length) return;
    const key = scope;
    const version = revision.current;
    sending.current = true; setBusy(true); setError(null); setReceipt(null);
    const release = deferDraftPersistence(key);
    const record = recovery ?? recoveryRecord(key, original, actorSessionId);
    const id = record.id;
    let clearedAt: number | undefined;
    try {
      await savePendingPrompt(record);
      if (currentScope.current !== key) return;
      setPending((previous) => [...previous.filter((item) => item.id !== id), record]);
      if (revision.current === version && (!recovery || isRecoveryDraft(current.current, recovery, actorSessionId))) {
        commit({ value: "", images: [], files: [] }); clearDraft(key); clearedAt = revision.current;
      }
      release(); setQuery(null);
      const input = submissionInput(record, actorSessionId);
      const response = await onSubmit(input);
      if (response.status === "error") throw new Error(response.error ?? t("roomUx.failed"));
      const confirmed = isConfirmed(response);
      if (confirmed) await confirmPendingPrompts([id]);
      if (currentScope.current !== key) return;
      if (confirmed) setPending((previous) => previous.filter((item) => item.id !== id));
      setReceipt(t(receiptLabel(response, input.intent)));
    } catch (reason) {
      if (currentScope.current !== key) return;
      if (clearedAt !== undefined && revision.current === clearedAt && !current.current.value && !current.current.files.length) commit(original);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      release(); sending.current = false;
      if (currentScope.current === key) { setBusy(false); focus(); }
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229 || event.timeStamp - compositionEnded.current < 80) return;
    if (query && candidates.length) {
      if (["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); setMentionIndex((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length); return; }
      if (event.key === "Tab" || isPlainEnter(event)) { event.preventDefault(); insertMention(candidates[mentionIndex]?.id ?? candidates[0].id); return; }
      if (event.key === "Escape") { event.preventDefault(); setQuery(null); return; }
    }
    if (matchesSendShortcut(event, newlineShortcut)) {
      event.preventDefault();
      const element = event.currentTarget;
      const start = element.selectionStart;
      const value = element.value.slice(0, start) + "\n" + element.value.slice(element.selectionEnd);
      commit({ ...current.current, value, roomInput: { ...roomInput, mentions: adjustRoomMentions(current.current.value, value, roomInput.mentions) } });
      syncQuery(value, start + 1);
      window.requestAnimationFrame(() => element.setSelectionRange(start + 1, start + 1));
      return;
    }
    if (matchesSendShortcut(event, shortcut)) { event.preventDefault(); if (!event.repeat) void send(); return; }
    if (event.key === "Enter") event.preventDefault();
  };

  return <div className={`${styles.composerWrap} room-workspace-composer`}>
    {pending.length ? <div className={styles.recoveryList}>{pending.map((record) => <div key={record.id} className={styles.recoveryRow}>
      <span><strong>{t("roomUx.recover")}</strong><small>{record.draft.value.slice(0, 140)}</small></span><button type="button" disabled={busy} onClick={() => void send(record)}>{t("roomUx.retry")}</button>
    </div>)}</div> : null}
    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    <div className={styles.composer}>
      {roomInput.reply ? <div className={styles.replyStrip}><AliIcon name="messages" size={15} /><span><strong>{t("roomUx.replying", { name: roomInput.reply.author.name ?? t("roomUx.participant") })}</strong><small>{roomInput.reply.content.slice(0, 130)}</small></span><button type="button" className={styles.iconButton} aria-label={t("roomUx.close")} onClick={() => commit({ ...draft, roomInput: { intent: "auto", mentions: roomInput.mentions } })}><AliIcon name="close" size={14} /></button></div> : null}
      {roomInput.intent === "new_task" ? <div className={styles.intentStrip}><AliIcon name="plus" size={14} /><span>{t("roomUx.newTaskHint")}</span><button type="button" className={styles.iconButton} aria-label={t("roomUx.close")} onClick={() => commit({ ...draft, roomInput: { ...roomInput, intent: "auto" } })}><AliIcon name="close" size={14} /></button></div> : null}
      {draft.files.length ? <div className={styles.attachments}>{draft.files.map((file, index) => <span key={`${file.path}:${index}`}><AliIcon name="file" size={14} />{file.name}<button type="button" className={styles.iconButton} aria-label={`${t("roomUx.removeAttachment")} ${file.name}`} onClick={() => commit({ ...draft, files: draft.files.filter((_, item) => item !== index) })}><AliIcon name="close" size={12} /></button></span>)}</div> : null}
      <textarea ref={textarea} value={draft.value} rows={2} aria-label={t("roomUx.placeholder")} placeholder={t(roomInput.intent === "answer" ? "roomUx.answerPlaceholder" : "roomUx.placeholder")}
        onChange={(event) => { const value = event.target.value; commit({ ...current.current, value, roomInput: { ...roomInput, mentions: adjustRoomMentions(current.current.value, value, roomInput.mentions) } }); syncQuery(value, event.target.selectionStart); }}
        onClick={(event) => syncQuery(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={keyDown}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={(event) => { composing.current = false; compositionEnded.current = event.timeStamp; }} />
      {query && candidates.length ? <div className={styles.mentionMenu} role="listbox" aria-label={t("roomUx.selectMember")}>{candidates.map((candidate, index) => <button key={candidate.id} type="button" role="option" aria-selected={index === mentionIndex} onMouseDown={(event) => event.preventDefault()} onClick={() => insertMention(candidate.id)}><RoomAvatar member={candidate.member} name={candidate.name} small /><span><strong>{candidate.name}</strong><small>{candidate.detail}</small></span></button>)}</div> : null}
      <div className={styles.composerFooter}>
        <button type="button" className={styles.iconButton} aria-label={t("roomUx.attach")} disabled={uploading} onClick={() => fileInput.current?.click()}><AliIcon name="plus" size={19} /></button>
        {room.coordination.mode === "team" ? <button type="button" className={styles.newTaskButton} aria-pressed={roomInput.intent === "new_task"} title={t("roomUx.newTaskHint")} onClick={() => { commit({ ...draft, roomInput: { intent: "new_task", mentions: roomInput.mentions } }); focus(); }}>{t("roomUx.newTask")}</button> : null}
        <span className={styles.sendHint}>{receipt ? <span role="status"><AliIcon name="check" size={13} />{receipt}</span> : [shortcut && t("settings.sendShortcutHint", { shortcut: formatShortcutBinding(shortcut) }), newlineShortcut && t("settings.newlineShortcutHint", { shortcut: formatShortcutBinding(newlineShortcut) })].filter(Boolean).join(" · ")}</span>
        <button type="button" className={styles.sendButton} aria-label={t("roomUx.send")} disabled={busy || uploading || (!draft.value.trim() && !draft.files.length)} onClick={() => void send()}><AliIcon name="send" size={18} /></button>
      </div>
      <input ref={fileInput} type="file" hidden multiple onChange={(event) => {
        const files = Array.from(event.target.files ?? []); event.target.value = ""; if (!files.length) return;
        const key = scope; setUploading(true); setError(null);
        void storeBrowserFiles(files, files.map((file) => file.name)).then((saved) => { if (currentScope.current === key) commit({ ...current.current, files: [...current.current.files, ...saved] }); }).catch((reason) => { if (currentScope.current === key) setError(String(reason)); }).finally(() => { if (currentScope.current === key) setUploading(false); });
      }} />
    </div>
  </div>;
}
