import { applyCompactionThresholdSettings, parseCompactionThresholdSettings, readCompactionThresholdSettings } from "@/lib/compaction-settings";
import { createCoreModelServices, ModelRequestCwdError, resolveModelRequestCwd } from "@/lib/model-runtime-context";
import { reloadLiveCompactionSettings } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

async function loadSettings(cwdParam?: string | null) {
  const cwd = await resolveModelRequestCwd(cwdParam ?? undefined);
  return (await createCoreModelServices(cwd)).settingsManager;
}

function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof ModelRequestCwdError) return Response.json({ error: error.message }, { status: error.status });
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const manager = await loadSettings(new URL(request.url).searchParams.get("cwd"));
    return Response.json(readCompactionThresholdSettings(manager), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error, "Failed to read compaction settings");
  }
}

export async function PATCH(request: Request) {
  let settings;
  try {
    const body = await request.json() as { settings?: unknown; cwd?: string };
    settings = parseCompactionThresholdSettings(body.settings);
    const manager = await loadSettings(body.cwd);
    const applied = await applyCompactionThresholdSettings(manager, settings);
    await reloadLiveCompactionSettings();
    return Response.json(applied, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 });
    return errorResponse(error, "Failed to save compaction settings");
  }
}
