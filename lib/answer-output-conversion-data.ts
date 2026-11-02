import { answerDataDigest } from "./answer-output-receipts";
import type { AnswerConversionSource, AnswerConversionField, AnswerConversionInputs, AnswerConversionIdentity } from "./answer-output-conversion-types";
import type { UiState, UiSurface } from "./intelligent-ui/surface-document";
import type { CompiledUiPlan } from "./intelligent-ui/plan-types";
import { formatSnapshot } from "./intelligent-ui/surface-document";
import type { MiniAppPlan1, MiniAppResult } from "./mini-app/plan";

export function componentConversionSource(input: { operationId: string; toolCallId: string; surface: UiSurface; state: UiState; revision: number; semantics?: CompiledUiPlan["inputSemantics"] }): AnswerConversionSource {
  const fields: AnswerConversionField[] = input.surface.nodes.flatMap((node): AnswerConversionField[] => {
    if (!["number", "slider", "checkbox", "select"].includes(node.type)) return [];
    if (node.type === "number" || node.type === "slider") return [{ id: node.id, label: node.label,
      meaning: input.semantics?.find(item => item.id === node.id)?.unit ?? "", type: "number", min: node.min, max: node.max, step: node.step }];
    if (node.type === "select") return [{ id: node.id, label: node.label, meaning: "", type: "select", options: node.options.map(value => ({ value, label: value })) }];
    return node.type === "checkbox" ? [{ id: node.id, label: node.label, meaning: "", type: "checkbox" }] : [];
  });
  const identity: AnswerConversionIdentity = { kind: "intelligent-ui", appId: input.surface.id,
    operationId: input.operationId, toolCallId: input.toolCallId, digest: answerDataDigest({ ...input, kind: "intelligent-ui" }) };
  return { identity, title: input.surface.title, fields, inputs: input.state as AnswerConversionInputs, summary: formatSnapshot(input.surface, input.state).slice(0, 2000) };
}

export function miniAppConversionSource(input: { operationId: string; toolCallId: string; plan: MiniAppPlan1; result: MiniAppResult; revision: number }): AnswerConversionSource {
  const fields: AnswerConversionField[] = input.plan.inputs.map(field => {
    const base = { id: field.id, label: field.label, meaning: field.meaning };
    if (field.type === "number" || field.type === "range") return { ...base, type: "number", min: field.min, max: field.max, step: field.step };
    if (field.type === "select") return { ...base, type: "select", options: field.options };
    if (field.type === "text") return { ...base, type: "text", maxLength: field.maxLength };
    return { ...base, type: "checkbox" };
  });
  const identity: AnswerConversionIdentity = { kind: "mini-app", appId: input.plan.id,
    operationId: input.operationId, toolCallId: input.toolCallId, digest: answerDataDigest({ ...input, kind: "mini-app" }) };
  return { identity, title: input.plan.title, fields, inputs: input.result.snapshot.inputs as AnswerConversionInputs, summary: input.result.frame.summary.slice(0, 2000) };
}

/** Authoring references never expose internal operation/run credentials. */
export function answerConversionContext(identity: AnswerConversionIdentity): Omit<AnswerConversionIdentity, "operationId"> {
  return { kind: identity.kind, appId: identity.appId, toolCallId: identity.toolCallId, digest: identity.digest };
}
