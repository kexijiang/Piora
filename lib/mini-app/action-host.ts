import type { AnswerActionData, AnswerActionHost, AnswerActionSource } from "../intelligent-ui/action-host";
import type { UiActionOperation, UiActionStart } from "../intelligent-ui/action-operation";
import { assertUiAction, UI_ACTION_LIMITS } from "../intelligent-ui/action-contract";
import { readActionParameterData } from "../intelligent-ui/action-files";
import type { UiState } from "../intelligent-ui/surface-document";
import { answerDataDigest, answerDiskBranch, type AnswerDisk } from "../answer-output-receipts";
import { readMiniAppJournalView, withMiniAppActionJournal } from "./journal";
import { commitMiniAppState, readMiniAppSavedState, readMiniAppSaveReceipt } from "./state-store";
import { validateMiniAppInputs, type MiniAppPlan1, type MiniAppResult } from "./plan";
import { trialMiniApp } from "./server-trial";
import { MiniAppError } from "./limits";

interface Manager { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null }
export interface MiniAppActionSource extends AnswerActionSource { plan: MiniAppPlan1; result: MiniAppResult; planDigest: string }
const copy = <T>(value: T): T => structuredClone(value);
export const miniAppActionData: AnswerActionData<MiniAppActionSource> = {
  parameters: (cwd, action, source, expected) => readActionParameterData(cwd, action, expected,
    value => validateMiniAppInputs(source.plan, value) as UiState).state,
  snapshot: (action, source) => {
    const snapshot = `${source.plan.title}\n${source.result.frame.summary}`;
    assertUiAction(snapshot.length <= UI_ACTION_LIMITS.resultCharacters, "LIMIT", "Snapshot exceeds the action result budget");
    const text = action.format === "json" ? JSON.stringify({ version: 1, kind: "mini-app", appId: source.plan.id,
      title: source.plan.title, planDigest: source.planDigest, stateRevision: source.revision,
      parameters: source.state, checkpoint: source.result.snapshot, snapshot }, null, 2) + "\n"
      : `${snapshot}\n\n${JSON.stringify(source.result.snapshot, null, 2)}`.split(/\r\n?|\n/).map(line => `    ${line}`).join("\n") + "\n";
    const bytes = Buffer.from(text, "utf8");
    assertUiAction(bytes.length <= UI_ACTION_LIMITS.fileBytes, "LIMIT", "Encoded report exceeds the file byte budget");
    return bytes;
  },
};

/** Only this host reads publications/files. The sandbox has no action command. */
export class MiniAppActionHost implements AnswerActionHost<MiniAppActionSource> {
  constructor(private readonly options: { manager: Manager; root: string }) {}
  private locked<T>(work: Parameters<typeof withMiniAppActionJournal<T>>[2], readOnly = false) {
    return withMiniAppActionJournal(this.options.manager, this.options.root, work, readOnly);
  }
  private source(toolCallId: string, leafId: string): MiniAppActionSource {
    const { manager, root } = this.options, sessionId = manager.getSessionId();
    const publication = readMiniAppJournalView(sessionId, manager.getSessionFile()!, toolCallId, leafId, root);
    if (!publication?.active || !publication.record.plan.actions?.actions.length) throw new MiniAppError("CONFLICT", "Actions require the current committed mini app");
    const { record, disk } = publication, saved = readMiniAppSavedState(sessionId, root, record, disk, leafId);
    const source = { sessionId, toolCallId, operationId: record.operationId, leafId,
      publicationEntryId: (record.migration?.anchor ?? record.receipt)!.id, revision: saved.stateRevision,
      actions: record.plan.actions!, state: saved.result.snapshot.inputs as UiState, plan: record.plan,
      planDigest: record.planDigest, result: saved.result };
    const children = new Map<string, number>();
    for (const entry of disk.entries) if (entry.parentId) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    let identityLeaf = leafId;
    for (const entry of answerDiskBranch(disk, leafId).reverse()) {
      if (entry.type !== "session_info" || !entry.parentId || children.get(entry.parentId) !== 1) break;
      identityLeaf = entry.parentId;
    }
    return copy({ ...source, digest: answerDataDigest({ ...source, leafId: identityLeaf }) });
  }
  private visible(disk: AnswerDisk, leafId: string, operation: UiActionOperation) {
    const ancestry = new Set(answerDiskBranch(disk, leafId).map(entry => entry.id));
    return ancestry.has(operation.source.leafId) && ancestry.has(operation.source.publicationEntryId);
  }
  readActionSource(toolCallId: string) { return this.locked(({ leafId }) => this.source(toolCallId, leafId), true); }
  readActions(toolCallId: string) {
    return this.locked(({ disk, leafId, operations }) => copy(operations.filter(operation => operation.source.toolCallId === toolCallId && this.visible(disk, leafId, operation))), true);
  }
  prepareAction(input: UiActionStart, runId: string, prepare: Parameters<AnswerActionHost<MiniAppActionSource>["prepareAction"]>[2], assertAllowed: () => void) {
    return this.locked(({ disk, leafId, operations, save, assertOwned }) => {
      assertAllowed(); assertOwned();
      assertUiAction(/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId), "INVALID", "Invalid action request identity");
      const prior = operations.find(item => item.id === input.requestId);
      if (prior) {
        assertUiAction(prior.source.digest === input.sourceDigest && prior.source.toolCallId === input.toolCallId && prior.action.id === input.actionId
          && this.visible(disk, leafId, prior), "CONFLICT", "Action request ID was already used");
        return { created: false, operation: copy(prior) };
      }
      assertUiAction(operations.length < 1024, "LIMIT", "This conversation has reached its action capacity");
      const source = this.source(input.toolCallId, leafId);
      assertUiAction(source.digest === input.sourceDigest, "CONFLICT", "Mini app changed before the action started");
      const action = source.actions.actions.find(item => item.id === input.actionId);
      assertUiAction(action, "INVALID", "Unknown registered action");
      const { toolCallId, operationId, publicationEntryId, revision, digest } = source;
      const operation: UiActionOperation = { id: input.requestId, runId, createdAt: Date.now(),
        source: { toolCallId, operationId, publicationEntryId, leafId, revision, digest }, action: copy(action), status: "prepared", ...prepare(source) };
      operations.push(operation); assertAllowed(); save();
      return { created: true, operation: copy(operation) };
    });
  }
  withActionOperation<T>(id: string, work: (operation: UiActionOperation, context: {
    currentSource(): MiniAppActionSource; save(): void; assertOwned(): void;
  }) => T): Promise<T> {
    return this.locked(({ disk, leafId, operations, save, assertOwned }) => {
      const operation = operations.find(item => item.id === id);
      assertUiAction(operation && this.visible(disk, leafId, operation), "CONFLICT", "Action is not on the current conversation branch");
      return work(operation, { save, assertOwned, currentSource: () => {
        const source = this.source(operation.source.toolCallId, leafId);
        assertUiAction(source.digest === operation.source.digest, "CONFLICT", "Mini app changed after the click");
        return source;
      } });
    });
  }
  async applyActionParameters(id: string, assertAllowed: () => void) {
    const { manager, root } = this.options, sessionId = manager.getSessionId();
    const requestId = `mini-action-${id}`;
    const prepare = () => this.locked(({ disk, leafId, operations, save }) => {
      assertAllowed();
      const operation = operations.find(item => item.id === id);
      assertUiAction(operation?.status === "completed" && operation.result?.kind === "parameters" && this.visible(disk, leafId, operation), "CONFLICT", "No completed parameter query on this branch");
      const receipt = readMiniAppSaveReceipt(sessionId, root, requestId);
      const requestDigest = answerDataDigest({ kind: "mini-app-action-parameters", id, source: operation.source, inputs: operation.result.state });
      if (receipt) {
        assertUiAction(receipt.requestDigest === requestDigest && receipt.publicationId === operation.source.operationId
          && answerDiskBranch(disk, leafId).some(entry => entry.id === receipt.leafId), "CONFLICT", "Parameter receipt changed");
        operation.appliedRevision = receipt.stateRevision; save();
        return { done: { revision: receipt.stateRevision, alreadyApplied: true } };
      }
      const source = this.source(operation.source.toolCallId, leafId);
      assertUiAction(source.digest === operation.source.digest, "CONFLICT", "Mini app changed since the query; read parameters again");
      return { source, inputs: copy(operation.result.state), requestDigest };
    });
    const initial = await prepare();
    if (initial.done) return initial.done;
    const result = await trialMiniApp(initial.source!.plan, { snapshot: initial.source!.result.snapshot, parameterInputs: initial.inputs });
    return this.locked(({ disk, leafId, operations, save, assertOwned }) => {
      assertAllowed(); assertOwned();
      const operation = operations.find(item => item.id === id)!;
      assertUiAction(operation && this.visible(disk, leafId, operation), "CONFLICT", "Action branch changed");
      const existing = readMiniAppSaveReceipt(sessionId, root, requestId);
      if (existing) {
        assertUiAction(existing.requestDigest === initial.requestDigest && answerDiskBranch(disk, leafId).some(entry => entry.id === existing.leafId), "CONFLICT", "Parameter application changed");
        operation.appliedRevision = existing.stateRevision; save();
        return { revision: existing.stateRevision, alreadyApplied: true };
      }
      const source = this.source(operation.source.toolCallId, leafId);
      assertUiAction(source.digest === initial.source!.digest, "CONFLICT", "Mini app changed during parameter application");
      const publication = readMiniAppJournalView(sessionId, manager.getSessionFile()!, source.toolCallId, leafId, root)!;
      const receipt = commitMiniAppState({ sessionId, root, record: publication.record, disk, leafId, requestId,
        requestDigest: initial.requestDigest!, expectedRevision: source.revision, result, assertOwned: () => { assertAllowed(); assertOwned(); } });
      operation.appliedRevision = receipt.stateRevision; save();
      return { revision: receipt.stateRevision, alreadyApplied: false };
    });
  }
}
