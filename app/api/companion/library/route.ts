import { NextResponse } from "next/server";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { getPocketStorageInfo } from "@/lib/pocket-storage";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { addTransferItem, migrateTransferItems, transferItemsForClient, updateTransferItem } from "@/lib/transfer-station";
import { readCompanionRuntimeState } from "@/lib/companion-runtime";
export const dynamic = "force-dynamic";
function initialize() { if (!existsSync(getPocketStorageInfo("library").dataFile)) migrateTransferItems(readCompanionRuntimeState().library); }
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { initialize(); return NextResponse.json({ items: transferItemsForClient() }); }
  catch (error) { return NextResponse.json({ error: String(error) }, { status: 500 }); }
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  try {
    const input = await parseJsonWithinLimit(request, 12 * 1024 * 1024) as { content: string; title?: string; kind?: string; language?: string };
    if (typeof input.content !== "string" || (input.title !== undefined && typeof input.title !== "string") || (input.language !== undefined && typeof input.language !== "string")) throw new Error("暂存内容无效。");
    if (input.kind === "image") {
      const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(input.content);
      if (!match) throw new Error("图片格式无效。");
      const metadata = await sharp(Buffer.from(match[2], "base64"), { limitInputPixels: 40_000_000 }).metadata();
      if (!metadata.width || !metadata.height || metadata.format !== match[1]) throw new Error("图片格式与内容不一致。");
    }
    initialize(); addTransferItem(input);
    return NextResponse.json({ items: transferItemsForClient() });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  try {
    const input = await parseJsonWithinLimit(request, 8192) as { id: string; pinned?: boolean; title?: string; remove?: boolean };
    if (typeof input.id !== "string" || (input.title !== undefined && typeof input.title !== "string")) throw new Error("内容标识无效。");
    initialize(); updateTransferItem(input.id, input);
    return NextResponse.json({ items: transferItemsForClient() });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
}
