import { parseAnswerOutputPrefix, type AnswerOutputPrefix } from "../answer-output-prefix";
import { compileMiniAppPlan, type MiniAppInput } from "./plan";
import { MINI_APP_LIMITS } from "./limits";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import type { MiniAppViewport } from "./frame";

const fields = ["planVersion", "id", "title", "purpose", "assumptions", "inputs", "stateSchema", "document", "viewports", "program", "initialSnapshot", "actions", "playback"];
const required = ["planVersion", "id", "title", "inputs", "document", "viewports"];
const inertProgram = "function init(){return null;} function reduce(s){return s;} function advance(s){return s;} function project(){return {summary:'Preview',bindings:{}};}";
export interface MiniAppPreviewPayload {
  previewVersion: 1; id: string; title: string; inputs: MiniAppInput[];
  document: { html: string; css: string }; viewports: MiniAppViewport[];
}
export function parseMiniAppPrefix(source: string): AnswerOutputPrefix {
  return parseAnswerOutputPrefix(source, { characters: MINI_APP_LIMITS.planBytes, values: MINI_APP_LIMITS.jsonNodes, depth: () => MINI_APP_LIMITS.depth });
}
export function compileMiniAppPreview(prefix: AnswerOutputPrefix): { status: "waiting" | "invalid" } | { status: "ready"; payload: MiniAppPreviewPayload; snapshot: string } {
  if (prefix.status === "invalid") return { status: "invalid" };
  if (Object.keys(prefix.values).some(key => !fields.includes(key))) return { status: "invalid" };
  if (required.some(key => !prefix.completeKeys.includes(key))) return { status: "waiting" };
  try {
    const closed = Object.fromEntries(prefix.completeKeys.map(key => [key, prefix.values[key]]));
    const compiled = compileMiniAppPlan(prefix.status === "complete" ? prefix.values
      : { purpose: "Preparing an interactive answer", assumptions: [], stateSchema: { type: "null" }, program: inertProgram, initialSnapshot: "Preparing", ...closed });
    const payload: MiniAppPreviewPayload = { previewVersion: 1, id: compiled.plan.id, title: compiled.plan.title, inputs: compiled.plan.inputs, document: compiled.plan.document, viewports: compiled.plan.viewports };
    boundedJson(payload, 128_000);
    return { status: "ready", payload, snapshot: compiled.plan.title };
  } catch { return { status: "invalid" }; }
}
/** Recompile authoring data at the browser boundary; never trust an incoming DOM tree. */
export function validateMiniAppPreview(value: unknown) {
  boundedJson(value, 128_000);
  const payload = jsonRecord(value, "preview"); exactKeys(payload, ["previewVersion", "id", "title", "inputs", "document", "viewports"], "preview");
  if (payload.previewVersion !== 1) throw new Error("Unsupported mini app preview");
  return compileMiniAppPlan({ planVersion: 1, id: payload.id, title: payload.title, purpose: "Preview", assumptions: [], inputs: payload.inputs, document: payload.document, viewports: payload.viewports,
    stateSchema: { type: "null" }, program: inertProgram, initialSnapshot: "Preview" });
}
