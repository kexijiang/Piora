import { exactKeys, jsonRecord, readId } from "./json";
import { MINI_APP_LIMITS, miniAppError } from "./limits";
import type { MiniAppDocument, MiniAppDocumentNode } from "./document";
import type { CompiledMiniApp, MiniAppPlan1 } from "./plan";
import type { MiniAppCheckpoint, MiniAppVmRequest } from "./vm";

export type MiniAppPlayback = { mode: "none" | "continuous" } | { mode: "discrete"; stepEvent: string };

/** Omission belongs only to previously saved v1.0 plans; never infer semantics from labels. */
export function compileMiniAppPlayback(value: unknown, document: MiniAppDocument): MiniAppPlayback | undefined {
  if (value === undefined) return undefined;
  const v = jsonRecord(value, "playback");
  if (v.mode === "none" || v.mode === "continuous") {
    exactKeys(v, ["mode"], "playback");
    return { mode: v.mode };
  }
  if (v.mode !== "discrete") miniAppError("SCHEMA", "playback/mode", "Expected none, discrete or continuous playback");
  exactKeys(v, ["mode", "stepEvent"], "playback");
  const stepEvent = readId(v.stepEvent, "playback/stepEvent");
  const button = (node: MiniAppDocumentNode): boolean => node.type === "element"
    && (node.tag === "button" && node.attrs["data-event"] === stepEvent || node.children.some(button));
  if (!document.nodes.some(button)) miniAppError("BINDING", "playback/stepEvent", "Discrete playback must name a declared button data-event; its click and host steps use the same reducer");
  return { mode: "discrete", stepEvent };
}

export function miniAppPlaybackMode(plan: Pick<MiniAppPlan1, "playback">): MiniAppPlayback["mode"] {
  return plan.playback?.mode ?? "continuous";
}

/** The same request is used for a native button, host step, autoplay and server trial. */
export function miniAppStepRequest(compiled: CompiledMiniApp, snapshot: MiniAppCheckpoint): MiniAppVmRequest | undefined {
  const playback = compiled.plan.playback;
  if (playback?.mode === "none") return undefined;
  return { command: "step", snapshot, ...(playback?.mode === "discrete" ? { event: { type: "click", id: playback.stepEvent } } : {}) };
}

export function miniAppStepInterval(plan: Pick<MiniAppPlan1, "playback">): number {
  // Educational steps remain readable. Wall-clock cadence does not alter the saved logical step.
  return plan.playback?.mode === "discrete" ? 750 : 1000 / MINI_APP_LIMITS.framesPerSecond;
}
