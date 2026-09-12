import { historyErrorResponse, historyJson, readHistorySnapshot, readHistoryVersion } from "@/lib/session-history-store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = (await params).id;
    if (new URL(request.url).searchParams.has("versionOnly")) return historyJson({ version: await readHistoryVersion(id) });
    return historyJson((await readHistorySnapshot(id)).index);
  } catch (error) { return historyErrorResponse(error); }
}
