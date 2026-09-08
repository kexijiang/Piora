import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { createTrustedModelServices, resolveModelRequestCwd } from "@/lib/model-runtime-context";
import { resolveVisibleModels } from "@/lib/model-scope";
import { listAllSessions } from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { scheduleSessionModels } from "@/lib/session-model-selection";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Access denied" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "JSON required" }, { status: 415 });
  try {
    const body = await req.json();
    if (typeof body.projectRoot !== "string" || typeof body.provider !== "string" || typeof body.modelId !== "string") return Response.json({ error: "Project, provider and model ID are required" }, { status: 400 });
    const cwd = await resolveModelRequestCwd(body.projectRoot);
    const services = await createTrustedModelServices(cwd);
    const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
    if (!scope.visible.some((model) => model.provider === body.provider && model.id === body.modelId)) return Response.json({ error: "Model not found or unavailable" }, { status: 400 });
    const sessions = (await listAllSessions()).filter((session) => !session.projectless && sessionPathKey(session.projectRoot ?? session.cwd) === sessionPathKey(cwd));
    const ids = sessions.map((session) => session.id);
    scheduleSessionModels(ids, { provider: body.provider, modelId: body.modelId });
    const running = new Set(getRunningRpcSessionIds());
    return Response.json({ ids, updated: ids.length, running: ids.filter((id) => running.has(id)).length, provider: body.provider, modelId: body.modelId });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
