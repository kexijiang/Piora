import { randomUUID } from "node:crypto";
import { validateAgentImages } from "./image-attachments";
import { getSessionCommandEventHub, SessionCommandEventHub } from "./session-command-events";
import { getSessionInboxRegistry, SESSION_MESSAGE_TEXT_MAX_BYTES, sessionCommandBytes, type SessionInboxState } from "./session-inbox";
import { getRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import { resolveOrStartRpcSession, SessionRuntimeResolverError } from "./session-runtime-resolver";
import { SessionControlStore } from "./session-control-store";
import {
  deleteTeamExecutionSecret,
  persistTeamExecutionContext,
  resolveTeamExecutionContext,
} from "./team-execution-secrets";
import type {
  AbortReceipt,
  DispatchReceipt,
  PromptCancellationReceipt,
  SessionCommandEvent,
  SessionCommandRecord,
  SessionCommandStatus,
  SessionControlState,
  SessionMessageInput,
  SessionMessageSourceKind,
} from "./session-message-types";

export interface SessionRoutePrincipal {
  kind?: SessionMessageSourceKind;
  allowedSessionIds?: ReadonlySet<string>;
  scopes?: ReadonlySet<string>;
}

export type SessionMessageRouterErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ALLOWED"
  | "SESSION_PROFILE_MISMATCH"
  | "SESSION_FILE_INVALID"
  | "INVALID_SESSION_ID"
  | "SESSION_BUSY"
  | "SESSION_QUEUE_FULL"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_DUPLICATE"
  | "COMMAND_EXPIRED"
  | "STEER_REQUIRES_RUNNING_SESSION"
  | "SESSION_MESSAGE_TOO_LARGE"
  | "INVALID_SESSION_MESSAGE"
  | "RUNTIME_START_FAILED"
  | "RUN_INTERRUPTED"
  | "TEAM_INVALID_CONTEXT"
  | "TEAM_LEASE_INVALID";

export class SessionMessageRouterError extends Error {
  constructor(readonly code: SessionMessageRouterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionMessageRouterError";
  }
}

interface RouterOptions {
  store?: SessionControlStore;
  events?: SessionCommandEventHub;
  resolver?: typeof resolveOrStartRpcSession;
  maxMessageBytes?: number;
  maxConcurrency?: number;
}

const TERMINAL_STATUSES = new Set<SessionCommandStatus>(["completed", "failed", "cancelled", "expired", "interrupted"]);

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function errorCode(error: unknown): SessionMessageRouterErrorCode {
  if (error instanceof SessionMessageRouterError) return error.code;
  if (error instanceof SessionRuntimeResolverError) return error.code === "RUNTIME_START_FAILED" ? "RUNTIME_START_FAILED" : error.code;
  const stableCode = (error as { code?: unknown } | null)?.code;
  if (stableCode === "TEAM_INVALID_CONTEXT" || stableCode === "TEAM_LEASE_INVALID") return stableCode;
  const message = safeErrorMessage(error);
  if (/busy|starting another prompt/i.test(message)) return "SESSION_BUSY";
  if (/queue full/i.test(message)) return "SESSION_QUEUE_FULL";
  return "RUNTIME_START_FAILED";
}

function validateInput(input: SessionMessageInput, maxMessageBytes: number): void {
  if (!input.targetSessionId || typeof input.targetSessionId !== "string") throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "targetSessionId is required.");
  if (!input.idempotencyKey || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length > 512) throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "A bounded idempotency key is required.");
  if (typeof input.content !== "string" || (!input.content.trim() && !input.materials?.length && !input.images?.length)) {
    throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "Message content cannot be empty without prompt materials or images.");
  }
  if (Buffer.byteLength(input.content, "utf8") > maxMessageBytes) {
    throw new SessionMessageRouterError(
      "SESSION_MESSAGE_TOO_LARGE",
      `Message content exceeds the ${Math.floor(maxMessageBytes / 1024)} KiB limit.`,
    );
  }
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now())) throw new SessionMessageRouterError("COMMAND_EXPIRED", "The message expiry is in the past.");
  if (input.teamExecution && input.source !== "room" && input.source !== "system") {
    throw new SessionMessageRouterError("TEAM_INVALID_CONTEXT", "Only the Team runtime may dispatch a Team execution context.");
  }
  if (
    (input.source === "room" && !input.roomContext)
    || (input.roomContext && (
      input.source !== "room"
      || !input.roomContext.roomId?.trim()
      || !input.roomContext.messageId?.trim()
      || input.roomContext.roomId.length > 512
      || input.roomContext.messageId.length > 512
    ))
  ) {
    throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "Room context is valid only for bounded Room messages.");
  }
  const imageError = validateAgentImages(input.images);
  if (imageError) throw new SessionMessageRouterError("SESSION_MESSAGE_TOO_LARGE", imageError);
  if (input.materials !== undefined && (
    !Array.isArray(input.materials)
    || input.materials.length === 0
    || input.materials.length > 8
    || input.materials.some((material) => !material || typeof material.id !== "string" || !/^[0-9a-f-]{36}$/i.test(material.id))
  )) {
    throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "Prompt material references are invalid.");
  }
}

function assertPrincipal(input: SessionMessageInput, principal?: SessionRoutePrincipal): void {
  if (principal?.allowedSessionIds && !principal.allowedSessionIds.has(input.targetSessionId)) {
    throw new SessionMessageRouterError("SESSION_NOT_ALLOWED", "The caller is not allowed to control this Session.");
  }
}

export class SessionMessageRouter {
  private readonly store: SessionControlStore;
  private readonly events: SessionCommandEventHub;
  private readonly resolver: typeof resolveOrStartRpcSession;
  private readonly maxMessageBytes: number;
  private readonly maxConcurrency: number;
  private readonly knownCommands = new Map<string, SessionCommandRecord>();
  private readonly activeCommands = new Map<string, SessionCommandRecord>();
  private readonly wakeSubscriptions = new Map<string, () => void>();
  private readonly pendingSubmissions = new Map<string, Promise<DispatchReceipt>>();
  // Never expire or evict an acknowledged fence: a delayed POST may still arrive.
  // The pending HTTP request cannot survive this router's process lifetime.
  private readonly cancellationIntents = new Set<string>();
  private readonly commandDurability = new Map<string, Promise<void>>();
  private readonly cancellationWork = new Map<string, Promise<PromptCancellationReceipt>>();
  private readonly admissions = new Map<string, { session: AgentSessionWrapper; started: boolean; runId?: string; cancelTerminal?: () => void }>();

  constructor(options: RouterOptions = {}) {
    this.store = options.store ?? new SessionControlStore();
    this.events = options.events ?? getSessionCommandEventHub();
    this.resolver = options.resolver ?? resolveOrStartRpcSession;
    this.maxMessageBytes = Math.max(1_024, Math.min(SESSION_MESSAGE_TEXT_MAX_BYTES, options.maxMessageBytes ?? SESSION_MESSAGE_TEXT_MAX_BYTES));
    this.maxConcurrency = Math.max(1, Math.min(32, options.maxConcurrency ?? 4));
  }

  private inbox(sessionId: string): SessionInboxState {
    return getSessionInboxRegistry().get(sessionId);
  }

  private async ensureLoaded(sessionId: string): Promise<SessionInboxState> {
    const inbox = this.inbox(sessionId);
    if (inbox.loaded) return inbox;
    inbox.loaded = true;
    for (const command of this.store.loadCommands(sessionId)) {
      this.knownCommands.set(command.commandId, command);
      if (TERMINAL_STATUSES.has(command.status)) continue;
      if (command.status === "running") {
        const live = getRpcSession(sessionId);
        if (live?.isAlive() && live.getActivePromptRunId() === command.runId) {
          this.activeCommands.set(sessionId, command);
          continue;
        }
        // After a process restart, an old in-memory run has no authority.
        command.status = "interrupted";
        command.errorCode = "RUN_INTERRUPTED";
        command.errorMessage = "The process stopped before this run could be proven complete.";
        await this.store.appendStatus(command, "interrupted", {
          errorCode: command.errorCode,
          errorMessage: command.errorMessage,
        });
        await this.publish({ type: "command_interrupted", sessionId, commandId: command.commandId, runId: command.runId, status: "interrupted", timestamp: Date.now(), errorCode: "RUN_INTERRUPTED" });
        continue;
      }
      if (command.status === "dispatching") {
        command.status = "queued";
        await this.store.appendStatus(command, "queued", { queuedAt: Date.now() });
      }
      if (command.status === "accepted" || command.status === "queued") {
        try { getSessionInboxRegistry().enqueue(command); } catch { /* a later receipt will report a full inbox */ }
      }
    }
    return inbox;
  }

  private async publish(event: Omit<SessionCommandEvent, "cursor">): Promise<void> {
    await this.events.publish(event).catch((error) => {
      console.error("[pi-web] failed to persist session command event:", safeErrorMessage(error));
    });
  }

  private async transition(command: SessionCommandRecord, status: SessionCommandStatus, patch: Partial<SessionCommandRecord> = {}, eventType?: SessionCommandEvent["type"]): Promise<void> {
    command = this.knownCommands.get(command.commandId) ?? command;
    if ((TERMINAL_STATUSES.has(command.status) && command.status !== status)
      || (this.cancellationWork.has(command.commandId) && !TERMINAL_STATUSES.has(status))) return;
    command.status = status;
    Object.assign(command, patch);
    this.knownCommands.set(command.commandId, command);
    await this.store.appendStatus(command, status, patch);
    const latest = this.knownCommands.get(command.commandId) ?? command;
    if (TERMINAL_STATUSES.has(latest.status) && latest.status !== status) {
      // A delayed persistence operation must not become the journal's last row
      // after cancellation has already settled the canonical record.
      await this.store.appendStatus(latest, latest.status);
      return;
    }
    await this.publish({
      type: eventType ?? `command_${status}` as SessionCommandEvent["type"],
      sessionId: command.targetSessionId,
      commandId: command.commandId,
      runId: command.runId,
      attachedRunId: command.attachedRunId,
      status,
      timestamp: Date.now(),
      ...(command.errorCode ? { errorCode: command.errorCode } : {}),
      ...(command.errorMessage ? { errorMessage: command.errorMessage } : {}),
    });
    if (TERMINAL_STATUSES.has(status) && command.teamExecution) {
      try { deleteTeamExecutionSecret(command.teamExecution); }
      catch (error) { console.error("[pi-web] failed to remove Team execution secret:", safeErrorMessage(error)); }
    }
  }

  private makeRecord(input: SessionMessageInput): SessionCommandRecord {
    const now = Date.now();
    return {
      commandId: `cmd_${randomUUID()}`,
      idempotencyKey: input.idempotencyKey,
      targetSessionId: input.targetSessionId,
      content: input.content,
      delivery: input.delivery ?? "next_turn",
      source: input.source,
      ...(input.roomContext ? { roomContext: input.roomContext } : {}),
      acceptedAt: now,
      queuedAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      status: "accepted",
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.materials?.length ? { materials: input.materials } : {}),
      ...(input.teamExecution ? { teamExecution: persistTeamExecutionContext(input.teamExecution) } : {}),
    };
  }

  async dispatchSessionMessage(input: SessionMessageInput, principal?: SessionRoutePrincipal): Promise<DispatchReceipt> {
    validateInput(input, this.maxMessageBytes);
    assertPrincipal(input, principal);
    if (input.delivery === "steer") {
      return this.steerSession(input, principal);
    }
    const key = this.submissionKey(input.targetSessionId, input.idempotencyKey);
    const pending = this.pendingSubmissions.get(key);
    if (pending) return { ...await pending, idempotent: true };
    const operation = this.admitSubmission(input);
    this.pendingSubmissions.set(key, operation);
    try { return await operation; }
    finally { if (this.pendingSubmissions.get(key) === operation) this.pendingSubmissions.delete(key); }
  }

  private submissionKey(sessionId: string, idempotencyKey: string): string {
    return JSON.stringify([sessionId, idempotencyKey]);
  }

  private submissionCommand(sessionId: string, idempotencyKey: string): SessionCommandRecord | undefined {
    const known = [...this.knownCommands.values()].find(command => command.targetSessionId === sessionId && command.idempotencyKey === idempotencyKey);
    if (known) return known;
    const stored = this.store.findByIdempotencyKey(idempotencyKey, sessionId);
    if (stored) this.knownCommands.set(stored.commandId, stored);
    return stored;
  }

  private isCancelled(command: SessionCommandRecord): boolean {
    const canonical = this.knownCommands.get(command.commandId) ?? command;
    return canonical.status === "cancelled" || this.cancellationWork.has(command.commandId)
      || this.cancellationIntents.has(this.submissionKey(command.targetSessionId, command.idempotencyKey));
  }

  private async admitSubmission(input: SessionMessageInput): Promise<DispatchReceipt> {
    const key = this.submissionKey(input.targetSessionId, input.idempotencyKey);
    const existing = this.submissionCommand(input.targetSessionId, input.idempotencyKey);
    if (existing) {
      if (this.cancellationIntents.has(key)) await this.cancelRecord(existing);
      if (!TERMINAL_STATUSES.has(existing.status)) void this.drain(existing.targetSessionId);
      return {
        accepted: true,
        commandId: existing.commandId,
        sessionId: existing.targetSessionId,
        status: existing.status,
        ...(existing.runId ? { runId: existing.runId } : {}),
        ...(existing.attachedRunId ? { attachedRunId: existing.attachedRunId } : {}),
        idempotent: true,
      };
    }

    try {
      await this.resolver(input.targetSessionId);
    } catch (error) {
      const code = errorCode(error);
      throw new SessionMessageRouterError(code, code === "SESSION_NOT_FOUND" ? "Session not found." : safeErrorMessage(error), { cause: error });
    }
    await this.ensureLoaded(input.targetSessionId);
    const command = this.makeRecord(input);
    this.knownCommands.set(command.commandId, command);
    let commandPersisted = false;
    try {
      const durability = this.store.appendCommand(command);
      this.commandDurability.set(command.commandId, durability);
      try { await durability; }
      finally { this.commandDurability.delete(command.commandId); }
      commandPersisted = true;
      await this.publish({ type: "command_accepted", sessionId: command.targetSessionId, commandId: command.commandId, status: "accepted", timestamp: command.acceptedAt });
      if (this.isCancelled(command)) {
        await this.cancelRecord(command);
        return { accepted: true, commandId: command.commandId, sessionId: command.targetSessionId, status: "cancelled" };
      }
      const position = getSessionInboxRegistry().enqueue(command).position;
      await this.transition(command, "queued", { queuedAt: Date.now() }, "command_queued");
      if (this.isCancelled(command)) {
        await this.cancelRecord(command);
        return { accepted: true, commandId: command.commandId, sessionId: command.targetSessionId, status: "cancelled" };
      }
      void this.drain(input.targetSessionId);
      return { accepted: true, commandId: command.commandId, sessionId: command.targetSessionId, status: "queued", queuePosition: position };
    } catch (error) {
      const code = /full|too large/i.test(safeErrorMessage(error)) ? (safeErrorMessage(error).includes("large") ? "SESSION_MESSAGE_TOO_LARGE" : "SESSION_QUEUE_FULL") : "RUNTIME_START_FAILED";
      getSessionInboxRegistry().removeCommand(command.targetSessionId, command.commandId);
      if (commandPersisted && !this.isCancelled(command) && !TERMINAL_STATUSES.has(command.status)) {
        // The original must be durable before admission, but a rejected inbox
        // admission must also be terminal so recovery cannot replay it.
        await this.transition(command, "failed", { errorCode: code, errorMessage: safeErrorMessage(error) }, "command_failed");
      }
      throw new SessionMessageRouterError(code, code === "SESSION_QUEUE_FULL" ? "Session inbox is full." : safeErrorMessage(error), { cause: error });
    }
  }

  async dispatchManySessionMessages(inputs: SessionMessageInput[], options: { maxConcurrency?: number; principal?: SessionRoutePrincipal } = {}): Promise<DispatchReceipt[]> {
    const results: DispatchReceipt[] = [];
    const limit = Math.max(1, Math.min(this.maxConcurrency, Math.floor(options.maxConcurrency ?? this.maxConcurrency)));
    let next = 0;
    const worker = async () => {
      while (next < inputs.length) {
        const index = next++;
        try { results[index] = await this.dispatchSessionMessage(inputs[index], options.principal); }
        catch (error) {
          results[index] = { accepted: true, commandId: "", sessionId: inputs[index].targetSessionId, status: "failed", ...(error instanceof SessionMessageRouterError ? { errorCode: error.code } : {}) } as DispatchReceipt;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, () => worker()));
    return results;
  }

  async steerSession(input: Omit<SessionMessageInput, "delivery">, principal?: SessionRoutePrincipal): Promise<DispatchReceipt> {
    const message = { ...input, delivery: "steer" as const };
    validateInput(message, this.maxMessageBytes);
    assertPrincipal(message, principal);
    const existing = this.store.findByIdempotencyKey(input.idempotencyKey, input.targetSessionId);
    if (existing) return { accepted: true, commandId: existing.commandId, sessionId: existing.targetSessionId, status: existing.status, attachedRunId: existing.attachedRunId, idempotent: true };
    const session = (await this.getLiveSession(input.targetSessionId));
    if (!session.isRunning() || !session.getActivePromptRunId()) throw new SessionMessageRouterError("STEER_REQUIRES_RUNNING_SESSION", "Steer requires a running Session.");
    const command = this.makeRecord(message);
    command.delivery = "steer";
    command.attachedRunId = session.getActivePromptRunId();
    await this.store.appendCommand(command);
    await this.transition(command, "dispatching", { attachedRunId: command.attachedRunId }, "command_dispatching");
    try {
      await session.send({ type: "steer", message: input.content, images: input.images, commandId: command.commandId });
      await this.transition(command, "delivered", { attachedRunId: command.attachedRunId }, "command_delivered");
      await this.transition(command, "completed", {}, "command_completed");
      return { accepted: true, commandId: command.commandId, sessionId: input.targetSessionId, status: "completed", attachedRunId: command.attachedRunId };
    } catch (error) {
      command.errorCode = errorCode(error);
      command.errorMessage = safeErrorMessage(error);
      await this.transition(command, "failed", {}, "command_failed");
      throw new SessionMessageRouterError(command.errorCode as SessionMessageRouterErrorCode, "Steer could not be delivered.", { cause: error });
    }
  }

  async followUpSession(input: Omit<SessionMessageInput, "delivery">, principal?: SessionRoutePrincipal): Promise<DispatchReceipt> {
    const message = { ...input, delivery: "steer" as const };
    validateInput(message, this.maxMessageBytes);
    assertPrincipal(message, principal);
    const session = await this.getLiveSession(input.targetSessionId);
    if (!session.isRunning() || !session.getActivePromptRunId()) throw new SessionMessageRouterError("SESSION_BUSY", "Follow-up requires a running Session.");
    const command = this.makeRecord(message);
    command.attachedRunId = session.getActivePromptRunId();
    await this.store.appendCommand(command);
    await this.transition(command, "dispatching", { attachedRunId: command.attachedRunId }, "command_dispatching");
    try {
      await session.send({ type: "follow_up", message: input.content, images: input.images, commandId: command.commandId });
      await this.transition(command, "delivered", {}, "command_delivered");
      return { accepted: true, commandId: command.commandId, sessionId: input.targetSessionId, status: "delivered", attachedRunId: command.attachedRunId };
    } catch (error) {
      command.errorCode = errorCode(error);
      command.errorMessage = safeErrorMessage(error);
      await this.transition(command, "failed", {}, "command_failed");
      throw new SessionMessageRouterError(command.errorCode as SessionMessageRouterErrorCode, "Follow-up could not be delivered.", { cause: error });
    }
  }

  private async getLiveSession(sessionId: string): Promise<AgentSessionWrapper> {
    const live = getRpcSession(sessionId);
    if (!live?.isAlive()) {
      const path = await resolveSessionPath(sessionId);
      if (!path) throw new SessionMessageRouterError("SESSION_NOT_FOUND", "Session not found.");
      throw new SessionMessageRouterError("STEER_REQUIRES_RUNNING_SESSION", "The target Session is not running.");
    }
    return live;
  }

  private watchForIdle(sessionId: string, session: AgentSessionWrapper): void {
    if (this.wakeSubscriptions.has(sessionId)) return;
    const unsubscribe = session.onEvent((event) => {
      if (["prompt_done", "prompt_error", "agent_end", "session_idle"].includes(event.type)) {
        void this.drain(sessionId);
      }
    });
    this.wakeSubscriptions.set(sessionId, () => {
      unsubscribe();
      this.wakeSubscriptions.delete(sessionId);
    });
  }

  private waitForTerminal(session: AgentSessionWrapper, command: SessionCommandRecord): {
    promise: Promise<"completed" | "failed" | "interrupted" | "cancelled">;
    cancel: () => void;
  } {
    let cancel = () => {};
    const promise = new Promise<"completed" | "failed" | "interrupted" | "cancelled">((resolve) => {
      let settled = false;
      const finish = (status: "completed" | "failed" | "interrupted" | "cancelled") => {
        if (settled) return;
        settled = true;
        unsubscribe();
        removeDestroy?.();
        resolve(status);
      };
      cancel = () => finish("interrupted");
      const unsubscribe = session.onEvent((event) => {
        if (event.commandId !== command.commandId && (!command.runId || event.runId !== command.runId)) return;
        if (event.type === "prompt_started" && typeof event.runId === "string") {
          command.runId = event.runId;
          const admission = this.admissions.get(command.commandId);
          if (admission?.session === session) admission.runId = event.runId;
        }
        const cancelled = this.isCancelled(command);
        if (event.type === "prompt_done") finish(cancelled ? "cancelled" : "completed");
        else if (event.type === "prompt_error") {
          if (typeof event.errorMessage === "string") command.errorMessage = safeErrorMessage(event.errorMessage);
          finish(cancelled ? "cancelled" : "failed");
        }
      });
      const removeDestroy = session.onDestroy(() => finish(this.isCancelled(command) ? "cancelled" : "interrupted"));
    });
    return { promise, cancel: () => cancel() };
  }

  private async drain(sessionId: string): Promise<void> {
    const inbox = this.inbox(sessionId);
    if (inbox.draining) return inbox.drainPromise;
    inbox.draining = true;
    const run = (async () => {
      await this.ensureLoaded(sessionId);
      while (inbox.queue.length > 0) {
        const command = inbox.queue[0];
        if (!command) break;
        if (this.isCancelled(command)) {
          getSessionInboxRegistry().removeCommand(sessionId, command.commandId);
          await this.cancelRecord(command);
          continue;
        }
        if (command.expiresAt !== undefined && command.expiresAt <= Date.now()) {
          getSessionInboxRegistry().shift(inbox);
          command.errorCode = "COMMAND_EXPIRED";
          command.errorMessage = "The command expired before delivery.";
          await this.transition(command, "expired", {}, "command_expired");
          continue;
        }
        let session: AgentSessionWrapper;
        try {
          session = (await this.resolver(sessionId)).session;
        } catch (error) {
          if (this.isCancelled(command)) continue;
          const code = errorCode(error);
          if (code === "SESSION_BUSY") return;
          getSessionInboxRegistry().shift(inbox);
          command.errorCode = code;
          command.errorMessage = safeErrorMessage(error);
          await this.transition(command, "failed", {}, "command_failed");
          continue;
        }
        if (this.isCancelled(command)) continue;
        if (session.isRunning()) {
          this.watchForIdle(sessionId, session);
          return;
        }
        getSessionInboxRegistry().removeCommand(sessionId, command.commandId);
        const admission: { session: AgentSessionWrapper; started: boolean; runId?: string; cancelTerminal?: () => void } = { session, started: false };
        this.admissions.set(command.commandId, admission);
        await this.transition(command, "dispatching", {}, "command_dispatching");
        if (this.isCancelled(command)) {
          await this.cancelRecord(command);
          this.admissions.delete(command.commandId);
          continue;
        }
        const terminal = this.waitForTerminal(session, command);
        admission.cancelTerminal = terminal.cancel;
        try {
          const teamExecution = command.teamExecution ? resolveTeamExecutionContext(command.teamExecution) : undefined;
          // No await between the canonical fence and the actual wrapper call.
          if (this.isCancelled(command)) { terminal.cancel(); continue; }
          admission.started = true;
          this.activeCommands.set(sessionId, command);
          const started = await session.startTrackedPrompt({
            commandId: command.commandId,
            ...(command.source === "ui" ? { clientPromptId: command.idempotencyKey } : {}),
            source: command.source,
            roomContext: command.roomContext,
            message: command.content,
            images: command.images,
            materials: command.materials,
            teamExecution,
          });
          command.runId = started.runId;
          admission.runId = started.runId;
          if (this.isCancelled(command)) await this.cancelRecord(command);
          else {
            await this.publish({ type: "prompt_started", sessionId, commandId: command.commandId, runId: started.runId, timestamp: Date.now() });
            await this.transition(command, "delivered", { runId: started.runId }, "command_delivered");
            await this.transition(command, "running", { runId: started.runId }, "command_running");
          }
        } catch (error) {
          terminal.cancel();
          this.admissions.delete(command.commandId);
          if (this.activeCommands.get(sessionId)?.commandId === command.commandId) this.activeCommands.delete(sessionId);
          if (this.isCancelled(command)) { await this.cancelRecord(command); continue; }
          const code = errorCode(error);
          if (code === "SESSION_BUSY") {
            inbox.queue.unshift(command);
            inbox.queuedBytes += sessionCommandBytes(command);
            await this.transition(command, "queued", { queuedAt: Date.now() }, "command_queued");
            this.watchForIdle(sessionId, session);
            return;
          }
          command.errorCode = code;
          command.errorMessage = safeErrorMessage(error);
          await this.transition(command, "failed", {}, "command_failed");
          continue;
        }
        const terminalStatus = await terminal.promise;
        const status = this.isCancelled(command) ? "cancelled" : terminalStatus;
        this.admissions.delete(command.commandId);
        if (this.activeCommands.get(sessionId)?.commandId === command.commandId) this.activeCommands.delete(sessionId);
        if (status === "completed") {
          await this.transition(command, "completed", {}, "command_completed");
          await this.publish({ type: "prompt_done", sessionId, commandId: command.commandId, runId: command.runId, timestamp: Date.now() });
        } else if (status === "cancelled") {
          await this.publish({ type: "prompt_error", sessionId, commandId: command.commandId, runId: command.runId, timestamp: Date.now(), errorCode: "COMMAND_CANCELLED" });
          await this.transition(command, "cancelled", {}, "command_cancelled");
        }
        else if (status === "interrupted") {
          command.errorCode = "RUN_INTERRUPTED";
          command.errorMessage = "The target runtime stopped before completion.";
          await this.publish({ type: "prompt_error", sessionId, commandId: command.commandId, runId: command.runId, timestamp: Date.now(), errorCode: "RUN_INTERRUPTED" });
          await this.transition(command, "interrupted", {}, "command_interrupted");
        } else {
          command.errorCode = "PROMPT_ERROR";
          await this.publish({ type: "prompt_error", sessionId, commandId: command.commandId, runId: command.runId, timestamp: Date.now(), errorCode: command.errorCode, errorMessage: command.errorMessage });
          await this.transition(command, "failed", {}, "command_failed");
        }
      }
      this.wakeSubscriptions.get(sessionId)?.();
    })();
    inbox.drainPromise = run;
    await run.catch((error) => {
      console.error("[pi-web] session inbox drain failed:", safeErrorMessage(error));
    }).finally(() => {
      inbox.draining = false;
      inbox.drainPromise = undefined;
    });
  }

  async abortSessionRun(input: { targetSessionId: string; idempotencyKey?: string }, principal?: SessionRoutePrincipal): Promise<AbortReceipt> {
    assertPrincipal({ targetSessionId: input.targetSessionId, content: "", source: "system", idempotencyKey: input.idempotencyKey ?? "abort" }, principal);
    const session = getRpcSession(input.targetSessionId);
    const command = this.activeCommands.get(input.targetSessionId);
    if (!session?.isAlive()) {
      if (!await resolveSessionPath(input.targetSessionId)) throw new SessionMessageRouterError("SESSION_NOT_FOUND", "Session not found.");
      return { accepted: true, sessionId: input.targetSessionId, status: "idle" };
    }
    const runId = session.getActivePromptRunId();
    if (!session.isRunning() && !runId) return { accepted: true, sessionId: input.targetSessionId, status: "idle" };
    if (command) {
      command.status = "cancelled";
      await this.transition(command, "cancelled", {}, "command_cancelled");
    }
    await session.send({ type: "abort", commandId: command?.commandId });
    return { accepted: true, sessionId: input.targetSessionId, status: command ? "cancelled" : "interrupted", ...(command?.commandId ? { commandId: command.commandId } : {}), ...(runId ? { runId } : {}) };
  }

  async cancelCommand(commandId: string, principal?: SessionRoutePrincipal): Promise<AbortReceipt> {
    const command = this.canonicalCommand(commandId);
    assertPrincipal({ targetSessionId: command.targetSessionId, content: "", source: "system", idempotencyKey: command.idempotencyKey }, principal);
    const receipt = await this.cancelRecord(command);
    return { ...receipt, status: receipt.status === "cancelled" || receipt.status === "interrupted" ? receipt.status : "idle" };
  }

  async cancelPromptSubmission(input: { targetSessionId: string; idempotencyKey: string; promptCommandId?: string }, principal?: SessionRoutePrincipal): Promise<PromptCancellationReceipt> {
    if (typeof input.targetSessionId !== "string" || !input.targetSessionId.trim() || input.targetSessionId.length > 512
      || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 512
      || (input.promptCommandId !== undefined && !/^cmd_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.promptCommandId))) {
      throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "A bounded original submission identity is required.");
    }
    assertPrincipal({ targetSessionId: input.targetSessionId, content: "", source: "ui", idempotencyKey: input.idempotencyKey }, principal);
    let command = this.submissionCommand(input.targetSessionId, input.idempotencyKey);
    if (input.promptCommandId) {
      command = this.canonicalCommand(input.promptCommandId);
    }
    if (command) {
      if (command.targetSessionId !== input.targetSessionId || command.idempotencyKey !== input.idempotencyKey || command.delivery !== "next_turn") {
        throw new SessionMessageRouterError("INVALID_SESSION_MESSAGE", "The command does not match this prompt submission.");
      }
      return this.cancelRecord(command);
    }
    const key = this.submissionKey(input.targetSessionId, input.idempotencyKey);
    if (!this.cancellationIntents.has(key) && this.cancellationIntents.size >= 256) {
      throw new SessionMessageRouterError("SESSION_QUEUE_FULL", "Pending prompt cancellation capacity is full.");
    }
    this.cancellationIntents.add(key);
    // A resolver may still be blocked before a real command exists. The fence
    // is already effective; do not make Stop wait for that original POST.
    return { accepted: true, sessionId: input.targetSessionId, status: "cancellation_pending" };
  }

  private cancelRecord(command: SessionCommandRecord): Promise<PromptCancellationReceipt> {
    command = this.knownCommands.get(command.commandId) ?? command;
    const existing = this.cancellationWork.get(command.commandId);
    if (existing) return existing;
    const key = this.submissionKey(command.targetSessionId, command.idempotencyKey);
    if (TERMINAL_STATUSES.has(command.status)) {
      this.cancellationIntents.delete(key);
      return Promise.resolve({ accepted: true, sessionId: command.targetSessionId, status: command.status, commandId: command.commandId, ...(command.runId ? { runId: command.runId } : {}) });
    }
    const priorStatus = command.status;
    getSessionInboxRegistry().removeCommand(command.targetSessionId, command.commandId);
    // Canonical mutation happens synchronously, before journal waits or SDK calls.
    command.status = "cancelled";
    this.knownCommands.set(command.commandId, command);
    const admission = this.admissions.get(command.commandId);
    const active = this.activeCommands.get(command.targetSessionId);
    const session = admission?.session ?? getRpcSession(command.targetSessionId);
    const runId = admission?.runId ?? command.runId;
    let abort: Promise<{ value?: unknown; error?: unknown }> | undefined;
    const ownsAdmission = admission?.started === true && active?.commandId === command.commandId;
    const ownsRun = active?.commandId === command.commandId && !!runId && session?.getActivePromptRunId() === runId;
    const pendingAdmission = ownsAdmission && !runId && !session?.getActivePromptRunId() && !session?.isRunning();
    if (session?.isAlive() && (ownsRun || pendingAdmission)) {
      // AgentSessionWrapper.send(abort) signals abortGeneration synchronously.
      // No await can admit a newer run between identity check and this call.
      abort = session.send({ type: "abort", commandId: command.commandId, ...(runId ? { runId } : {}) })
        .then(value => ({ value }), error => ({ error }));
    } else if (priorStatus === "running" || priorStatus === "delivered" || ownsAdmission) {
      command.status = "interrupted";
      // The runtime no longer belongs to this old command. Settle only its
      // router waiter rather than waiting for, or aborting, the newer run.
      admission?.cancelTerminal?.();
    }
    const cancellation = (async (): Promise<PromptCancellationReceipt> => {
      await this.commandDurability.get(command.commandId);
      await this.transition(command, command.status, {}, command.status === "interrupted" ? "command_interrupted" : "command_cancelled");
      const outcome = await abort;
      if (outcome && Object.hasOwn(outcome, "error")) throw outcome.error;
      const result = outcome?.value as { queuedMessages?: { id?: unknown; steering?: unknown; followUp?: unknown } } | undefined;
      const queued = result?.queuedMessages;
      const queuedMessages = queued && typeof queued.id === "string" && Array.isArray(queued.steering) && Array.isArray(queued.followUp)
        && queued.steering.every(item => typeof item === "string") && queued.followUp.every(item => typeof item === "string")
        ? { id: queued.id, steering: queued.steering as string[], followUp: queued.followUp as string[] } : undefined;
      this.cancellationIntents.delete(key);
      return { accepted: true, sessionId: command.targetSessionId, status: command.status, commandId: command.commandId,
        ...(runId ? { runId } : {}), ...(queuedMessages ? { queuedMessages } : {}) };
    })();
    // Failed journal/SDK work remains a failed receipt on retry. Clearing this
    // cache would turn an unproven canonical terminal into a false success or
    // issue a second generic abort against a newer run.
    this.cancellationWork.set(command.commandId, cancellation);
    return cancellation;
  }

  async getState(sessionId: string): Promise<SessionControlState> {
    const inbox = await this.ensureLoaded(sessionId);
    const session = getRpcSession(sessionId)?.isAlive() ? getRpcSession(sessionId) : undefined;
    if (!session && !await resolveSessionPath(sessionId)) throw new SessionMessageRouterError("SESSION_NOT_FOUND", "Session not found.");
    const live = this.activeCommands.get(sessionId);
    const snapshot = session?.getTaskRuntimeSnapshot();
    return {
      sessionId,
      runtime: snapshot?.runtime ?? "idle",
      ...(live?.commandId ? { activeCommandId: live.commandId } : {}),
      ...(live?.runId ? { activeRunId: live.runId } : {}),
      queueLength: inbox.queue.length,
      attention: snapshot?.pendingApproval ? "needs_approval" : snapshot?.lastPromptFailed ? "failed" : "none",
      pendingApproval: snapshot?.pendingApproval ?? false,
      ...(snapshot?.errorSummary ? { lastFailureSummary: snapshot.errorSummary } : {}),
    };
  }

  async getCommand(commandId: string): Promise<SessionCommandRecord> {
    return { ...this.canonicalCommand(commandId) };
  }

  private canonicalCommand(commandId: string): SessionCommandRecord {
    const known = this.knownCommands.get(commandId);
    if (known) return known;
    const found = this.store.findByCommandId(commandId);
    if (!found) throw new SessionMessageRouterError("COMMAND_NOT_FOUND", "Command not found.");
    this.knownCommands.set(commandId, found);
    return found;
  }

  listEvents(sessionId: string, afterCursor = 0): SessionCommandEvent[] {
    return this.events.list(sessionId, afterCursor);
  }

  /** Resume persisted accepted/queued inbox work after process startup. */
  async resumeSession(sessionId: string): Promise<void> {
    await this.ensureLoaded(sessionId);
    await this.drain(sessionId);
  }

  subscribeEvents(sessionId: string, listener: (event: SessionCommandEvent) => void): () => void {
    return this.events.subscribe(sessionId, listener);
  }
}

declare global {
  var __pioraSessionMessageRouter: SessionMessageRouter | undefined;
}

export function getSessionMessageRouter(): SessionMessageRouter {
  return globalThis.__pioraSessionMessageRouter ??= new SessionMessageRouter();
}

export function resetSessionMessageRouterForTests(): void {
  globalThis.__pioraSessionMessageRouter = undefined;
}
