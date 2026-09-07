import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ThinkingContent,
  ToolCallContent,
} from "./types";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function normalizeToolCallBlock(block: unknown): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
}

const THINKING_BLOCK_TYPES = new Set([
  "analysis",
  "reasoning",
  "reasoning_summary",
  "reasoning_text",
  "summary_text",
  "thought",
  "thought_summary",
  "thinking",
]);

const TAGGED_THINKING_PATTERN = /^\s*<(think|thinking|analysis|reasoning|thought)>\s*([\s\S]*?)(?:\s*<\/\1>\s*([\s\S]*))?$/i;

function collectText(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectText(entry, depth + 1));
  if (!isObject(value)) return [];

  const textKeys = [
    "thinking",
    "reasoning_content",
    "reasoning_text",
    "reasoning",
    "summary_text",
    "text",
    "content",
    "summary",
  ];
  for (const key of textKeys) {
    const extracted = collectText(value[key], depth + 1);
    if (extracted.length > 0) return extracted;
  }
  return [];
}

function normalizeThinkingBlock(block: unknown): ThinkingContent | null {
  if (!isObject(block)) return null;
  const normalizedType = typeof block.type === "string"
    ? block.type.toLocaleLowerCase().replace(/[.-]/g, "_")
    : "";
  const channel = typeof block.channel === "string" ? block.channel.toLocaleLowerCase() : "";
  const isThinkingType = THINKING_BLOCK_TYPES.has(normalizedType);
  const isThinkingChannel = channel === "analysis" || channel === "reasoning" || channel === "thinking";
  if (!isThinkingType && !isThinkingChannel && block.thought !== true) return null;
  const thinking = collectText(block).join("\n");
  if (!thinking && block.type !== "thinking") return null;
  return {
    ...block,
    type: "thinking",
    thinking,
  } as ThinkingContent;
}

/**
 * Some OpenAI-compatible gateways serialize model thinking into the ordinary
 * content string. Only unwrap explicit, leading thinking tags: untagged prose
 * is intentionally left alone because guessing from wording would hide real
 * answers.
 */
function splitTaggedThinking(text: string): AssistantContentBlock[] | null {
  const match = TAGGED_THINKING_PATTERN.exec(text);
  if (!match) return null;
  const thinking = match[2] ?? "";
  const answer = match[3] ?? "";
  const blocks: AssistantContentBlock[] = [{ type: "thinking", thinking }];
  if (answer.trim()) blocks.push({ type: "text", text: answer });
  return blocks;
}

function topLevelThinking(message: Record<string, unknown>): string {
  for (const key of [
    "reasoning_content",
    "reasoningContent",
    "reasoning_text",
    "reasoningText",
    "reasoning",
    "analysis",
    "thinking_content",
    "thinking",
    "thoughts",
  ]) {
    const text = collectText(message[key]).join("\n");
    if (text) return text;
  }
  const details = collectText(message.reasoning_details).join("\n");
  if (details) return details;
  return collectText(message.reasoningDetails).join("\n");
}

function normalizeAssistantContent(message: Record<string, unknown>): AssistantContentBlock[] {
  const rawContent = Array.isArray(message.content)
    ? message.content
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  const normalized: AssistantContentBlock[] = [];

  for (const block of rawContent) {
    const toolCall = normalizeToolCallBlock(block);
    if (toolCall) {
      normalized.push(toolCall);
      continue;
    }
    const thinking = normalizeThinkingBlock(block);
    if (thinking) {
      normalized.push(thinking);
      continue;
    }
    if (isObject(block) && block.type === "text") {
      // Incomplete/provider-shaped text can be an object or null. Never pass
      // it to React as a child while switching from vision to the main model.
      if (typeof block.text !== "string") continue;
      const tagged = splitTaggedThinking(block.text);
      if (tagged) normalized.push(...tagged);
      else normalized.push(block as unknown as AssistantContentBlock);
      continue;
    }
    if (isObject(block)) normalized.push(block as unknown as AssistantContentBlock);
  }

  const providerThinking = topLevelThinking(message);
  if (providerThinking && !normalized.some((block) => block.type === "thinking")) {
    normalized.unshift({ type: "thinking", thinking: providerThinking });
  }
  return normalized;
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  // Non-assistant roles (user, toolResult, bashExecution, custom) are returned
  // unchanged. Assistant normalization is display-only and accepts both Pi's
  // canonical blocks and provider-shaped fallbacks restored from older sessions.
  if (msg.role !== "assistant") return msg;
  const message = msg as AssistantMessage & Record<string, unknown>;
  return { ...msg, content: normalizeAssistantContent(message) } as AgentMessage;
}
