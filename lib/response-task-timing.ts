import { mergeTaskTiming, type TaskTiming } from "./task-timing";
import type { AgentMessage } from "./types";
import { getDisplayableAssistantBlocks, hasAssistantNotice } from "./message-display";

export interface ResponseTaskTiming {
  idempotencyKey: string;
  taskTiming: TaskTiming;
}

export function mergeResponseTaskTimings(current: ResponseTaskTiming[], incoming: ResponseTaskTiming[]): ResponseTaskTiming[] {
  const records = new Map(current.map(record => [record.taskTiming.commandId, record]));
  for (const record of incoming) {
    const previous = records.get(record.taskTiming.commandId);
    records.set(record.taskTiming.commandId, { ...record, taskTiming: mergeTaskTiming(previous?.taskTiming ?? null, record.taskTiming)! });
  }
  return [...records.values()];
}

/** Bind by durable prompt identity, never by prompt text or the latest timer. */
export function responseTaskTimings(messages: AgentMessage[], records: ResponseTaskTiming[]): Map<number, TaskTiming> {
  const byPrompt = new Map(records.map(record => [record.idempotencyKey, record.taskTiming]));
  const finalReplies = new Map<string, { index: number; timing: TaskTiming }>();
  let active: TaskTiming | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      const matched = message.clientPromptId ? byPrompt.get(message.clientPromptId) : undefined;
      // A steering message can arrive inside the same task. An unrelated or
      // undated prompt must not inherit a previous task's duration.
      const withinTask = active && message.timestamp !== undefined && message.timestamp >= active.startedAt
        && (active.finishedAt === undefined ? !active.outcome : message.timestamp <= active.finishedAt);
      active = matched ?? (withinTask ? active : undefined);
    } else if (message.role === "assistant" && active) {
      if (message.timestamp !== undefined && active.finishedAt !== undefined && message.timestamp > active.finishedAt) {
        active = undefined;
        continue;
      }
      finalReplies.set(active.commandId, { index, timing: active });
    }
  }
  const result = new Map<number, TaskTiming>();
  for (const { index, timing } of finalReplies.values()) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    // ChatHistory splits process blocks from the answer. Only its final answer
    // segment (or a standalone stop/error notice) can actually render a footer.
    const lastBlock = getDisplayableAssistantBlocks(message).at(-1);
    const visible = lastBlock ? lastBlock.type === "text" || lastBlock.type === "image" : hasAssistantNotice(message);
    if (visible) result.set(index, timing);
  }
  return result;
}
