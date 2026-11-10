import { getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import { acquireSessionMutation } from "./session-mutation";
import { openOwnedSessionManager, type OwnedSessionManager } from "./session-owned-manager";
import { beginPromptRun, finishPromptRun, getActivePromptRun, type PromptRunIdentity } from "./prompt-run-registry";
import { betaFeatureRevision, subscribeBetaFeatureChanges } from "./beta-feature-events";
import { invalidateSessionListCache } from "./session-reader";
import { answerDataDigest, answerDiskBranch, readAnswerDisk, syncAnswerDisk, assertAnswerReceipt } from "./answer-output-receipts";
import { ANSWER_CONVERSION_COMPLETE, ANSWER_CONVERSION_INTENT, readAnswerConversionReceipts } from "./answer-output-conversion-receipts";
import type { AnswerConversionChoice, AnswerConversionIntent, AnswerConversionReview, AnswerConversionSpec } from "./answer-output-conversion-types";
import { UiGenerationPrototype } from "./intelligent-ui/generation-journal";
import { validateState, type UiState } from "./intelligent-ui/surface-document";
import { authorizeUiMigration, revokeUiMigrationAuthorization, type UiMigrationAuthorization } from "./intelligent-ui/migration-authorization";
import { withUiSessionReadLock, withUiSessionMutationLock } from "./intelligent-ui/session-lock";
import { readMiniAppConversionSource, readMiniAppConversionTarget, commitMiniAppConversionTarget } from "./mini-app/journal";
import { validateMiniAppInputs, type MiniAppResult } from "./mini-app/plan";
import { trialMiniApp } from "./mini-app/server-trial";
import { boundedJson, exactKeys, jsonRecord } from "./mini-app/json";
import { MiniAppError } from "./mini-app/limits";

type Kind = AnswerConversionSpec["fromKind"];
type Manager = Pick<SessionManager, "getSessionId" | "getSessionFile" | "getLeafId">;
type Owner = { assertOwned(): void };
function fail(message: string): never { throw new MiniAppError("CONFLICT", message); }
const reviewDigest = (intent: Pick<AnswerConversionIntent, "source" | "target" | "leafId">) => answerDataDigest(intent);
const requestDigest = (intent: Pick<AnswerConversionIntent, "requestId" | "decision" | "source" | "target" | "inputs">) => answerDataDigest(intent);

export function parseAnswerConversionChoice(value: unknown): AnswerConversionChoice {
  const input = jsonRecord(JSON.parse(boundedJson(value, 64 * 1024)), "conversion");
  exactKeys(input, ["kind", "toolCallId", "requestId", "leafId", "digest", "decision", "inputs"], "conversion");
  for (const key of ["toolCallId", "requestId", "leafId"]) if (typeof input[key] !== "string" || !input[key] || input[key].length > 200) throw new MiniAppError("IDENTITY", "Invalid conversion identity");
  if (!["mini-app", "intelligent-ui"].includes(String(input.kind)) || !["confirm", "cancel"].includes(String(input.decision))
    || typeof input.digest !== "string" || !/^[a-f0-9]{64}$/.test(input.digest)) throw new MiniAppError("SCHEMA", "Invalid conversion choice");
  const inputs = jsonRecord(input.inputs, "conversion/inputs");
  if (Object.keys(inputs).length > 128 || Object.values(inputs).some(value => !(typeof value === "boolean" || typeof value === "string" && value.length <= 4000 || typeof value === "number" && Number.isFinite(value)))
    || input.decision === "cancel" && Object.keys(inputs).length) throw new MiniAppError("SCHEMA", "Invalid conversion inputs");
  return input as unknown as AnswerConversionChoice;
}

function adapters(manager: Manager, root: string, owner?: Owner) {
  const sessionId = manager.getSessionId(), file = manager.getSessionFile()!;
  const ui = new UiGenerationPrototype({ manager, root, mutationOwner: owner });
  const lock = <T>(work: () => T) => owner ? withUiSessionMutationLock(sessionId, root, owner, work) : withUiSessionReadLock(sessionId, root, work);
  return {
    source: (kind: Kind, id: string) => kind === "intelligent-ui" ? ui.readConversionSource(id)
      : lock(() => readMiniAppConversionSource(sessionId, file, id, manager.getLeafId()!, root)),
    target: async (kind: Kind, id: string) => kind === "intelligent-ui" ? { kind, ...await ui.readConversionTarget(id) } as const
      : { kind, ...await lock(() => readMiniAppConversionTarget(sessionId, file, id, manager.getLeafId()!, root)) } as const,
    ui, lock,
  };
}
async function base(manager: Manager, root: string, kind: Kind, toolCallId: string, owner?: Owner) {
  const leafId = manager.getLeafId(); if (!leafId) fail("No conversation branch is selected");
  const access = adapters(manager, root, owner), target = await access.target(kind, toolCallId);
  const disk = readAnswerDisk(manager.getSessionFile()!, manager.getSessionId()), branch = answerDiskBranch(disk, leafId);
  const receipts = readAnswerConversionReceipts(disk, leafId);
  const completed = receipts.findLast(item => item.intent.target.operationId === target.target.identity.operationId);
  const pending = branch.filter(entry => entry.type === "custom" && entry.customType === ANSWER_CONVERSION_INTENT
    && (entry.data as AnswerConversionIntent)?.target?.operationId === target.target.identity.operationId
    && !receipts.some(receipt => receipt.intentId === entry.id)).at(-1);
  const source = await access.source(target.spec.fromKind, target.spec.fromToolCallId);
  const matches = source && source.identity.digest === target.spec.fromDigest && source.identity.appId === target.target.identity.appId;
  const intent = pending?.data as AnswerConversionIntent | undefined;
  const review: AnswerConversionReview = { kind, toolCallId, leafId,
    digest: source ? reviewDigest({ source: source.identity, target: target.target.identity, leafId }) : "0".repeat(64),
    status: completed ? completed.intent.decision === "confirm" ? "confirmed" : "cancelled" : matches ? "ready" : "stale",
    description: target.spec.description, source, target: target.target,
    ...(intent ? { pending: { kind, toolCallId, requestId: intent.requestId, leafId: intent.leafId,
      digest: reviewDigest({ source: intent.source, target: intent.target, leafId: intent.leafId }), decision: intent.decision, inputs: intent.inputs } } : {}) };
  if (manager.getLeafId() !== leafId) fail("Conversation branch changed during review");
  return { access, target, source, review, pending, completed, disk };
}

export async function readAnswerConversion(options: { sessionId: string; sessionFile: string; kind: Kind; toolCallId: string; root?: string }) {
  const { answerOutputSessionReader } = await import("./answer-output-session");
  const read = await answerOutputSessionReader(options.sessionId, options.sessionFile);
  return (await base(read(), options.root ?? getAgentDir(), options.kind, options.toolCallId)).review;
}

export async function validateAnswerConversionProposal(manager: Manager, root: string, spec: AnswerConversionSpec, appId: string) {
  const source = await adapters(manager, root).source(spec.fromKind, spec.fromToolCallId);
  if (!source || source.identity.digest !== spec.fromDigest || source.identity.appId !== appId) fail("Conversion must bind the exact active source from saved context and preserve its logical answer id");
}

/** Trusted host interaction, isolated from model execution and generated code. */
export async function confirmAnswerConversion(options: { sessionId: string; sessionFile: string; input: unknown; root?: string;
  enabled(): boolean; signal?: AbortSignal; fault?: (stage: "intent" | "state" | "complete") => void }) {
  const choice = parseAnswerConversionChoice(options.input), root = options.root ?? getAgentDir();
  const { getRpcSession, stopRpcSessionsForFileMutation } = await import("./rpc-manager");
  const mutation = acquireSessionMutation([options.sessionId], root);
  let owned: OwnedSessionManager | undefined, identity: PromptRunIdentity | undefined, authorization: UiMigrationAuthorization | undefined;
  const revision = betaFeatureRevision(root), cancellation = new AbortController();
  const unsubscribe = subscribeBetaFeatureChanges(root, features => { if (!features.intelligentUi) cancellation.abort(); });
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const assertOwned = () => {
    mutation.assertOwned(); owned?.assertOwned();
    if (!options.enabled() || betaFeatureRevision(root) !== revision) throw new MiniAppError("DISABLED", "Intelligent UI changed during conversion");
    if (signal.aborted) throw new MiniAppError("STOPPED", "Conversion stopped; read its saved status before retrying");
  };
  try {
    assertOwned();
    const live = getRpcSession(options.sessionId);
    if (live?.isRunning() || getActivePromptRun(options.sessionId)) fail("Wait for the current task to finish before confirming");
    const selected = live?.isAlive() ? live.inner.sessionManager.getLeafId() : undefined;
    if (selected === null) fail("No conversation branch is selected");
    await stopRpcSessionsForFileMutation([options.sessionId], { rejectRunning: true });
    owned = openOwnedSessionManager(options.sessionFile, undefined, root);
    const manager = owned.manager;
    if (manager.getSessionId() !== options.sessionId) fail("Session identity changed");
    if (selected) manager.branch(selected);
    identity = beginPromptRun(options.sessionId);
    const runId = identity.runId, owner = { assertOwned };
    const current = await base(manager, root, choice.kind, choice.toolCallId, owner);
    const { target, access } = current;
    if (current.completed) {
      const original = current.completed.intent;
      if (original.requestId !== choice.requestId || original.decision !== choice.decision || answerDataDigest(original.inputs) !== answerDataDigest(choice.inputs)
        || original.leafId !== choice.leafId || choice.digest !== reviewDigest({ source: original.source, target: original.target, leafId: original.leafId })) fail("This conversion already has a different decision");
      return { status: current.review.status, leafId: current.review.leafId };
    }
    if (!current.source || choice.decision === "confirm" && current.review.status !== "ready") fail("Conversion source changed; keep the old output and refresh the proposal");
    const resume = current.pending && current.review.pending?.requestId === choice.requestId ? current.pending : undefined;
    if (resume) {
      if (answerDataDigest(choice) !== answerDataDigest(current.review.pending) || manager.getLeafId() !== resume.id) fail("An unfinished conversion owns this choice; resume the saved request");
    } else if (choice.decision === "confirm" && current.pending || choice.leafId !== current.review.leafId || choice.digest !== current.review.digest) fail("Source state or branch changed; refresh the review");
    const selectedSource = current.source.identity, selectedTarget = target.target.identity;
    const digest = requestDigest({ requestId: choice.requestId, decision: choice.decision, source: selectedSource, target: selectedTarget, inputs: choice.inputs });
    authorization = authorizeUiMigration({ identity, proposalId: selectedTarget.operationId, digest: selectedTarget.digest, choiceDigest: digest,
      signal, assertOwned, isActive: () => getActivePromptRun(options.sessionId)?.runId === runId });
    let result: UiState | MiniAppResult | undefined;
    if (choice.decision === "confirm") {
      if (target.kind === "mini-app") { validateMiniAppInputs(target.plan, choice.inputs); result = await trialMiniApp(target.plan, { inputs: choice.inputs, signal }); }
      else { try { result = validateState(target.surface, choice.inputs); } catch { throw new MiniAppError("SCHEMA", "Chosen values do not match the target controls"); } }
    }
    assertOwned();
    // The mutation owner excludes UI saves, branching and tool actions throughout the trial.
    const fresh = await access.source(target.spec.fromKind, target.spec.fromToolCallId);
    if (!fresh || answerDataDigest(fresh.identity) !== answerDataDigest(selectedSource)) fail("Source state changed during conversion");
    const intent: AnswerConversionIntent = resume ? resume.data as AnswerConversionIntent : {
      version: 1, requestId: choice.requestId, runId, leafId: choice.leafId, decision: choice.decision,
      source: selectedSource, target: selectedTarget, inputs: choice.inputs, resultDigest: result ? answerDataDigest(result) : null };
    if (intent.resultDigest !== (result ? answerDataDigest(result) : null)) fail("The proposed result changed; conversion was not activated");
    let intentId = resume?.id;
    if (!intentId) intentId = await access.lock(() => {
      assertOwned(); const id = manager.appendCustomEntry(ANSWER_CONVERSION_INTENT, intent); syncAnswerDisk(options.sessionFile);
      const disk = readAnswerDisk(options.sessionFile, options.sessionId);
      assertAnswerReceipt(answerDataDigest(disk.byId.get(id)?.data) === answerDataDigest(intent), "Conversion intent was not persisted");
      return id;
    });
    options.fault?.("intent");
    if (choice.decision === "confirm") {
      if (target.kind === "mini-app") await access.lock(() => commitMiniAppConversionTarget({ manager, root, target: selectedTarget, intentId: intentId!, intent,
        requestDigest: digest, result: result as Awaited<ReturnType<typeof trialMiniApp>>, authorization: authorization!, assertOwned }));
      else await access.ui.commitConversionTarget({ target: selectedTarget, intentId, intent, requestDigest: digest, authorization });
    }
    options.fault?.("state");
    return await access.lock(() => {
      assertOwned();
      const completion = { version: 1, intentId, intentHash: answerDataDigest(intent), requestDigest: digest };
      const leafId = manager.appendCustomEntry(ANSWER_CONVERSION_COMPLETE, completion); syncAnswerDisk(options.sessionFile);
      const disk = readAnswerDisk(options.sessionFile, options.sessionId);
      assertAnswerReceipt(readAnswerConversionReceipts(disk, leafId).some(item => item.entryId === leafId && item.intentId === intentId), "Conversion completion was not persisted");
      invalidateSessionListCache(); options.fault?.("complete");
      return { status: choice.decision === "confirm" ? "confirmed" : "cancelled", leafId };
    });
  } finally {
    unsubscribe(); if (authorization) revokeUiMigrationAuthorization(authorization);
    try { await finishPromptRun(identity, signal.aborted ? "abort" : "idle"); }
    finally { try { owned?.release(); } finally { mutation(); } }
  }
}
