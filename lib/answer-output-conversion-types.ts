/** An explicit form change. Reusing an ID alone never requests conversion. */
export interface AnswerConversionSpec {
  fromKind: "intelligent-ui" | "mini-app";
  fromToolCallId: string;
  fromDigest: string;
  description: string;
}
export interface AnswerConversionIdentity {
  kind: AnswerConversionSpec["fromKind"]; appId: string; operationId: string; toolCallId: string;
  digest: string;
}
export type AnswerConversionInputs = Record<string, number | string | boolean>;
export interface AnswerConversionField {
  id: string; label: string; meaning: string;
  type: "number" | "checkbox" | "text" | "select";
  min?: number; max?: number; step?: number; maxLength?: number;
  options?: Array<{ value: string; label: string }>;
}
export interface AnswerConversionSource {
  identity: AnswerConversionIdentity; title: string;
  fields: AnswerConversionField[]; inputs: AnswerConversionInputs; summary: string;
}
export interface AnswerConversionIntent {
  version: 1; requestId: string; runId: string; leafId: string;
  decision: "confirm" | "cancel";
  source: AnswerConversionIdentity; target: AnswerConversionIdentity;
  inputs: AnswerConversionInputs; resultDigest: string | null;
}
export interface AnswerConversionCompletion {
  version: 1; intentId: string; intentHash: string; requestDigest: string;
}
export interface AnswerConversionChoice {
  kind: AnswerConversionSpec["fromKind"]; toolCallId: string; requestId: string;
  leafId: string; digest: string; decision: "confirm" | "cancel"; inputs: AnswerConversionInputs;
}
export interface AnswerConversionReview {
  kind: AnswerConversionSpec["fromKind"]; toolCallId: string; leafId: string; digest: string;
  status: "ready" | "stale" | "confirmed" | "cancelled";
  description: string; source?: AnswerConversionSource; target: AnswerConversionSource;
  pending?: AnswerConversionChoice;
}

export function parseAnswerConversionSpec(value: unknown, targetKind: AnswerConversionSpec["fromKind"]): AnswerConversionSpec {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Conversion must be an object");
  const fields = Object.getOwnPropertyDescriptors(value), keys = ["fromKind", "fromToolCallId", "fromDigest", "description"];
  if (Object.getOwnPropertySymbols(value).length || Object.keys(fields).length !== keys.length
    || !keys.every(key => fields[key]?.enumerable && "value" in fields[key])) throw new Error("Use only the documented conversion fields");
  const spec = value as AnswerConversionSpec;
  if (!["intelligent-ui", "mini-app"].includes(spec.fromKind) || spec.fromKind === targetKind
    || typeof spec.fromToolCallId !== "string" || !spec.fromToolCallId || spec.fromToolCallId.length > 256
    || typeof spec.fromDigest !== "string" || !/^[a-f0-9]{64}$/.test(spec.fromDigest)
    || typeof spec.description !== "string" || !spec.description.trim() || spec.description.length > 600) {
    throw new Error("Conversion requires the other output kind, exact source identity and an impact description");
  }
  return { fromKind: spec.fromKind, fromToolCallId: spec.fromToolCallId, fromDigest: spec.fromDigest, description: spec.description };
}
