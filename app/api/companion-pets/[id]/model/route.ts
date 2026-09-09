import { NextResponse } from "next/server";
import { CompanionModelError, readCompanionModelAsset } from "@/lib/companion-models";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const { id } = await params;
    const asset = new URL(request.url).searchParams.get("asset");
    if (asset !== null && asset !== "preview") return NextResponse.json({ error: "Invalid model asset" }, { status: 400 });
    const bytes = readCompanionModelAsset(id, asset === "preview" ? "preview.png" : "model.glb");
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": asset === "preview" ? "image/png" : "model/gltf-binary",
      "Content-Length": String(bytes.length), "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof CompanionModelError ? error.message : "Could not load 3D pet" }, { status: error instanceof CompanionModelError ? error.status : 500 });
  }
}
