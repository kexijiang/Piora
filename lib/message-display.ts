import type { AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export type ThinkingLoadState =
  | { sourceKey: string; status: "loading" }
  | { sourceKey: string; status: "loaded"; content: string }
  | { sourceKey: string; status: "error"; error: string };

export type ThinkingBlockDisplay =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "content"; content: string }
  | { status: "error"; error: string };

/**
 * Resolve what a thinking block should show from its current Pi message and an
 * optional historical load. The message snapshot is authoritative: once Pi
 * supplies live/full thinking, a stale deferred request must never cover it
 * with a loading or error placeholder.
 */
export function getThinkingBlockDisplay(
  block: ThinkingContent,
  sourceKey: string | null,
  loadState: ThinkingLoadState | null,
): ThinkingBlockDisplay {
  if (!block.deferred) {
    return { status: "content", content: block.thinking };
  }
  if (!sourceKey || loadState?.sourceKey !== sourceKey) {
    return { status: "idle" };
  }
  if (loadState.status === "loading") return { status: "loading" };
  if (loadState.status === "error") return { status: "error", error: loadState.error };
  return { status: "content", content: loadState.content };
}

export function shouldSubscribeToThinkingLoad(
  sourceKey: string,
  loadState: ThinkingLoadState | null,
): boolean {
  return loadState?.sourceKey !== sourceKey || loadState.status !== "loaded";
}

/**
 * Bind one mounted view to a shared historical-thinking request. A loading
 * request may be subscribed to more than once: this is required when the user
 * collapses and reopens a block before the shared promise settles.
 */
export function subscribeToThinkingLoad(
  sourceKey: string,
  request: Promise<string>,
  isCurrentSource: () => boolean,
  onState: (state: ThinkingLoadState) => void,
): () => void {
  let active = true;
  onState({ sourceKey, status: "loading" });
  void request.then((content) => {
    if (active && isCurrentSource()) {
      onState({ sourceKey, status: "loaded", content });
    }
  }).catch((error) => {
    if (active && isCurrentSource()) {
      onState({
        sourceKey,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return () => {
    active = false;
  };
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  // Sessions restored across versions can carry thinking blocks whose text is
  // missing entirely; treat those as non-empty so the block still renders.
  return block.type === "thinking"
    && !block.deferred
    && !options.isStreaming
    && typeof block.thinking === "string"
    && block.thinking.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((block) => !isEmptyThinkingBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage.trim()
    : "";
  return errorMessage || "Unknown provider error";
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

export function hasVisibleToolOutput(blocks: AssistantContentBlock[]): boolean {
  return hasFileMutationBlocks(blocks) || blocks.some((block) => block.type === "toolCall" && /^bash(?:\s|$)/.test(block.toolName));
}

export function hasFileMutationBlocks(blocks: AssistantContentBlock[]): boolean {
  return blocks.some((block) => block.type === "toolCall" && (block.toolName === "edit" || block.toolName === "write"));
}
