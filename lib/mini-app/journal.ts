import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { answerOutputMiniAppPublicationPath } from "../answer-output-paths";
import { withUiSessionLock, withUiSessionReadLock } from "../intelligent-ui/session-lock";
import { answerDataDigest, readAnswerDisk, syncAnswerDisk, answerDiskBranch, answerDeclaredCalls, answerTurnResults, assertAnswerReceipt, type AnswerDisk } from "../answer-output-receipts";
import { compileMiniAppPlan, validateMiniAppResult, type MiniAppPlan1, type MiniAppResult } from "./plan";
import type { MiniAppVmReply } from "./vm";
import { MiniAppError } from "./limits";
import { miniAppSavedStateReader, commitMiniAppState, type MiniAppSavedState } from "./state-store";
import { inheritAnswerForkCall, verifyAnswerForkCall, verifyAnswerForkMapping, type AnswerForkCall } from "../answer-output-inheritance";
import { copyMiniAppState } from "./state-store";
import { assessMiniAppMigration, type MiniAppMigrationChoice, type MiniAppMigrationReview } from "./migration-types";
import { assertUiMigrationAuthorization, type UiMigrationAuthorization } from "../intelligent-ui/migration-authorization";
import { answerConversionOutcome, answerConversionCurrentKind, ANSWER_CONVERSION_INTENT } from "../answer-output-conversion-receipts";
import { miniAppConversionSource } from "../answer-output-conversion-data";
import type { AnswerConversionIdentity, AnswerConversionIntent } from "../answer-output-conversion-types";

type Source = { operationId: string; revision: number; digest: string } | null;
export interface MiniAppRequestContext { requestId: string; leafId: string; epoch: string; sources: Record<string, Source> }
interface Receipt { id: string; hash: string }
export interface MiniAppRecord {
  operationId: string; toolCallId: string; runId: string; request: MiniAppRequestContext; source: Source;
  call: Receipt; revision: number; status: "candidate" | "committed" | "aborted" | "awaiting_confirmation";
  plan: MiniAppPlan1; planDigest: string; runtimeVersion: string; initial: MiniAppResult;
  receipt?: Receipt; turn?: Receipt[]; stateRevision: number; reason?: string;
  forkCall?: AnswerForkCall;
  migration?: { choice: MiniAppMigrationChoice; requestDigest: string; runId: string; source: Source;
    result?: MiniAppResult; anchor?: Receipt; fork?: AnswerForkCall };
  inheritance?: { version: 1; sourceSessionId: string; sourceRecordDigest: string; sourceStatus: MiniAppRecord["status"] };
}
interface Journal { version: 1; sessionId: string; epoch: string | null; records: MiniAppRecord[]; actionOperations?: import("../intelligent-ui/action-operation").UiActionOperation[] }
interface Manager { getSessionId(): string; getSessionFile(): string | undefined; getLeafId(): string | null }
export interface MiniAppPublication { record: MiniAppRecord; active: boolean; leafId: string }
export interface MiniAppTurnReceipt { messageEntryId: string; toolResultEntryIds: readonly string[]; outcome?: "completed" | "aborted" | "error" }

export function miniAppJournalPath(sessionId: string, root: string): string {
  return answerOutputMiniAppPublicationPath(sessionId, root);
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const sourceOf = (record: MiniAppRecord, saved: MiniAppSavedState): Source => ({ operationId: record.operationId, revision: saved.stateRevision, digest: saved.checkpointDigest });

export function miniAppEnvelope(record: MiniAppRecord) {
  return { answerOutput: { kind: "mini-app", version: 1, snapshot: `${record.plan.title}\n${record.initial.frame.summary}`,
    payload: { operationId: record.operationId, planDigest: record.planDigest, revision: record.revision, runtimeVersion: record.runtimeVersion } } };
}
function readJournal(sessionId: string, root: string): Journal {
  const path = miniAppJournalPath(sessionId, root);
  if (!existsSync(path)) return { version: 1, sessionId, epoch: null, records: [] };
  assertAnswerReceipt(statSync(path).size <= 16 * 1024 * 1024, "Mini app journal exceeds its read budget");
  let journal: Journal;
  try { journal = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new MiniAppError("CORRUPT", "Mini app journal is unreadable"); }
  assertAnswerReceipt(journal.version === 1 && journal.sessionId === sessionId && (journal.epoch === null || typeof journal.epoch === "string") && Array.isArray(journal.records) && journal.records.length <= 128, "Invalid mini app journal");
  if (journal.actionOperations !== undefined) {
    assertAnswerReceipt(Array.isArray(journal.actionOperations) && journal.actionOperations.length <= 1024, "Invalid mini app action journal");
    const operationIds = new Set<string>();
    for (const operation of journal.actionOperations) {
      assertAnswerReceipt(operation && /^[A-Za-z0-9_-]{1,128}$/.test(operation.id) && !operationIds.has(operation.id)
        && typeof operation.runId === "string" && typeof operation.source?.toolCallId === "string"
        && typeof operation.source.publicationEntryId === "string" && typeof operation.source.leafId === "string"
        && /^[a-f0-9]{64}$/.test(operation.source.digest) && typeof operation.action?.id === "string"
        && ["read_json_parameters", "save_snapshot"].includes(operation.action.kind) && typeof operation.file?.path === "string"
        && ["prepared", "waiting_approval", "executing", "completed", "cancelled", "failed", "uncertain"].includes(operation.status), "Invalid mini app action operation");
      operationIds.add(operation.id);
    }
  }
  const seen = new Set<string>();
  for (const record of journal.records) {
    assertAnswerReceipt(typeof record.operationId === "string" && !seen.has(record.operationId) && typeof record.toolCallId === "string"
      && typeof record.runId === "string" && record.request?.epoch === record.runId && typeof record.request.leafId === "string" && typeof record.call?.id === "string"
      && Number.isSafeInteger(record.revision) && record.revision > 0 && Number.isSafeInteger(record.stateRevision) && record.stateRevision >= 0
      && ["candidate", "committed", "aborted", "awaiting_confirmation"].includes(record.status), "Invalid mini app publication record");
    seen.add(record.operationId);
    const compiled = compileMiniAppPlan(record.plan);
    assertAnswerReceipt(answerDataDigest(record.plan) === record.planDigest && record.runtimeVersion === compiled.runtimeVersion, "Mini app program or runtime identity changed");
    validateMiniAppResult(compiled, record.initial as unknown as MiniAppVmReply);
    if (record.migration) {
      const migration = record.migration;
      assertAnswerReceipt(migration.choice.publicationId === record.operationId && migration.choice.toolCallId === record.toolCallId
        && migration.requestDigest === answerDataDigest(migration.choice) && typeof migration.runId === "string"
        && ["confirm", "cancel"].includes(migration.choice.decision), "Invalid mini app migration intent");
      if (migration.result) validateMiniAppResult(compiled, migration.result as unknown as MiniAppVmReply);
      assertAnswerReceipt(record.status !== "committed" || migration.choice.decision === "confirm" && migration.result && migration.anchor, "Migration has no confirmed checkpoint");
    }
    assertAnswerReceipt(record.status !== "committed" && record.status !== "awaiting_confirmation" || !!record.receipt && Array.isArray(record.turn) && record.turn.length > 0, "Mini app publication lacks durable receipts");
    if (record.inheritance) assertAnswerReceipt(record.inheritance.version === 1 && typeof record.inheritance.sourceSessionId === "string"
      && record.inheritance.sourceSessionId.length > 0 && /^[a-f0-9]{64}$/.test(record.inheritance.sourceRecordDigest)
      && ["candidate", "committed", "aborted", "awaiting_confirmation"].includes(record.inheritance.sourceStatus)
      && (record.status !== "committed" || record.inheritance.sourceStatus === "committed"), "Invalid mini app inheritance provenance");
  }
  return journal;
}
function saveJournal(journal: Journal, root: string, assertOwned: () => void) {
  assertOwned();
  const text = JSON.stringify(journal);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new MiniAppError("LIMIT", "Mini app journal capacity reached");
  const path = miniAppJournalPath(journal.sessionId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertOwned(); writePrivateFileAtomicSync(path, text + "\n");
}

/** Host-only action storage shares the publication lock and trash lifecycle. */
export function withMiniAppActionJournal<T>(manager: Manager, root: string, work: (context: {
  disk: AnswerDisk; leafId: string; operations: NonNullable<Journal["actionOperations"]>; save(): void; assertOwned(): void;
}) => T, readOnly = false): Promise<T> {
  const sessionId = manager.getSessionId(), file = manager.getSessionFile();
  if (!file) throw new MiniAppError("IDENTITY", "Actions require a durable session");
  const lock = readOnly ? withUiSessionReadLock : withUiSessionLock;
  return lock(sessionId, root, lease => {
    const leafId = manager.getLeafId();
    if (!leafId || manager.getSessionId() !== sessionId || manager.getSessionFile() !== file) throw new MiniAppError("IDENTITY", "Action session changed");
    const journal = readJournal(sessionId, root), disk = readAnswerDisk(file, sessionId);
    return work({ disk, leafId, operations: journal.actionOperations ??= [], assertOwned: lease,
      save: () => { if (readOnly) throw new MiniAppError("CONFLICT", "Read-only action access"); saveJournal(journal, root, lease); } });
  });
}
function verifyRecord(disk: AnswerDisk, record: MiniAppRecord): void {
  const call = disk.byId.get(record.call.id);
  verifyAnswerForkCall(disk, record.call, record.forkCall);
  assertAnswerReceipt(call, "Mini app assistant receipt is absent");
  assertAnswerReceipt(answerDeclaredCalls(call).some(call => call.id === record.toolCallId && call.name === "piora_render_mini_app"), "Assistant did not declare this mini app");
  if (record.receipt) {
    const result = disk.byId.get(record.receipt.id);
    assertAnswerReceipt(result && answerDataDigest(result) === record.receipt.hash && result.message?.role === "toolResult" && result.message.toolCallId === record.toolCallId
      && result.message.toolName === "piora_render_mini_app" && result.message.isError === false
      && answerDataDigest(result.message.details) === answerDataDigest(miniAppEnvelope(record)), "Mini app tool result is not durably confirmed");
  }
  if (record.turn?.length) {
    const results = answerTurnResults(disk, record.call.id, record.turn.at(-1)!.id, !record.inheritance);
    assertAnswerReceipt(!record.receipt || results.some(entry => entry.id === record.receipt!.id), "Mini app turn lacks its own tool receipt");
    assertAnswerReceipt(answerDataDigest(record.turn) === answerDataDigest(results.map(entry => ({ id: entry.id, hash: answerDataDigest(entry) }))), "Mini app turn evidence changed");
  }
  if (record.migration?.anchor) {
    const migration = record.migration, entry = disk.byId.get(migration.anchor!.id);
    verifyAnswerForkCall(disk, migration.anchor!, migration.fork);
    assertAnswerReceipt(entry?.type === "custom" && entry.customType === "piora-mini-app-confirmation"
      && answerDataDigest(entry.data) === answerDataDigest(migrationData(record)), "Mini app migration receipt changed");
  }
}
function migrationData(record: MiniAppRecord) {
  const migration = record.migration!;
  return { version: 1, operationId: record.operationId, requestDigest: migration.requestDigest, runId: migration.runId,
    source: migration.source, decision: migration.choice.decision, resultDigest: migration.result ? answerDataDigest(migration.result) : null };
}
function activeRecords(journal: Journal, disk: AnswerDisk, leafId: string): Map<string, MiniAppRecord> {
  const ancestry = answerDiskBranch(disk, leafId), positions = new Map(ancestry.map((entry, i) => [entry.id, i]));
  const anchor = (record: MiniAppRecord) => record.migration?.anchor?.id ?? record.receipt?.id;
  const visible = journal.records.filter(record => record.status === "committed" && anchor(record) && positions.has(anchor(record)!)
    && answerConversionCurrentKind(disk, leafId, record.plan.id) !== "intelligent-ui"
    && (!record.plan.conversion || answerConversionOutcome(disk, leafId, "mini-app", record.operationId) === "confirmed")
    && answerConversionOutcome(disk, leafId, "mini-app", record.operationId) !== "superseded")
    .sort((a, b) => positions.get(anchor(a)!)! - positions.get(anchor(b)!)!);
  const active = new Map<string, MiniAppRecord>();
  for (const record of visible) { verifyRecord(disk, record); active.set(record.plan.id, record); }
  return active;
}
function requestStillMatches(context: MiniAppRequestContext, journal: Journal, disk: AnswerDisk, currentLeaf: string, root: string): void {
  const active = activeRecords(journal, disk, context.leafId);
  const savedState = miniAppSavedStateReader(journal.sessionId, root);
  const sources = Object.fromEntries([...active].map(([id, record]) => [id, sourceOf(record, savedState(record, disk, currentLeaf))]));
  assertAnswerReceipt(answerDataDigest(sources) === answerDataDigest(context.sources), "Mini app state changed after model context was captured");
}

/** Candidate publication uses the same session write lock as existing answers. */
export class MiniAppJournal {
  readonly sessionId: string;
  readonly sessionFile: string;
  private readonly contexts = new Map<string, MiniAppRequestContext>();
  constructor(private readonly options: { manager: Manager; root: string; runId: string; assertActive(): void }) {
    this.sessionId = options.manager.getSessionId();
    const file = options.manager.getSessionFile();
    if (!file) throw new MiniAppError("IDENTITY", "Mini apps require a durable session");
    this.sessionFile = resolve(file);
  }
  private guard() {
    this.options.assertActive();
    if (this.options.manager.getSessionId() !== this.sessionId || resolve(this.options.manager.getSessionFile() ?? "") !== this.sessionFile) throw new MiniAppError("IDENTITY", "Mini app session identity changed");
  }
  private write<T>(work: (journal: Journal, disk: AnswerDisk, owned: () => void) => T): Promise<T> {
    return withUiSessionLock(this.sessionId, this.options.root, lease => {
      const owned = () => { lease(); this.guard(); }; owned();
      return work(readJournal(this.sessionId, this.options.root), readAnswerDisk(this.sessionFile, this.sessionId), owned);
    });
  }
  start(): Promise<void> {
    return this.write((journal, _disk, owned) => {
      for (const record of journal.records) if (record.status === "candidate") { record.status = "aborted"; record.reason = "INTERRUPTED"; }
      journal.epoch = this.options.runId; saveJournal(journal, this.options.root, owned);
    });
  }
  capture(): Promise<{ context: MiniAppRequestContext; apps: Array<{ record: MiniAppRecord; saved: MiniAppSavedState }> }> {
    return this.write((journal, disk) => {
      assertAnswerReceipt(journal.epoch === this.options.runId, "Mini app generation epoch was superseded");
      const leafId = this.options.manager.getLeafId(); assertAnswerReceipt(leafId, "A current conversation leaf is required");
      const active = activeRecords(journal, disk, leafId);
      const savedState = miniAppSavedStateReader(this.sessionId, this.options.root);
      const apps = [...active.values()].map(record => ({ record, saved: savedState(record, disk, leafId) }));
      const context: MiniAppRequestContext = { requestId: randomUUID(), leafId, epoch: this.options.runId, sources: Object.fromEntries(apps.map(({ record, saved }) => [record.plan.id, sourceOf(record, saved)])) };
      this.contexts.clear(); this.contexts.set(context.requestId, context);
      return { context: clone(context), apps: clone(apps) };
    });
  }
  /** Read the exact request's saved source under the session lock; no writes. */
  inspectSource(requestId: string, appId: string): Promise<{ record: MiniAppRecord; saved: MiniAppSavedState }> {
    return this.write((journal, disk) => {
      const context = this.contexts.get(requestId);
      assertAnswerReceipt(context && journal.epoch === this.options.runId, "Mini app request is no longer current");
      const leaf = this.options.manager.getLeafId(); assertAnswerReceipt(leaf, "Missing mini app inspection leaf");
      assertAnswerReceipt(answerDiskBranch(disk, leaf).some(entry => entry.id === context.leafId), "Mini app source is not on this branch");
      requestStillMatches(context, journal, disk, leaf, this.options.root);
      const record = activeRecords(journal, disk, leaf).get(appId);
      assertAnswerReceipt(record && context.sources[appId]?.operationId === record.operationId, "The requested app is not active in this captured context");
      const saved = miniAppSavedStateReader(this.sessionId, this.options.root)(record, disk, leaf);
      return clone({ record, saved });
    });
  }
  create(requestId: string, toolCallId: string, plan: MiniAppPlan1, initial: MiniAppResult): Promise<MiniAppRecord> {
    return this.write((journal, disk, owned) => {
      const context = this.contexts.get(requestId);
      assertAnswerReceipt(context && journal.epoch === this.options.runId, "Mini app request is no longer current");
      const leaf = this.options.manager.getLeafId(); assertAnswerReceipt(leaf, "Missing mini app call leaf");
      requestStillMatches(context, journal, disk, leaf, this.options.root);
      const ancestry = answerDiskBranch(disk, leaf), position = ancestry.findIndex(entry => entry.id === context.leafId);
      assertAnswerReceipt(position >= 0, "Mini app source is not on this branch");
      const tail = ancestry.slice(position + 1);
      const call = tail.find(entry => entry.type === "message" && entry.message?.role === "assistant");
      assertAnswerReceipt(call && tail.slice(0, tail.indexOf(call)).every(entry => entry.type === "session_info"), "Only title metadata may precede the originating assistant");
      answerTurnResults(disk, call.id, leaf, false);
      assertAnswerReceipt(answerDeclaredCalls(call).some(item => item.id === toolCallId && item.name === "piora_render_mini_app"), "Assistant did not declare this mini app tool call");
      const existing = journal.records.find(record => record.toolCallId === toolCallId);
      if (existing) {
        assertAnswerReceipt(existing.runId === this.options.runId && existing.request.requestId === requestId && existing.call.id === call.id
          && existing.planDigest === answerDataDigest(compileMiniAppPlan(plan).plan) && answerDataDigest(existing.initial) === answerDataDigest(initial)
          && existing.status !== "aborted", "Mini app tool identity was reused with changed content");
        verifyRecord(disk, existing); return clone(existing);
      }
      if (journal.records.length >= 128) throw new MiniAppError("LIMIT", "Mini app publication capacity reached");
      const previous = activeRecords(journal, disk, context.leafId).get(plan.id);
      const compiled = compileMiniAppPlan(plan); validateMiniAppResult(compiled, initial as unknown as MiniAppVmReply);
      const currentKind = answerConversionCurrentKind(disk, context.leafId, plan.id);
      if (currentKind && currentKind !== "mini-app" && !compiled.plan.conversion) throw new MiniAppError("CONFLICT", "Changing this answer back to a mini app requires explicit conversion metadata");
      if (compiled.plan.conversion && previous) throw new MiniAppError("CONFLICT", "This answer already has an active mini app; revise it without cross-form conversion");
      if (compiled.plan.migration && previous?.planDigest !== compiled.plan.migration.fromPlanDigest) throw new MiniAppError("CONFLICT", "Progress migration requires the exact active source program");
      const record: MiniAppRecord = { operationId: randomUUID(), toolCallId, runId: this.options.runId, request: clone(context), source: context.sources[plan.id] ?? null,
        call: { id: call.id, hash: answerDataDigest(call) }, revision: (previous?.revision ?? 0) + 1, status: "candidate", plan: clone(compiled.plan), planDigest: answerDataDigest(compiled.plan), runtimeVersion: compiled.runtimeVersion, initial: clone(initial), stateRevision: 0 };
      journal.records.push(record); saveJournal(journal, this.options.root, owned); return clone(record);
    });
  }
  publish(operationId: string, receipt: MiniAppTurnReceipt): Promise<MiniAppRecord> {
    return this.write((journal, disk, owned) => {
      const record = journal.records.find(record => record.operationId === operationId);
      assertAnswerReceipt(record && record.runId === this.options.runId && journal.epoch === this.options.runId, "Mini app publication belongs to another run");
      assertAnswerReceipt(record.status === "candidate" || record.status === "committed" || record.status === "awaiting_confirmation", "Mini app candidate was aborted");
      assertAnswerReceipt((receipt.outcome ?? "completed") === "completed" && receipt.messageEntryId === record.call.id, "Mini app turn did not complete");
      verifyRecord(disk, record);
      const leaf = this.options.manager.getLeafId(); assertAnswerReceipt(leaf, "Missing mini app turn leaf");
      requestStillMatches(record.request, journal, disk, leaf, this.options.root);
      const results = answerTurnResults(disk, record.call.id, leaf, true);
      assertAnswerReceipt(receipt.toolResultEntryIds.length === results.length && new Set(receipt.toolResultEntryIds).size === results.length && results.every(entry => receipt.toolResultEntryIds.includes(entry.id)), "SDK turn receipt does not match complete durable results");
      const result = results.find(entry => entry.message?.toolCallId === record.toolCallId);
      assertAnswerReceipt(result?.message?.isError === false && answerDataDigest(result.message.details) === answerDataDigest(miniAppEnvelope(record)), "Exact mini app candidate result is absent from disk");
      syncAnswerDisk(this.sessionFile);
      const finalDisk = readAnswerDisk(this.sessionFile, this.sessionId);
      assertAnswerReceipt(answerDataDigest(results) === answerDataDigest(answerTurnResults(finalDisk, record.call.id, leaf, true)), "Mini app results changed while confirming durability");
      record.receipt = { id: result.id, hash: answerDataDigest(result) };
      record.turn = results.map(entry => ({ id: entry.id, hash: answerDataDigest(entry) }));
      // Existing app revisions await explicit migration review. This conservative
      // boundary preserves the old state until the migration flow is connected.
      record.status = record.source || record.plan.conversion ? "awaiting_confirmation" : "committed";
      saveJournal(journal, this.options.root, owned); return clone(record);
    });
  }
  async abortCandidates(reason: string): Promise<void> {
    await this.write((journal, _disk, owned) => {
      for (const record of journal.records) if (record.runId === this.options.runId && (record.status === "candidate"
        || reason !== "idle" && record.plan.conversion && record.status === "awaiting_confirmation")) { record.status = "aborted"; record.reason = reason; }
      saveJournal(journal, this.options.root, owned);
    });
  }
  abortCandidate(operationId: string, reason: string): Promise<void> {
    return this.write((journal, _disk, owned) => {
      const record = journal.records.find(record => record.operationId === operationId && record.runId === this.options.runId);
      if (record?.status === "candidate") { record.status = "aborted"; record.reason = reason; saveJournal(journal, this.options.root, owned); }
    });
  }
}

/** Reads never promote a candidate after a crash or reconstruct a missing receipt. */
export async function readMiniAppPublication(sessionId: string, sessionFile: string, toolCallId: string, leafId: string, root: string): Promise<MiniAppPublication | undefined> {
  return withUiSessionReadLock(sessionId, root, () => {
    const view = readMiniAppJournalView(sessionId, sessionFile, toolCallId, leafId, root);
    if (view) return { record: view.record, active: view.active, leafId };
  });
}

/** For readers/writers already holding the common session lock. */
export function readMiniAppJournalView(sessionId: string, sessionFile: string, toolCallId: string, leafId: string, root: string): (MiniAppPublication & { disk: AnswerDisk }) | undefined {
  const journal = readJournal(sessionId, root), disk = readAnswerDisk(sessionFile, sessionId);
  const ancestry = new Set(answerDiskBranch(disk, leafId).map(entry => entry.id));
  const record = journal.records.find(record => record.toolCallId === toolCallId && ancestry.has(record.call.id));
  if (!record) return;
  verifyRecord(disk, record);
  const visible = clone(record);
  if (record.migration?.anchor && !ancestry.has(record.migration.anchor.id)) visible.status = "awaiting_confirmation";
  if (record.plan.conversion && record.status !== "aborted" && record.status !== "candidate") {
    const outcome = answerConversionOutcome(disk, leafId, "mini-app", record.operationId);
    if (outcome !== "confirmed" && outcome !== "superseded") visible.status = outcome === "cancelled" ? "aborted" : "awaiting_confirmation";
  }
  return { record: visible, active: visible.status === "committed" && activeRecords(journal, disk, leafId).get(record.plan.id)?.operationId === record.operationId, leafId, disk };
}

/** Caller holds the common session lock. */
export function readMiniAppConversionSource(sessionId: string, file: string, toolCallId: string, leafId: string, root: string) {
  const view = readMiniAppJournalView(sessionId, file, toolCallId, leafId, root);
  if (!view?.active) return undefined;
  const saved = miniAppSavedStateReader(sessionId, root)(view.record, view.disk, leafId);
  return miniAppConversionSource({ operationId: view.record.operationId, toolCallId, plan: view.record.plan, result: saved.result, revision: saved.stateRevision });
}
export function readMiniAppConversionTarget(sessionId: string, file: string, toolCallId: string, leafId: string, root: string) {
  const journal = readJournal(sessionId, root), disk = readAnswerDisk(file, sessionId), entries = new Set(answerDiskBranch(disk, leafId).map(entry => entry.id));
  const record = journal.records.find(item => item.toolCallId === toolCallId);
  if (!record?.plan.conversion || !record.receipt || !entries.has(record.receipt.id) || !["awaiting_confirmation", "committed"].includes(record.status)) throw new MiniAppError("CONFLICT", "No conversion is available for this output");
  verifyRecord(disk, record);
  return { spec: record.plan.conversion, plan: record.plan,
    target: miniAppConversionSource({ operationId: record.operationId, toolCallId, plan: record.plan, result: record.initial, revision: 0 }) };
}
/** Installs state before the completion marker, without activating the candidate. */
export function commitMiniAppConversionTarget(options: { manager: Manager; root: string; target: AnswerConversionIdentity; intentId: string;
  intent: AnswerConversionIntent; result: MiniAppResult; requestDigest: string; authorization: UiMigrationAuthorization; assertOwned(): void }) {
  const { manager, root, intent, target } = options, sessionId = manager.getSessionId(), file = manager.getSessionFile()!, leaf = manager.getLeafId()!;
  assertUiMigrationAuthorization(options.authorization, { sessionId, proposalId: target.operationId, digest: target.digest, choiceDigest: options.requestDigest });
  const journal = readJournal(sessionId, root), disk = readAnswerDisk(file, sessionId);
  const record = journal.records.find(item => item.operationId === target.operationId);
  if (!record?.plan.conversion || !["awaiting_confirmation", "committed"].includes(record.status)) throw new MiniAppError("CONFLICT", "Conversion candidate changed");
  verifyRecord(disk, record);
  const actual = miniAppConversionSource({ operationId: record.operationId, toolCallId: record.toolCallId, plan: record.plan, result: record.initial, revision: 0 }).identity;
  const entry = disk.byId.get(options.intentId);
  assertAnswerReceipt(answerDataDigest(actual) === answerDataDigest(target) && answerDataDigest(intent.target) === answerDataDigest(target)
    && entry?.type === "custom" && entry.customType === ANSWER_CONVERSION_INTENT && answerDataDigest(entry.data) === answerDataDigest(intent)
    && answerDiskBranch(disk, leaf).some(item => item.id === entry.id) && intent.decision === "confirm"
    && answerDataDigest(options.result) === intent.resultDigest && answerDataDigest(options.result.snapshot.inputs) === answerDataDigest(intent.inputs), "Conversion intent or result changed");
  commitMiniAppState({ sessionId, root, record, disk, leafId: entry.id, requestId: `conversion-${intent.requestId}`,
    requestDigest: options.requestDigest, expectedRevision: 0, result: options.result, assertOwned: options.assertOwned });
  record.status = "committed"; saveJournal(journal, root, options.assertOwned);
}

/** Caller holds the common session lock. Reviews never publish or execute code. */
export function readMiniAppMigrationBase(sessionId: string, file: string, toolCallId: string, leafId: string, root: string) {
  const journal = readJournal(sessionId, root), disk = readAnswerDisk(file, sessionId);
  const ancestry = new Set(answerDiskBranch(disk, leafId).map(entry => entry.id));
  const record = journal.records.find(item => item.toolCallId === toolCallId && item.receipt && ancestry.has(item.receipt.id));
  if (!record || !record.source) throw new MiniAppError("NOT_FOUND", "No revision is available for review");
  verifyRecord(disk, record);
  const source = activeRecords(journal, disk, leafId).get(record.plan.id);
  const saved = source ? miniAppSavedStateReader(sessionId, root)(source, disk, leafId) : undefined;
  const assessment = assessMiniAppMigration(source?.plan ?? record.plan, saved?.result.snapshot.inputs ?? record.initial.snapshot.inputs, record.plan);
  const sourceIdentity = source && saved ? sourceOf(source, saved) : null;
  const progress = record.plan.migration?.fromPlanDigest === source?.planDigest
    ? { description: record.plan.migration!.description, clock: record.plan.migration!.clock } : undefined;
  const digest = answerDataDigest({ publicationId: record.operationId, planDigest: record.planDigest, leafId, source: sourceIdentity, ...assessment, ...(progress ? { progress } : {}) });
  const review: MiniAppMigrationReview = { toolCallId, publicationId: record.operationId, digest, leafId, ...assessment,
    status: record.migration?.anchor ? ancestry.has(record.migration.anchor.id) ? record.status === "committed" ? "committed" : "cancelled" : "stale"
      : record.status === "awaiting_confirmation" && source?.operationId === record.source.operationId ? "ready" : "stale",
    ...(progress ? { progress } : {}), ...(record.migration && !record.migration.anchor ? { pending: record.migration.choice } : {}) };
  return { review, record, source: sourceIdentity, sourcePlan: source?.plan, sourceSnapshot: saved?.result.snapshot, disk };
}

/** An owned host click supplies the exact reviewed choice and server trial result. */
export function commitMiniAppMigration(options: {
  manager: Manager & { appendCustomEntry(type: string, data: unknown): string }; root: string; choice: MiniAppMigrationChoice;
  result?: MiniAppResult; authorization: UiMigrationAuthorization; assertOwned(): void;
}) {
  options.assertOwned();
  const { manager, root, choice } = options, sessionId = manager.getSessionId(), file = manager.getSessionFile()!, leafId = manager.getLeafId()!;
  const identity = assertUiMigrationAuthorization(options.authorization, { sessionId, proposalId: choice.publicationId,
    digest: choice.digest, choiceDigest: answerDataDigest(choice) });
  const journal = readJournal(sessionId, root), record = journal.records.find(item => item.operationId === choice.publicationId && item.toolCallId === choice.toolCallId);
  if (!record) throw new MiniAppError("NOT_FOUND", "Revision is unavailable");
  const requestDigest = answerDataDigest(choice), disk = readAnswerDisk(file, sessionId);
  verifyRecord(disk, record);
  if (record.migration) {
    if (record.migration.requestDigest !== requestDigest) throw new MiniAppError("CONFLICT", "A different confirmation already owns this revision");
    if (record.migration.anchor) {
      if (!answerDiskBranch(disk, leafId).some(entry => entry.id === record.migration!.anchor!.id)) throw new MiniAppError("CONFLICT", "Confirmation is outside this branch");
      return { status: record.status === "committed" ? "committed" as const : "cancelled" as const };
    }
  }
  const current = readMiniAppMigrationBase(sessionId, file, choice.toolCallId, choice.leafId, root);
  const recovered = record.migration && disk.byId.get(leafId)?.type === "custom" && disk.byId.get(leafId)?.customType === "piora-mini-app-confirmation"
    && disk.byId.get(leafId)?.parentId === choice.leafId && answerDataDigest(disk.byId.get(leafId)?.data) === answerDataDigest(migrationData(record));
  if (current.review.status !== "ready" || current.review.digest !== choice.digest || (leafId !== choice.leafId && !recovered)) {
    throw new MiniAppError("CONFLICT", "The conversation or source state changed; review this revision again");
  }
  if (!record.migration) {
    if (choice.progress === "migrate" && !current.review.progress) throw new MiniAppError("CONFLICT", "Progress preservation is unavailable for this source");
    if (choice.decision === "confirm" && !options.result) throw new MiniAppError("STATE", "Migration requires a server-verified initialization");
    if (choice.decision === "confirm") {
      validateMiniAppResult(compileMiniAppPlan(record.plan), options.result as unknown as MiniAppVmReply);
      if (answerDataDigest(options.result!.snapshot.inputs) !== answerDataDigest(choice.inputs)) throw new MiniAppError("STATE", "Initialization does not match the confirmed inputs");
    }
    record.migration = { choice: clone(choice), requestDigest, runId: identity.runId, source: current.source,
      ...(choice.decision === "confirm" ? { result: clone(options.result!) } : {}) };
    saveJournal(journal, root, options.assertOwned);
  }
  options.assertOwned();
  const anchorId = recovered ? leafId : manager.appendCustomEntry("piora-mini-app-confirmation", migrationData(record));
  syncAnswerDisk(file);
  const durable = readAnswerDisk(file, sessionId), entry = durable.byId.get(anchorId);
  assertAnswerReceipt(entry?.parentId === choice.leafId && entry.type === "custom" && entry.customType === "piora-mini-app-confirmation"
    && answerDataDigest(entry.data) === answerDataDigest(migrationData(record)) && manager.getLeafId() === anchorId, "Migration confirmation is not durable");
  record.migration.anchor = { id: anchorId, hash: answerDataDigest(entry) };
  record.status = choice.decision === "confirm" ? "committed" : "aborted";
  saveJournal(journal, root, options.assertOwned);
  return { status: choice.decision === "confirm" ? "committed" as const : "cancelled" as const };
}

export async function readMiniAppSnapshotRecords(sessionId: string, sessionFile: string, leafId: string, root: string, toolCallId?: string): Promise<Array<{ record: MiniAppRecord; saved: MiniAppSavedState; active: boolean }>> {
  return withUiSessionReadLock(sessionId, root, () => {
    const journal = readJournal(sessionId, root), disk = readAnswerDisk(sessionFile, sessionId);
    const ancestry = new Set(answerDiskBranch(disk, leafId).map(entry => entry.id));
    const active = activeRecords(journal, disk, leafId), saved = miniAppSavedStateReader(sessionId, root);
    const records = toolCallId === undefined ? [...active.values()]
      : journal.records.filter(record => record.toolCallId === toolCallId && ancestry.has(record.call.id));
    return records.map(record => {
      verifyRecord(disk, record);
      if (record.migration?.anchor && !ancestry.has(record.migration.anchor.id)) record = { ...record, status: "awaiting_confirmation" };
      if (record.plan.conversion && record.status !== "aborted" && record.status !== "candidate") {
        const outcome = answerConversionOutcome(disk, leafId, "mini-app", record.operationId);
        if (outcome !== "confirmed" && outcome !== "superseded") record = { ...record, status: outcome === "cancelled" ? "aborted" : "awaiting_confirmation" };
      }
      return { record: clone(record), active: active.get(record.plan.id)?.operationId === record.operationId,
        saved: record.status === "committed" ? saved(record, disk, leafId)
          : { stateRevision: 0, checkpointDigest: answerDataDigest(record.initial.snapshot), result: clone(record.initial), savedAt: null } };
    });
  });
}

/** Copy into a staged SDK fork. The caller publishes its session only on success. */
export async function copyMiniAppJournal(options: {
  source: string; target: string; sourceFile: string; targetFile: string;
  retainedEntryIds: readonly string[]; sourceLeafId?: string | null; root: string;
  beforePublish?(): void;
}): Promise<{ copied: number; excluded: number }> {
  if (options.source === options.target) return { copied: 0, excluded: 0 };
  const ids = [options.source, options.target].sort(), guards: Array<() => void> = [];
  const assertOwned = () => { for (const guard of guards) guard(); };
  const withLocks = (index: number): Promise<{ copied: number; excluded: number }> => index < ids.length
    ? withUiSessionLock(ids[index], options.root, guard => { guards.push(guard); return withLocks(index + 1); })
    : Promise.resolve(copy());
  const copy = () => {
    assertOwned();
    if (existsSync(miniAppJournalPath(options.target, options.root))) throw new MiniAppError("CONFLICT", "Target mini app journal already exists");
    const source = readJournal(options.source, options.root), sourceDisk = readAnswerDisk(options.sourceFile, options.source), targetDisk = readAnswerDisk(options.targetFile, options.target);
    const mapping = verifyAnswerForkMapping(sourceDisk, targetDisk, options.retainedEntryIds, options.sourceLeafId);
    const outputs = targetDisk.entries.filter(entry => {
      const output = (entry.message?.details as { answerOutput?: { kind?: unknown; version?: unknown } } | undefined)?.answerOutput;
      return entry.type === "message" && entry.message?.role === "toolResult" && !entry.message.isError && output?.kind === "mini-app" && output.version === 1;
    });
    const inherited: Journal = { version: 1, sessionId: options.target, epoch: null, records: [] }, confirmed: MiniAppRecord[] = [];
    let excluded = 0;
    for (const result of outputs) {
      const output = result.message!.details as ReturnType<typeof miniAppEnvelope>;
      const record = source.records.find(record => record.operationId === output.answerOutput.payload.operationId);
      assertAnswerReceipt(record && !inherited.records.some(item => item.operationId === record.operationId), "Fork output lacks unique source publication evidence");
      verifyRecord(sourceDisk, record);
      const sourceResult = sourceDisk.byId.get(result.id);
      assertAnswerReceipt(sourceResult && answerDataDigest(sourceResult) === answerDataDigest(result)
        && result.message!.isError === false && result.message!.toolName === "piora_render_mini_app" && result.message!.toolCallId === record.toolCallId
        && answerDataDigest(result.message!.details) === answerDataDigest(miniAppEnvelope(record)), "Fork mini app result changed");
      if (record.receipt) assertAnswerReceipt(record.receipt.id === result.id, "Fork mini app receipt identity changed");
      const inheritedRecord = clone(record);
      inheritedRecord.forkCall = inheritAnswerForkCall(sourceDisk, targetDisk, record.call, options.source, record.forkCall);
      inheritedRecord.inheritance = { version: 1, sourceSessionId: options.source, sourceRecordDigest: answerDataDigest(record), sourceStatus: record.status };
      const sourceLeaf = mapping.anchors.get(record.request.leafId);
      assertAnswerReceipt(sourceLeaf, "Fork omitted the mini app request ancestor");
      inheritedRecord.request.leafId = sourceLeaf;
      inheritedRecord.receipt = { id: result.id, hash: answerDataDigest(result) };
      const retainedTurn = record.turn?.filter(receipt => targetDisk.byId.has(receipt.id));
      const turnLeaf = retainedTurn?.at(-1)?.id ?? result.id;
      inheritedRecord.turn = answerTurnResults(targetDisk, record.call.id, turnLeaf, false).map(entry => ({ id: entry.id, hash: answerDataDigest(entry) }));
      if (record.migration?.anchor && targetDisk.byId.has(record.migration.anchor.id)) {
        inheritedRecord.migration!.fork = inheritAnswerForkCall(sourceDisk, targetDisk, record.migration.anchor, options.source, record.migration.fork);
      } else if (record.migration) delete inheritedRecord.migration;
      if (record.status === "committed" && (!record.migration || inheritedRecord.migration?.anchor)
        && (!record.plan.conversion || ["confirmed", "superseded"].includes(answerConversionOutcome(targetDisk, targetDisk.entries.at(-1)!.id, "mini-app", record.operationId) ?? ""))) confirmed.push(record);
      else { inheritedRecord.status = "aborted"; inheritedRecord.reason = "INHERITED_UNCONFIRMED"; excluded++; }
      verifyRecord(targetDisk, inheritedRecord); inherited.records.push(inheritedRecord);
    }
    options.beforePublish?.(); assertOwned();
    assertAnswerReceipt(answerDataDigest(readJournal(options.source, options.root)) === answerDataDigest(source)
      && answerDataDigest(readAnswerDisk(options.sourceFile, options.source).entries) === answerDataDigest(sourceDisk.entries)
      && answerDataDigest(readAnswerDisk(options.targetFile, options.target).entries) === answerDataDigest(targetDisk.entries), "Mini app fork source or target changed before publication");
    if (!inherited.records.length) return { copied: 0, excluded: 0 };
    syncAnswerDisk(options.targetFile);
    copyMiniAppState({ ...options, sourceDisk, targetDisk, records: confirmed, anchors: mapping.anchors,
      sourceOrder: new Map(mapping.sourceEntries.map((entry, index) => [entry.id, index])), assertOwned });
    saveJournal(inherited, options.root, assertOwned);
    return { copied: confirmed.length, excluded };
  };
  return withLocks(0);
}
