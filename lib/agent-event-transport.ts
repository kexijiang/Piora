/** Browser transport; the SDK and extension event contract stays unchanged. */
type Event = { type: string; [key: string]: unknown };
type Message = { role: string; content: Array<Record<string, unknown>>; [key: string]: unknown };
type Delta = { type: "message_delta"; index: number; field: "text" | "thinking"; delta: string };
type BlockUpdate = { type: "message_block"; index: number; block: Record<string, unknown> };

export function createAgentEventTransport(write: (event: Event) => void, options: { incremental?: boolean; intervalMs?: number } = {}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Delta | BlockUpdate | undefined;
  let lengths = new Map<number, number>();
  let hasSnapshot = false;
  let closed = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (pending && !closed) write(pending);
    pending = undefined;
  };
  const snapshot = (message: Message) => {
    hasSnapshot = true;
    lengths = new Map(message.content.map((block, index) => [index, String(block.text ?? block.thinking ?? "").length]));
  };
  return {
    push(event: Event) {
      if (closed) return;
      if (!options.incremental) { write(event); return; }
      const message = event.message as Message | undefined;
      const update = event.assistantMessageEvent as { type: string; contentIndex: number; delta?: string } | undefined;
      if (event.type === "message_update" && message?.role === "assistant" && Array.isArray(message.content) && hasSnapshot && update) {
        const index = update.contentIndex;
        const block = message.content[index];
        if (block) {
          const field = update.type === "text_delta" ? "text" : update.type === "thinking_delta" ? "thinking" : null;
          if (field && typeof update.delta === "string" && typeof block[field] === "string"
            && (block[field] as string).length === (lengths.get(index) ?? 0) + update.delta.length
            && (block[field] as string).endsWith(update.delta)) {
            lengths.set(index, (block[field] as string).length);
            if (pending?.type === "message_delta" && pending.index === index && pending.field === field) pending.delta += update.delta;
            else { flush(); pending = { type: "message_delta", index, field, delta: update.delta }; }
          } else {
            lengths.set(index, String(block.text ?? block.thinking ?? "").length);
            // Only the changing tool/thinking/text block is replaced. A tool argument
            // update never retransmits earlier text or unrelated tool calls.
            if (pending?.type !== "message_block" || pending.index !== index) flush();
            pending = { type: "message_block", index, block: { ...block } };
          }
          timer ??= setTimeout(flush, options.intervalMs ?? 32);
          return;
        }
      }
      // Terminal and lifecycle events never overtake pending text.
      flush();
      if ((event.type === "message_start" || event.type === "message_update") && message?.role === "assistant" && Array.isArray(message.content)) snapshot(message);
      if (event.type === "message_end" || event.type === "connected") { hasSnapshot = false; lengths.clear(); }
      const slim = { ...event };
      delete slim.assistantMessageEvent;
      write(slim);
    },
    flush,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending = undefined;
      lengths.clear();
    },
  };
}

export function createAgentEventDecoder() {
  let current: Message | undefined;
  return (event: Event): Event | null => {
    if (event.type === "connected" || event.type === "message_end") current = undefined;
    if (event.type === "message_start" || event.type === "message_update") current = event.message as Message | undefined;
    if (event.type !== "message_delta" && event.type !== "message_block") return event;
    if (!current || !Number.isInteger(event.index) || (event.index as number) < 0) return null;
    const index = event.index as number;
    const content = [...current.content];
    if (event.type === "message_block") content[index] = event.block as Record<string, unknown>;
    else {
      const { field, delta } = event as Delta;
      if ((field !== "text" && field !== "thinking") || typeof delta !== "string" || !content[index]) return null;
      content[index] = { ...content[index], [field]: String(content[index][field] ?? "") + delta };
    }
    current = { ...current, content };
    return { type: "message_update", message: current };
  };
}
