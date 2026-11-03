import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withUiSessionLock, withUiSessionReadLock } from "../intelligent-ui/session-lock";
import { answerDataDigest, answerDiskBranch } from "../answer-output-receipts";
import { readMiniAppJournalView } from "./journal";
import { commitMiniAppState, readMiniAppSavedState, readMiniAppSaveReceipt, type MiniAppSavedState, type MiniAppSaveReceipt } from "./state-store";
import { compileMiniAppPlan, validateMiniAppCheckpoint, type MiniAppPlan1 } from "./plan";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { trialMiniApp } from "./server-trial";
import type { MiniAppCheckpoint } from "./vm";
import { betaFeatureRevision, subscribeBetaFeatureChanges } from "../beta-feature-events";

interface Manager { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null }
interface SessionOptions { sessionId: string; readManager(): Manager; root?: string }
export interface MiniAppOutput extends MiniAppSavedState {
  kind: "mini-app"; version: 1; toolCallId: string; leafId: string; writable: boolean;
  plan: MiniAppPlan1;
  publication: { id: string; revision: number; planDigest: string; runtimeVersion: string; status: "candidate" | "committed" | "aborted" | "awaiting_confirmation" | "superseded" };
}
export interface MiniAppSaveRequest {
  requestId: string; toolCallId: string; publicationId: string; planDigest: string; runtimeVersion: string;
  leafId: string; expectedRevision: number; checkpoint: MiniAppCheckpoint;
}
function identity(options: SessionOptions) {
  const manager = options.readManager(), file = manager.getSessionFile(), leafId = manager.getLeafId();
  if (manager.getSessionId() !== options.sessionId || !file || !leafId) throw new MiniAppError("IDENTITY", "Mini app session identity is unavailable");
  return { file: resolve(file), leafId };
}
function view(options: SessionOptions, toolCallId: string, selectedLeaf?: string) {
  const current = identity(options), leafId = selectedLeaf ?? current.leafId;
  const publication = readMiniAppJournalView(options.sessionId, current.file, toolCallId, leafId, options.root ?? getAgentDir());
  if (!publication) throw new MiniAppError("NOT_FOUND", "Mini app is not present on this conversation branch");
  return { ...publication, current };
}
export function readMiniAppOutput(options: SessionOptions & { toolCallId: string; leafId?: string; requiredAncestorLeafId?: string }): Promise<MiniAppOutput> {
  const root = options.root ?? getAgentDir();
  return withUiSessionReadLock(options.sessionId, root, () => {
    const publication = view(options, options.toolCallId, options.leafId), { record, disk, leafId, active } = publication;
    if (options.requiredAncestorLeafId !== undefined && (leafId !== publication.current.leafId || !active
      || !answerDiskBranch(disk, leafId).some(entry => entry.id === options.requiredAncestorLeafId))) {
      throw new MiniAppError("CONFLICT", "The recovery checkpoint is not on the current conversation branch");
    }
    const saved = record.status === "committed" ? readMiniAppSavedState(options.sessionId, root, record, disk, leafId)
      : { stateRevision: 0, checkpointDigest: answerDataDigest(record.initial.snapshot), result: record.initial, savedAt: null };
    return { ...saved, kind: "mini-app", version: 1, toolCallId: record.toolCallId, leafId,
      writable: active && publication.current.leafId === leafId, plan: record.plan,
      publication: { id: record.operationId, revision: record.revision, planDigest: record.planDigest, runtimeVersion: record.runtimeVersion,
        status: record.status === "committed" && !active ? "superseded" : record.status } };
  });
}
export function readMiniAppReceipt(options: SessionOptions & { toolCallId: string; requestId: string }): Promise<MiniAppSaveReceipt | undefined> {
  const root = options.root ?? getAgentDir();
  return withUiSessionReadLock(options.sessionId, root, () => {
    const { record, disk, leafId } = view(options, options.toolCallId);
    const receipt = readMiniAppSaveReceipt(options.sessionId, root, options.requestId);
    if (receipt && receipt.publicationId === record.operationId && answerDiskBranch(disk, leafId).some(entry => entry.id === receipt.leafId)) return receipt;
  });
}
function parseRequest(value: unknown): MiniAppSaveRequest {
  // Normalize through JSON only after checking descriptors, sizes and depth.
  const input = jsonRecord(JSON.parse(boundedJson(value, MINI_APP_LIMITS.replyBytes)), "save");
  exactKeys(input, ["requestId", "toolCallId", "publicationId", "planDigest", "runtimeVersion", "leafId", "expectedRevision", "checkpoint"], "save");
  for (const name of ["requestId", "toolCallId", "publicationId", "runtimeVersion", "leafId"]) {
    if (typeof input[name] !== "string" || input[name].length === 0 || input[name].length > 256) throw new MiniAppError("IDENTITY", "Invalid mini app save identity", name);
  }
  if (typeof input.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.planDigest)
    || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 0) throw new MiniAppError("IDENTITY", "Invalid mini app save revision");
  return input as unknown as MiniAppSaveRequest;
}
function writable(options: SessionOptions, request: MiniAppSaveRequest) {
  const current = view(options, request.toolCallId), { record, disk, leafId } = current;
  if (!current.active || record.operationId !== request.publicationId || record.planDigest !== request.planDigest || record.runtimeVersion !== request.runtimeVersion) {
    throw new MiniAppError("CONFLICT", "Mini app program changed; reload the saved output");
  }
  if (leafId !== request.leafId) {
    const branch = answerDiskBranch(disk, leafId), start = branch.findIndex(entry => entry.id === request.leafId);
    if (start < 0 || !branch.slice(start + 1).every(entry => entry.type === "session_info")
      || !branch.slice(start, -1).every(entry => disk.entries.filter(child => child.parentId === entry.id).length === 1)) {
      throw new MiniAppError("CONFLICT", "Conversation branch changed; recover the unsaved mini app state");
    }
  }
  return current;
}

export async function saveMiniAppOutput(options: SessionOptions & {
  request: unknown; enabled(): boolean; signal?: AbortSignal;
}): Promise<MiniAppSaveReceipt> {
  const request = parseRequest(options.request), root = options.root ?? getAgentDir(), requestDigest = answerDataDigest(request);
  const featureRevision = betaFeatureRevision(root), cancellation = new AbortController();
  const unsubscribe = subscribeBetaFeatureChanges(root, features => { if (!features.intelligentUi) cancellation.abort(); });
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const active = () => {
    if (!options.enabled() || betaFeatureRevision(root) !== featureRevision) throw new MiniAppError("DISABLED", "Intelligent UI was disabled or changed during this save; explicitly retry after checking the saved state");
    if (signal.aborted) throw new MiniAppError("STOPPED", "Mini app save was cancelled; check its receipt before retrying");
  };
  const prepare = () => {
    active();
    const publication = writable(options, request);
    const receipt = readMiniAppSaveReceipt(options.sessionId, root, request.requestId);
    if (receipt) {
      if (receipt.requestDigest !== requestDigest || receipt.publicationId !== request.publicationId) throw new MiniAppError("CONFLICT", "Mini app save request identity was reused");
      return { publication, receipt };
    }
    const saved = readMiniAppSavedState(options.sessionId, root, publication.record, publication.disk, publication.leafId);
    if (saved.stateRevision !== request.expectedRevision) throw new MiniAppError("CONFLICT", "Mini app state changed in another view");
    validateMiniAppCheckpoint(compileMiniAppPlan(publication.record.plan), request.checkpoint);
    return { publication, receipt: undefined };
  };
  try {
    const initial = await withUiSessionReadLock(options.sessionId, root, prepare);
    if (initial.receipt) return initial.receipt;
    // Project outside the write lock. Commit rechecks identity, branch and CAS;
    // the browser cannot persist a forged result or hold the lock with its code.
    const result = await trialMiniApp(initial.publication.record.plan, { snapshot: request.checkpoint, signal });
    return await withUiSessionLock(options.sessionId, root, lease => {
      const assertOwned = () => { lease(); active(); };
      assertOwned();
      const fresh = prepare();
      if (fresh.publication.current.file !== initial.publication.current.file) throw new MiniAppError("IDENTITY", "Mini app session file changed during save");
      if (fresh.receipt) return fresh.receipt;
      return commitMiniAppState({ sessionId: options.sessionId, root, record: fresh.publication.record, disk: fresh.publication.disk,
        leafId: fresh.publication.leafId, requestId: request.requestId, requestDigest, expectedRevision: request.expectedRevision, result, assertOwned });
    });
  } finally { unsubscribe(); }
}
