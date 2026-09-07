/** Bounded, display-only projection of a member's current room turn. */
export interface RoomActivity {
  sessionId: string;
  runId: string;
  status: "working" | "ended" | "error";
  phase: string;
  text: string;
  thinking: string;
  tools: Array<{ id: string; name: string; status: "running" | "completed" | "error"; input: string; output: string }>;
  browser: boolean;
  startedAt?: number;
  updatedAt: number;
}

type RuntimeMessage = { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; timestamp?: number };
const tail = (value: unknown, limit = 12_000) => typeof value === "string" ? value.slice(-limit) : "";
const blocks = (message?: RuntimeMessage): Array<Record<string, unknown>> => Array.isArray(message?.content) ? message.content : [];
const runtimeMessage = (value: unknown): RuntimeMessage => value && typeof value === "object" ? value as RuntimeMessage : {};

export function projectRoomActivity(input: {
  sessionId: string; runId: string; messages: readonly unknown[];
  streamingMessage?: unknown; pendingToolCalls: ReadonlySet<string>; compacting?: boolean; startedAt?: number;
}): RoomActivity {
  // Never include prompts, system instructions, or previous turns in the room feed.
  let start = input.messages.length;
  while (start > 0 && runtimeMessage(input.messages[start - 1]).role !== "user") start--;
  if (input.startedAt !== undefined && (runtimeMessage(input.messages[start - 1]).timestamp ?? 0) < input.startedAt) start = input.messages.length;
  if (start === 0) start = input.messages.length;
  const recent = input.messages.slice(Math.max(start, input.messages.length - 32)).map(runtimeMessage);
  if (input.streamingMessage && !recent.includes(runtimeMessage(input.streamingMessage))) recent.push(runtimeMessage(input.streamingMessage));
  const results = new Map(recent.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const tools: RoomActivity["tools"] = [];
  let text = "", thinking = "";
  for (const message of recent) {
    if (message.role !== "assistant") continue;
    for (const block of blocks(message)) {
      if (block.type === "text") text = tail(text + tail(block.text));
      if (block.type === "thinking") thinking = tail(thinking + tail(block.thinking));
      if (block.type === "toolCall") {
        const id = String(block.id ?? block.toolCallId ?? "");
        const result = results.get(id);
        tools.push({ id, name: String(block.name ?? block.toolName ?? "tool"),
          status: result ? result.isError ? "error" : "completed" : "running",
          input: tail(JSON.stringify(block.arguments ?? block.input ?? {}), 2_000),
          output: tail(blocks(result).filter((item) => item.type === "text").map((item) => tail(item.text, 2_000)).join("\n"), 2_000),
        });
      }
    }
  }
  const active = tools.filter((tool) => input.pendingToolCalls.has(tool.id));
  return { sessionId: input.sessionId, runId: input.runId, status: "working",
    phase: input.compacting ? "正在整理上下文" : active.length ? `正在使用 ${active.map((tool) => tool.name).join("、")}` : input.streamingMessage ? blocks(runtimeMessage(input.streamingMessage)).at(-1)?.type === "thinking" ? "正在思考" : "正在回复" : "正在处理",
    text, thinking, tools: tools.slice(-12), browser: tools.some((tool) => /browser/i.test(tool.name)),
    startedAt: input.startedAt ?? runtimeMessage(input.messages[start - 1]).timestamp, updatedAt: Date.now() };
}
