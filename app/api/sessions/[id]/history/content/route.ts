import { historyMessage } from "@/lib/session-history";
import { HistoryReadError, historyErrorResponse, historyJson, readHistorySnapshot, restoreHistoryEntry } from "@/lib/session-history-store";

export const runtime = "nodejs";

/** Deferred content uses the same saved version as its index and visible card. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams;
    const snapshot = await readHistorySnapshot((await params).id, query.get("version"));
    const entry = snapshot.entries.find(entry => entry.id === query.get("entryId"));
    if (!entry) throw new HistoryReadError("History entry not found", 404);
    const message = historyMessage(restoreHistoryEntry(entry));
    if (query.get("kind") === "prompt" && message?.role === "user") {
      return historyJson({ content: typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n") });
    }
    const blockIndex = Number(query.get("blockIndex"));
    if (query.get("kind") === "thinking" && message?.role === "assistant" && Number.isSafeInteger(blockIndex) && blockIndex >= 0) {
      const block = message.content[blockIndex];
      if (block?.type === "thinking") return historyJson({ thinking: block.thinking });
    }
    throw new HistoryReadError("Requested history content is unavailable", 404);
  } catch (error) { return historyErrorResponse(error); }
}
