import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { HarmonyError } from "@/lib/harmony/errors";
import { previewHapArtifact } from "@/lib/harmony/runtime/hap-preview";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (body?.action !== "preview" || typeof body.hapPath !== "string" || body.hapPath.length > 4096
      || !isExistingFilePathAllowed(body.hapPath, await getAllowedFileRoots())) throw new HarmonyError("INVALID_ARGUMENT", "Select a HAP within an allowed workspace root");
    return noStoreJson({ preview: await previewHapArtifact(body.hapPath, request.signal) });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
