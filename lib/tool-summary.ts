import {
  isBashToolResult,
  isEditToolResult,
  isFindToolResult,
  isGrepToolResult,
  isLsToolResult,
  isReadToolResult,
  isToolCallEventType,
  isWriteToolResult,
  type ToolCallEvent,
  type ToolResultEvent,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.js";

export interface ToolSummary {
  title: string;
  detail?: string;
  icon: string;
  status: "running" | "ok" | "error";
}

export type Translate = (key: string, variables?: Record<string, string | number>) => string;

export interface ToolDisclosureSummary extends ToolSummary {
  subject?: string;
  subjectIsPath?: boolean;
}

/** Structured subjects for the chat header, without parsing localized summaries. */
export function summarizeToolDisclosure(name: string, input: unknown, result: unknown, t: Translate): ToolDisclosureSummary {
  const summary = summarizeToolCall(name, input, result, t);
  const values = isRecord(input) ? input : {};
  if (name === "read" || name === "ls") {
    return { ...summary, title: t(`toolSummary.action.${name}`),
      subject: typeof values.path === "string" ? values.path : name === "ls" ? "." : undefined, subjectIsPath: true };
  }
  if (name === "grep" || name === "find") {
    return { ...summary, title: t(`toolSummary.action.${name}`),
      subject: typeof values.pattern === "string" ? values.pattern : undefined };
  }
  return summary;
}

export function summarizeToolCall(
  name: string,
  input: unknown,
  result: unknown,
  t: Translate,
): ToolSummary {
  const safeName = typeof name === "string" ? name : "";
  const recordInput = isRecord(input) ? input : {};
  const call = { type: "tool_call", toolCallId: "summary", toolName: safeName, input: recordInput } as ToolCallEvent;
  const resultEvent = toResultEvent(safeName, recordInput, result);
  const status = !result ? "running" : resultEvent?.isError ? "error" : "ok";

  if (isToolCallEventType("read", call)) {
    touchResultGuard(resultEvent, isReadToolResult);
    return { title: t("toolSummary.read", { path: call.input.path }), detail: rangeDetail(call.input.offset, call.input.limit, t), icon: "eye", status };
  }
  if (isToolCallEventType("bash", call)) {
    touchResultGuard(resultEvent, isBashToolResult);
    return { title: t("toolSummary.bash"), detail: truncate(call.input.command), icon: "code", status };
  }
  if (isToolCallEventType("edit", call)) {
    const editResult = resultEvent && isEditToolResult(resultEvent) ? resultEvent : null;
    return { title: t("toolSummary.edit", { path: call.input.path }), detail: patchStats(editResult?.details?.patch), icon: "edit", status };
  }
  if (isToolCallEventType("write", call)) {
    touchResultGuard(resultEvent, isWriteToolResult);
    const contentLength = typeof call.input.content === "string" ? call.input.content.length : 0;
    return { title: t("toolSummary.write", { path: call.input.path }), detail: t("toolSummary.characters", { count: contentLength }), icon: "save", status };
  }
  if (isToolCallEventType("grep", call)) {
    touchResultGuard(resultEvent, isGrepToolResult);
    return { title: t("toolSummary.grep", { pattern: call.input.pattern }), detail: call.input.path, icon: "search", status };
  }
  if (isToolCallEventType("find", call)) {
    touchResultGuard(resultEvent, isFindToolResult);
    return { title: t("toolSummary.find", { pattern: call.input.pattern }), detail: call.input.path, icon: "file-search", status };
  }
  if (isToolCallEventType("ls", call)) {
    touchResultGuard(resultEvent, isLsToolResult);
    return { title: t("toolSummary.ls", { path: call.input.path ?? "." }), icon: "folder", status };
  }

  return {
    title: safeName || t("toolSummary.unknown"),
    detail: firstStringValue(recordInput),
    icon: "wrench",
    status,
  };
}

function toResultEvent(name: string, input: Record<string, unknown>, result: unknown): ToolResultEvent | null {
  if (!isRecord(result)) return null;
  return {
    type: "tool_result",
    toolCallId: typeof result.toolCallId === "string" ? result.toolCallId : "summary",
    toolName: name,
    input,
    content: Array.isArray(result.content) ? result.content : [],
    isError: result.isError === true,
    details: result.details,
  } as ToolResultEvent;
}

function touchResultGuard<T extends ToolResultEvent>(event: ToolResultEvent | null, guard: (value: ToolResultEvent) => value is T): T | null {
  return event && guard(event) ? event : null;
}

function patchStats(patch: unknown): string | undefined {
  if (typeof patch !== "string" || !patch) return undefined;
  let added = 0;
  let removed = 0;
  for (const line of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return added || removed ? `+${added} −${removed}` : undefined;
}

function rangeDetail(offset: number | undefined, limit: number | undefined, t: Translate): string | undefined {
  if (offset === undefined && limit === undefined) return undefined;
  return t("toolSummary.range", { offset: offset ?? 1, limit: limit ?? "∞" });
}

function firstStringValue(input: Record<string, unknown>): string | undefined {
  const value = Object.values(input).find((candidate) => typeof candidate === "string") as string | undefined;
  return value ? truncate(value) : undefined;
}

function truncate(value: unknown, max = 120): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
