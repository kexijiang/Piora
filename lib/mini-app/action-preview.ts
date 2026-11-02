import { answerDataDigest } from "../answer-output-receipts";
import type { MiniAppDocumentNode } from "./document";
import type { MiniAppFrame } from "./frame";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import { MiniAppError } from "./limits";
import { validateMiniAppCheckpoint, type CompiledMiniApp, type MiniAppResult } from "./plan";
import type { MiniAppCheckpoint } from "./vm";
import { miniAppCheckpointChanges, validateMiniAppCheckpointChanges, type MiniAppCheckpointChanges } from "./checkpoint-changes";

// Host-owned observation budgets, independent of the saved plan/runtime version.
export const MINI_APP_ACTION_PREVIEW_LIMITS = Object.freeze({ actions: 12, bytes: 48_000, snapshotCharacters: 1200, summaryCharacters: 384, contextCharacters: 4500 });
export interface MiniAppPreviewChoice { id: string; label: string; disabled: boolean }
export type MiniAppActionPreview = MiniAppPreviewChoice & ({ status: "disabled" } | {
  status: "ok"; summary: string; summaryComplete: boolean; checkpointUnchanged: boolean;
  snapshot: MiniAppCheckpoint | null; changes: MiniAppCheckpointChanges;
});
export interface MiniAppActionEvidence {
  version: 2; sourceCheckpointDigest: string; eligibleActions: number; omittedActions: number;
  actions: MiniAppActionPreview[];
}
type ContextAction = MiniAppPreviewChoice & ({ status: "disabled" } | {
  status: "ok"; checkpointUnchanged: boolean; changes: MiniAppCheckpointChanges;
});
export interface MiniAppActionContextEvidence extends Omit<MiniAppActionEvidence, "actions"> { actions: ContextAction[] }

/** Only declared local click targets. No host actions, row events, input edits or inferred labels. */
export function miniAppPreviewChoices(compiled: CompiledMiniApp, frame: MiniAppFrame): MiniAppPreviewChoice[] {
  const text = (node: MiniAppDocumentNode): string => node.type === "text" ? node.text
    : node.attrs["data-text"] ? String(frame.bindings[node.attrs["data-text"]] ?? "") : node.children.map(text).join("");
  const choices: MiniAppPreviewChoice[] = [];
  const visit = (node: MiniAppDocumentNode) => {
    if (node.type === "text") return;
    if (node.attrs["data-event"] && (node.tag === "button" || node.attrs.role === "button")) {
      choices.push({ id: node.attrs["data-event"], label: (node.attrs["aria-label"] || text(node)).trim().slice(0, 80),
        disabled: node.tag === "button" && Object.hasOwn(node.attrs, "disabled") });
    }
    for (const child of node.children) visit(child);
  };
  for (const node of compiled.document.nodes) visit(node);
  return choices;
}

export function miniAppPreviewOutcome(choice: MiniAppPreviewChoice, source: MiniAppCheckpoint, result: MiniAppResult): MiniAppActionPreview {
  return { ...choice, status: "ok", summary: result.frame.summary.slice(0, MINI_APP_ACTION_PREVIEW_LIMITS.summaryCharacters),
    summaryComplete: result.frame.summary.length <= MINI_APP_ACTION_PREVIEW_LIMITS.summaryCharacters,
    checkpointUnchanged: answerDataDigest(source) === answerDataDigest(result.snapshot),
    changes: miniAppCheckpointChanges(source, result.snapshot),
    snapshot: JSON.stringify(result.snapshot).length <= MINI_APP_ACTION_PREVIEW_LIMITS.snapshotCharacters ? result.snapshot : null };
}

/** Validate the trusted worker's bounded evidence without accepting arbitrary events or source identities. */
export function validateMiniAppActionEvidence(compiled: CompiledMiniApp, initial: MiniAppResult, value: unknown): MiniAppActionEvidence {
  boundedJson(value, MINI_APP_ACTION_PREVIEW_LIMITS.bytes);
  const evidence = jsonRecord(value, "preview"), choices = miniAppPreviewChoices(compiled, initial.frame);
  exactKeys(evidence, ["version", "sourceCheckpointDigest", "eligibleActions", "omittedActions", "actions"], "preview");
  const fail = () => { throw new MiniAppError("PROTOCOL", "Invalid local action preview evidence"); };
  if (evidence.version !== 2 || evidence.sourceCheckpointDigest !== answerDataDigest(initial.snapshot)
    || evidence.eligibleActions !== choices.length || !Array.isArray(evidence.actions)
    || evidence.actions.length !== Math.min(choices.length, MINI_APP_ACTION_PREVIEW_LIMITS.actions)
    || evidence.omittedActions !== choices.length - evidence.actions.length) fail();
  for (const [index, item] of (evidence.actions as unknown[]).entries()) {
    const action = jsonRecord(item, "preview/action"), choice = choices[index];
    exactKeys(action, ["id", "label", "disabled", "status", "summary", "summaryComplete", "checkpointUnchanged", "snapshot", "changes"], "preview/action");
    if (action.id !== choice.id || action.label !== choice.label || action.disabled !== choice.disabled) fail();
    if (choice.disabled) { if (action.status !== "disabled" || Object.keys(action).length !== 4) fail(); continue; }
    if (action.status !== "ok" || typeof action.summary !== "string" || action.summary.length > MINI_APP_ACTION_PREVIEW_LIMITS.summaryCharacters
      || typeof action.summaryComplete !== "boolean" || typeof action.checkpointUnchanged !== "boolean") fail();
    const changes = validateMiniAppCheckpointChanges(initial.snapshot, action.changes);
    if (action.checkpointUnchanged !== (changes.total === 0)) fail();
    if (action.snapshot !== null) {
      const snapshot = validateMiniAppCheckpoint(compiled, action.snapshot);
      if (JSON.stringify(snapshot).length > MINI_APP_ACTION_PREVIEW_LIMITS.snapshotCharacters
        || action.checkpointUnchanged !== (answerDataDigest(snapshot) === answerDataDigest(initial.snapshot))
        || answerDataDigest(changes) !== answerDataDigest(miniAppCheckpointChanges(initial.snapshot, snapshot))) fail();
    }
  }
  return value as MiniAppActionEvidence;
}

/** Keep whole outcomes; never truncate JSON into apparent partial state. */
export function compactMiniAppActionEvidence(evidence: MiniAppActionContextEvidence, maximum = MINI_APP_ACTION_PREVIEW_LIMITS.contextCharacters): MiniAppActionContextEvidence {
  // Do not repeat generated goal prose or duplicate full snapshots in every
  // alternative. Host-computed before/after facts are the evidence for a claim.
  const actions: ContextAction[] = evidence.actions.map(action => ({ id: action.id, label: action.label, disabled: action.disabled,
    ...(action.status === "disabled" ? { status: "disabled" as const } : { status: "ok" as const,
      checkpointUnchanged: action.checkpointUnchanged, changes: action.changes }) }));
  const compact = { ...evidence, actions };
  while (JSON.stringify(compact).length > maximum && compact.actions.length) { compact.actions.pop(); compact.omittedActions++; }
  return compact;
}
