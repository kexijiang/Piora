import { answerDataDigest } from "../answer-output-receipts";
import { miniAppCheckpointChanges } from "./checkpoint-changes";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import { MiniAppError } from "./limits";
import { validateMiniAppInputs, type CompiledMiniApp, type MiniAppResult } from "./plan";
import { miniAppTextContext } from "./text-context";
import type { MiniAppCheckpoint } from "./vm";

export interface MiniAppInputCase { inputId: string; value: string | number | boolean }
export function parseMiniAppInputCases(value: unknown): MiniAppInputCase[] {
  boundedJson(value, 16_000);
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new MiniAppError("SCHEMA", "Choose 1..8 independent input cases", "inputCases", true);
  return value.map(raw => {
    const item = jsonRecord(raw, "inputCases/item"); exactKeys(item, ["inputId", "value"], "inputCases/item");
    if (typeof item.inputId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.inputId)
      || !(typeof item.value === "boolean" || typeof item.value === "number" && Number.isFinite(item.value)
        || typeof item.value === "string" && item.value.length <= 512)) throw new MiniAppError("SCHEMA", "An input case requires an input ID and a bounded scalar value", "inputCases", true);
    return { inputId: item.inputId, value: item.value };
  });
}
export function validateMiniAppInputCases(compiled: CompiledMiniApp, snapshot: MiniAppCheckpoint, value: unknown) {
  const cases = parseMiniAppInputCases(value);
  for (const item of cases) {
    if (!compiled.plan.inputs.some(input => input.id === item.inputId)) throw new MiniAppError("SCHEMA", "Choose a declared input ID", "inputCases/inputId", true);
    validateMiniAppInputs(compiled.plan, { ...snapshot.inputs, [item.inputId]: item.value });
  }
  return cases;
}
export function miniAppInputObservation(compiled: CompiledMiniApp, source: MiniAppCheckpoint, item: MiniAppInputCase, result: MiniAppResult) {
  return { ...item, checkpointUnchanged: answerDataDigest(source) === answerDataDigest(result.snapshot),
    changes: miniAppCheckpointChanges(source, result.snapshot), projectionText: miniAppTextContext(compiled.document, result.frame, 1000) };
}
export interface MiniAppInputEvidence {
  sourceCheckpointDigest: string;
  scope: "independent-single-input-events";
  requestedCases: number;
  omittedCases: number;
  cases: Array<ReturnType<typeof miniAppInputObservation>>;
}
export function compactMiniAppInputEvidence(evidence: MiniAppInputEvidence, maximum = 6000): MiniAppInputEvidence {
  const result: MiniAppInputEvidence = JSON.parse(JSON.stringify(evidence));
  while (JSON.stringify(result).length > maximum && result.cases.length) { result.cases.pop(); result.omittedCases++; }
  return result;
}
