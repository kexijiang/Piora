import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireSessionMutation } from "../session-mutation";
import { beginPromptRun, finishPromptRun, getActivePromptRun, type PromptRunIdentity } from "../prompt-run-registry";
import { openOwnedSessionManager, type OwnedSessionManager } from "../session-owned-manager";
import { invalidateSessionListCache } from "../session-reader";
import { withUiSessionMutationLock, withUiSessionReadLock } from "../intelligent-ui/session-lock";
import { authorizeUiMigration, revokeUiMigrationAuthorization, type UiMigrationAuthorization } from "../intelligent-ui/migration-authorization";
import { betaFeatureRevision, subscribeBetaFeatureChanges } from "../beta-feature-events";
import { answerDataDigest } from "../answer-output-receipts";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import { validateMiniAppInputs, type MiniAppResult } from "./plan";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { readMiniAppMigrationBase, commitMiniAppMigration } from "./journal";
import { trialMiniApp } from "./server-trial";
import type { MiniAppMigrationChoice, MiniAppMigrationPreview } from "./migration-types";
import { miniAppCheckpointChanges } from "./checkpoint-changes";

export function parseMiniAppMigrationChoice(value: unknown): MiniAppMigrationChoice {
  const choice = jsonRecord(JSON.parse(boundedJson(value, MINI_APP_LIMITS.replyBytes)), "migration");
  exactKeys(choice, ["toolCallId", "publicationId", "digest", "leafId", "requestId", "decision", "inputs", "progress", "previewDigest"], "migration");
  for (const key of ["toolCallId", "publicationId", "leafId", "requestId"]) {
    if (typeof choice[key] !== "string" || !choice[key] || choice[key].length > 256) throw new MiniAppError("IDENTITY", "Invalid migration identity", key);
  }
  if (typeof choice.digest !== "string" || !/^[a-f0-9]{64}$/.test(choice.digest) || !["confirm", "cancel"].includes(String(choice.decision))) {
    throw new MiniAppError("IDENTITY", "Invalid migration decision");
  }
  jsonRecord(choice.inputs, "migration/inputs");
  if (choice.progress !== undefined && choice.progress !== "reset" && choice.progress !== "migrate") throw new MiniAppError("SCHEMA", "Invalid progress choice");
  if (choice.decision === "cancel" && choice.progress === "migrate") throw new MiniAppError("SCHEMA", "Cancellation cannot migrate progress");
  if (choice.decision === "cancel" && Object.keys(choice.inputs as object).length) throw new MiniAppError("SCHEMA", "Cancellation cannot change inputs");
  if (choice.previewDigest !== undefined && (choice.decision !== "confirm" || typeof choice.previewDigest !== "string" || !/^[a-f0-9]{64}$/.test(choice.previewDigest))) {
    throw new MiniAppError("SCHEMA", "Invalid migration preview identity");
  }
  return choice as unknown as MiniAppMigrationChoice;
}

/** Bind the actual isolated result, not a model's description or a mutable UI label. */
function previewDigest(choice: MiniAppMigrationChoice, result: MiniAppResult) {
  return answerDataDigest({ publicationId: choice.publicationId, toolCallId: choice.toolCallId, digest: choice.digest,
    leafId: choice.leafId, inputs: choice.inputs, progress: choice.progress ?? "reset", result });
}

/** Explicit host preview. No session owner, prompt run, journal intent or saved state is created. */
export async function previewMiniAppMigration(options: {
  sessionId: string; sessionFile: string; input: unknown; root?: string; enabled(): boolean; signal?: AbortSignal;
}): Promise<MiniAppMigrationPreview> {
  const choice = parseMiniAppMigrationChoice(options.input), root = options.root ?? getAgentDir();
  if (choice.decision !== "confirm" || choice.previewDigest) throw new MiniAppError("SCHEMA", "Expected an unconfirmed preview choice");
  const { answerOutputSessionReader } = await import("../answer-output-session");
  const { getRpcSession } = await import("../rpc-manager");
  const read = await answerOutputSessionReader(options.sessionId, options.sessionFile);
  const revision = betaFeatureRevision(root), cancellation = new AbortController();
  const unsubscribe = subscribeBetaFeatureChanges(root, features => { if (!features.intelligentUi) cancellation.abort(); });
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const current = () => {
    if (!options.enabled() || betaFeatureRevision(root) !== revision) throw new MiniAppError("DISABLED", "Intelligent UI changed during preview");
    if (signal.aborted) throw new MiniAppError("STOPPED", "Preview stopped");
    if (getRpcSession(options.sessionId)?.isRunning() || getActivePromptRun(options.sessionId)) throw new MiniAppError("CONFLICT", "Wait for the current task before previewing");
    const leaf = read().getLeafId();
    if (leaf !== choice.leafId) throw new MiniAppError("CONFLICT", "The selected branch changed; refresh the review");
    const base = readMiniAppMigrationBase(options.sessionId, options.sessionFile, choice.toolCallId, leaf, root);
    if (base.record.migration || base.review.status !== "ready" || base.review.publicationId !== choice.publicationId || base.review.digest !== choice.digest
      || !base.sourceSnapshot || !base.sourcePlan || !base.sourceResult) throw new MiniAppError("CONFLICT", "Source state changed; refresh the review");
    if (choice.progress === "migrate" && !base.review.progress) throw new MiniAppError("CONFLICT", "Progress preservation is unavailable for this source");
    validateMiniAppInputs(base.record.plan, choice.inputs);
    return base;
  };
  try {
    const base = await withUiSessionReadLock(options.sessionId, root, current);
    const result = await trialMiniApp(base.record.plan, { inputs: choice.inputs, signal,
      ...(choice.progress === "migrate" ? { migration: { sourcePlan: base.sourcePlan!, snapshot: base.sourceSnapshot! } } : {}) });
    return await withUiSessionReadLock(options.sessionId, root, () => {
      current(); // A save, navigation, cancellation or confirmation while the worker ran invalidates its result.
      return { digest: previewDigest(choice, result), sourceSummary: base.sourceResult!.frame.summary, resultSummary: result.frame.summary,
        changes: miniAppCheckpointChanges(base.sourceSnapshot!, result.snapshot) };
    });
  } finally { unsubscribe(); }
}

export async function readMiniAppMigration(options: { sessionId: string; sessionFile: string; toolCallId: string; root?: string }) {
  const { answerOutputSessionReader } = await import("../answer-output-session");
  const read = await answerOutputSessionReader(options.sessionId, options.sessionFile), root = options.root ?? getAgentDir();
  return withUiSessionReadLock(options.sessionId, root, () => {
    const manager = read(), leaf = manager.getLeafId();
    if (!leaf) throw new MiniAppError("CONFLICT", "No conversation branch is selected");
    return readMiniAppMigrationBase(options.sessionId, options.sessionFile, options.toolCallId, leaf, root).review;
  });
}

/** Same-origin host interaction; never a generated program or an old model run. */
export async function confirmMiniAppMigration(options: {
  sessionId: string; sessionFile: string; input: unknown; root?: string; enabled(): boolean; signal?: AbortSignal;
}) {
  const choice = parseMiniAppMigrationChoice(options.input), root = options.root ?? getAgentDir();
  const { getRpcSession, stopRpcSessionsForFileMutation } = await import("../rpc-manager");
  const mutation = (() => {
    try { return acquireSessionMutation([options.sessionId], root); }
    catch { throw new MiniAppError("CONFLICT", "Another operation owns this conversation"); }
  })();
  let owned: OwnedSessionManager | undefined, identity: PromptRunIdentity | undefined, authorization: UiMigrationAuthorization | undefined;
  const revision = betaFeatureRevision(root), cancellation = new AbortController();
  const unsubscribe = subscribeBetaFeatureChanges(root, features => { if (!features.intelligentUi) cancellation.abort(); });
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const assertAllowed = () => {
    mutation.assertOwned(); owned?.assertOwned();
    if (!options.enabled() || betaFeatureRevision(root) !== revision) throw new MiniAppError("DISABLED", "Intelligent UI changed during confirmation");
    if (signal.aborted) throw new MiniAppError("STOPPED", "Confirmation stopped; read its result before retrying");
  };
  try {
    assertAllowed();
    const live = getRpcSession(options.sessionId);
    if (live?.isRunning() || getActivePromptRun(options.sessionId)) throw new MiniAppError("CONFLICT", "Wait for the current task to finish before confirming");
    const selectedLeaf = live?.isAlive() ? live.inner.sessionManager.getLeafId() : undefined;
    if (selectedLeaf === null) throw new MiniAppError("CONFLICT", "No conversation branch is selected");
    await stopRpcSessionsForFileMutation([options.sessionId], { rejectRunning: true });
    assertAllowed();
    owned = openOwnedSessionManager(options.sessionFile, undefined, root);
    if (owned.manager.getSessionId() !== options.sessionId) throw new MiniAppError("IDENTITY", "Session identity changed");
    if (selectedLeaf) owned.manager.branch(selectedLeaf);
    identity = beginPromptRun(options.sessionId);
    const manager = owned.manager, runId = identity.runId;
    authorization = authorizeUiMigration({ identity, proposalId: choice.publicationId, digest: choice.digest, choiceDigest: answerDataDigest(choice),
      signal, assertOwned: assertAllowed, isActive: () => getActivePromptRun(options.sessionId)?.runId === runId });
    const base = await withUiSessionMutationLock(options.sessionId, root, { assertOwned: assertAllowed }, () => {
      assertAllowed();
      const current = readMiniAppMigrationBase(options.sessionId, options.sessionFile, choice.toolCallId, manager.getLeafId()!, root);
      if (current.record.migration && current.record.migration.requestDigest !== answerDataDigest(choice)) throw new MiniAppError("CONFLICT", "A different confirmation already owns this revision");
      if (!current.record.migration && (current.review.status !== "ready" || current.review.digest !== choice.digest || current.review.leafId !== choice.leafId)) {
        throw new MiniAppError("CONFLICT", "Source state changed; refresh the review");
      }
      if (choice.decision === "confirm") validateMiniAppInputs(current.record.plan, choice.inputs);
      if (!current.record.migration && choice.progress === "migrate" && !current.review.progress) throw new MiniAppError("CONFLICT", "Progress preservation is unavailable for this source");
      return current;
    });
    const result = choice.decision === "confirm" && !base.record.migration
      ? await trialMiniApp(base.record.plan, { inputs: choice.inputs, signal,
        ...(choice.progress === "migrate" ? { migration: { sourcePlan: base.sourcePlan!, snapshot: base.sourceSnapshot! } } : {}) }) : base.record.migration?.result;
    // Older clients/receipts omit this field. New host choices bind exactly what
    // the user previewed; retries retain the original durable choice/result.
    if (!base.record.migration && choice.previewDigest && (!result || previewDigest(choice, result) !== choice.previewDigest)) {
      throw new MiniAppError("CONFLICT", "The result differs from its preview; review the selected changes again");
    }
    return await withUiSessionMutationLock(options.sessionId, root, { assertOwned: assertAllowed }, lease => {
      const response = commitMiniAppMigration({ manager, root, choice, result, authorization: authorization!, assertOwned: () => { lease(); assertAllowed(); } });
      invalidateSessionListCache(); return response;
    });
  } finally {
    unsubscribe();
    if (authorization) revokeUiMigrationAuthorization(authorization);
    try { await finishPromptRun(identity, signal.aborted ? "abort" : "idle"); }
    finally { try { owned?.release(); } finally { mutation(); } }
  }
}
