import { getMessageImageSource } from "@/lib/message-images";
import { entryToUiMessage } from "@/lib/session-reader";
import { HistoryReadError, historyErrorResponse, readHistorySnapshot } from "@/lib/session-history-store";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const query = new URL(request.url).searchParams;
    const snapshot = await readHistorySnapshot((await params).id, query.get("version"));
    const entry = snapshot.entries.find(entry => entry.id === query.get("entryId"));
    const block = Number(query.get("block"));
    if (!entry || !Number.isSafeInteger(block) || block < 0) throw new HistoryReadError("Image not found", 404);
    const message = entryToUiMessage(entry, { deferThinking: false });
    const image = message && "content" in message && Array.isArray(message.content) ? getMessageImageSource(message.content[block]) : null;
    if (image?.type !== "base64" || !image.data) throw new HistoryReadError("Image not found", 404);
    const mime = image.media_type ?? "image/png";
    if (!/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(mime)) throw new HistoryReadError("Unsupported image format", 415);
    return new Response(Buffer.from(image.data, "base64"), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return historyErrorResponse(error); }
}
