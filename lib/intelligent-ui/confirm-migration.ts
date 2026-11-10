import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { acquireSessionMutation } from "../session-mutation";
import { beginPromptRun, finishPromptRun, getActivePromptRun, type PromptRunIdentity } from "../prompt-run-registry";
import { openOwnedSessionManager, type OwnedSessionManager } from "../session-owned-manager";
import { invalidateSessionListCache } from "../session-reader";
import { UiGenerationPrototype, UiGenerationError, generationDigest } from "./generation-journal";
import { authorizeUiMigration, revokeUiMigrationAuthorization, type UiMigrationAuthorization } from "./migration-authorization";

/** Same-origin HTTP entry only; never a model tool or a continuation of its old run. */
export async function confirmUiMigration(options: { sessionId: string; sessionFile: string;
  input: Parameters<UiGenerationPrototype["confirmMigration"]>[0]; signal?: AbortSignal; enabled(): boolean; root?: string }) {
  const root = options.root ?? getAgentDir();
  const { getRpcSession, stopRpcSessionsForFileMutation } = await import("../rpc-manager");
  const mutation = (() => {
    try { return acquireSessionMutation([options.sessionId], root); }
    catch { throw new UiGenerationError("CONFLICT", "Another operation owns this conversation; retry after it finishes"); }
  })();
  let owned: OwnedSessionManager | undefined, identity: PromptRunIdentity | undefined, authorization: UiMigrationAuthorization | undefined;
  const assertAllowed = () => {
    mutation.assertOwned(); owned?.assertOwned();
    if (options.signal?.aborted || !options.enabled()) throw new UiGenerationError("CANCELLED", "UI confirmation is cancelled or disabled");
  };
  try {
    assertAllowed();
    const live = getRpcSession(options.sessionId);
    if (live?.isRunning() || getActivePromptRun(options.sessionId)) throw new UiGenerationError("CONFLICT", "Wait for the current task to finish before reviewing this change");
    const selectedLeaf = live?.isAlive() ? live.inner.sessionManager.getLeafId() : undefined;
    if (selectedLeaf === null) throw new UiGenerationError("CONFLICT", "No conversation branch is selected");
    await stopRpcSessionsForFileMutation([options.sessionId], { rejectRunning: true });
    assertAllowed();
    owned = openOwnedSessionManager(options.sessionFile, undefined, root);
    if (owned.manager.getSessionId() !== options.sessionId) throw new UiGenerationError("IDENTITY", "Session identity changed");
    if (selectedLeaf) owned.manager.branch(selectedLeaf);
    identity = beginPromptRun(options.sessionId);
    const host = new UiGenerationPrototype({ manager: owned.manager, root, mutationOwner: { assertOwned: assertAllowed } });
    // The locked method validates the full state. IDs only locate a proposal;
    // the click's exact choices bind this separate host authorization.
    const choiceState = options.input.decision === "cancel" ? {} : options.input.state;
    const choiceDigest = generationDigest({ decision: options.input.decision, state: choiceState });
    const runId = identity.runId;
    authorization = authorizeUiMigration({ identity, proposalId: options.input.proposalId, digest: options.input.digest,
      choiceDigest, signal: options.signal, assertOwned: assertAllowed, isActive: () => getActivePromptRun(options.sessionId)?.runId === runId });
    const result = await host.confirmMigration(options.input, authorization);
    invalidateSessionListCache(); return result;
  } finally {
    if (authorization) revokeUiMigrationAuthorization(authorization);
    try { await finishPromptRun(identity, options.signal?.aborted ? "abort" : "idle"); }
    finally { try { owned?.release(); } finally { mutation(); } }
  }
}
