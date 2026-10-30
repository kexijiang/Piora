import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readBetaFeatures } from "../beta-features";
import { getActivePromptRun } from "../prompt-run-registry";
import { resolveOrStartRpcSession } from "../session-runtime-resolver";
import { getRpcSession } from "../rpc-manager";
import { assertUiAction } from "./action-contract";
import { intelligentUiSessionReader } from "./session";
import { UiGenerationPrototype, isUiGenerationError } from "./generation-journal";
import { recoverUiAction, runUiAction } from "./action-runtime";
import type { UiActionOperation, UiActionStart } from "./action-operation";

interface LiveAction {
  sessionId: string; input: UiActionStart; runId?: string;
  ready: Promise<UiActionOperation>;
  cancel(): void;
  pending?: { id: string; message: string; resolve(value: "once" | "deny"): void };
}
declare global { var __pioraUiActions: Map<string, LiveAction> | undefined; }
const liveActions = () => globalThis.__pioraUiActions ??= new Map();
const key = (sessionId: string, id: string) => `${sessionId}:${id}`;
const enabled = () => readBetaFeatures().intelligentUi;
const isLive = (sessionId: string, runId: string) => getActivePromptRun(sessionId)?.runId === runId;
async function reader(sessionId: string, path: string) {
  const manager = (await intelligentUiSessionReader(sessionId, path))();
  return { manager, host: new UiGenerationPrototype({ manager, root: getAgentDir() }) };
}
function sameIntent(a: UiActionStart, b: UiActionStart) {
  return a.actionId === b.actionId && a.sourceDigest === b.sourceDigest && a.toolCallId === b.toolCallId && a.requestId === b.requestId;
}

export async function readUiActions(sessionId: string, path: string, toolCallId: string) {
  const { host } = await reader(sessionId, path);
  let source;
  try { source = await host.readActionSource(toolCallId); }
  catch (error) { if (!isUiGenerationError(error) || !["CONFLICT", "IDENTITY"].includes(error.code)) throw error; }
  const operations = await host.readActions(toolCallId);
  return { source: source ? { digest: source.digest, actions: source.actions, state: source.state, revision: source.revision } : null,
    operations: operations.map(operation => {
      const live = liveActions().get(key(sessionId, operation.id));
      // A read-only projection communicates interrupted attempts without reviving them.
      const status = !isLive(sessionId, operation.runId) && ["prepared", "waiting_approval", "executing"].includes(operation.status)
        ? operation.status === "executing" && operation.action.kind === "save_snapshot" ? "uncertain" : "cancelled" : operation.status;
      return { ...operation, status, ...(live?.pending && isLive(sessionId, operation.runId)
        ? { approval: { id: live.pending.id, message: live.pending.message } } : {}) };
    }) };
}

export async function startUiAction(sessionId: string, path: string, input: UiActionStart): Promise<UiActionOperation> {
  const { host } = await reader(sessionId, path);
  const existing = (await host.readActions(input.toolCallId)).find(item => item.id === input.requestId);
  if (existing) {
    assertUiAction(existing.source.digest === input.sourceDigest && existing.action.id === input.actionId, "CONFLICT", "Request ID already used");
    return existing;
  }
  const actionKey = key(sessionId, input.requestId), existingLive = liveActions().get(actionKey);
  if (existingLive) { assertUiAction(sameIntent(existingLive.input, input), "CONFLICT", "Request ID already used"); return existingLive.ready; }
  let accept!: (value: UiActionOperation) => void, reject!: (error: unknown) => void;
  const ready = new Promise<UiActionOperation>((resolve, fail) => { accept = resolve; reject = fail; });
  let cancelled = false, cancelRun: (() => void) | undefined;
  const live: LiveAction = { sessionId, input, ready, cancel: () => { cancelled = true; live.pending?.resolve("deny"); cancelRun?.(); } };
  liveActions().set(actionKey, live);
  void (async () => {
    assertUiAction(enabled() && !cancelled, "CANCELLED", "Action cancelled or disabled");
    const { session, cwd } = await resolveOrStartRpcSession(sessionId);
    const actual = new UiGenerationPrototype({ manager: session.inner.sessionManager, root: getAgentDir() });
    const source = await actual.readActionSource(input.toolCallId);
    assertUiAction(source.digest === input.sourceDigest, "CONFLICT", "UI changed before the click was admitted");
    const action = source.actions.actions.find(item => item.id === input.actionId);
    assertUiAction(action, "INVALID", "Unknown registered action");
    const message = action.kind === "save_snapshot" ? `Create ${action.path} from the current UI parameters; do not overwrite existing files.`
      : `Read ${action.path} and show proposed UI parameters for me to review.`;
    await session.executeAnswerAction(input.requestId, message, async run => {
      live.runId = run.identity.runId;
      cancelRun = () => { if (isLive(sessionId, run.identity.runId)) void session.send({ type: "abort" }).catch(() => undefined); };
      const available = () => enabled() && !cancelled && session.inner.getActiveToolNames().includes("piora_render_ui_plan");
      const operation = await runUiAction({ host: actual, cwd, input, run, enabled: available, prepared: accept,
        ask: (text, signal) => new Promise<"once" | "deny">((resolve) => {
          if (signal.aborted || run.signal.aborted || cancelled) { resolve("deny"); return; }
          const approvalId = randomUUID();
          const finish = (value: "once" | "deny") => {
            clearTimeout(timer); signal.removeEventListener("abort", abort); run.signal.removeEventListener("abort", abort);
            if (live.pending?.id === approvalId) live.pending = undefined;
            resolve(value);
          };
          const abort = () => finish("deny");
          const timer = setTimeout(abort, 10 * 60_000);
          live.pending = { id: approvalId, message: text, resolve: finish };
          signal.addEventListener("abort", abort, { once: true }); run.signal.addEventListener("abort", abort, { once: true });
        }),
      });
      assertUiAction(operation.status === "completed", "CANCELLED", "Action did not complete; consult its saved result");
      return operation;
    });
  })().catch(reject).finally(() => { liveActions().delete(actionKey); });
  return ready;
}

export async function controlUiAction(sessionId: string, path: string, input: {
  operationId: string; command: "approve" | "deny" | "cancel" | "reconcile" | "apply"; approvalId?: string;
}, signal?: AbortSignal) {
  const { host, manager } = await reader(sessionId, path);
  const allowed = () => {
    assertUiAction(enabled() && !signal?.aborted, "CANCELLED", "Action cancelled or disabled");
    const current = getRpcSession(sessionId);
    assertUiAction(!current?.isAlive() || current.inner.sessionManager.getLeafId() === manager.getLeafId(), "CONFLICT", "Conversation branch changed during the request");
  };
  allowed();
  if (input.command === "apply") return host.applyActionParameters(input.operationId, allowed);
  const live = liveActions().get(key(sessionId, input.operationId));
  if (input.command === "approve" || input.command === "deny") {
    assertUiAction(live?.pending && live.pending.id === input.approvalId && !!live.runId && isLive(sessionId, live.runId), "CONFLICT", "This approval request is no longer active");
    const pending = live.pending;
    // A rejection needs branch visibility, not unchanged parameter values. A
    // stale approval cannot execute, and must also release its pending run so
    // the user can start another action instead of waiting for the timeout.
    try {
      await host.withActionOperation(input.operationId, (_, context) => {
        allowed(); if (input.command === "approve") context.currentSource();
      });
    } catch (error) { if (live.pending === pending) live.cancel(); throw error; }
    assertUiAction(live.pending === pending && isLive(sessionId, live.runId), "CONFLICT", "This approval request is no longer active");
    live.pending = undefined; pending.resolve(input.command === "approve" ? "once" : "deny");
    return { accepted: true };
  }
  if (input.command === "cancel" && live) {
    await host.withActionOperation(input.operationId, () => allowed());
    live.cancel(); return { accepted: true };
  }
  return recoverUiAction(host, input.operationId, manager.getCwd(), runId => isLive(sessionId, runId), input.command === "reconcile");
}
