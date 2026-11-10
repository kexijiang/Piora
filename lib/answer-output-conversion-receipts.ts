import { answerDataDigest, answerDiskBranch, assertAnswerReceipt, type AnswerDisk } from "./answer-output-receipts";
import type { AnswerConversionCompletion, AnswerConversionIntent, AnswerConversionSpec } from "./answer-output-conversion-types";

export const ANSWER_CONVERSION_INTENT = "piora-answer-conversion-intent";
export const ANSWER_CONVERSION_COMPLETE = "piora-answer-conversion-complete";
const identityText = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Reading cannot finish an intent. Only a durable completion activates a target. */
export function readAnswerConversionReceipts(disk: AnswerDisk, leafId: string) {
  const branch = answerDiskBranch(disk, leafId), visible = new Set<string>();
  const receipts: Array<{ entryId: string; intentId: string; intent: AnswerConversionIntent; requestDigest: string }> = [];
  const requests = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === ANSWER_CONVERSION_COMPLETE) {
      const completion = entry.data as AnswerConversionCompletion;
      assertAnswerReceipt(completion?.version === 1 && identityText(completion.intentId) && visible.has(completion.intentId)
        && hash(completion.intentHash) && hash(completion.requestDigest), "Invalid conversion completion");
      const intentEntry = disk.byId.get(completion.intentId)!;
      assertAnswerReceipt(intentEntry.type === "custom" && intentEntry.customType === ANSWER_CONVERSION_INTENT
        && answerDataDigest(intentEntry.data) === completion.intentHash, "Conversion intent changed");
      const intent = intentEntry.data as AnswerConversionIntent;
      assertAnswerReceipt(intent?.version === 1 && identityText(intent.requestId) && !requests.has(intent.requestId)
        && identityText(intent.runId) && identityText(intent.leafId) && visible.has(intent.leafId)
        && ["confirm", "cancel"].includes(intent.decision) && intent.source && intent.target
        && [intent.source, intent.target].every(item => ["intelligent-ui", "mini-app"].includes(item.kind)
          && identityText(item.appId) && identityText(item.operationId) && identityText(item.toolCallId) && hash(item.digest))
        && intent.source.kind !== intent.target.kind && intent.source.appId === intent.target.appId
        && intent.inputs && typeof intent.inputs === "object" && !Array.isArray(intent.inputs)
        && Object.values(intent.inputs).every(value => typeof value === "boolean" || typeof value === "string" && value.length <= 4000 || typeof value === "number" && Number.isFinite(value))
        && (intent.decision === "confirm" ? hash(intent.resultDigest) : intent.resultDigest === null && !Object.keys(intent.inputs).length), "Invalid conversion intent");
      assertAnswerReceipt(answerDataDigest({ requestId: intent.requestId, decision: intent.decision,
        source: intent.source, target: intent.target, inputs: intent.inputs }) === completion.requestDigest, "Conversion request changed");
      requests.add(intent.requestId);
      receipts.push({ entryId: entry.id, intentId: intentEntry.id, intent, requestDigest: completion.requestDigest });
    }
    visible.add(entry.id);
  }
  return receipts;
}

export function answerConversionOutcome(disk: AnswerDisk, leafId: string, kind: AnswerConversionSpec["fromKind"], operationId: string) {
  let outcome: "confirmed" | "cancelled" | "superseded" | undefined;
  for (const { intent } of readAnswerConversionReceipts(disk, leafId)) {
    if (intent.target.kind === kind && intent.target.operationId === operationId) outcome = intent.decision === "confirm" ? "confirmed" : "cancelled";
    if (intent.decision === "confirm" && intent.source.kind === kind && intent.source.operationId === operationId) outcome = "superseded";
  }
  return outcome;
}

export function answerConversionCurrentKind(disk: AnswerDisk, leafId: string, appId: string) {
  return readAnswerConversionReceipts(disk, leafId).filter(item => item.intent.decision === "confirm" && item.intent.target.appId === appId).at(-1)?.intent.target.kind;
}
