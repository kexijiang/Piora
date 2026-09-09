import { requireRemotePrincipal } from "@/lib/remote-control-auth";
import { remoteErrorResponse } from "@/lib/remote-control-response";
import { createCoreModelServices } from "@/lib/model-runtime-context";
import { resolveVisibleModels } from "@/lib/model-scope";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    requireRemotePrincipal(request, "session.create");
    const services = await createCoreModelServices(process.cwd());
    const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
    return Response.json({ models: scope.visible.map(model => ({ id: model.id, provider: model.provider, name: model.name, thinkingLevels: getSupportedThinkingLevels(model) })), source: "core", defaultModel: { provider: services.settingsManager.getDefaultProvider(), modelId: services.settingsManager.getDefaultModel() } }, { headers: { "Cache-Control": "no-store" } });
  }
  catch (error) { return remoteErrorResponse(error); }
}
