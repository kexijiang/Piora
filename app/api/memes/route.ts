import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { callMemeDesktop, memeDesktopAvailable, memeCatalog, memeHttp } from "@/lib/dsh-meme-bridge";
import { captureMeme } from "@/lib/meme-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  try {
    if (!memeDesktopAvailable()) return Response.json({ available: false, status: { phase: "absent", version: "0.1.76" }, memes: [] });
    const url = new URL(request.url);
    const image = url.searchParams.get("image");
    if (image) {
      if (!image.startsWith("/dsh-memes/")) throw new Error("Invalid image URL");
      const response = await memeHttp(image);
      if (!response.mime.startsWith("image/")) throw new Error("Invalid image response");
      return new Response(new Uint8Array(response.bytes), { status: response.status, headers: { "Content-Type": response.mime, "X-Content-Type-Options": "nosniff" } });
    }
    const status = await callMemeDesktop<{ phase: string }>("status");
    return Response.json({ available: true, status, ...(status.phase === "running" && !url.searchParams.has("status") ? await memeCatalog() : { memes: [] }) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Meme request failed" }, { status: 503 }); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Expected JSON" }, { status: 415 });
  try {
    const input = await parseJsonWithinLimit(request, 32000) as Record<string, unknown>;
    if (input.action === "capture" && typeof input.url === "string" && typeof input.caption === "string") return Response.json({ markdown: await captureMeme(input.url, input.caption) });
    if (input.action === "preferences" && typeof input.autoStart === "boolean") return Response.json({ status: await callMemeDesktop("preferences", { autoStart: input.autoStart }) });
    if (typeof input.action !== "string" || !["install", "start", "stop", "uninstall", "cancel", "settings"].includes(input.action)) throw new Error("Invalid action");
    return Response.json({ status: await callMemeDesktop("action", { action: input.action }) });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Meme operation failed" }, { status: 400 }); }
}
