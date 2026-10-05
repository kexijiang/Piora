import { dirname, join } from "node:path";
import { defaultHarmonyConfigPath } from "@/lib/harmony/runtime";
import { DevelopmentReportStore } from "@/lib/harmony/development/report-store";
import { getHarmonyDeviceManager } from "@/lib/harmony";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { sourceFingerprint } from "@/lib/harmony/check-runtime";
import { validateDevelopmentOnDevice, type DevelopmentValidationOptions } from "@/lib/harmony/development/validation-chain";
import { HarmonyError } from "@/lib/harmony/errors";
import { hasJsonContentType } from "@/lib/request-security";
import { harmonyErrorResponse, noStoreJson, requireHarmonyAccess } from "../_shared";
export async function POST(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  if (!hasJsonContentType(request)) return noStoreJson({ error: "JSON required" }, { status: 415 });
  try {
    const body = await parseJsonWithinLimit(request, 128 * 1024) as DevelopmentValidationOptions;
    const roots = await getAllowedFileRoots();
    if (!body || typeof body.projectRoot !== "string" || typeof body.hapPath !== "string" || !isExistingFilePathAllowed(body.projectRoot, roots) || !isExistingFilePathAllowed(body.hapPath, roots)) throw new HarmonyError("INVALID_ARGUMENT", "Select a project and artifact within allowed workspace roots");
    const result = await validateDevelopmentOnDevice({ ...body, signal: request.signal }, { manager: getHarmonyDeviceManager(), fingerprint: sourceFingerprint,
    });
    return noStoreJson({ result: await new DevelopmentReportStore(join(dirname(defaultHarmonyConfigPath()), "harmony-development-reports")).save(result) });
  } catch (error) { return harmonyErrorResponse(error); }
}

export async function GET(request: Request) {
  const denied = requireHarmonyAccess(request); if (denied) return denied;
  try {
    const projectRoot = new URL(request.url).searchParams.get("projectRoot");
    if (!projectRoot || !isExistingFilePathAllowed(projectRoot, await getAllowedFileRoots())) throw new HarmonyError("INVALID_ARGUMENT", "Select an allowed project");
    return noStoreJson({ reports: await new DevelopmentReportStore(join(dirname(defaultHarmonyConfigPath()), "harmony-development-reports")).list(projectRoot) });
  } catch (error) { return harmonyErrorResponse(error); }
}
