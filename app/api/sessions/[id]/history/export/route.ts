import { historyMarkdown, historyPath, historyCategory } from "@/lib/session-history";
import { HistoryReadError, historyErrorResponse, readHistorySnapshot, requireHistoryLeaf, restoreHistoryEntry } from "@/lib/session-history-store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams;
    const snapshot = await readHistorySnapshot((await params).id, query.get("version"));
    const format = query.get("format");
    if (format !== "json" && format !== "markdown") throw new HistoryReadError("Choose json or markdown");
    let entries = historyPath(snapshot.entries, requireHistoryLeaf(snapshot, query.get("leafId")));
    const target = query.get("entryId");
    if (target) {
      const index = entries.findIndex(entry => entry.id === target);
      if (index < 0) throw new HistoryReadError("Entry not found in branch", 404);
      if (query.get("selection") === "turn") {
        let start = index, end = index + 1;
        while (start > 0 && historyCategory(entries[start]) !== "user") start--;
        while (end < entries.length && historyCategory(entries[end]) !== "user") end++;
        entries = entries.slice(start, end);
      } else entries = [entries[index]];
    }
    const body = format === "json" ? JSON.stringify({ header: snapshot.header, entries: snapshot.entries }, null, 2)
      : historyMarkdown(entries.map(restoreHistoryEntry), snapshot.index.name || snapshot.header.id);
    return new Response(body, { headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="piora-history-${snapshot.header.id}.${format === "json" ? "json" : "md"}"`,
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return historyErrorResponse(error); }
}
