import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBetaFeatures } from "../lib/beta-features.ts";
import { miniAppPlanSchema } from "../lib/mini-app/plan-schema.ts";
import { miniAppDecisionPrompt, miniAppEnvironmentContext } from "../lib/mini-app/decision-policy.ts";
import { readMiniAppCapabilities } from "../lib/mini-app/capability-host.ts";
import { getMiniAppGenerationRuntime } from "../lib/mini-app/generation-runtime.ts";

export default function miniAppExtension(api: ExtensionAPI): void {
  if (!readBetaFeatures().intelligentUi) return;
  api.registerTool(defineTool({
    name: "piora_render_mini_app", label: "Intelligent UI mini app", executionMode: "sequential",
    ...miniAppDecisionPrompt(), parameters: miniAppPlanSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getMiniAppGenerationRuntime(ctx.sessionManager);
      if (!runtime || signal?.aborted) {
        const problem = { code: "UI_RUN_UNAVAILABLE", message: "Mini app generation is unavailable for this originating task", repairable: false };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(problem) }], details: { answerOutputDiagnostic: problem } };
      }
      const result = await runtime.executePlan(toolCallId, params, signal);
      if (!result.isError) onUpdate?.(result);
      return result;
    },
  }));
  api.on("context", async (event, ctx) => {
    const runtime = getMiniAppGenerationRuntime(ctx.sessionManager);
    let content: string;
    try {
      if (!runtime) throw new Error("No originating mini app run");
      content = await runtime.captureContext();
    } catch {
      content = "Saved mini app parameters and generation context are unavailable for this request. Do not assume initial values are current or invoke mini app generation. Continue with an ordinary answer or an available component UI.";
    }
    const messages = event.messages.filter(message => !(message.role === "custom" && ["piora-mini-app-state", "piora-mini-app-capabilities"].includes(message.customType)));
    messages.push({ role: "custom", customType: "piora-mini-app-capabilities", content: miniAppEnvironmentContext(runtime?.capabilities() ?? readMiniAppCapabilities()), display: false, timestamp: Date.now() });
    return { messages: content ? [...messages, { role: "custom" as const, customType: "piora-mini-app-state", content, display: false, timestamp: Date.now() }] : messages };
  });
  api.on("turn_end", async (event, ctx) => {
    const runtime = getMiniAppGenerationRuntime(ctx.sessionManager);
    if (runtime) await runtime.onTurnEnd({ messageEntryId: event.messageEntryId, toolResultEntryIds: event.toolResultEntryIds, outcome: event.outcome });
  });
}
