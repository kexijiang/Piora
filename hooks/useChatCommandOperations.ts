"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import { createChatCommandOperation, parseChatInput, persistentChatInputOptions } from "@/lib/chat-command-input";
import type { ChatCommandCatalog, ChatCommandView, ChatInputOptions } from "@/lib/chat-command-types";
import type { DispatchReceipt, SessionCommandEvent } from "@/lib/session-message-types";
import { dismissPendingPrompt, confirmPendingPrompts, readPendingPrompts, savePendingPrompt, PROMPT_RECOVERY_CONFIRMED_EVENT, type PendingPrompt } from "@/lib/prompt-recovery";
import { type AttachedFile } from "@/lib/file-attachments";
import type { AttachedImage } from "./useAgentSession";
import type { PromptMaterialReference } from "@/lib/prompt-material-format";
import { hydrateDraft } from "@/lib/draft-store";
import { useI18n } from "./useI18n";
import { isTerminalCommandStatus as terminal, mergeChatCommandViews, recoverChatCommandViews } from "@/lib/chat-command-views";

interface Options {
  /** Stable for the lifetime of this chat, including new-session promotion. */
  conversationKey: string;
  sessionId: string | null;
  scope: string;
  catalog: ChatCommandCatalog;
  /** Capture cancellation identity synchronously; run its async gate only after recovery commits. */
  captureSubmissionGuard?(expectedSessionId?: string): (admittedSessionId?: string) => Promise<boolean>;
  ensureSession(): Promise<string | null>;
  loadCatalog(): Promise<ChatCommandCatalog>;
  connectModelEvents(sessionId: string): Promise<void>;
  uploadFiles(files: AttachedFile[]): Promise<PromptMaterialReference[]>;
  onAccepted(): void;
  onFinished(record: ChatCommandView): void;
}

export function useChatCommandOperations(options: Options) {
  const { t } = useI18n();
  const latest = useRef(options);
  latest.current = options;
  const [localSessionId, setLocalSessionId] = useState<string | null>(null);
  const [records, setRecords] = useState<ChatCommandView[]>([]);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const notified = useRef(new Set<string>());
  const generation = useRef(0);
  const submitting = useRef(new Set<string>());
  const sessionId = options.sessionId ?? localSessionId;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;
  useEffect(() => {
    const confirmed = (event: Event) => {
      const ids = (event as CustomEvent<string[]>).detail;
      if (!Array.isArray(ids)) return;
      setRecords(current => current.filter(record => !record.local || !ids.includes(record.idempotencyKey)));
    };
    window.addEventListener(PROMPT_RECOVERY_CONFIRMED_EVENT, confirmed);
    return () => window.removeEventListener(PROMPT_RECOVERY_CONFIRMED_EVENT, confirmed);
  }, []);

  const refresh = useCallback(async (offset = 0) => {
    const sid = sessionRef.current;
    if (!sid) return;
    const query = new URLSearchParams({ view: "operations", offset: String(offset) });
    for (const record of recordsRef.current.filter(record => record.targetSessionId === sid && !record.operation && !record.local && !terminal(record.status)).slice(0, 100)) query.append("trackedCommandId", record.commandId);
    for (const record of recordsRef.current.filter(record => record.targetSessionId === sid && record.local).slice(0, 100)) query.append("trackedPromptId", record.idempotencyKey);
    const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/submissions?${query}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { items: ChatCommandView[]; nextOffset: number | null };
    if (sessionRef.current !== sid) return;
    setRecords(current => mergeChatCommandViews(current.filter(record => record.targetSessionId === sid || record.local && submitting.current.has(record.idempotencyKey)), body.items));
    setNextOffset(body.nextOffset);
    await Promise.all(body.items.filter(record => !record.operation && record.status === "cancelled").map(record => dismissPendingPrompt(record.idempotencyKey)));
    const completed = body.items.filter(record => record.status === "completed");
    await confirmPendingPrompts(completed.map(record => record.idempotencyKey));
    for (const record of body.items.filter(record => terminal(record.status))) {
      if (notified.current.has(record.commandId)) continue;
      notified.current.add(record.commandId);
      latest.current.onFinished(record);
    }
  }, []);

  useEffect(() => {
    const activeGeneration = ++generation.current;
    setLocalSessionId(null);
    setRecords([]);
    setNextOffset(null);
    setConnectionError(null);
    notified.current.clear();
    return () => { generation.current = activeGeneration + 1; };
  }, [options.conversationKey]);

  useEffect(() => {
    let disposed = false;
    const scope = sessionId ?? options.scope;
    void readPendingPrompts(scope).then(pending => {
      if (disposed) return;
      const recovered = recoverChatCommandViews(pending.filter(record => !submitting.current.has(record.id)), latest.current.catalog, sessionId);
      setRecords(current => mergeChatCommandViews(current, recovered));
    }).catch(() => { if (!disposed) setConnectionError(t("chatCommands.connectionRecovering")); });
    return () => { disposed = true; };
  }, [sessionId, options.scope, t]);

  useEffect(() => {
    if (!sessionId) return;
    const sid = sessionId;
    const source = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events?scope=commands`);
    let disposed = false;
    const recover = () => { void refresh().catch(() => { if (!disposed) setConnectionError(t("chatCommands.connectionRecovering")); }); };
    source.onmessage = event => {
      if (disposed || sessionRef.current !== sid) return;
      try {
        const data = JSON.parse(event.data) as Omit<SessionCommandEvent, "type"> & { operations?: ChatCommandView[]; type: string; hasMore?: boolean };
        if (data.type === "command_snapshot" && data.operations) {
          setRecords(current => mergeChatCommandViews(current.filter(record => record.targetSessionId === sid || record.local && submitting.current.has(record.idempotencyKey)), data.operations!));
          setNextOffset(data.hasMore ? 50 : null);
          setConnectionError(null);
          recover();
        } else if (data.commandId && data.idempotencyKey && data.status) {
          const record: ChatCommandView = { commandId: data.commandId, idempotencyKey: data.idempotencyKey, targetSessionId: sid,
            acceptedAt: data.acceptedAt ?? data.timestamp, status: data.status, revision: data.revision, queuePaused: data.queuePaused, operation: data.operation, errorCode: data.errorCode, errorMessage: data.errorMessage, preview: data.preview };
          setRecords(current => mergeChatCommandViews(current, [record]));
          if (terminal(data.status)) {
            if (!record.operation && !notified.current.has(record.commandId)) { notified.current.add(record.commandId); latest.current.onFinished(record); }
            recover();
          }
        } else if (data.type === "command_stream_error") setConnectionError(t("chatCommands.connectionRecovering"));
      } catch { setConnectionError(t("chatCommands.connectionRecovering")); }
    };
    source.onerror = () => { if (!disposed) { setConnectionError(t("chatCommands.connectionRecovering")); recover(); } };
    const reconcile = () => { if (document.visibilityState !== "hidden") recover(); };
    const timer = setInterval(reconcile, 2500);
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => { disposed = true; source.close(); clearInterval(timer); window.removeEventListener("online", reconcile); document.removeEventListener("visibilitychange", reconcile); };
  }, [sessionId, refresh, t]);

  const submit = useCallback(async (message: string, images: AttachedImage[] = [], files: AttachedFile[] = [], onDurable?: (id?: string) => void, inputOptions: ChatInputOptions = {}, retryOfPromptIds?: string[]) => {
    const initial = latest.current;
    const currentGeneration = generation.current;
    const guard = initial.captureSubmissionGuard?.(initial.sessionId ?? undefined);
    let catalog = initial.catalog;
    let parsed = parseChatInput(message, catalog, { ...inputOptions, hasAttachments: Boolean(images.length || files.length) });
    const id = inputOptions.submissionId ?? crypto.randomUUID();
    const timestamp = Date.now();
    let operation = parsed.kind === "command" ? createChatCommandOperation(message, catalog, parsed, inputOptions) : undefined;
    const draft = { value: message, files: files.map(file => ({ ...file })), images: images.map(({ data, mimeType }) => ({ data, mimeType })), ...(retryOfPromptIds?.length ? { retryOfPromptIds } : {}), commandInput: persistentChatInputOptions(inputOptions) };
    let recovery: PendingPrompt = { id, scope: initial.scope, draft, message: { role: "user", content: message, timestamp, clientPromptId: id, commandSubmission: true, recoveryDraft: draft } };
    let local: ChatCommandView = { commandId: `pending-${id}`, idempotencyKey: id, targetSessionId: initial.sessionId ?? "", acceptedAt: timestamp, status: "accepted", operation, preview: message, local: true };
    const admitted = async (admittedSessionId?: string) => {
      if (generation.current !== currentGeneration) return false;
      if (guard && !await guard(admittedSessionId)) {
        if (generation.current === currentGeneration) setRecords(current => current.map(record => record.idempotencyKey === id && record.local ? { ...record, status: "interrupted" } : record));
        return false;
      }
      return generation.current === currentGeneration;
    };
    submitting.current.add(id);
    setRecords(current => mergeChatCommandViews(current, [local]));
    try {
      await savePendingPrompt(recovery);
      if (generation.current !== currentGeneration) return false;
      onDurable?.(id);
      // The composer may already contain a newer draft. Keep this original
      // submission in its own durable record before any save/network preflight.
      if (!await admitted()) return false;
      if (parsed.kind === "invalid" && parsed.code === "UNKNOWN_COMMAND") {
        catalog = await initial.loadCatalog();
        parsed = parseChatInput(message, catalog, { ...inputOptions, hasAttachments: Boolean(images.length || files.length) });
      }
      if (parsed.kind === "invalid") throw new Error(t(`chatCommands.error.${parsed.code}`, { name: parsed.name }));
      operation = parsed.kind === "command" ? createChatCommandOperation(message, catalog, parsed, inputOptions) : undefined;
      local = { ...local, operation };
      if (!await admitted()) return false;
      setRecords(current => current.map(record => record.idempotencyKey === id && record.local ? { ...record, operation } : record));
      const sid = await initial.ensureSession();
      if (!sid) throw new Error(t("chatCommands.sessionUnavailable"));
      recovery = { ...recovery, scope: sid };
      await savePendingPrompt(recovery);
      if (generation.current !== currentGeneration) return false;
      setLocalSessionId(sid);
      setRecords(current => current.map(record => record.idempotencyKey === id ? { ...record, targetSessionId: sid } : record));
      const materials = await initial.uploadFiles(files.filter(file => !file.path && file.text != null));
      if (operation?.command.source !== "builtin" || operation.afterPrompt || !operation) await initial.connectModelEvents(sid);
      if (!await admitted(sid)) return false;
      const localFiles = files.filter(file => file.path);
      const effectiveMessage = message;
      const receipt = await sendAgentCommand<DispatchReceipt>(sid, { type: "submit_input", message: effectiveMessage, rawText: message, idempotencyKey: id, ...inputOptions,
        ...(localFiles.length ? { localFiles: localFiles.map(({ name, size, path }) => ({ name, size, path })) } : {}),
        ...(parsed.kind === "command" && parsed.command.source !== "builtin" ? { commandKey: parsed.command.key, catalogRevision: catalog.revision } : {}),
        ...(materials.length ? { materials } : {}), ...(images.length ? { images: images.map(({ data, mimeType }) => ({ type: "image", data, mimeType })) } : {}),
      });
      if (generation.current !== currentGeneration) return true;
      setRecords(current => mergeChatCommandViews(current, [{ ...local, commandId: receipt.commandId, targetSessionId: sid, status: receipt.status, local: false }]));
      initial.onAccepted();
      void refresh().catch(() => {});
      return true;
    } catch (error) {
      if (generation.current === currentGeneration) {
        const ambiguous = error instanceof AgentCommandError && (error.status === 0 || error.status >= 500);
        setRecords(current => current.map(record => record.idempotencyKey === id && record.local ? { ...record, status: ambiguous ? "interrupted" : "failed", errorMessage: error instanceof AgentCommandError && error.code ? t(`chatCommands.error.${error.code}`) : error instanceof Error ? error.message : String(error) } : record));
        void refresh().catch(() => {});
      }
      throw error;
    } finally {
      submitting.current.delete(id);
    }
  }, [refresh, t]);

  const cancel = useCallback(async (record: ChatCommandView) => {
    await sendAgentCommand(record.targetSessionId, { type: "cancel_prompt_submission", idempotencyKey: record.idempotencyKey, ...(record.local ? {} : { promptCommandId: record.commandId }) });
    await refresh();
  }, [refresh]);

  const restore = useCallback(async (record: ChatCommandView) => {
    const local = (await readPendingPrompts(record.targetSessionId || latest.current.scope)).find(item => item.id === record.idempotencyKey);
    if (record.local && local) return local.draft;
    const response = await fetch(`/api/sessions/${encodeURIComponent(record.targetSessionId)}/submissions?commandId=${encodeURIComponent(record.commandId)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(t("chatCommands.restoreFailed"));
    return await response.json() as PendingPrompt["draft"];
  }, [t]);

  const queueAction = useCallback(async (record: ChatCommandView, action: "pause" | "resume" | "edit" | "steer" | "cancel", text?: string) => {
    try {
      const updated = await sendAgentCommand<ChatCommandView>(record.targetSessionId, { type: "queued_input_action", commandId: record.commandId, expectedRevision: record.revision, action, ...(text !== undefined ? { text } : {}) });
      if (action === "cancel" && updated.status === "cancelled") await dismissPendingPrompt(record.idempotencyKey);
      if (sessionRef.current === record.targetSessionId) setRecords(current => mergeChatCommandViews(current, [updated]));
      return updated;
    } catch (error) {
      void refresh().catch(() => {});
      throw new Error(error instanceof AgentCommandError && error.code ? t(`chatCommands.error.${error.code}`) : error instanceof Error ? error.message : String(error));
    }
  }, [refresh, t]);

  const edit = useCallback(async (record: ChatCommandView) => {
    const paused = record.queuePaused ? record : await queueAction(record, "pause");
    try {
      const draft = await restore(paused);
      const saved = await hydrateDraft("queue-edit:" + record.commandId);
      return saved?.value ?? (paused.operation?.steps[0]?.status === "completed" && paused.operation.afterPrompt
        ? paused.operation.afterPrompt : draft.value);
    } catch (error) {
      // Undo only the pause owned by this attempt. A restored paused item stays paused.
      if (!record.queuePaused) {
        try { await queueAction(paused, "resume"); }
        catch (resumeError) { throw new Error(t("chatCommands.editRecoveryFailed", { error: String(error), resumeError: String(resumeError) })); }
      }
      throw error;
    }
  }, [queueAction, restore, t]);

  const copy = useCallback(async (record: ChatCommandView) => {
    const action = record.operation?.result?.clientAction;
    if (!action) return;
    const payload = await sendAgentCommand<{ text: string }>(record.targetSessionId, { type: "read_command_client_action", commandId: record.commandId, requestId: action.id });
    await navigator.clipboard.writeText(payload.text);
    await sendAgentCommand(record.targetSessionId, { type: "confirm_command_client_action", commandId: record.commandId, requestId: action.id, success: true });
    await refresh();
  }, [refresh]);

  return { records, connectionError, submit, cancel, restore, queueAction, edit, copy, loadMore: nextOffset === null ? null : () => refresh(nextOffset) };
}
