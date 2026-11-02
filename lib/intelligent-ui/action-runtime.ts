import { createHash } from "node:crypto";
import type { AnswerActionRun } from "../answer-output-action";
import { collectReviewEvidence } from "../tool-review-evidence";
import { isUiActionError, assertUiAction, actionErrorProblem } from "./action-contract";
import { actionSnapshotBytes, createActionSnapshot, inspectActionFile, readActionParameters, reconcileActionSnapshot } from "./action-files";
import { actionTerminal, type UiActionOperation, type UiActionStart } from "./action-operation";
import { generationDigest } from "./generation-journal";
import type { UiActionSource } from "./action-contract";
import type { AnswerActionData, AnswerActionHost, AnswerActionSource } from "./action-host";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);

/** All effects are synchronous inside the final source/operation lock; approval waits outside it. */
interface ActionOptions<S extends AnswerActionSource> {
  host: AnswerActionHost<S>; cwd: string; input: UiActionStart; run: AnswerActionRun;
  enabled(): boolean;
  prepared(operation: UiActionOperation): void;
  ask(message: string, signal: AbortSignal): Promise<"once" | "deny">;
}
export const componentActionData: AnswerActionData<UiActionSource> = {
  snapshot: (action, source) => actionSnapshotBytes(action, source.surface, source.state),
  parameters: (cwd, action, source, file) => readActionParameters(cwd, action, source.surface, file).state,
};
export function runUiAction(options: ActionOptions<UiActionSource>): Promise<UiActionOperation> {
  return runAnswerAction({ ...options, data: componentActionData });
}
export async function runAnswerAction<S extends AnswerActionSource>(options: ActionOptions<S> & { data: AnswerActionData<S> }): Promise<UiActionOperation> {
  const { host, run, cwd, input } = options;
  const active = () => {
    run.assertActive();
    assertUiAction(options.enabled(), "CANCELLED", "Intelligent UI actions are disabled");
  };
  let prepared: UiActionOperation | undefined;
  try {
    const start = await host.prepareAction(input, run.identity.runId, source => {
      const action = source.actions.actions.find(item => item.id === input.actionId)!;
      const file = inspectActionFile(cwd, action);
      assertUiAction(action.kind === "save_snapshot" ? !file.exists : file.exists, "TARGET",
        action.kind === "save_snapshot" ? "A report already exists at this path; existing files are never overwritten" : "Parameter file does not exist",
        action.kind === "save_snapshot" ? "file_exists" : "file_missing");
      return { file, ...(action.kind === "save_snapshot" ? { snapshotHash: hash(options.data.snapshot(action, source)) } : {}) };
    }, active);
    prepared = start.operation;
    options.prepared(prepared);
    if (!start.created) return prepared;
    const name = prepared.action.kind === "save_snapshot" ? "write" : "read";
    const args = { path: prepared.file.path, action: prepared.action.kind, sourceDigest: prepared.source.digest,
      ...(prepared.snapshotHash ? { contentSha256: prepared.snapshotHash, createOnly: true } : {}) };
    const assertAuthorized = await run.authorize({ name, args,
      evidence: async signal => host.withActionOperation(input.requestId, (operation, context) => {
        active(); assertUiAction(!signal.aborted, "CANCELLED", "Review cancelled");
        const source = context.currentSource();
        const file = inspectActionFile(cwd, operation.action);
        assertUiAction(generationDigest(file) === generationDigest(operation.file), "CONFLICT", "Action target changed after the click");
        const bytes = operation.action.kind === "save_snapshot" ? options.data.snapshot(operation.action, source) : undefined;
        assertUiAction(!bytes || hash(bytes) === operation.snapshotHash, "CONFLICT", "Report changed after the click");
        // This is the host's bounded read/create adapter; no extension-supplied executable is invoked.
        const evidence = collectReviewEvidence({ name, args: { path: file.path, ...(bytes ? { content: bytes.toString("utf8") } : {}) }, cwd,
          tool: { name, description: "Host answer action file adapter", sourceInfo: { source: "builtin", path: "", scope: "temporary", origin: "top-level" } } });
        return { ...evidence, fingerprint: generationDigest({ evidence: evidence.fingerprint, args, file }),
          context: { operation: evidence.context, action: operation.action.kind, sourceDigest: source.digest,
            ...(operation.snapshotHash ? { contentSha256: operation.snapshotHash, createOnly: true } : {}) } };
      }),
      ask: async (message, signal) => {
        await host.withActionOperation(input.requestId, (operation, context) => {
          active(); context.currentSource(); operation.status = "waiting_approval"; context.save();
        });
        return options.ask(message, signal);
      },
    });
    return await host.withActionOperation(input.requestId, (operation, context) => {
      active(); assertAuthorized(); context.assertOwned();
      assertUiAction(operation.runId === run.identity.runId && ["prepared", "waiting_approval"].includes(operation.status), "CONFLICT", "Action is no longer executable");
      const source = context.currentSource(), action = operation.action;
      const bytes = action.kind === "save_snapshot" ? options.data.snapshot(action, source) : undefined;
      assertUiAction(!bytes || hash(bytes) === operation.snapshotHash, "CONFLICT", "Report content changed");
      operation.status = "executing"; context.save(); // Durable before any effect.
      if (action.kind === "read_json_parameters") {
        operation.result = { kind: "parameters", state: options.data.parameters(cwd, action, source, operation.file) };
      } else {
        const result = createActionSnapshot(cwd, action, bytes!, operation.file, () => { active(); assertAuthorized(); context.assertOwned(); });
        operation.result = { kind: "snapshot", ...result };
      }
      operation.status = "completed"; context.save();
      return copy(operation);
    });
  } catch (error) {
    if (!prepared) throw error;
    return host.withActionOperation(input.requestId, (operation, context) => {
      if (actionTerminal(operation.status)) return copy(operation);
      operation.status = operation.status === "executing" && operation.action.kind === "save_snapshot" ? "uncertain"
        : run.signal.aborted || !options.enabled() ? "cancelled" : "failed";
      operation.error = isUiActionError(error) ? error.message : "Action stopped or its source changed. Refresh before trying a new action.";
      operation.problem = operation.status === "uncertain" ? "uncertain" : operation.status === "cancelled" ? "cancelled" : actionErrorProblem(error) ?? "interrupted";
      context.save(); return copy(operation);
    });
  }
}

/** Old runs cannot regain authorization. Recovery only observes a possible effect. */
export async function recoverUiAction<S extends AnswerActionSource>(host: AnswerActionHost<S>, id: string, cwd: string,
  isLive: (runId: string) => boolean, reconcile: boolean): Promise<UiActionOperation> {
  return host.withActionOperation(id, (operation, context) => {
    if (isLive(operation.runId)) return copy(operation);
    let changed = false;
    if (!actionTerminal(operation.status)) {
      operation.status = operation.status === "executing" && operation.action.kind === "save_snapshot" ? "uncertain" : "cancelled";
      operation.error = "The original run ended. This operation will not be replayed.";
      operation.problem = operation.status === "uncertain" ? "uncertain" : "cancelled";
      changed = true;
    }
    if (reconcile && operation.status === "uncertain" && operation.action.kind === "save_snapshot") {
      // Resolve against the original real project root, not a later runtime cwd.
      assertUiAction(inspectActionFile(cwd, operation.action).root === operation.file.root, "CONFLICT", "Action project changed");
      operation.reconciliation = reconcileActionSnapshot(cwd, operation.action, operation.snapshotHash!);
      changed = true;
    }
    if (changed) context.save();
    return copy(operation);
  });
}
