import { historyErrorResponse, historyJson, readHistoryDetails, readHistorySnapshot } from "@/lib/session-history-store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams;
    const snapshot = await readHistorySnapshot((await params).id, query.get("version"));
    return historyJson({ version: snapshot.index.version, entries: readHistoryDetails(snapshot, query.get("leafId"), query.getAll("entryId"), query.get("original") === "1") });
  } catch (error) { return historyErrorResponse(error); }
}
