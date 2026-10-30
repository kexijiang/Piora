import { createHash } from "node:crypto";
import type { AnswerActionRun } from "../answer-output-action";
import { collectReviewEvidence } from "../tool-review-evidence";
import { isUiActionError, assertUiAction, actionErrorProblem } from "./action-contract";
import { actionSnapshotBytes, createActionSnapshot, inspectActionFile, readActionParameters, reconcileActionSnapshot } from "./action-files";
import { actionTerminal, type UiActionOperation, type UiActionStart } from "./action-operation";
import { generationDigest, UiGenerationPrototype } from "./generation-journal";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const copy = <T>(value: T): T => structuredClone(value);

/** All effects are synchronous inside the final source/operation lock; approval waits outside it. */
export async function runUiAction(options: {
  host: UiGenerationPrototype; cwd: string; input: UiActionStart; run: AnswerActionRun;
  enabled(): boolean;
  prepared(operation: UiActionOperation): void;
  ask(message: string, signal: AbortSignal): Promise<"once" | "deny">;
}): Promise<UiActionOperation> {
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
      return { file, ...(action.kind === "save_snapshot" ? { snapshotHash: hash(actionSnapshotBytes(action, source.surface, source.state)) } : {}) };
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
        const bytes = operation.action.kind === "save_snapshot" ? actionSnapshotBytes(operation.action, source.surface, source.state) : undefined;
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
      const bytes = action.kind === "save_snapshot" ? actionSnapshotBytes(action, source.surface, source.state) : undefined;
      assertUiAction(!bytes || hash(bytes) === operation.snapshotHash, "CONFLICT", "Report content changed");
      operation.status = "executing"; context.save(); // Durable before any effect.
      if (action.kind === "read_json_parameters") {
        const result = readActionParameters(cwd, action, source.surface, operation.file);
        operation.result = { kind: "parameters", state: result.state };
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
export async function recoverUiAction(host: UiGenerationPrototype, id: string, cwd: string,
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
