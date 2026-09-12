import { searchHistory, type HistoryCategory } from "@/lib/session-history";
import { HistoryReadError, historyErrorResponse, historyJson, readHistorySnapshot, requireHistoryLeaf, restoreHistoryEntry } from "@/lib/session-history-store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams;
    const snapshot = await readHistorySnapshot((await params).id, query.get("version"));
    const category = query.get("category");
    if (category && !["user", "assistant", "tool", "system"].includes(category)) throw new HistoryReadError("Unknown history category");
    const offset = Number(query.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HistoryReadError("Invalid search offset");
    const leafId = query.get("scope") === "branch" ? requireHistoryLeaf(snapshot, query.get("leafId")) ?? undefined : undefined;
    return historyJson(searchHistory(snapshot.entries.map(restoreHistoryEntry), snapshot.index, { query: query.get("q") ?? "", leafId,
      category: category as HistoryCategory | undefined, from: query.get("from") ?? undefined, to: query.get("to") ?? undefined,
      failedOnly: query.get("failed") === "1", includeThinking: query.get("thinking") === "1", offset }));
  } catch (error) { return historyErrorResponse(error); }
}
