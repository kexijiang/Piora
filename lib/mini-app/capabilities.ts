import { MINI_APP_CAPABILITIES, MINI_APP_CAPABILITY_MANIFEST_VERSION, type MiniAppCapabilityId } from "./capability-manifest";
import { MiniAppError } from "./limits";
import type { CompiledMiniApp } from "./plan";
import type { MiniAppDocumentNode } from "./document";

export interface MiniAppCapabilityEvidence {
  manifestVersion: number;
  entries: Array<{ id: MiniAppCapabilityId; version: number; result: "passed"; platform: string;
    scope: string; checks: string[]; sources: Record<string, string> }>;
}
export interface MiniAppCapabilityState {
  id: MiniAppCapabilityId; version: number; status: "planned" | "implemented" | "verified";
  available: boolean; reason: string; evidenceScope?: string;
}
export interface MiniAppCapabilitySnapshot {
  manifestVersion: number; development: boolean; capabilities: MiniAppCapabilityState[];
}
export interface MiniAppCapabilityEnvironment { platform: string; wasm: boolean; webgl: boolean; development: boolean }

/** Pure evaluation: tests can supply evidence without granting a production override. */
export function evaluateMiniAppCapabilities(evidence: MiniAppCapabilityEvidence | undefined, digests: Record<string, string>, environment: MiniAppCapabilityEnvironment): MiniAppCapabilitySnapshot {
  const states = new Map<MiniAppCapabilityId, MiniAppCapabilityState>();
  for (const capability of MINI_APP_CAPABILITIES) {
    // Keep the planned gate even when every current manifest entry is implemented.
    const planned = (capability.implementation as string) === "planned";
    const record = evidence?.manifestVersion === MINI_APP_CAPABILITY_MANIFEST_VERSION
      ? evidence.entries.find(entry => entry.id === capability.id && entry.version === capability.version && entry.result === "passed") : undefined;
    const verified = !planned && !!record && record.platform === environment.platform
      && !!record.scope && record.checks.length > 0 && capability.sources.every(file => !!digests[file] && record.sources[file] === digests[file]);
    const status = planned ? "planned" : verified ? "verified" : "implemented";
    const ready = environment[capability.environment];
    const dependencies = capability.requires.every(id => states.get(id)?.available);
    const available = status !== "planned" && ready && dependencies && (verified || environment.development);
    states.set(capability.id, { id: capability.id, version: capability.version, status, available,
      reason: status === "planned" ? "Not implemented" : !ready ? "Required host environment is unavailable or unconfirmed"
        : !dependencies ? "A required capability is unavailable" : !verified && !environment.development ? "Verification is missing, stale or for another platform"
          : !verified ? "Isolated development validation only" : "Verified for the recorded scope",
      ...(verified ? { evidenceScope: record!.scope } : {}) });
  }
  return { manifestVersion: MINI_APP_CAPABILITY_MANIFEST_VERSION, development: environment.development, capabilities: [...states.values()] };
}
export function hasMiniAppCapability(snapshot: MiniAppCapabilitySnapshot, id: MiniAppCapabilityId): boolean {
  return snapshot.capabilities.some(capability => capability.id === id && capability.available);
}
export function requiredMiniAppCapabilities(compiled: CompiledMiniApp): MiniAppCapabilityId[] {
  const required = new Set<MiniAppCapabilityId>(["document"]);
  if (compiled.document.events.length) required.add("events");
  if (compiled.plan.playback?.mode !== "none") required.add("playback");
  const visit = (nodes: MiniAppDocumentNode[]) => { for (const node of nodes) if (node.type === "element") { if (node.svg) required.add("svg"); visit(node.children); } };
  visit(compiled.document.nodes);
  if (compiled.document.repeats?.length) { required.add("repeat"); for (const repeat of compiled.document.repeats) visit(repeat.template); }
  for (const viewport of compiled.plan.viewports) {
    required.add(viewport.kind === "canvas2d" ? "canvas2d" : "scene3d");
    if (viewport.picking) required.add("scenePicking");
    if (viewport.cameraControls) required.add("cameraControls");
    if (viewport.groups) required.add("sceneGroups");
  }
  if (compiled.plan.actions) required.add("registeredActions");
  if (compiled.plan.inputPresets) required.add("inputPresets");
  if (compiled.plan.migration) required.add("stateMigration");
  if (compiled.plan.conversion) required.add("outputConversion");
  return [...required];
}
/** Admission only. Historical compilation, projection and read paths stay independent. */
export function assertMiniAppCapabilities(compiled: CompiledMiniApp, snapshot: MiniAppCapabilitySnapshot): void {
  for (const id of requiredMiniAppCapabilities(compiled)) if (!hasMiniAppCapability(snapshot, id)) {
    throw new MiniAppError("CAPABILITY_UNAVAILABLE", `Mini app capability '${id}' is unavailable. ${snapshot.capabilities.find(capability => capability.id === id)?.reason ?? "Unknown capability"}. Preserve the existing answer; do not retry the same unsupported operation.`, "capabilities/" + id, false);
  }
}
