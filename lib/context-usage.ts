import type { AgentMessage, AssistantMessage, AssistantContentBlock, TextContent, ImageContent } from "./types";
import type { ContextUsage, ContextUsageBreakdown } from "./pi-types";
import { estimateToolDefinitionPromptTokens } from "./tool-definition-budget.ts";

const ESTIMATED_IMAGE_CHARS = 4_800;
const PROJECT_CONTEXT_PATTERN = /(?:\r?\n)*<project_context>[\s\S]*?<\/project_context>(?:\r?\n)*/gi;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateBasicContentChars(content: string | (TextContent | ImageContent)[]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((chars, block) => {
    if (block.type === "text") return chars + block.text.length;
    if (block.type === "image") return chars + ESTIMATED_IMAGE_CHARS;
    return chars;
  }, 0);
}

function estimateAssistantContentChars(content: AssistantContentBlock[]): number {
  return content.reduce((chars, block) => {
    if (block.type === "text") return chars + block.text.length;
    if (block.type === "thinking") return chars + block.thinking.length;
    if (block.type === "image") return chars + ESTIMATED_IMAGE_CHARS;
    if (block.type === "toolCall") {
      return chars + block.toolName.length + safeStringify(block.input).length;
    }
    return chars;
  }, 0);
}

export function estimateMessageTokens(message: AgentMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      chars = estimateBasicContentChars(message.content);
      break;
    case "assistant":
      chars = estimateAssistantContentChars(message.content);
      break;
    case "toolResult":
      chars = estimateBasicContentChars(message.content);
      break;
    case "custom":
      chars = estimateBasicContentChars(message.content);
      break;
    case "bashExecution":
      chars = message.command.length + message.output.length;
      break;
  }
  return Math.ceil(chars / 4);
}

function estimateUnknownMessageTokens(value: unknown): number {
  if (!value || typeof value !== "object") return estimateTextTokens(safeStringify(value));
  const message = value as Record<string, unknown>;
  const content = message.content;
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) {
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return command || output ? estimateTextTokens(command + output) : estimateTextTokens(safeStringify(value));
  }

  let chars = 0;
  for (const candidate of content) {
    if (!candidate || typeof candidate !== "object") {
      chars += safeStringify(candidate).length;
      continue;
    }
    const block = candidate as Record<string, unknown>;
    if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    } else if (typeof block.text === "string") {
      chars += block.text.length;
    } else if (typeof block.thinking === "string") {
      chars += block.thinking.length;
    } else if (block.type === "toolCall") {
      const name = typeof block.toolName === "string" ? block.toolName : typeof block.name === "string" ? block.name : "";
      chars += name.length + safeStringify(block.input ?? block.arguments).length;
    } else {
      chars += safeStringify(block).length;
    }
  }
  return Math.ceil(chars / 4);
}

function reconcileBreakdown(raw: Omit<ContextUsageBreakdown, "otherRuntime">, totalTokens: number | null): ContextUsageBreakdown {
  const rawTotal = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (totalTokens === null || totalTokens <= 0) return { ...raw, otherRuntime: 0 };
  if (rawTotal <= totalTokens) return { ...raw, otherRuntime: totalTokens - rawTotal };
  if (rawTotal === 0) return { ...raw, otherRuntime: totalTokens };

  const entries = Object.entries(raw) as Array<[keyof typeof raw, number]>;
  const scaled = entries.map(([key, value]) => {
    const exact = value * totalTokens / rawTotal;
    return { exact, key, tokens: Math.floor(exact) };
  });
  let remaining = totalTokens - scaled.reduce((sum, entry) => sum + entry.tokens, 0);
  scaled.sort((a, b) => (b.exact - b.tokens) - (a.exact - a.tokens));
  for (let index = 0; index < scaled.length && remaining > 0; index += 1, remaining -= 1) scaled[index].tokens += 1;
  return {
    conversationMessages: scaled.find((entry) => entry.key === "conversationMessages")?.tokens ?? 0,
    otherRuntime: 0,
    projectInstructions: scaled.find((entry) => entry.key === "projectInstructions")?.tokens ?? 0,
    systemPrompt: scaled.find((entry) => entry.key === "systemPrompt")?.tokens ?? 0,
    toolDefinitions: scaled.find((entry) => entry.key === "toolDefinitions")?.tokens ?? 0,
  };
}

export function estimateContextUsageBreakdown(input: {
  messages: readonly unknown[];
  systemPrompt: string;
  tools: readonly unknown[];
  totalTokens: number | null;
}): ContextUsageBreakdown {
  let projectContext = "";
  const baseSystemPrompt = input.systemPrompt.replace(PROJECT_CONTEXT_PATTERN, (match) => {
    projectContext += match;
    return "";
  });
  return reconcileBreakdown({
    conversationMessages: input.messages.reduce<number>((sum, message) => sum + estimateUnknownMessageTokens(message), 0),
    projectInstructions: estimateTextTokens(projectContext),
    systemPrompt: estimateTextTokens(baseSystemPrompt),
    toolDefinitions: estimateToolDefinitionPromptTokens(input.tools as Array<Record<string, unknown>>),
  }, input.totalTokens);
}

export function mergeContextUsageWithEstimate(
  usage: ContextUsage | null,
  estimate: ContextUsage | null,
): ContextUsage | null {
  if (!usage) return estimate;
  if (!estimate || usage.tokens === null || estimate.tokens === null || estimate.tokens <= usage.tokens) return usage;
  const trailingTokens = estimate.tokens - usage.tokens;
  return {
    ...estimate,
    ...(usage.breakdown ? {
      breakdown: {
        ...usage.breakdown,
        conversationMessages: usage.breakdown.conversationMessages + trailingTokens,
      },
    } : {}),
  };
}

function contextTokensFromUsage(message: AssistantMessage): number | null {
  if (message.stopReason === "aborted" || message.stopReason === "error" || !message.usage) return null;
  const { input, output, cacheRead, cacheWrite, totalTokens } = message.usage;
  const tokens = typeof totalTokens === "number" && totalTokens > 0
    ? totalTokens
    : input + output + cacheRead + cacheWrite;
  return tokens > 0 ? tokens : null;
}

export function estimateSessionContextUsage(messages: AgentMessage[], contextWindow: number): ContextUsage | null {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return null;

  let tokens = 0;
  let trailingStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const usageTokens = contextTokensFromUsage(message);
    if (usageTokens === null) continue;
    tokens = usageTokens;
    trailingStart = index + 1;
    break;
  }

  for (let index = trailingStart; index < messages.length; index += 1) {
    tokens += estimateMessageTokens(messages[index]);
  }

  return {
    tokens,
    contextWindow,
    percent: (tokens / contextWindow) * 100,
  };
}
