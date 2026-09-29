import { applyPrivilegeConfig, previewPrivilegeConfig, restorePrivilegeConfig, type PrivilegeEdit } from "@/lib/harmony/privilege-config";
import { HarmonyError } from "@/lib/harmony/errors";
import { InvalidJsonBodyError, JsonBodyTooLargeError, parseJsonWithinLimit } from "@/lib/bounded-json";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 8 * 1024) as Record<string, unknown>;
    if (!body || typeof body !== "object") throw new HarmonyError("INVALID_ARGUMENT", "Choose a privilege configuration action");
    if (body.action === "restore" && typeof body.path === "string" && typeof body.backupPath === "string" && typeof body.expectedHash === "string") {
      return noStoreJson({ result: await restorePrivilegeConfig(body.path, body.backupPath, body.expectedHash) });
    }
    if ((body.action === "preview" || body.action === "apply") && typeof body.path === "string"
      && typeof body.bundleName === "string" && typeof body.fingerprint === "string"
      && typeof body.singleton === "boolean" && typeof body.allowAppUsePrivilegeExtension === "boolean") {
      const edit: PrivilegeEdit = { path: body.path, bundleName: body.bundleName, fingerprint: body.fingerprint,
        singleton: body.singleton, allowAppUsePrivilegeExtension: body.allowAppUsePrivilegeExtension };
      if (body.action === "preview") return noStoreJson({ result: await previewPrivilegeConfig(edit) });
      if (typeof body.expectedHash === "string") return noStoreJson({ result: await applyPrivilegeConfig(edit, body.expectedHash) });
    }
    throw new HarmonyError("INVALID_ARGUMENT", "Choose preview, apply or restore with the required fields");
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) return noStoreJson({ error: "Request body is too large" }, { status: 413 });
    if (error instanceof InvalidJsonBodyError) return noStoreJson({ error: "Invalid JSON body" }, { status: 400 });
    return harmonyErrorResponse(error);
  }
}
