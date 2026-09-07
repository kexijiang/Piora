import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readTransferImage } from "@/lib/transfer-station";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const image = readTransferImage(new URL(request.url).searchParams.get("id") || "");
    if (!image) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(image.bytes), { headers: { "Content-Type": image.type, "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response(null, { status: 404 }); }
}
