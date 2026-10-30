import { Type, type TSchema } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { intelligentUiPlanPrompt, intelligentUiRichPlanPrompt, intelligentUiSurfacePrompt } from "../lib/intelligent-ui/decision-policy.ts";
import { readBetaFeatures } from "../lib/beta-features.ts";
import { formatSnapshot, validateSurface } from "../lib/intelligent-ui/protocol.ts";
import { surfaceDiagnostic } from "../lib/intelligent-ui/surface-diagnostic.ts";
import { readUiDecisionRecords } from "../lib/intelligent-ui/read-output.ts";
import { formatUiDecisionContext } from "../lib/intelligent-ui/decision-context.ts";
import { readSurfaceState } from "../lib/intelligent-ui/store.ts";
import { uiPlanSchema } from "../lib/intelligent-ui/plan-schema.ts";
import { uiRichPlanSchema } from "../lib/intelligent-ui/rich-plan-schema.ts";
import { getAnswerOutputGeneration } from "../lib/answer-output-generation.ts";
import { uiInputProtocol } from "../lib/intelligent-ui/input-protocol.ts";

function unavailableResult() {
  const diagnostic = { code: "UI_RUN_UNAVAILABLE", repairable: false };
  return { content: [{ type: "text" as const, text: JSON.stringify(diagnostic) }], isError: true, details: { intelligentUiDiagnostic: diagnostic } };
}

function registerPlan(api: ExtensionAPI, planVersion: 1 | 2): void {
  api.registerTool(defineTool({
    name: "piora_render_ui_plan", label: "Intelligent UI",
    ...(planVersion === 2 ? intelligentUiRichPlanPrompt() : intelligentUiPlanPrompt()),
    executionMode: "sequential",
    parameters: planVersion === 2 ? uiRichPlanSchema : uiPlanSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const runtime = getAnswerOutputGeneration(ctx.sessionManager);
      if (!runtime || signal?.aborted) return unavailableResult();
      const result = await runtime.executePlan(toolCallId, params, signal, planVersion);
      if (!result.isError) onUpdate?.(result);
      return result;
    },
  }));
  api.on("context", async (event, ctx) => {
    const runtime = getAnswerOutputGeneration(ctx.sessionManager);
    let content: string;
    try {
      if (!runtime) throw new Error("No originating generation run");
      content = (await runtime.captureContext(planVersion)).content;
    } catch {
      content = "Saved UI parameters and generation context are unavailable for this request. Do not assume initial values are current or invoke UI generation; continue with an ordinary answer.";
    }
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "piora-ui-state"));
    return { messages: content ? [...messages, { role: "custom" as const, customType: "piora-ui-state", content, display: false, timestamp: Date.now() }] : messages };
  });
  api.on("turn_end", async (event, ctx) => {
    const runtime = getAnswerOutputGeneration(ctx.sessionManager);
    if (!runtime) return;
    await runtime.onTurnEnd({ messageEntryId: event.messageEntryId, toolResultEntryIds: event.toolResultEntryIds, outcome: event.outcome });
  });
}

// Bounded inline schemas also work with providers that cannot resolve recursive $refs.
function expressionSchema(depth: number): TSchema {
  const values: TSchema[] = [Type.String({ maxLength: 2000 }), Type.Number(), Type.Boolean(), Type.Object({ ref: Type.String({ description: "ID of a control" }) }, { additionalProperties: false })];
  return Type.Union(depth ? [...values, Type.Object({ op: Type.Union(["add", "subtract", "multiply", "divide", "round", "min", "max", "if", "equals"].map(op => Type.Literal(op))), args: Type.Array(expressionSchema(depth - 1), { minItems: 1, maxItems: 32 }) }, { additionalProperties: false })] : values);
}
const expr = expressionSchema(12);
const id = Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" });
const label = Type.String({ maxLength: 160 });
const node = Type.Union([
  Type.Object({ id, type: Type.Literal("text"), text: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Union([Type.Literal("number"), Type.Literal("slider")]), label, value: Type.Number(), min: Type.Optional(Type.Number()), max: Type.Optional(Type.Number()), step: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Literal("select"), label, value: label, options: Type.Array(label, { minItems: 1, maxItems: 40 }) }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Literal("checkbox"), label, value: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Literal("metric"), label, value: expr }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Literal("table"), columns: Type.Array(label, { minItems: 1, maxItems: 12 }), rows: Type.Array(Type.Array(expr, { maxItems: 12 }), { maxItems: 100 }) }, { additionalProperties: false }),
  Type.Object({ id, type: Type.Literal("barChart"), labels: Type.Array(label, { maxItems: 40 }), values: Type.Array(expr, { maxItems: 40 }) }, { additionalProperties: false }),
]);

export default function intelligentUi(api: ExtensionAPI) {
  // Both the load plan and this entry point fail closed. The loaded instance is
  // the per-run capability snapshot; toggling settings must not mutate a run.
  if (!readBetaFeatures().intelligentUi) return;
  // Beta uses Plan2 by default; the internal switch retains explicit older
  // protocols. An instance exposes exactly one authoring contract.
  const protocol = uiInputProtocol();
  if (protocol === "plan-1" || protocol === "plan-2") {
    registerPlan(api, protocol === "plan-2" ? 2 : 1); return;
  }
  api.registerTool(defineTool({
    name: "piora_render_ui", label: "Intelligent UI",
    ...intelligentUiSurfacePrompt(),
    executionMode: "sequential",
    parameters: Type.Object({ id, title: label, nodes: Type.Array(node, { minItems: 1, maxItems: 64 }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("UI generation cancelled");
      const saved = await readUiDecisionRecords(ctx.sessionManager);
      if (signal?.aborted) throw new Error("UI generation cancelled");
      const previous = saved.records.find(item => item.surface.id === params.id);
      if (previous?.protocolVersion === 2) {
        const diagnostic = { code: "UI_PROTOCOL_UNAVAILABLE", repairable: false,
          message: "This saved UI uses the plan protocol. Surface generation cannot revise it. Keep the existing UI and saved parameters; answer ordinary follow-up questions from its acknowledged values." };
        return { content: [{ type: "text" as const, text: JSON.stringify(diagnostic) }], isError: true, details: { intelligentUiDiagnostic: diagnostic } };
      }
      let surface;
      try { surface = validateSurface({ version: 1, revision: (previous?.surface.revision ?? 0) + 1, ...params }); }
      catch (error) {
        const diagnostic = surfaceDiagnostic(error);
        return { content: [{ type: "text" as const, text: JSON.stringify(diagnostic) }],
          isError: true, details: { intelligentUiDiagnostic: diagnostic } };
      }
      const state = readSurfaceState(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch(), surface);
      const snapshot = formatSnapshot(surface, state);
      const result = { content: [{ type: "text" as const, text: snapshot }], details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot, payload: surface } } };
      onUpdate?.(result);
      return result;
    },
  }));
  api.on("context", async (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "piora-ui-state"));
    try {
      const snapshot = await readUiDecisionRecords(ctx.sessionManager);
      const content = formatUiDecisionContext(snapshot.records, snapshot.leafId);
      if (!content) return { messages };
      return { messages: [...messages, {
        role: "custom" as const, customType: "piora-ui-state", content, display: false, timestamp: Date.now(),
      }] };
    } catch {
      // A corrupted optional sidecar must never prevent ordinary chat requests.
      return { messages: [...messages, { role: "custom" as const, customType: "piora-ui-state", content: "Saved UI parameters are unavailable. Do not assume the initial values reflect the user's current choices or generate a replacement UI from defaults; continue with an ordinary answer.", display: false, timestamp: Date.now() }] };
    }
  });
}
