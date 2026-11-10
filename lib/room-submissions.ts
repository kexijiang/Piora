import { createHash, randomUUID } from "node:crypto";
import { ensureRoomSessionIsolation } from "./room-session-isolation";
import { localRoomUserAuthor } from "./room-local-user";
import { roomMessageAttribution, ROOM_SENDER_AUTHORITY_NOTE } from "./room-sender";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { appendRoomMessage, findRoomMessage, getRoom, readRoomMessageFullContent } from "./room-store";
import { isRoomBroadcast, resolveRoomMentions } from "./room-chat-routing";
import { TeamError } from "./team-errors";
import { isCurrentRoomQuestion } from "./room-question";
import { publishRoomMemberSelection, selectRoomMessageHandler, type RoomSelectionServices } from "./room-member-selection";
import type { RoomAttachment, RoomMention, RoomSubmission } from "./room-types";

export interface RoomSubmissionInput {
  sessionId: string;
  clientPromptId: string;
  content: string;
  intent?: RoomSubmission["intent"];
  mentions?: RoomMention[];
  replyTo?: string;
  attachments?: RoomAttachment[];
}

type SavedSubmission = RoomSubmission & { input: RoomSubmissionInput; requestHash: string; actorMemberId?: string };
declare global {
  var __pioraRoomSubmissionFlights: Map<string, Promise<SavedSubmission>> | undefined;
}
const terminal = new Set(["completed", "cancelled", "failed"]);

function directory(roomId: string): string {
  const path = join(getRoom(roomId).paths.shared, "submissions");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function recordPath(roomId: string, id: string): string {
  return join(directory(roomId), `${createHash("sha256").update(id).digest("hex")}.json`);
}

function readRecord(roomId: string, id: string): SavedSubmission | undefined {
  const path = recordPath(roomId, id);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as SavedSubmission : undefined;
}

function writeRecord(record: SavedSubmission): void {
  record.updatedAt = Date.now();
  const path = recordPath(record.roomId, record.clientPromptId);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flush: true });
  renameSync(temporary, path);
}

export function listRoomSubmissions(roomId: string): RoomSubmission[] {
  return readdirSync(directory(roomId)).filter((name) => name.endsWith(".json")).flatMap((name) => {
    try {
      const { input: _input, requestHash: _hash, ...record } = JSON.parse(readFileSync(join(directory(roomId), name), "utf8")) as SavedSubmission;
      void _input; void _hash;
      return record.roomId === roomId ? [record] : [];
    } catch { return []; }
  }).sort((a, b) => a.createdAt - b.createdAt);
}

async function withSubmissionLock<T>(roomId: string, action: () => Promise<T>): Promise<T> {
  const release = await lockfile.lock(directory(roomId), { realpath: false, stale: 120_000, retries: { retries: 100, minTimeout: 20, maxTimeout: 100 } });
  try { return await action(); } finally { await release(); }
}

async function activeRun(roomId: string) {
  const { getTeamRunStore } = await import("./team-run-store");
  return getTeamRunStore().listTeamRuns(roomId, { includeTerminal: false, limit: 50 }).find((run) => !terminal.has(run.phase));
}

function confirmSubmission(record: SavedSubmission): SavedSubmission {
  record.status = "delivered";
  delete record.error;
  writeRecord(record);
  return record;
}

async function recoverAppliedAnswer(record: SavedSubmission, parentRunId?: string): Promise<boolean> {
  if (record.intent !== "answer" || !parentRunId) return false;
  const { getTeamRunStore } = await import("./team-run-store");
  const events = getTeamRunStore().listTeamRunEvents(record.roomId, parentRunId);
  if (!events.some((entry) => entry.event.type === "run.resumed" && entry.correlationId === `room-answer:${record.messageId}`)) return false;
  record.teamRunId = parentRunId;
  confirmSubmission(record);
  return true;
}

async function deliver(record: SavedSubmission): Promise<SavedSubmission> {
  if (record.intent === "share") return confirmSubmission(record);
  const room = getRoom(record.roomId);
  const message = findRoomMessage(room.id, record.messageId)!;
  const parent = message.replyTo ? findRoomMessage(room.id, message.replyTo) : undefined;
  const parentRunId = parent?.teamRunId ?? /^team:([^:]+):question:/u.exec(parent?.correlationId ?? "")?.[1];
  // A run event may be durable even when the final submission receipt was not.
  if (await recoverAppliedAnswer(record, parentRunId)) return record;
  const contentForAgent = message.attachments?.length
    ? `${readRoomMessageFullContent(room.id, message)}\n\n用户附件（按需使用文件工具读取）：\n${message.attachments.map((file) => JSON.stringify(file)).join("\n")}`
    : readRoomMessageFullContent(room.id, message);
  const current = await activeRun(room.id);
  const { getSessionMessageRouter } = await import("./session-message-router");
  const router = getSessionMessageRouter();
  const { getTeamCoordinatorService } = await import("./team-coordinator-service");
  const service = getTeamCoordinatorService();
  const coordinator = room.members.find((member) => member.memberId === room.coordination.coordinatorMemberId)!;
  if (record.intent === "answer") {
    if (!parentRunId || !parent || !(parent.kind === "question" || parent.correlationId?.includes(":question:"))) {
      throw new TeamError("TEAM_INVALID_INPUT", "请选择要回答的具体问题。");
    }
    if (!current || current.id !== parentRunId || !isCurrentRoomQuestion(parent, current)) throw new TeamError("TEAM_REVISION_CONFLICT", "这个问题已处理，请查看最新任务状态。");
    record.teamRunId = current.id;
    await service.resumeRun(room.id, current.id, readRoomMessageFullContent(room.id, message), parent.id, message.id);
  } else if (record.intent === "new_task") {
    if (current) {
      record.status = "queued";
      writeRecord(record);
      return record;
    }
    const run = await service.createRun({ roomId: room.id, objective: contentForAgent,
      coordinatorMemberId: coordinator.memberId, createdBy: { kind: "user", id: message.author.id }, correlationId: `room:${record.messageId}` });
    record.teamRunId = run.id;
  } else if (current && !message.replyTo) {
    // A supplementary instruction is not an answer and cannot silently resume waiting_user.
    record.teamRunId = current.id;
    const { getTeamRunStore } = await import("./team-run-store");
    const store = getTeamRunStore();
    if (!current.guidance?.some((item) => item.messageId === message.id)) {
      await store.appendTeamRunEvents(room.id, current.id, store.getTeamRun(room.id, current.id).revision, [{ type: "run.guidance_added", messageId: message.id,
        ...(record.targetMemberIds.length ? { memberIds: record.targetMemberIds } : {}) }]);
    }
    const targets = Object.values(current.activeDispatches).filter((dispatch) => ["requested", "accepted", "queued", "running"].includes(dispatch.status)
      && (!record.targetMemberIds.length || record.targetMemberIds.includes(dispatch.memberId)));
    for (const sessionId of [...new Set(targets.map((dispatch) => dispatch.sessionId))]) {
      const { getActivePromptRun } = await import("./prompt-run-registry");
      const prompt = getActivePromptRun(sessionId);
      if (prompt?.roomContext?.roomId !== room.id || !targets.some((dispatch) => dispatch.sessionId === sessionId && (dispatch.promptRunId === prompt.runId || dispatch.dispatchId === prompt.roomContext?.messageId))) continue;
      const receipt = await router.dispatchSessionMessage({ targetSessionId: sessionId, content: `Sender: ${JSON.stringify(roomMessageAttribution(room, message, id => findRoomMessage(room.id, id)))}\n${ROOM_SENDER_AUTHORITY_NOTE}\n用户对当前任务的补充（保持原任务与审查约束）：\n${contentForAgent}`,
        source: "room", roomContext: { roomId: room.id, messageId: message.id }, delivery: "steer", idempotencyKey: `room:${message.id}:${sessionId}:supplement` });
      record.commandIds.push(receipt.commandId);
    }
  } else {
    let targetIds = record.targetMemberIds;
    if (!targetIds.length && parent?.author.kind === "session") {
      const owner = room.members.find((member) => member.binding.sessionId === parent.author.id || member.binding.previousSessionIds?.includes(parent.author.id));
      if (owner) targetIds = [owner.memberId];
    }
    const broadcast = isRoomBroadcast(message.content);
    if (broadcast) targetIds = room.members.map((member) => member.memberId);
    const requested = targetIds.length > 1 && room.coordination.mode === "team" && !broadcast ? [coordinator.memberId] : targetIds.length ? targetIds : [record.memberSelection?.selectedMemberId ?? coordinator.memberId];
    if (requested.some(id => !room.members.some(member => member.memberId === id))) throw new Error("选定成员已离开群聊，请重试原消息。");
    if (!targetIds.length && record.memberSelection?.selectedMemberId) publishRoomMemberSelection(room.id, message.id, record.memberSelection);
    const { dispatchRoomChat } = await import("./room-chat");
    const failedStatuses = new Set(["failed", "cancelled", "expired", "interrupted"]);
    const previousCommands = await Promise.all(record.commandIds.map((id) => router.getCommand(id)));
    const previouslyAccepted = new Set(previousCommands.flatMap((command) => !failedStatuses.has(command.status) ? [command.targetSessionId] : []));
    const remaining = requested.map((id) => room.members.find((member) => member.memberId === id)!.binding.sessionId).filter((id) => !previouslyAccepted.has(id));
    if (!remaining.length) return confirmSubmission(record);
    const result = await dispatchRoomChat(room.id, { messageId: message.id, content: contentForAgent, authorName: "你",
      authorSessionId: record.input.sessionId, targetSessionIds: remaining, clarificationOnly: record.memberSelection?.clarificationOnly,
      replyTo: message.replyTo, correlationId: message.id, attempt: record.commandIds.length + 1, intake: room.coordination.mode === "team" || Boolean(record.memberSelection), maxAutoRounds: broadcast ? 0 : 6,
      delivery: "next_turn" });
    record.commandIds = [...new Set([...record.commandIds, ...result.dispatched.map((item) => item.commandId)])];
    if (result.dispatched.some((item) => ["failed", "cancelled", "expired", "interrupted"].includes(item.status))) throw new Error("成员未能处理这条消息，原文已保留。");
    if (result.skipped.length) throw new Error(result.skipped.map((item) => item.reason).join("；"));
  }
  return confirmSubmission(record);
}

export async function startRoomIntakeTask(roomId: string, sessionId: string, messageId: string, objective: string) {
  return withSubmissionLock(roomId, async () => {
  const room = getRoom(roomId);
  const message = findRoomMessage(roomId, messageId);
  if (!message?.clientPromptId || message.author.kind !== "user" || !room.members.some((member) => member.binding.sessionId === sessionId)) throw new TeamError("TEAM_INVALID_CONTEXT", "只能从当前群聊用户消息建立任务。");
  const record = readRecord(roomId, message.clientPromptId);
  if (record?.memberSelection?.selectedMemberId && !room.members.some(member => member.memberId === record.memberSelection!.selectedMemberId && member.binding.sessionId === sessionId)) throw new TeamError("TEAM_INVALID_CONTEXT", "只有本条消息选定的处理人可以建立任务。");
  if (record?.memberSelection?.clarificationOnly) throw new TeamError("TEAM_INVALID_CONTEXT", "成员均未认领时请先澄清需求，不能直接创建执行任务。");
  const { getTeamCoordinatorService } = await import("./team-coordinator-service");
  const run = await getTeamCoordinatorService().createRun({ roomId, objective, coordinatorMemberId: room.coordination.coordinatorMemberId,
    createdBy: { kind: "user", id: message.author.id }, correlationId: `room:${message.id}` });
  if (record) { record.teamRunId = run.id; writeRecord(record); }
  return run;
  });
}

async function processSubmission(roomId: string, id: string, services?: RoomSelectionServices): Promise<SavedSubmission> {
  const flights = globalThis.__pioraRoomSubmissionFlights ??= new Map();
  const key = recordPath(roomId, id);
  const existing = flights.get(key);
  if (existing) return existing;
  const flight = (async () => {
    const release = await lockfile.lock(recordPath(roomId, id), { realpath: false, stale: 120_000, update: 15_000,
      retries: { retries: 1200, minTimeout: 50, maxTimeout: 250 } });
    try {
      const record = readRecord(roomId, id)!;
      if (record.status === "delivered") return record;
      if (record.status === "queued" && await activeRun(roomId)) return record;
      if (record.status === "error") { record.status = "accepted"; delete record.error; writeRecord(record); }
      try {
        const room = ensureRoomSessionIsolation(roomId);
        const message = findRoomMessage(roomId, record.messageId)!;
        const parent = message.replyTo ? findRoomMessage(roomId, message.replyTo) : undefined;
        const replyOwner = parent?.author.kind === "session" && room.members.some(member => member.binding.sessionId === parent.author.id || member.binding.previousSessionIds?.includes(parent.author.id));
        if (record.intent === "auto" && !record.targetMemberIds.length && !replyOwner && !isRoomBroadcast(message.content)
          && (!await activeRun(roomId) || Boolean(message.replyTo))) {
          record.memberSelection ??= { assessments: [] };
          writeRecord(record);
          const content = readRoomMessageFullContent(roomId, message) + (message.attachments?.length ? `\n附件：${message.attachments.map(file => file.name).join("、")}` : "");
          await selectRoomMessageHandler(roomId, message.id, content, record.memberSelection, () => writeRecord(record), services);
        }
        return await withSubmissionLock(roomId, async () => {
          const latest = readRecord(roomId, id)!;
          try { return await deliver(latest); }
          catch (error) { latest.status = "error"; latest.error = error instanceof Error ? error.message : String(error); writeRecord(latest); return latest; }
        });
      } catch (error) {
        record.status = "error"; record.error = error instanceof Error ? error.message : String(error); writeRecord(record);
        return record;
      }
    } finally { await release(); }
  })();
  flights.set(key, flight);
  try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
}

export async function submitRoomMessage(roomId: string, input: RoomSubmissionInput, services?: RoomSelectionServices, background = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || (input.mentions !== undefined && (!Array.isArray(input.mentions) || input.mentions.some((item) => !item || typeof item.memberId !== "string")))
    || (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.some((item) => !item)))
    || (input.replyTo !== undefined && typeof input.replyTo !== "string")) throw new TeamError("TEAM_INVALID_INPUT", "消息格式无效。");
  const room = getRoom(roomId);
  if (typeof input.content !== "string" || (!input.content.trim() && !input.attachments?.length)
    || typeof input.clientPromptId !== "string" || !/^[\w-]{8,160}$/u.test(input.clientPromptId)) throw new TeamError("TEAM_INVALID_INPUT", "消息内容与发送标识无效。");
  const known = readRecord(roomId, input.clientPromptId);
  const actor = room.members.find((member) => member.binding.sessionId === input.sessionId);
  const receiptActor = known?.actorMemberId ? room.members.find((member) => member.memberId === known.actorMemberId) : undefined;
  // Old execution ids can retry only their exact accepted receipt, while its
  // stable member remains. They cannot authorize a new message after migration.
  if ((!actor && !(receiptActor && known?.input.sessionId === input.sessionId))
    || (known?.actorMemberId && actor && actor.memberId !== known.actorMemberId)) throw new TeamError("TEAM_INVALID_CONTEXT", "你不在这个群聊中。");
  if (Buffer.byteLength(input.content, "utf8") > 256 * 1024) throw new TeamError("TEAM_INPUT_TOO_LARGE", "消息超过 256 KiB。");
  if (input.intent && !["auto", "new_task", "answer", "share"].includes(input.intent)) throw new TeamError("TEAM_INVALID_INPUT", "消息意图无效。");
  if (input.attachments?.length) {
    if (input.attachments.length > 20) throw new TeamError("TEAM_INVALID_INPUT", "每条消息最多附加 20 个文件。");
    const { getAllowedFileRoots, isExistingFilePathAllowed } = await import("./file-access");
    const { getPromptFilesRoot } = await import("./prompt-files");
    const roots = new Set(await getAllowedFileRoots());
    roots.add(getPromptFilesRoot());
    for (const file of input.attachments) {
      if (typeof file.name !== "string" || typeof file.path !== "string" || !isExistingFilePathAllowed(file.path, roots)) throw new TeamError("TEAM_INVALID_INPUT", "附件不存在或不在允许的目录中。");
    }
  }
  const prepared = await withSubmissionLock(roomId, async () => {
    const requestHash = createHash("sha256").update(JSON.stringify({ sessionId: known?.input.sessionId ?? input.sessionId, clientPromptId: input.clientPromptId, content: input.content,
      intent: input.intent ?? "auto", mentions: (input.mentions ?? []).map(({ memberId, start, end }) => ({ memberId, start, end })),
      replyTo: input.replyTo ?? null, attachments: (input.attachments ?? []).map(({ name, path, mimeType }) => ({ name, path, mimeType: mimeType ?? null })) })).digest("hex");
    const saved = readRecord(roomId, input.clientPromptId);
    if (saved && saved.requestHash !== requestHash) throw new TeamError("TEAM_REVISION_CONFLICT", "这个发送标识已用于另一条消息。");
    if (saved?.status === "delivered" || saved?.status === "queued") return { message: findRoomMessage(roomId, saved.messageId), submission: saved };
    const parent = input.replyTo ? findRoomMessage(roomId, input.replyTo) : undefined;
    if (input.replyTo && !parent) throw new TeamError("TEAM_INVALID_INPUT", "回复的消息不存在。");
    const targetMemberIds = resolveRoomMentions(room, input.content, input.mentions);
    const content = input.content || "请查看附件。";
    const message = saved ? findRoomMessage(roomId, saved.messageId)! : appendRoomMessage(roomId, {
      ...localRoomUserAuthor(), content,
      clientPromptId: input.clientPromptId, correlationId: `room-prompt:${input.clientPromptId}`,
      replyTo: input.replyTo, threadRootId: parent ? parent.threadRootId ?? parent.id : undefined,
      targetMemberIds, attachments: input.attachments,
    });
    const record: SavedSubmission = saved ?? { clientPromptId: input.clientPromptId, roomId, messageId: message.id, status: "accepted",
      intent: input.intent ?? "auto", targetMemberIds, commandIds: [], createdAt: message.createdAt, updatedAt: Date.now(), input, requestHash, actorMemberId: actor!.memberId };
    if (!saved || record.status === "error") {
      record.status = "accepted"; delete record.error; writeRecord(record);
    }
    return { message, submission: record };
  });
  if (prepared.submission.status === "delivered" || prepared.submission.status === "queued") return prepared;
  if (background) {
    void processSubmission(roomId, input.clientPromptId, services).catch(() => {});
    return prepared;
  }
  return { message: prepared.message, submission: await processSubmission(roomId, input.clientPromptId, services) };
}

/** Safe to call on reconnect or startup: durable messages and Router keys make replay idempotent. */
export async function drainRoomSubmissions(roomId: string): Promise<void> {
  for (const item of listRoomSubmissions(roomId)) {
    if (item.status !== "accepted" && item.status !== "queued") continue;
    if (item.status === "queued" && await activeRun(roomId)) break;
    const record = await processSubmission(roomId, item.clientPromptId);
    if (record.status === "queued") break;
  }
}
