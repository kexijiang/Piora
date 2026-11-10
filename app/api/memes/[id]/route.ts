import { readMemeImage } from "@/lib/meme-store";
import { isApiRequestAllowed } from "@/lib/request-security";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(request)) return new Response(null, { status: 403 });
  try {
    const { bytes, mime } = readMemeImage((await params).id);
    return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=86400" } });
  } catch { return new Response(null, { status: 404 }); }
}
