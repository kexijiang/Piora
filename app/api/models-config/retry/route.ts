import {
  applyModelRetrySettings,
  parseModelRetrySettings,
  readModelRetrySettings,
} from "@/lib/retry-settings";
import {
  createCoreModelServices,
  ModelRequestCwdError,
  resolveModelRequestCwd,
} from "@/lib/model-runtime-context";
import { reloadLiveModelRetrySettings } from "@/lib/rpc-manager";
import { applyNetworkProxySettings } from "@/lib/http-dispatcher";
import { readNetworkProxySettings } from "@/lib/network-proxy";

export const dynamic = "force-dynamic";

function jsonError(code: string, error: string, status: number): Response {
  return Response.json({ code, error }, { status });
}

async function loadSettings(cwdParam?: string | null) {
  const cwd = await resolveModelRequestCwd(cwdParam ?? undefined);
  const { settingsManager } = await createCoreModelServices(cwd);
  return settingsManager;
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  try {
    const settings = await loadSettings(requestUrl.searchParams.get("cwd"));
    return Response.json(readModelRetrySettings(settings), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelRequestCwdError) return jsonError(error.code, error.message, error.status);
    return jsonError("read_failed", error instanceof Error ? error.message : String(error), 500);
  }
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("invalid_request", "Request body must be JSON", 400);
  }
  const payload = (body && typeof body === "object" ? body : {}) as { cwd?: unknown; settings?: unknown };
  let settings;
  try {
    settings = parseModelRetrySettings(payload.settings);
  } catch (error) {
    return jsonError("invalid_settings", error instanceof Error ? error.message : String(error), 400);
  }
  try {
    const manager = await loadSettings(typeof payload.cwd === "string" ? payload.cwd : undefined);
    const applied = await applyModelRetrySettings(manager, settings);
    applyNetworkProxySettings(readNetworkProxySettings(), settings.httpIdleTimeoutMs);
    await reloadLiveModelRetrySettings();
    return Response.json(applied, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ModelRequestCwdError) return jsonError(error.code, error.message, error.status);
    return jsonError("write_failed", error instanceof Error ? error.message : String(error), 500);
  }
}
