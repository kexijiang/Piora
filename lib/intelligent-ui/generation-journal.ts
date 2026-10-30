/** Candidate journal. Production generation and mutation coordination are still being integrated. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { answerOutputGenerationPath } from "../answer-output-paths";
import { readOnlySessionManager } from "../session-readonly-manager";
import type { SavedUiDecisionRecord } from "./decision-context";
import { branchSurfaces, copyIntelligentUiState, getSurfaceState, intelligentUiStatePath, type UiBranchEntry } from "./store";
import { formatSnapshot, initialState, isUiId, validateState, validateSurface, type UiState, type UiSurface } from "./surface-document";
import type { CompiledUiPlan } from "./plan-types";
import type { CompiledUiRichPlan } from "./rich-plan";
import { withUiFileLock, withUiSessionLock, withUiSessionReadLock, withUiSessionMutationLock } from "./session-lock";

import { assessUiMigration, type UiMigrationField, type UiMigrationReview } from "./structure-migration";
import { assertUiMigrationAuthorization, type UiMigrationAuthorization } from "./migration-authorization";
import { validateUiActions, type UiActionDeclaration, type UiActionSource } from "./action-contract";
import type { UiActionOperation, UiActionStart } from "./action-operation";
import { uiActionFacts } from "./action-description";

type Manager = Pick<SessionManager, "getSessionId" | "getSessionFile" | "getLeafId"> & Partial<Pick<SessionManager, "appendMessage" | "appendCustomEntry">>;
type Source = { origin: "none" | "legacy" | "journal"; surfaceId: string; surfaceRevision: number; stateRevision: number; stateHash: string; operationId?: string };
type Context = { contextId: string; sessionId: string; leafId: string; epoch: string; source: Source; state: UiState };
export interface UiGenerationRequestContext {
  requestId: string; sessionId: string; leafId: string; epoch: string;
  surfaces: Array<{ source: Source; state: UiState; summary?: ReturnType<typeof decisionSummary> }>;
}
export interface UiGenerationTurnReceipt { messageEntryId: string; toolResultEntryIds: readonly string[] }
export interface UiGenerationOutput {
  surface: UiSurface; state: UiState; revision: number; leafId: string; snapshot: string;
  publication: { status: "candidate" | "awaiting_confirmation" | "committed" | "aborted" | "superseded"; operationId: string; currentToolCallId?: string };
}
export interface UiDecisionSnapshot {
  leafId: string | null;
  records: Array<SavedUiDecisionRecord & { protocolVersion: 1 | 2 }>;
}
type Receipt = { entryId: string; entryHash: string };
type Semantics = CompiledUiPlan["inputSemantics"];
type RecordStatus = "candidate" | "awaiting_confirmation" | "committed" | "aborted";
interface MigrationProposal {
  version: 1; proposalId: string; operationId: string; originRunId: string; source: Context;
  callEntryHash: string; surfaceHash: string; semantics: Semantics;
  receipt: Receipt; turnReceipt: NonNullable<GenerationRecord["turnReceipt"]>;
  fields: UiMigrationField[]; suggestedState: UiState;
}
interface MigrationRecord {
  proposal: MigrationProposal; digest: string; status: UiMigrationReview["status"];
  readyReceipt?: Receipt;
  confirmation?: { requestId: string; runId: string; choiceDigest: string; decision: "confirm" | "cancel"; state: UiState };
}
/** The original assistant hash remains authoritative after SDK label removal. */
interface ForkCallProvenance {
  version: 1; sourceSessionId: string; targetParentId: string | null;
  removedLabels: Array<{ entry: DiskEntry; hash: string }>;
}
/** Title metadata may arrive while a model request is in flight. Preserve its
 * exact ancestry separately from the frozen request and original call hash. */
type ContextTitleReceipt = Receipt & { forkCall?: ForkCallProvenance };
interface GenerationRecord {
  operationId: string; epoch: string; status: RecordStatus; source: Context;
  callEntryId: string; callEntryHash: string; toolCallId: string;
  planVersion: 1 | 2; compilerVersion: string;
  surface: UiSurface; surfaceHash: string; semantics: Semantics;
  actions?: UiActionDeclaration;
  receipt?: Receipt; state?: UiState; stateRevision?: number; abortReason?: string;
  turnReceipt?: { leafId: string; entryIds: string[]; entryHashes: string[] };
  migration?: MigrationRecord;
  publicationAnchor?: Receipt;
  confirmationFork?: ForkCallProvenance;
  forkCall?: ForkCallProvenance;
  contextTitles?: ContextTitleReceipt[];
}
interface ExcludedGenerationOutput {
  reason: "uncommitted-at-fork"; sourceSessionId: string; sourceStatus: "candidate" | "awaiting_confirmation" | "aborted";
  evidenceOrigin: "source-receipt" | "fork-observed-jsonl";
  operationId: string; toolCallId: string; surfaceHash: string;
  callEntryId: string; callEntryHash: string; source: { leafId: string }; forkCall?: ForkCallProvenance;
  contextTitles?: ContextTitleReceipt[];
  receipt: Receipt;
}
interface SavedState { anchor: string; operationId: string; revision: number; state: UiState }
interface Journal {
  version: 1; sessionId: string; epoch: string | null; revision: number;
  records: GenerationRecord[];
  active: Array<{ anchor: string; surfaceId: string; operationId: string }>;
  states: SavedState[];
  actionOperations?: UiActionOperation[];
  /** Exact evidence for inherited history that must never become editable. */
  excludedOutputs?: ExcludedGenerationOutput[];
}
interface DiskEntry extends UiBranchEntry { message?: Record<string, unknown>; [key: string]: unknown }
interface Disk { entries: DiskEntry[]; byId: Map<string, DiskEntry> }
export type GenerationStage = "candidate-written" | "tool-result-written" | "receipt-written" | "before-commit" | "committed"
  | "migration-proposed" | "migration-ready" | "confirmation-intent" | "confirmation-entry" | "confirmation-receipt" | "migration-committed";
export class UiGenerationError extends Error {
  constructor(readonly code: "IDENTITY" | "CONFLICT" | "RECEIPT" | "CORRUPT" | "CANCELLED" | "MIGRATION_REQUIRED" | "UI_PROTOCOL_UNAVAILABLE" | "LIMIT", message: string) { super(message); this.name = "UiGenerationError"; }
}
export function isUiGenerationError(error: unknown): error is UiGenerationError {
  return error instanceof Error && error.name === "UiGenerationError" && ["IDENTITY", "CONFLICT", "RECEIPT", "CORRUPT", "CANCELLED", "MIGRATION_REQUIRED", "UI_PROTOCOL_UNAVAILABLE", "LIMIT"].includes((error as UiGenerationError).code);
}
function check(condition: unknown, code: UiGenerationError["code"], message: string): asserts condition { if (!condition) throw new UiGenerationError(code, message); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function generationDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Capture human meanings with the same source values, without retaining a full
 * large table for every provider request. Omission must never look like a default. */
function decisionSummary(surface: UiSurface, state: UiState, actions?: UiActionDeclaration) {
  const controls = surface.nodes.filter(node => ["number", "slider", "select", "checkbox"].includes(node.type)).map(node => {
    const description = { ...node } as Record<string, unknown>;
    delete description.value;
    return description;
  });
  const snapshot = formatSnapshot(surface, state);
  const summary = { title: surface.title, controls, omittedControls: 0, snapshot: snapshot.slice(0, 2000), snapshotTruncated: snapshot.length > 2000,
    ...(actions ? { actions: actions.actions.map(uiActionFacts), omittedActions: 0 } : {}) };
  if (JSON.stringify(summary).length > 6000) { summary.snapshot = ""; summary.snapshotTruncated = true; }
  while (JSON.stringify(summary).length > 6000 && summary.controls.length) { summary.controls.pop(); summary.omittedControls++; }
  while (JSON.stringify(summary).length > 6000 && summary.actions?.length) { summary.actions.pop(); summary.omittedActions!++; }
  return summary;
}
export function generationJournalPath(sessionId: string, root: string): string {
  return answerOutputGenerationPath(sessionId, root);
}

/** Re-read actual JSONL bytes. SDK in-memory entries and SSE are not disk receipts. */
function readDisk(sessionFile: string, sessionId: string): Disk {
  check(existsSync(sessionFile) && statSync(sessionFile).size <= 64 * 1024 * 1024, "RECEIPT", "Session file is missing or exceeds the prototype read limit");
  const text = readFileSync(sessionFile, "utf8");
  check(text.endsWith("\n"), "RECEIPT", "Session file has an incomplete record");
  let lines: Record<string, unknown>[];
  try { lines = text.trimEnd().split("\n").map(line => JSON.parse(line)); }
  catch { throw new UiGenerationError("RECEIPT", "Session file is not valid JSONL"); }
  check(lines[0]?.type === "session" && lines[0].id === sessionId && lines[0].version === 3, "IDENTITY", "Session file identity or format changed");
  const entries = lines.slice(1) as DiskEntry[], byId = new Map<string, DiskEntry>();
  for (const entry of entries) {
    check(typeof entry.id === "string" && !byId.has(entry.id) && (entry.parentId === null || typeof entry.parentId === "string") && typeof entry.type === "string", "CORRUPT", "Session contains invalid or duplicate entries");
    byId.set(entry.id, entry);
  }
  return { entries, byId };
}
function branch(disk: Disk, leafId: string): DiskEntry[] {
  const result: DiskEntry[] = [], seen = new Set<string>();
  let id: string | null = leafId;
  while (id !== null) {
    check(!seen.has(id), "CORRUPT", "Session branch has a cycle"); seen.add(id);
    const entry = disk.byId.get(id); check(entry, "RECEIPT", "Requested branch is not on disk"); result.push(entry); id = entry.parentId;
  }
  return result.reverse();
}
function emptyJournal(sessionId: string): Journal { return { version: 1, sessionId, epoch: null, revision: 0, records: [], active: [], states: [] }; }
function readJournal(path: string, sessionId: string): Journal {
  if (!existsSync(path)) return emptyJournal(sessionId);
  check(statSync(path).size <= 8 * 1024 * 1024, "LIMIT", "Generation journal exceeds the prototype size limit");
  let journal: Journal;
  try { journal = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new UiGenerationError("CORRUPT", "Generation journal cannot be read"); }
  check(journal?.version === 1 && journal.sessionId === sessionId && Number.isSafeInteger(journal.revision) && journal.revision >= 0 && (journal.epoch === null || typeof journal.epoch === "string") && Array.isArray(journal.records) && Array.isArray(journal.active) && Array.isArray(journal.states), "CORRUPT", "Unsupported generation journal");
  const ids = new Set<string>();
  for (const record of journal.records) {
    check(typeof record.operationId === "string" && !ids.has(record.operationId) && ["candidate", "awaiting_confirmation", "committed", "aborted"].includes(record.status), "CORRUPT", "Invalid generation journal record"); ids.add(record.operationId);
    try { validateSurface(record.surface); } catch { throw new UiGenerationError("CORRUPT", "Invalid saved generation surface"); }
    if (record.actions !== undefined) {
      try { validateUiActions(record.actions); } catch { throw new UiGenerationError("CORRUPT", "Invalid saved action declarations"); }
    }
    check(record.planVersion === record.surface.version && typeof record.compilerVersion === "string" && record.compilerVersion.length > 0 && record.compilerVersion.length <= 80,
      "CORRUPT", "Saved compiler and surface versions are incompatible");
    check(record.source?.sessionId === sessionId && typeof record.source.leafId === "string" && typeof record.epoch === "string" && typeof record.toolCallId === "string" && Array.isArray(record.semantics) && generationDigest(record.surface) === record.surfaceHash, "CORRUPT", "Generation metadata does not match the saved candidate");
    if (record.status === "committed") {
      check(record.receipt && Number.isSafeInteger(record.stateRevision) && record.stateRevision! >= 0, "CORRUPT", "Committed candidate has no publication receipt");
      try { validateState(record.surface, record.state); } catch { throw new UiGenerationError("CORRUPT", "Committed candidate has invalid parameters"); }
    }
    if (record.migration) {
      const { proposal, digest, status, readyReceipt, confirmation } = record.migration;
      check(proposal?.version === 1 && typeof proposal.proposalId === "string" && typeof proposal.originRunId === "string"
        && proposal.operationId === record.operationId && proposal.surfaceHash === record.surfaceHash && proposal.callEntryHash === record.callEntryHash
        && generationDigest(proposal) === digest && generationDigest(proposal.receipt) === generationDigest(record.receipt)
        && generationDigest(proposal.semantics) === generationDigest(record.semantics) && Array.isArray(proposal.fields)
        && proposal.fields.length <= 128 && ["provisional", "ready", "committed", "cancelled", "stale"].includes(status), "CORRUPT", "Invalid migration proposal");
      try { validateState(record.surface, proposal.suggestedState); } catch { throw new UiGenerationError("CORRUPT", "Invalid migration defaults"); }
      check((status === "provisional" || status === "ready") ? record.status === "awaiting_confirmation"
        : status === "committed" ? record.status === "committed" && !!record.publicationAnchor : record.status === "aborted", "CORRUPT", "Migration lifecycle disagrees with generation");
      if (status === "ready" || status === "committed") check(readyReceipt && typeof readyReceipt.entryId === "string" && typeof readyReceipt.entryHash === "string", "CORRUPT", "Migration completion receipt is missing");
      if (confirmation) check(typeof confirmation.requestId === "string" && typeof confirmation.runId === "string"
        && generationDigest({ decision: confirmation.decision, state: confirmation.state }) === confirmation.choiceDigest
        && ["confirm", "cancel"].includes(confirmation.decision), "CORRUPT", "Invalid confirmation intent");
    } else check(record.status !== "awaiting_confirmation" && !record.publicationAnchor, "CORRUPT", "Migration proof is missing");
  }
  for (const pointer of journal.active) {
    const record = journal.records.find(item => item.operationId === pointer.operationId);
    check(record?.status === "committed" && (record.publicationAnchor ?? record.receipt)?.entryId === pointer.anchor && record.surface.id === pointer.surfaceId, "CORRUPT", "Active pointer has no matching committed record");
  }
  for (const record of journal.records) if (record.status === "committed") {
    check(journal.active.filter(pointer => pointer.operationId === record.operationId).length === 1, "CORRUPT", "Committed generation is missing its unique active pointer");
  }
  for (const state of journal.states) {
    const record = journal.records.find(item => item.operationId === state.operationId);
    check(record?.status === "committed" && typeof state.anchor === "string" && Number.isSafeInteger(state.revision) && state.revision >= 0, "CORRUPT", "Saved parameters have no committed generation");
    try { validateState(record.surface, state.state); } catch { throw new UiGenerationError("CORRUPT", "Saved generation parameters are invalid"); }
  }
  check(journal.excludedOutputs === undefined || Array.isArray(journal.excludedOutputs), "CORRUPT", "Invalid excluded generation history");
  for (const excluded of journal.excludedOutputs ?? []) {
    check(excluded.reason === "uncommitted-at-fork" && ["candidate", "awaiting_confirmation", "aborted"].includes(excluded.sourceStatus) && ["source-receipt", "fork-observed-jsonl"].includes(excluded.evidenceOrigin) && typeof excluded.sourceSessionId === "string"
      && typeof excluded.operationId === "string" && !ids.has(excluded.operationId) && typeof excluded.toolCallId === "string" && typeof excluded.surfaceHash === "string"
      && typeof excluded.callEntryId === "string" && typeof excluded.callEntryHash === "string" && typeof excluded.source?.leafId === "string"
      && typeof excluded.receipt?.entryId === "string" && typeof excluded.receipt.entryHash === "string", "CORRUPT", "Invalid excluded generation evidence");
    ids.add(excluded.operationId);
  }
  check(journal.actionOperations === undefined || Array.isArray(journal.actionOperations), "CORRUPT", "Invalid action history");
  const actionIds = new Set<string>();
  for (const operation of journal.actionOperations ?? []) {
    const record = journal.records.find(item => item.operationId === operation.source?.operationId);
    check(typeof operation.id === "string" && operation.id.length > 0 && operation.id.length <= 128 && !actionIds.has(operation.id)
      && typeof operation.runId === "string" && Number.isFinite(operation.createdAt)
      && ["prepared", "waiting_approval", "executing", "completed", "cancelled", "failed", "uncertain"].includes(operation.status), "CORRUPT", "Invalid action operation");
    actionIds.add(operation.id);
    check(record?.status === "committed" && operation.source.toolCallId === record.toolCallId
      && operation.source.publicationEntryId === publicationEntry(record) && typeof operation.source.leafId === "string"
      && /^[a-f0-9]{64}$/.test(operation.source.digest) && Number.isSafeInteger(operation.source.revision)
      && record.actions?.actions.some(action => generationDigest(action) === generationDigest(operation.action)), "CORRUPT", "Action no longer matches its publication");
    check(operation.file && typeof operation.file.root === "string" && typeof operation.file.path === "string"
      && typeof operation.file.exists === "boolean" && operation.file.rootIdentity && operation.file.parentIdentity,
    "CORRUPT", "Invalid action file evidence");
    check(operation.action.kind !== "save_snapshot" || typeof operation.snapshotHash === "string" && /^[a-f0-9]{64}$/.test(operation.snapshotHash), "CORRUPT", "Missing report fingerprint");
    if (operation.result?.kind === "parameters") {
      check(operation.action.kind === "read_json_parameters", "CORRUPT", "Unexpected parameter result");
      try { validateState(record.surface, operation.result.state); } catch { throw new UiGenerationError("CORRUPT", "Invalid queried parameters"); }
    } else if (operation.result) check(operation.result.kind === "snapshot" && operation.action.kind === "save_snapshot"
      && operation.result.sha256 === operation.snapshotHash && operation.result.path === operation.file.path
      && Number.isSafeInteger(operation.result.bytes), "CORRUPT", "Invalid saved report receipt");
    check(operation.status !== "completed" || !!operation.result, "CORRUPT", "Completed action has no result");
    check(operation.appliedRevision === undefined || operation.status === "completed" && operation.result?.kind === "parameters"
      && Number.isSafeInteger(operation.appliedRevision), "CORRUPT", "Invalid parameter application receipt");
  }
  return journal;
}
function saveJournal(path: string, journal: Journal, assertOwned: () => void): void {
  check(journal.records.length + (journal.excludedOutputs?.length ?? 0) <= 1000 && journal.states.length <= 10_000
    && (journal.actionOperations?.length ?? 0) <= 1000, "LIMIT", "Generation journal has reached its entry limit");
  const text = `${JSON.stringify(journal)}\n`;
  check(Buffer.byteLength(text) <= 8 * 1024 * 1024, "LIMIT", "Generation journal has reached its size limit");
  assertOwned();
  writePrivateFileAtomicSync(path, text);
}
function envelope(record: GenerationRecord) {
  return { answerOutput: { kind: "intelligent-ui", version: 2, operationId: record.operationId, surfaceHash: record.surfaceHash, snapshot: formatSnapshot(record.surface), payload: record.surface,
    ...(record.actions ? { actions: record.actions } : {}) } };
}
type BoundEntry = Pick<GenerationRecord, "callEntryId" | "callEntryHash" | "forkCall"> & { source: { leafId: string } };
function verifyCall(disk: Disk, record: BoundEntry & { contextTitles?: ContextTitleReceipt[] }): void {
  let parent = record.source.leafId;
  if (record.contextTitles !== undefined) {
    check(Array.isArray(record.contextTitles) && record.contextTitles.length > 0 && record.contextTitles.length <= 64,
      "CORRUPT", "Invalid captured title ancestry");
    const seen = new Set<string>([parent]);
    for (const title of record.contextTitles) {
      check(title && !seen.has(title.entryId) && disk.byId.get(title.entryId)?.type === "session_info",
        "RECEIPT", "Captured title metadata changed or disappeared");
      verifyBoundEntry(disk, { callEntryId: title.entryId, callEntryHash: title.entryHash,
        source: { leafId: parent }, forkCall: title.forkCall });
      seen.add(title.entryId); parent = title.entryId;
    }
  }
  verifyBoundEntry(disk, { ...record, source: { leafId: parent } });
}
function verifyBoundEntry(disk: Disk, record: BoundEntry): void {
  const call = disk.byId.get(record.callEntryId);
  if (!record.forkCall) {
    check(call && call.parentId === record.source.leafId && generationDigest(call) === record.callEntryHash, "RECEIPT", "Bound assistant tool call changed or disappeared");
    return;
  }
  const proof = record.forkCall;
  check(proof.version === 1 && typeof proof.sourceSessionId === "string" && Array.isArray(proof.removedLabels) && proof.removedLabels.length > 0 && proof.removedLabels.length <= 1000, "CORRUPT", "Invalid fork call provenance");
  let parent: string | null = record.source.leafId;
  const seen = new Set<string>();
  for (const label of proof.removedLabels) {
    check(label.entry?.type === "label" && label.entry.id === parent && !seen.has(parent) && generationDigest(label.entry) === label.hash, "RECEIPT", "Fork label provenance changed");
    seen.add(parent); parent = label.entry.parentId;
  }
  check(parent === proof.targetParentId && call && call.parentId === parent
    && generationDigest({ ...call, parentId: record.source.leafId }) === record.callEntryHash, "RECEIPT", "Inherited assistant does not match its original call evidence");
}
function declaredCalls(call: DiskEntry): Array<{ id: string; name: string }> {
  check(call.type === "message" && call.message?.role === "assistant" && Array.isArray(call.message.content), "RECEIPT", "Expected a persisted assistant tool-call message");
  const calls = call.message.content.filter((block: { type?: string }) => block?.type === "toolCall");
  check(calls.length > 0 && calls.length <= 64 && calls.every((call: { id?: unknown; name?: unknown }) => typeof call.id === "string" && call.id.length > 0 && call.id.length <= 256 && typeof call.name === "string" && call.name.length > 0) && new Set(calls.map((call: { id: string }) => call.id)).size === calls.length, "RECEIPT", "Assistant must declare unique, bounded tool-call identities");
  return calls;
}
/** Accept only one assistant's declared result chain, never arbitrary descendants. */
function turnPath(disk: Disk, callEntryId: string, leafId: string, complete = false): DiskEntry[] {
  const call = disk.byId.get(callEntryId); check(call, "RECEIPT", "Bound assistant entry is missing");
  const calls = new Map(declaredCalls(call).map(item => [item.id, item.name]));
  const entries = branch(disk, leafId), position = entries.findIndex(entry => entry.id === callEntryId);
  check(position >= 0, "CONFLICT", "Current branch does not contain the bound assistant");
  const results = entries.slice(position + 1), seen = new Set<string>();
  for (const entry of results) {
    const message = entry.message, id = message?.toolCallId;
    check(entry.type === "message" && message?.role === "toolResult" && typeof id === "string" && calls.has(id) && message.toolName === calls.get(id) && !seen.has(id), "CONFLICT", "Only unique results declared by this assistant may advance the generation branch");
    seen.add(id);
  }
  check(!complete || seen.size === calls.size, "RECEIPT", "The assistant's complete tool result set is not on disk yet");
  return results;
}
function verifyReceipt(disk: Disk, record: GenerationRecord, entryId = record.receipt?.entryId): DiskEntry {
  verifyCall(disk, record);
  const entry = entryId && disk.byId.get(entryId);
  check(entry && entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === record.toolCallId && entry.message.isError === false && generationDigest(entry.message.details) === generationDigest(envelope(record)), "RECEIPT", "Exact candidate tool result is not present on disk");
  turnPath(disk, record.callEntryId, entry.id);
  if (record.receipt) check(record.receipt.entryId === entry.id && record.receipt.entryHash === generationDigest(entry), "RECEIPT", "Candidate receipt no longer matches the disk record");
  return entry;
}

const publicationEntry = (record: GenerationRecord) => (record.publicationAnchor ?? record.receipt)?.entryId;
function verifyTurnReceipt(disk: Disk, record: GenerationRecord, required = false): void {
  const receipt = record.turnReceipt ?? record.migration?.proposal.turnReceipt;
  check(!required || receipt, "RECEIPT", "Migration requires a complete SDK turn receipt");
  if (!receipt) return;
  const results = turnPath(disk, record.callEntryId, receipt.leafId, true);
  check(generationDigest(receipt.entryIds) === generationDigest(results.map(entry => entry.id))
    && generationDigest(receipt.entryHashes) === generationDigest(results.map(generationDigest)), "RECEIPT", "Acknowledged turn evidence changed");
}
function confirmationData(record: GenerationRecord) {
  const migration = record.migration!;
  return { version: 1, kind: "intelligent-ui-confirmation", sessionId: migration.proposal.source.sessionId,
    operationId: record.operationId, proposalId: migration.proposal.proposalId, digest: migration.digest,
    readyLeafId: migration.readyReceipt!.entryId, ...migration.confirmation };
}
function verifyPublication(disk: Disk, record: GenerationRecord): void {
  verifyReceipt(disk, record);
  if (!record.publicationAnchor) return;
  const migration = record.migration;
  check(migration?.status === "committed" && migration.readyReceipt && migration.confirmation?.decision === "confirm", "RECEIPT", "Published migration has no confirmation");
  verifyTurnReceipt(disk, record, true);
  verifyCall(disk, { callEntryId: record.publicationAnchor.entryId, callEntryHash: record.publicationAnchor.entryHash,
    source: { leafId: migration.readyReceipt.entryId }, forkCall: record.confirmationFork });
  const ready = disk.byId.get(migration.readyReceipt.entryId)
    ?? record.confirmationFork?.removedLabels.find(label => label.entry.id === migration.readyReceipt!.entryId)?.entry;
  check(ready && generationDigest(ready) === migration.readyReceipt.entryHash, "RECEIPT", "Original completion receipt changed");
  const entry = disk.byId.get(record.publicationAnchor.entryId)!;
  check(entry.type === "custom" && entry.customType === "piora-ui-confirmation"
    && generationDigest(entry.data) === generationDigest(confirmationData(record))
    && generationDigest({ decision: "confirm", state: record.state }) === migration.confirmation.choiceDigest,
  "RECEIPT", "Confirmation receipt does not match the published parameters");
}

export class UiGenerationPrototype {
  private readonly sessionId: string;
  private readonly sessionFile: string;
  private readonly path: string;
  private epoch: string | null = null;
  private readonly contexts = new Map<string, Context>();
  private readonly requests = new Map<string, UiGenerationRequestContext>();
  constructor(private readonly options: { manager: Manager; root: string; signal?: AbortSignal; runId?: string;
    mutationOwner?: { assertOwned(): void }; fault?: (stage: GenerationStage) => void }) {
    this.sessionId = options.manager.getSessionId();
    const file = options.manager.getSessionFile(); check(file, "IDENTITY", "A disk-backed session is required");
    this.sessionFile = resolve(file); this.path = generationJournalPath(this.sessionId, options.root);
  }
  private locked<T>(work: (journal: Journal, disk: Disk, assertOwned: () => void) => T, readOnly = false, allowLegacySnapshot = false): Promise<T> {
    const withLock = this.options.mutationOwner
      ? <R>(id: string, root: string, work: (assertOwned: () => void) => R | Promise<R>) => withUiSessionMutationLock(id, root, this.options.mutationOwner!, work)
      : readOnly ? withUiSessionReadLock : withUiSessionLock;
    return withLock(this.sessionId, this.options.root, sessionOwned =>
      withUiFileLock(`${intelligentUiStatePath(this.sessionId, this.options.root)}.lock`, legacyOwned =>
        withUiFileLock(`${this.path}.lock`, journalOwned => {
          sessionOwned(); legacyOwned(); journalOwned();
          check(this.options.manager.getSessionId() === this.sessionId && resolve(this.options.manager.getSessionFile() ?? "") === this.sessionFile, "IDENTITY", "Session identity changed");
          const journal = readJournal(this.path, this.sessionId);
          // Legacy-only snapshots may be old SDK versions or lack a final LF.
          // The isolated reader can migrate memory, never repair source bytes.
          const entries = allowLegacySnapshot && !existsSync(this.path)
            ? readOnlySessionManager(this.sessionFile, { expectedSessionId: this.sessionId }).getEntries() as unknown as DiskEntry[] : undefined;
          const disk = entries ? { entries, byId: new Map(entries.map(entry => [entry.id, entry])) } : readDisk(this.sessionFile, this.sessionId);
          return work(journal, disk, () => { sessionOwned(); legacyOwned(); journalOwned(); });
        })));
  }
  private currentLeaf(disk: Disk, requireTip = false): string {
    const leaf = this.options.manager.getLeafId(); check(leaf && disk.byId.has(leaf), "RECEIPT", "Current session leaf is not on disk");
    check(!requireTip || disk.entries.at(-1)?.id === leaf, "CONFLICT", "Session disk tip advanced in another writer"); return leaf;
  }
  private admitted(journal: Journal): void { check(this.epoch && journal.epoch === this.epoch && !this.options.signal?.aborted, "CANCELLED", "Generation run is cancelled or superseded"); }
  private active(journal: Journal, disk: Disk, leafId: string, surfaceId: string) {
    const entries = branch(disk, leafId), ancestry = new Set(entries.map(entry => entry.id));
    const pointerByAnchor = new Map(journal.active.filter(item => item.surfaceId === surfaceId).map(item => [item.anchor, item]));
    let record: GenerationRecord | undefined;
    for (const entry of entries) {
      const pointer = pointerByAnchor.get(entry.id);
      if (pointer) record = journal.records.find(item => item.operationId === pointer.operationId);
    }
    if (!record) return undefined;
    check(record.status === "committed" && record.receipt && ancestry.has(publicationEntry(record)!), "CORRUPT", "Published generation is not on this branch");
    verifyPublication(disk, record);
    const states = new Map(journal.states.filter(item => item.operationId === record!.operationId).map(item => [item.anchor, item]));
    let state = record.state!, revision = record.stateRevision!;
    for (const entry of entries) { const saved = states.get(entry.id); if (saved) { state = saved.state; revision = saved.revision; } }
    return { record, state, revision };
  }
  private source(journal: Journal, disk: Disk, leafId: string, surfaceId: string): { source: Source; state: UiState; surface?: UiSurface; semantics?: Semantics; actions?: UiActionDeclaration } {
    const latest = this.active(journal, disk, leafId, surfaceId);
    const entries = branch(disk, leafId);
    const legacy = branchSurfaces(entries).filter(item => item.surface.id === surfaceId).at(-1);
    // Protocol rollbacks may produce a later legacy result. Branch order, not
    // protocol version, determines which committed structure is current.
    if (latest && (!legacy || entries.findIndex(entry => entry.id === publicationEntry(latest.record)) > entries.findIndex(entry => entry.id === legacy.entryId))) {
      return { source: { origin: "journal", surfaceId, surfaceRevision: latest.record.surface.revision, stateRevision: latest.revision, stateHash: generationDigest(latest.state), operationId: latest.record.operationId }, state: latest.state, surface: latest.record.surface, semantics: latest.record.semantics, actions: latest.record.actions };
    }
    if (legacy) {
      const saved = getSurfaceState(this.sessionId, entries, legacy.toolCallId, this.options.root);
      return { source: { origin: "legacy", surfaceId, surfaceRevision: saved.surface.revision, stateRevision: saved.revision, stateHash: generationDigest(saved.state) }, state: saved.state, surface: saved.surface };
    }
    return { source: { origin: "none", surfaceId, surfaceRevision: 0, stateRevision: 0, stateHash: generationDigest({}) }, state: {} };
  }
  /** A new host run/epoch aborts all unfinished candidates; no automatic crash publication. */
  async startRun(): Promise<string> {
    return this.locked((journal, _disk, assertOwned) => {
      check(!this.options.signal?.aborted, "CANCELLED", "Generation run is cancelled");
      this.epoch = randomUUID(); this.contexts.clear(); this.requests.clear(); journal.epoch = this.epoch;
      for (const record of journal.records) if (record.status === "candidate" || record.migration?.status === "provisional") {
        record.status = "aborted"; record.abortReason = "previous-epoch";
        if (record.migration) record.migration.status = "cancelled";
      }
      saveJournal(this.path, journal, assertOwned); return this.epoch;
    });
  }
  async cancelRun(): Promise<void> {
    return this.locked((journal, _disk, assertOwned) => {
      if (journal.epoch === this.epoch) {
        journal.epoch = null;
        for (const record of journal.records) if ((record.status === "candidate" || record.migration?.status === "provisional") && record.epoch === this.epoch) {
          record.status = "aborted"; record.abortReason = "cancelled";
          if (record.migration) record.migration.status = "cancelled";
        }
        saveJournal(this.path, journal, assertOwned);
      }
      this.epoch = null; this.contexts.clear(); this.requests.clear();
    });
  }
  /** Call when constructing model context, never at execute completion. */
  async captureContext(surfaceId: string): Promise<Context> {
    return this.locked((journal, disk) => {
      this.admitted(journal);
      check(isUiId(surfaceId), "IDENTITY", "Context requires a valid surface identity");
      check(this.contexts.size < 256, "LIMIT", "Run has reached its context capture limit");
      const leafId = this.currentLeaf(disk, true), current = this.source(journal, disk, leafId, surfaceId);
      const context: Context = { contextId: randomUUID(), sessionId: this.sessionId, leafId, epoch: this.epoch!, source: current.source, state: current.state };
      this.contexts.set(context.contextId, copy(context)); return copy(context);
    });
  }
  /**
   * Capture once inside the model-context hook, before the provider request.
   * Recording the whole visible identity set also proves which IDs did not exist;
   * a model-selected new ID must not be sampled later during tool execution.
   */
  async captureRequestContext(): Promise<UiGenerationRequestContext> {
    return this.locked((journal, disk) => {
      this.admitted(journal);
      check(this.requests.size < 256, "LIMIT", "Run has reached its request capture limit");
      const leafId = this.currentLeaf(disk, true), entries = branch(disk, leafId), ancestry = new Set(entries.map(entry => entry.id));
      const ids = new Set(branchSurfaces(entries).map(item => item.surface.id));
      for (const pointer of journal.active) if (ancestry.has(pointer.anchor)) ids.add(pointer.surfaceId);
      check(ids.size <= 256, "LIMIT", "Request exceeds the source identity snapshot limit");
      const snapshot: UiGenerationRequestContext = { requestId: randomUUID(), sessionId: this.sessionId, leafId, epoch: this.epoch!, surfaces: [...ids].map(id => {
        const { source, state, surface, actions } = this.source(journal, disk, leafId, id);
        return { source, state, ...(surface ? { summary: decisionSummary(surface, state, actions) } : {}) };
      }) };
      this.requests.set(snapshot.requestId, copy(snapshot)); return copy(snapshot);
    });
  }
  /** Pure lookup of the frozen request snapshot; does not read current parameter values. */
  contextForSurface(requestId: string, surfaceId: string): Context {
    check(isUiId(surfaceId), "IDENTITY", "Context requires a valid surface identity");
    const snapshot = this.requests.get(requestId);
    check(snapshot && snapshot.epoch === this.epoch && !this.options.signal?.aborted, "IDENTITY", "Source requires the current host-captured request context");
    const captured = snapshot.surfaces.find(item => item.source.surfaceId === surfaceId);
    return copy({ contextId: requestId, sessionId: this.sessionId, leafId: snapshot.leafId, epoch: snapshot.epoch,
      source: captured?.source ?? { origin: "none", surfaceId, surfaceRevision: 0, stateRevision: 0, stateHash: generationDigest({}) }, state: captured?.state ?? {} });
  }
  async createCandidate(contextId: string, toolCallId: string, compiled: Pick<CompiledUiPlan | CompiledUiRichPlan, "surface" | "inputSemantics" | "planVersion" | "compilerVersion" | "actions">): Promise<{ operationId: string; messageEntryId: string; details: ReturnType<typeof envelope> }> {
    return this.locked((journal, disk, assertOwned) => {
      this.admitted(journal);
      check(typeof toolCallId === "string" && toolCallId.length > 0 && toolCallId.length <= 256, "IDENTITY", "Candidate requires a bounded tool call identity");
      const surface = validateSurface(compiled.surface), semantics = copy(compiled.inputSemantics);
      const actions = compiled.actions === undefined ? undefined : validateUiActions(compiled.actions);
      const context = this.contexts.get(contextId) ?? (this.requests.has(contextId) ? this.contextForSurface(contextId, surface.id) : undefined);
      check(context && context.epoch === this.epoch, "IDENTITY", "Candidate requires a host-captured context");
      check(compiled.planVersion === surface.version && typeof compiled.compilerVersion === "string" && compiled.compilerVersion.length > 0 && compiled.compilerVersion.length <= 80, "IDENTITY", "A compatible versioned host compiler result is required");
      check(surface.id === context.source.surfaceId && surface.revision === context.source.surfaceRevision + 1, "CONFLICT", "Candidate version must follow the captured source");
      const surfaceHash = generationDigest(surface);
      const replay = journal.records.find(item => item.epoch === this.epoch && item.toolCallId === toolCallId);
      if (replay) {
        check(generationDigest(replay.actions ?? null) === generationDigest(actions ?? null), "CONFLICT", "Tool call identity was reused with different actions");
        check(replay.surfaceHash === surfaceHash && replay.planVersion === compiled.planVersion && replay.compilerVersion === compiled.compilerVersion && generationDigest(replay.semantics) === generationDigest(semantics) && replay.source.contextId === contextId && replay.status !== "aborted", "CONFLICT", "Tool call identity was reused with different content");
        return { operationId: replay.operationId, messageEntryId: replay.callEntryId, details: envelope(replay) };
      }
      const leaf = this.currentLeaf(disk, true), entries = branch(disk, leaf), sourcePosition = entries.findIndex(entry => entry.id === context.leafId);
      check(sourcePosition >= 0, "CONFLICT", "Current branch no longer contains the captured context");
      let callPosition = sourcePosition + 1;
      const contextTitles: ContextTitleReceipt[] = [];
      while (entries[callPosition]?.type === "session_info") {
        check(contextTitles.length < 64, "LIMIT", "Too many title changes during generation");
        const title = entries[callPosition++];
        contextTitles.push({ entryId: title.id, entryHash: generationDigest(title) });
      }
      const call = entries[callPosition];
      check(call && call.type === "message" && call.message?.role === "assistant", "CONFLICT", "Only title metadata may precede the bound assistant after context capture");
      const calls = declaredCalls(call), callEntryId = call.id;
      check(calls.some(call => call.id === toolCallId && call.name === "piora_render_ui_plan"), "CONFLICT", "Assistant did not declare this candidate UI tool call");
      turnPath(disk, callEntryId, leaf);
      const current = this.source(journal, disk, leaf, surface.id);
      check(generationDigest(current.source) === generationDigest(context.source), "CONFLICT", "Saved parameters changed after context capture");
      check(current.surface?.version !== 2 || surface.version === 2, "UI_PROTOCOL_UNAVAILABLE", "This saved UI requires the rich layout protocol. Preserve its layout and parameters instead of replacing it with a legacy surface.");
      const record: GenerationRecord = { operationId: randomUUID(), epoch: this.epoch!, status: "candidate", source: copy(context), callEntryId, callEntryHash: generationDigest(call), toolCallId, surface, surfaceHash, semantics, planVersion: compiled.planVersion, compilerVersion: compiled.compilerVersion, ...(actions ? { actions } : {}), ...(contextTitles.length ? { contextTitles } : {}) };
      journal.records.push(record); saveJournal(this.path, journal, assertOwned); this.options.fault?.("candidate-written");
      return { operationId: record.operationId, messageEntryId: record.callEntryId, details: envelope(record) };
    });
  }
  /** Fixture-only writer. Production must let SDK append and use observePersistedCandidate. */
  async persistCandidate(operationId: string): Promise<Receipt> {
    return this.locked((journal, disk, assertOwned) => {
      this.admitted(journal);
      const record = journal.records.find(item => item.operationId === operationId);
      check(record && record.epoch === this.epoch && record.status !== "aborted", "IDENTITY", "Candidate is not admitted for this run");
      if (record.receipt) { verifyReceipt(disk, record); return copy(record.receipt); }
      verifyCall(disk, record);
      const recovered = disk.entries.filter(entry => entry.message?.role === "toolResult" && entry.message?.toolCallId === record.toolCallId);
      check(recovered.length <= 1, "RECEIPT", "Ambiguous candidate tool results");
      let entryId: string;
      if (recovered.length) { entryId = verifyReceipt(disk, record, recovered[0].id).id; check(this.currentLeaf(disk, true) === entryId, "CONFLICT", "Conversation moved after candidate persistence"); }
      else {
        check(this.currentLeaf(disk, true) === record.callEntryId, "CONFLICT", "Conversation moved before candidate persistence");
        check(this.options.manager.appendMessage, "IDENTITY", "Production read-only session adapters cannot append candidate results");
        assertOwned();
        entryId = this.options.manager.appendMessage({ role: "toolResult", toolCallId: record.toolCallId, toolName: "piora_render_ui_plan", isError: false, content: [{ type: "text", text: formatSnapshot(record.surface) }], details: JSON.parse(JSON.stringify(envelope(record))), timestamp: Date.now() });
        this.options.fault?.("tool-result-written");
      }
      const fd = openSync(this.sessionFile, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      const written = verifyReceipt(readDisk(this.sessionFile, this.sessionId), record, entryId);
      record.receipt = { entryId, entryHash: generationDigest(written) };
      saveJournal(this.path, journal, assertOwned); this.options.fault?.("receipt-written"); return copy(record.receipt);
    });
  }
  /**
   * Await from SDK turn_end, whose IDs refer to already appended messages. The
   * message_end/tool_execution_end event alone is too early. This never appends.
   */
  async observePersistedCandidate(operationId: string, boundary: UiGenerationTurnReceipt): Promise<Receipt> {
    return this.locked((journal, disk, assertOwned) => {
      this.admitted(journal);
      const record = journal.records.find(item => item.operationId === operationId);
      check(record && record.epoch === this.epoch && record.status !== "aborted", "IDENTITY", "Candidate is not admitted for this run");
      check(boundary.messageEntryId === record.callEntryId, "RECEIPT", "Turn boundary belongs to another assistant");
      verifyCall(disk, record);
      const leafId = this.currentLeaf(disk, true), results = turnPath(disk, record.callEntryId, leafId, true);
      const ids = boundary.toolResultEntryIds;
      check(Array.isArray(ids) && ids.length === results.length && new Set(ids).size === ids.length && results.every(entry => ids.includes(entry.id)), "RECEIPT", "Turn boundary must identify the exact complete disk result set");
      const matching = results.filter(entry => entry.message?.toolCallId === record.toolCallId);
      check(matching.length === 1, "RECEIPT", "Candidate result is missing or ambiguous");
      const fd = openSync(this.sessionFile, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      const durable = readDisk(this.sessionFile, this.sessionId), finalResults = turnPath(durable, record.callEntryId, this.currentLeaf(durable, true), true);
      check(generationDigest(finalResults) === generationDigest(results), "RECEIPT", "Turn results changed during disk receipt verification");
      const entry = verifyReceipt(durable, record, matching[0].id);
      const turnReceipt = { leafId, entryIds: results.map(entry => entry.id), entryHashes: results.map(generationDigest) };
      if (record.turnReceipt) check(generationDigest(record.turnReceipt) === generationDigest(turnReceipt), "RECEIPT", "Previously acknowledged turn results changed");
      record.receipt = { entryId: entry.id, entryHash: generationDigest(entry) }; record.turnReceipt = turnReceipt;
      saveJournal(this.path, journal, assertOwned); this.options.fault?.("receipt-written"); return copy(record.receipt);
    });
  }
  /** A rejected publication is terminal even while other tools in this run continue. */
  async abortCandidate(operationId: string, reason: string): Promise<void> {
    return this.locked((journal, _disk, assertOwned) => {
      this.admitted(journal);
      check(/^[A-Z][A-Z0-9_]{0,79}$/.test(reason), "IDENTITY", "Candidate failure requires a bounded diagnostic code");
      const record = journal.records.find(item => item.operationId === operationId);
      check(record && record.epoch === this.epoch, "IDENTITY", "Candidate belongs to another run");
      check(record.status !== "committed", "CONFLICT", "Published output cannot be cancelled as a candidate");
      if (record.status === "aborted") return;
      record.status = "aborted"; record.abortReason = reason;
      if (record.migration) record.migration.status = "cancelled";
      saveJournal(this.path, journal, assertOwned);
    });
  }
  async commitCandidate(operationId: string) {
    return this.locked((journal, disk, assertOwned) => {
      const record = journal.records.find(item => item.operationId === operationId); check(record, "IDENTITY", "Unknown candidate");
      if (record.status === "committed") { verifyPublication(disk, record); return copy({ operationId, state: record.state!, stateRevision: record.stateRevision!, entryId: publicationEntry(record)! }); }
      this.admitted(journal);
      check(record.status === "candidate" && record.epoch === this.epoch, "CANCELLED", "Candidate was cancelled or superseded");
      check(record.receipt, "RECEIPT", "Candidate has no disk receipt");
      verifyReceipt(disk, record);
      const leafId = this.currentLeaf(disk, true);
      if (record.turnReceipt) {
        const results = turnPath(disk, record.callEntryId, leafId, true);
        check(record.turnReceipt.leafId === leafId && generationDigest(record.turnReceipt.entryIds) === generationDigest(results.map(entry => entry.id)) && generationDigest(record.turnReceipt.entryHashes) === generationDigest(results.map(generationDigest)), "CONFLICT", "Acknowledged turn changed before publication");
      } else check(leafId === record.receipt.entryId, "CONFLICT", "Conversation moved after candidate generation");
      const current = this.source(journal, disk, leafId, record.surface.id);
      check(generationDigest(current.source) === generationDigest(record.source.source), "CONFLICT", "Saved parameters changed during generation");
      const migration = assessUiMigration(current.surface ? { ...current, surface: current.surface } : undefined, record);
      check(!migration.requiresConfirmation, "MIGRATION_REQUIRED", "Changed or removed inputs require explicit migration");
      const state = migration.suggestedState;
      validateState(record.surface, state);
      this.options.fault?.("before-commit");
      this.admitted(journal);
      record.status = "committed"; record.state = state; record.stateRevision = ++journal.revision;
      journal.active.push({ anchor: record.receipt.entryId, surfaceId: record.surface.id, operationId });
      journal.states.push({ anchor: record.receipt.entryId, operationId, revision: record.stateRevision, state });
      // This single atomic rename is the publication point for status, parameters and pointer.
      saveJournal(this.path, journal, assertOwned); this.options.fault?.("committed");
      return copy({ operationId, state, stateRevision: record.stateRevision, entryId: record.receipt.entryId });
    });
  }
  /** Preserve a verified incompatible candidate; only normal run completion can make it confirmable. */
  async prepareMigration(operationId: string): Promise<UiMigrationReview> {
    return this.locked((journal, disk, assertOwned) => {
      this.admitted(journal);
      const record = journal.records.find(item => item.operationId === operationId);
      check(record && record.epoch === this.epoch && ["candidate", "awaiting_confirmation"].includes(record.status), "CANCELLED", "Candidate cannot request confirmation");
      verifyReceipt(disk, record); verifyTurnReceipt(disk, record, true);
      const leafId = this.currentLeaf(disk, true);
      check(leafId === record.turnReceipt!.leafId, "CONFLICT", "Conversation moved before migration preparation");
      const current = this.source(journal, disk, leafId, record.surface.id);
      check(current.surface && generationDigest(current.source) === generationDigest(record.source.source), "CONFLICT", "Source changed before migration preparation");
      const assessment = assessUiMigration({ ...current, surface: current.surface }, record);
      check(assessment.requiresConfirmation, "CONFLICT", "Candidate does not require migration confirmation");
      if (!record.migration) {
        const proposal: MigrationProposal = { version: 1, proposalId: randomUUID(), operationId, originRunId: this.options.runId ?? this.epoch!,
          source: copy(record.source), callEntryHash: record.callEntryHash, surfaceHash: record.surfaceHash, semantics: copy(record.semantics),
          receipt: copy(record.receipt!), turnReceipt: copy(record.turnReceipt!), fields: assessment.fields, suggestedState: assessment.suggestedState };
        record.status = "awaiting_confirmation"; record.migration = { proposal, digest: generationDigest(proposal), status: "provisional" };
        saveJournal(this.path, journal, assertOwned); this.options.fault?.("migration-proposed");
      }
      return this.migrationView(record, leafId);
    });
  }
  /** Called after synchronous execution revocation, while the manager still owns the file. */
  async finishRun(reason: "idle" | "error" | "abort" | "destroy" | "fork"): Promise<void> {
    if (reason !== "idle") return this.cancelRun();
    return this.locked((journal, disk, assertOwned) => {
      if (!this.epoch || journal.epoch !== this.epoch) return;
      const leafId = this.currentLeaf(disk, true), ancestry = new Set(branch(disk, leafId).map(entry => entry.id));
      for (const record of journal.records) if (record.epoch === this.epoch) {
        if (record.status === "candidate") { record.status = "aborted"; record.abortReason = "unfinished-run"; }
        if (record.migration?.status !== "provisional") continue;
        try {
          verifyReceipt(disk, record); verifyTurnReceipt(disk, record, true);
          check(ancestry.has(record.turnReceipt!.leafId), "CONFLICT", "Migration turn is outside the completed branch");
          check(generationDigest(this.source(journal, disk, leafId, record.surface.id).source) === generationDigest(record.source.source), "CONFLICT", "Migration source changed before completion");
          record.migration.readyReceipt = { entryId: leafId, entryHash: generationDigest(disk.byId.get(leafId)) };
          record.migration.status = "ready";
        } catch {
          record.status = "aborted"; record.abortReason = "migration-stale"; record.migration.status = "stale";
        }
      }
      journal.epoch = null; saveJournal(this.path, journal, assertOwned);
      this.epoch = null; this.contexts.clear(); this.requests.clear(); this.options.fault?.("migration-ready");
    });
  }
  private migrationView(record: GenerationRecord, leafId: string, status = record.migration!.status): UiMigrationReview {
    const migration = record.migration!;
    return copy({ proposalId: migration.proposal.proposalId, digest: migration.digest, toolCallId: record.toolCallId, leafId,
      status, fields: migration.proposal.fields, suggestedState: migration.proposal.suggestedState,
      ...(status === "ready" && migration.confirmation?.decision === "confirm"
        ? { pendingConfirmation: { requestId: migration.confirmation.requestId, state: migration.confirmation.state } } : {}) });
  }
  private checkMigrationSource(journal: Journal, disk: Disk, record: GenerationRecord): void {
    verifyReceipt(disk, record); verifyTurnReceipt(disk, record, true);
    const migration = record.migration!, ready = migration.readyReceipt;
    check(ready && generationDigest(disk.byId.get(ready.entryId)) === ready.entryHash, "RECEIPT", "Migration completion evidence changed");
    const current = this.source(journal, disk, ready.entryId, record.surface.id);
    check(current.surface && generationDigest(current.source) === generationDigest(record.source.source), "CONFLICT", "Saved parameters or structure changed after generation");
    const assessment = assessUiMigration({ ...current, surface: current.surface }, record);
    check(assessment.requiresConfirmation && generationDigest(assessment.fields) === generationDigest(migration.proposal.fields)
      && generationDigest(assessment.suggestedState) === generationDigest(migration.proposal.suggestedState), "RECEIPT", "Migration review no longer matches its source");
  }
  async readMigration(toolCallId: string): Promise<UiMigrationReview | null> {
    return this.locked((journal, disk) => {
      const leafId = this.currentLeaf(disk), ancestry = new Set(branch(disk, leafId).map(entry => entry.id));
      const record = journal.records.find(item => item.toolCallId === toolCallId && item.receipt && ancestry.has(item.receipt.entryId));
      if (!record?.migration) return null;
      if (record.status === "committed" && !ancestry.has(publicationEntry(record)!)) return null;
      verifyReceipt(disk, record);
      let status = record.migration.status;
      if (status === "ready") {
        try {
          this.checkMigrationSource(journal, disk, record);
          const intent = record.migration.confirmation;
          const entry = disk.byId.get(leafId);
          const recovered = intent?.decision === "confirm" && entry?.type === "custom" && entry.customType === "piora-ui-confirmation"
            && entry.parentId === record.migration.readyReceipt!.entryId && generationDigest(entry.data) === generationDigest(confirmationData(record));
          check(leafId === record.migration.readyReceipt!.entryId || recovered, "CONFLICT", "Conversation changed since migration review");
        } catch { status = "stale"; }
      }
      if (status === "committed") verifyPublication(disk, record);
      return this.migrationView(record, leafId, status);
    }, true);
  }
  async confirmMigration(input: { proposalId: string; digest: string; leafId: string; requestId: string;
    decision: "confirm" | "cancel"; state: unknown }, authorization: UiMigrationAuthorization) {
    return this.locked((journal, disk, assertOwned) => {
      const record = journal.records.find(item => item.migration?.proposal.proposalId === input.proposalId);
      check(record?.migration && record.migration.digest === input.digest, "IDENTITY", "Unknown or changed migration proposal");
      check(typeof input.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId)
        && ["confirm", "cancel"].includes(input.decision), "IDENTITY", "A bounded confirmation identity and choice are required");
      const migration = record.migration;
      const state = input.decision === "confirm" ? validateState(record.surface, input.state) : {};
      const choiceDigest = generationDigest({ decision: input.decision, state });
      const authorize = () => assertUiMigrationAuthorization(authorization, { sessionId: this.sessionId, proposalId: input.proposalId, digest: input.digest, choiceDigest });
      const identity = authorize();
      check(identity.runId !== migration.proposal.originRunId, "IDENTITY", "Confirmation requires a new user operation identity");
      const previous = migration.confirmation;
      if (previous && (input.decision === "confirm" || migration.status === "committed" || migration.status === "cancelled")) {
        check(previous.requestId === input.requestId && previous.choiceDigest === choiceDigest, "CONFLICT", "Another confirmation choice already owns this proposal");
      }
      if (migration.status === "committed") {
        verifyPublication(disk, record);
        check(branch(disk, this.currentLeaf(disk)).some(entry => entry.id === publicationEntry(record)), "CONFLICT", "Published confirmation is outside the selected branch");
        return copy({ status: "committed" as const, entryId: publicationEntry(record)!, state: record.state!, stateRevision: record.stateRevision! });
      }
      if (migration.status === "cancelled" && previous?.decision === "cancel") return { status: "cancelled" as const };
      check(record.status === "awaiting_confirmation" && migration.status === "ready" && journal.epoch === null,
        "CANCELLED", "Only a ready proposal from a completed run can be confirmed");
      const leafId = this.currentLeaf(disk, true);
      try {
        this.checkMigrationSource(journal, disk, record);
        const leaf = disk.byId.get(leafId)!;
        const recovered = previous?.decision === "confirm" && leaf.type === "custom" && leaf.customType === "piora-ui-confirmation"
          && leaf.parentId === migration.readyReceipt!.entryId && generationDigest(leaf.data) === generationDigest(confirmationData(record));
        check((leafId === input.leafId || recovered && input.leafId === migration.readyReceipt!.entryId)
          && (leafId === migration.readyReceipt!.entryId || recovered), "CONFLICT", "Branch changed after the user reviewed the proposal");
      } catch (error) {
        record.status = "aborted"; record.abortReason = "migration-stale"; migration.status = "stale";
        authorize(); saveJournal(this.path, journal, assertOwned); throw error;
      }
      // Compatible fields are preserved even if a caller submits different values.
      for (const field of migration.proposal.fields) if (field.change === "compatible") {
        check(input.decision === "cancel" || state[field.id] === migration.proposal.suggestedState[field.id], "CONFLICT", "Compatible saved values must be retained");
      }
      authorize();
      if (input.decision === "cancel") {
        migration.confirmation = { requestId: input.requestId, runId: identity.runId, choiceDigest, decision: input.decision, state };
        record.status = "aborted"; record.abortReason = "user-cancelled-migration"; migration.status = "cancelled";
        saveJournal(this.path, journal, assertOwned); return { status: "cancelled" as const };
      }
      migration.confirmation ??= { requestId: input.requestId, runId: identity.runId, choiceDigest, decision: input.decision, state };
      saveJournal(this.path, journal, assertOwned); this.options.fault?.("confirmation-intent");
      let entryId = leafId;
      if (leafId === migration.readyReceipt!.entryId) {
        check(this.options.manager.appendCustomEntry, "IDENTITY", "A protected confirmation writer is required");
        authorize(); assertOwned();
        entryId = this.options.manager.appendCustomEntry("piora-ui-confirmation", confirmationData(record));
        this.options.fault?.("confirmation-entry");
      }
      const fd = openSync(this.sessionFile, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
      const durable = readDisk(this.sessionFile, this.sessionId), entry = durable.byId.get(entryId);
      check(entry?.type === "custom" && entry.customType === "piora-ui-confirmation" && entry.parentId === migration.readyReceipt!.entryId
        && generationDigest(entry.data) === generationDigest(confirmationData(record)) && this.currentLeaf(durable, true) === entryId,
      "RECEIPT", "Exact confirmation is not durable at the current leaf");
      this.options.fault?.("confirmation-receipt"); authorize();
      record.publicationAnchor = { entryId, entryHash: generationDigest(entry) };
      record.status = "committed"; migration.status = "committed"; record.state = state; record.stateRevision = ++journal.revision;
      journal.active.push({ anchor: entryId, surfaceId: record.surface.id, operationId: record.operationId });
      journal.states.push({ anchor: entryId, operationId: record.operationId, revision: record.stateRevision, state });
      saveJournal(this.path, journal, assertOwned); this.options.fault?.("migration-committed");
      return copy({ status: "committed" as const, entryId, state, stateRevision: record.stateRevision });
    });
  }
  async readActive(surfaceId: string) {
    return this.locked((journal, disk) => {
      const leafId = this.currentLeaf(disk);
      if (this.source(journal, disk, leafId, surfaceId).source.origin !== "journal") return null;
      const current = this.active(journal, disk, leafId, surfaceId);
      return current ? copy({ operationId: current.record.operationId, surface: current.record.surface, state: current.state, stateRevision: current.revision }) : null;
    }, true);
  }
  /** Reads never start an epoch or promote a candidate, including after restart. */
  async readDecisionRecords(): Promise<UiDecisionSnapshot> {
    return this.locked((journal, disk) => {
      const leafId = this.options.manager.getLeafId();
      if (leafId === null) return { leafId, records: [] };
      const entries = branch(disk, leafId), legacy = branchSurfaces(entries);
      const legacyByEntry = new Map(legacy.map(item => [item.entryId, item]));
      const latest = new Map<string, true>();
      const published = new Map(journal.active.map(pointer => [pointer.anchor, pointer.operationId]));
      for (const entry of entries) {
        const old = legacyByEntry.get(entry.id);
        if (old) { latest.delete(old.surface.id); latest.set(old.surface.id, true); }
        const operationId = published.get(entry.id);
        if (operationId) {
          const record = journal.records.find(item => item.operationId === operationId)!;
          verifyPublication(disk, record); latest.delete(record.surface.id); latest.set(record.surface.id, true);
        }
        const message = entry.message;
        const output = (message?.details as { answerOutput?: { kind?: unknown; version?: unknown; operationId?: unknown } } | undefined)?.answerOutput;
        if (entry.type !== "message" || message?.role !== "toolResult" || message.isError || output?.kind !== "intelligent-ui" || output.version !== 2) continue;
        const matches = journal.records.filter(item => item.operationId === output.operationId && item.toolCallId === message.toolCallId);
        if (!matches.length) {
          const excluded = (journal.excludedOutputs ?? []).filter(item => item.operationId === output.operationId && item.toolCallId === message.toolCallId);
          check(excluded.length === 1 && excluded[0].receipt.entryId === entry.id, "CORRUPT", "Output has no matching generation evidence");
          verifyExcludedOutput(disk, excluded[0]);
          continue;
        }
        check(matches.length === 1, "CORRUPT", "Output generation evidence is ambiguous");
        const record = matches[0]; verifyReceipt(disk, record, entry.id);
      }
      const records: UiDecisionSnapshot["records"] = [];
      for (const surfaceId of latest.keys()) {
        const saved = this.source(journal, disk, leafId, surfaceId);
        check(saved.surface && saved.source.origin !== "none", "CORRUPT", "Published output has no current structure");
        const toolCallId = saved.source.origin === "journal"
          ? journal.records.find(record => record.operationId === saved.source.operationId)?.toolCallId
          : legacy.filter(item => item.surface.id === surfaceId).at(-1)?.toolCallId;
        check(toolCallId, "CORRUPT", "Published output identity is unavailable");
        records.push({ toolCallId, surface: saved.surface, state: saved.state, stateRevision: saved.source.stateRevision,
          protocolVersion: saved.source.origin === "journal" ? 2 : 1 });
      }
      // Every structure and parameter comes from this one lock scope. No nested
      // readOutput call can release the snapshot between two surfaces.
      return copy({ leafId, records });
    }, true, true);
  }

  async readOutput(toolCallId: string): Promise<UiGenerationOutput> {
    return this.locked((journal, disk) => {
      const leafId = this.currentLeaf(disk), entries = branch(disk, leafId);
      const results = entries.filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId);
      check(results.length === 1, "RECEIPT", "Output must identify exactly one result on this branch");
      const details = results[0].message?.details as { answerOutput?: { operationId?: unknown } } | undefined;
      const record = journal.records.find(item => item.operationId === details?.answerOutput?.operationId && item.toolCallId === toolCallId);
      check(record, "CORRUPT", "Output has no matching generation record");
      verifyReceipt(disk, record, results[0].id);
      let state = initialState(record.surface), revision = 0;
      let status: UiGenerationOutput["publication"]["status"] = record.status;
      let currentToolCallId: string | undefined;
      if (record.status === "committed" && !entries.some(entry => entry.id === publicationEntry(record))) status = "candidate";
      else if (record.status === "committed") {
        verifyPublication(disk, record);
        state = record.state!; revision = record.stateRevision!;
        const saved = new Map(journal.states.filter(item => item.operationId === record.operationId).map(item => [item.anchor, item]));
        for (const entry of entries) { const item = saved.get(entry.id); if (item) { state = item.state; revision = item.revision; } }
        const current = this.source(journal, disk, leafId, record.surface.id);
        if (current.source.operationId !== record.operationId) {
          status = "superseded";
          currentToolCallId = current.source.origin === "journal"
            ? journal.records.find(item => item.operationId === current.source.operationId)?.toolCallId
            : branchSurfaces(entries).filter(item => item.surface.id === record.surface.id).at(-1)?.toolCallId;
        }
      }
      return copy({ surface: record.surface, state, revision, leafId, snapshot: formatSnapshot(record.surface, state),
        publication: { status, operationId: record.operationId, ...(currentToolCallId ? { currentToolCallId } : {}) } });
    }, true);
  }
  private actionSource(journal: Journal, disk: Disk, toolCallId: string): UiActionSource {
    const leafId = this.currentLeaf(disk), entries = branch(disk, leafId), ancestry = new Set(entries.map(entry => entry.id));
    const matches = journal.records.filter(record => record.toolCallId === toolCallId && record.receipt
      && ancestry.has(record.receipt.entryId));
    check(matches.length === 1, "IDENTITY", "An action requires one published output on the current branch");
    const record = matches[0];
    check(record.status === "committed" && record.actions, "CONFLICT", "This output has no published action declarations");
    const current = this.source(journal, disk, leafId, record.surface.id);
    check(current.source.origin === "journal" && current.source.operationId === record.operationId, "CONFLICT", "Actions require the current committed version");
    verifyPublication(disk, record);
    const source = { sessionId: this.sessionId, toolCallId, operationId: record.operationId, leafId,
      publicationEntryId: publicationEntry(record)!, surface: record.surface, state: current.state,
      revision: current.source.stateRevision, actions: record.actions };
    // Automatic titles append session_info entries after the answer has finished.
    // Keep the real leaf for state reads/writes, but do not revoke an action merely
    // because its chat was renamed. Collapse only a linear metadata suffix: a
    // sibling branch, message or any other entry still changes the identity.
    const children = new Map<string, number>();
    for (const entry of disk.entries) if (entry.parentId) children.set(entry.parentId, (children.get(entry.parentId) ?? 0) + 1);
    let identityLeaf = leafId;
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (entry.type !== "session_info" || !entry.parentId || children.get(entry.parentId) !== 1) break;
      identityLeaf = entry.parentId;
    }
    return copy({ ...source, digest: generationDigest({ ...source, leafId: identityLeaf }) });
  }
  async readActionSource(toolCallId: string): Promise<UiActionSource> {
    return this.locked((journal, disk) => this.actionSource(journal, disk, toolCallId), true);
  }
  /** Server-only synchronous final guard. Permission is a separate host boundary. */
  async withActionSource<T>(toolCallId: string, expectedDigest: string, work: (source: UiActionSource, assertOwned: () => void) => T): Promise<T> {
    return this.locked((journal, disk, assertOwned) => {
      const source = this.actionSource(journal, disk, toolCallId);
      check(source.digest === expectedDigest, "CONFLICT", "UI branch, structure, parameters or actions changed after review");
      assertOwned(); return work(source, assertOwned);
    });
  }
  /** Request IDs are durable intents: replays never call prepare or execute again. */
  async prepareAction(input: UiActionStart, runId: string, prepare: (source: UiActionSource) => Pick<UiActionOperation, "file" | "snapshotHash">,
    assertAllowed: () => void): Promise<{ created: boolean; operation: UiActionOperation }> {
    return this.locked((journal, disk, assertOwned) => {
      assertAllowed(); assertOwned();
      check(typeof input.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(input.requestId), "IDENTITY", "Invalid action request identity");
      const existing = journal.actionOperations?.find(item => item.id === input.requestId);
      if (existing) {
        check(existing.source.digest === input.sourceDigest && existing.source.toolCallId === input.toolCallId && existing.action.id === input.actionId,
          "CONFLICT", "Action request ID was already used for another intent");
        this.assertActionVisible(disk, existing);
        return { created: false, operation: copy(existing) };
      }
      const current = this.actionSource(journal, disk, input.toolCallId);
      check(current.digest === input.sourceDigest, "CONFLICT", "UI changed before the action started");
      const action = current.actions.actions.find(item => item.id === input.actionId);
      check(action, "IDENTITY", "Unknown registered action");
      const { toolCallId, operationId, leafId, publicationEntryId, revision, digest } = current;
      const operation: UiActionOperation = { id: input.requestId, runId, createdAt: Date.now(),
        source: { toolCallId, operationId, leafId, publicationEntryId, revision, digest }, action: copy(action),
        ...prepare(current), status: "prepared" };
      (journal.actionOperations ??= []).push(operation);
      assertAllowed(); saveJournal(this.path, journal, assertOwned);
      return { created: true, operation: copy(operation) };
    });
  }
  private assertActionVisible(disk: Disk, operation: UiActionOperation): void {
    const ancestry = new Set(branch(disk, this.currentLeaf(disk)).map(entry => entry.id));
    check(ancestry.has(operation.source.leafId) && ancestry.has(operation.source.publicationEntryId), "CONFLICT", "Action belongs to another conversation branch");
  }
  async readActions(toolCallId: string): Promise<UiActionOperation[]> {
    return this.locked((journal, disk) => {
      const ancestry = new Set(branch(disk, this.currentLeaf(disk)).map(entry => entry.id));
      return copy((journal.actionOperations ?? []).filter(item => item.source.toolCallId === toolCallId
        && ancestry.has(item.source.leafId) && ancestry.has(item.source.publicationEntryId)));
    }, true);
  }
  /** Synchronous host callbacks only. UI/model arguments cannot supply executable work. */
  async withActionOperation<T>(id: string, work: (operation: UiActionOperation, context: {
    currentSource(): UiActionSource; save(): void; assertOwned(): void;
  }) => T): Promise<T> {
    return this.locked((journal, disk, assertOwned) => {
      const operation = journal.actionOperations?.find(item => item.id === id);
      check(operation, "IDENTITY", "Unknown action operation"); this.assertActionVisible(disk, operation);
      return work(operation, { assertOwned, save: () => saveJournal(this.path, journal, assertOwned), currentSource: () => {
        const source = this.actionSource(journal, disk, operation.source.toolCallId);
        check(source.digest === operation.source.digest, "CONFLICT", "UI branch, structure or parameters changed after the click");
        return source;
      } });
    });
  }
  async applyActionParameters(id: string, assertAllowed: () => void): Promise<{ revision: number; alreadyApplied: boolean }> {
    return this.locked((journal, disk, assertOwned) => {
      assertAllowed();
      const operation = journal.actionOperations?.find(item => item.id === id);
      check(operation?.status === "completed" && operation.result?.kind === "parameters", "CONFLICT", "No completed parameter query to apply");
      this.assertActionVisible(disk, operation);
      if (operation.appliedRevision !== undefined) return { revision: operation.appliedRevision, alreadyApplied: true };
      const source = this.actionSource(journal, disk, operation.source.toolCallId);
      check(source.digest === operation.source.digest, "CONFLICT", "UI changed since the query; keep the current parameters and read again");
      const record = journal.records.find(item => item.operationId === operation.source.operationId)!;
      const result = this.writeParameters(journal, disk, record, source.revision, operation.result.state,
        () => { assertAllowed(); assertOwned(); }, source.leafId, revision => { operation.appliedRevision = revision; });
      return { revision: result.revision, alreadyApplied: false };
    });
  }
  private writeParameters(journal: Journal, disk: Disk, record: GenerationRecord, expectedRevision: number, parameters: unknown, assertOwned: () => void, expectedLeaf?: string, beforeSave?: (revision: number) => void): UiGenerationOutput {
    const leaf = this.currentLeaf(disk), entries = branch(disk, leaf);
    if (expectedLeaf !== undefined && expectedLeaf !== leaf) {
      const start = entries.findIndex(entry => entry.id === expectedLeaf);
      check(start >= 0 && entries.slice(start, -1).every(entry => disk.entries.filter(item => item.parentId === entry.id).length === 1), "CONFLICT", "Conversation branch changed; reload saved parameters");
    }
    const current = this.active(journal, disk, leaf, record.surface.id);
    check(this.source(journal, disk, leaf, record.surface.id).source.operationId === record.operationId && current?.record.operationId === record.operationId && current.revision === expectedRevision, "CONFLICT", "Generation or parameter version changed");
    const state = validateState(record.surface, parameters);
    // Freeze existing descendants before editing their ancestor. Future children
    // inherit the new value; already-created branches retain their old choice.
    for (const child of disk.entries.filter(entry => entry.parentId === leaf)) {
      if (!journal.states.some(item => item.operationId === record.operationId && item.anchor === child.id)) {
        journal.states.push({ anchor: child.id, operationId: record.operationId, revision: current.revision, state: copy(current.state) });
      }
    }
    journal.states = journal.states.filter(item => !(item.operationId === record.operationId && item.anchor === leaf));
    journal.states.push({ anchor: leaf, operationId: record.operationId, revision: ++journal.revision, state });
    beforeSave?.(journal.revision);
    saveJournal(this.path, journal, assertOwned);
    return copy({ surface: record.surface, state, revision: journal.revision, leafId: leaf, snapshot: formatSnapshot(record.surface, state), publication: { status: "committed", operationId: record.operationId } });
  }
  async saveParameters(operationId: string, expectedRevision: number, parameters: unknown): Promise<number> {
    return this.locked((journal, disk, assertOwned) => {
      const record = journal.records.find(item => item.operationId === operationId); check(record, "IDENTITY", "Unknown generation");
      return this.writeParameters(journal, disk, record, expectedRevision, parameters, assertOwned).revision;
    });
  }
  /** HTTP callers supply a result identity, never a model/client-supplied operation credential. */
  async saveOutput(input: { toolCallId: string; leafId: string; expectedRevision: number; state: unknown; enabled(): boolean }): Promise<UiGenerationOutput> {
    return this.locked((journal, disk, assertOwned) => {
      check(input.enabled(), "CANCELLED", "Intelligent UI is disabled");
      const results = branch(disk, this.currentLeaf(disk)).filter(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === input.toolCallId);
      check(results.length === 1, "RECEIPT", "Output must identify exactly one result on this branch");
      const details = results[0].message?.details as { answerOutput?: { operationId?: unknown } } | undefined;
      const records = journal.records.filter(item => item.toolCallId === input.toolCallId && item.operationId === details?.answerOutput?.operationId);
      check(records.length === 1, "IDENTITY", "Output does not identify one generation");
      verifyReceipt(disk, records[0], results[0].id);
      return this.writeParameters(journal, disk, records[0], input.expectedRevision, input.state, assertOwned, input.leafId);
    });
  }
}

/** Called synchronously under the common session/legacy lock before a v1 write. */
export function assertLegacySurfaceWritable(sessionId: string, entries: readonly UiBranchEntry[], toolCallId: string, root: string): void {
  const old = branchSurfaces(entries).find(item => item.toolCallId === toolCallId);
  if (!old) return; // The v1 writer reports its usual missing-output error.
  const journal = readJournal(generationJournalPath(sessionId, root), sessionId);
  const index = entries.findIndex(item => item.id === old.entryId);
  const disk = { entries: entries as DiskEntry[], byId: new Map(entries.map(entry => [entry.id, entry as DiskEntry])) };
  for (const record of journal.records) {
    if (record.status !== "committed" || record.surface.id !== old.surface.id || !record.receipt) continue;
    if (entries.findIndex(entry => entry.id === publicationEntry(record)) <= index) continue;
    verifyPublication(disk, record);
    throw new UiGenerationError("CONFLICT", "This UI has a newer committed revision; use the latest output");
  }
}

/**
 * Inherit only disk-proven committed generations into an already-created SDK
 * fork/duplicate. This never manufactures a tool result or repairs either log.
 * Session operation locks are sorted first, then legacy locks, then journals.
 */
export async function copyGenerationJournal(options: {
  source: string; target: string; sourceFile: string; targetFile: string;
  retainedEntryIds: readonly string[]; sourceLeafId?: string | null; root: string;
  /** Copy legacy parameters under the same source/target snapshot locks. */
  includeLegacy?: boolean;
  /** Fault injection immediately before the guarded publication. */
  beforePublish?: () => void;
}): Promise<{ copied: number; anchorMap: ReadonlyMap<string, string> }> {
  if (options.source === options.target) return { copied: 0, anchorMap: new Map(options.retainedEntryIds.map(id => [id, id])) };
  const sourcePath = generationJournalPath(options.source, options.root), targetPath = generationJournalPath(options.target, options.root);
  type CopyResult = { copied: number; anchorMap: ReadonlyMap<string, string> };
  const ids = [options.source, options.target].sort(), assertions: Array<() => void> = [];
  const assertOwned = () => { for (const assertion of assertions) assertion(); };
  const withSessions = (index: number, work: () => Promise<CopyResult>): Promise<CopyResult> => index === ids.length ? work()
    : withUiSessionLock(ids[index], options.root, guard => { assertions.push(guard); return withSessions(index + 1, work); });
  const mutexPaths = [
    ...ids.map(id => `${intelligentUiStatePath(id, options.root)}.lock`),
    ...ids.map(id => `${generationJournalPath(id, options.root)}.lock`),
  ];
  const withMutexes = (index: number, work: () => CopyResult): Promise<CopyResult> => index === mutexPaths.length ? Promise.resolve(work())
    : withUiFileLock(mutexPaths[index], guard => { assertions.push(guard); return withMutexes(index + 1, work); });
  return withSessions(0, () => withMutexes(0, () => {
    assertOwned();
    check(!existsSync(targetPath), "CONFLICT", "Target generation journal already exists");
    const source = readJournal(sourcePath, options.source), sourceDisk = readDisk(options.sourceFile, options.source), targetDisk = readDisk(options.targetFile, options.target);
    const mapping = verifyForkMapping(sourceDisk, targetDisk, options.retainedEntryIds, options.sourceLeafId);
    const retained = new Set(mapping.sourceEntries.map(entry => entry.id));
    const outputs = targetDisk.entries.filter(entry => {
      const output = (entry.message?.details as { answerOutput?: { kind?: unknown; version?: unknown } } | undefined)?.answerOutput;
      return entry.type === "message" && entry.message?.role === "toolResult" && !entry.message.isError && output?.kind === "intelligent-ui" && output.version === 2;
    });
    const targetResult = (operationId: string) => {
      const matching = outputs.filter(entry => (entry.message?.details as { answerOutput: { operationId?: unknown } }).answerOutput.operationId === operationId);
      check(matching.length <= 1, "RECEIPT", "Fork contains duplicate generation identities"); return matching[0];
    };
    const verifiedResults = new Set<string>();
    const inherited = emptyJournal(options.target);
    inherited.excludedOutputs = [];
    for (const record of source.records) {
      const result = targetResult(record.operationId); if (!result) continue;
      check(retained.has(record.callEntryId), "RECEIPT", "Retained generation is missing its assistant ancestor");
      verifyReceipt(sourceDisk, record, result.id);
      const clone = copy(record);
      clone.forkCall = forkCallEvidence(sourceDisk, targetDisk, record, options.source);
      clone.contextTitles = forkContextTitles(sourceDisk, targetDisk, record, options.source);
      // Original result and assistant hashes stay unchanged. Only the explicitly
      // verified SDK label transformation may explain a different call parent.
      verifyReceipt(targetDisk, clone, result.id);
      verifiedResults.add(result.id);
      if (record.status !== "committed" || !retained.has(publicationEntry(record)!)) {
        inherited.excludedOutputs.push({ reason: "uncommitted-at-fork", sourceSessionId: options.source, sourceStatus: record.status === "committed" ? "candidate" : record.status, evidenceOrigin: record.receipt ? "source-receipt" : "fork-observed-jsonl",
          operationId: record.operationId, toolCallId: record.toolCallId, surfaceHash: record.surfaceHash,
          callEntryId: record.callEntryId, callEntryHash: record.callEntryHash, source: { leafId: record.source.leafId }, forkCall: clone.forkCall,
          ...(clone.contextTitles ? { contextTitles: clone.contextTitles } : {}),
          receipt: record.receipt ? copy(record.receipt) : { entryId: result.id, entryHash: generationDigest(sourceDisk.byId.get(result.id)) } });
        continue;
      }
      verifyPublication(sourceDisk, record);
      if (record.publicationAnchor) {
        clone.confirmationFork = forkCallEvidence(sourceDisk, targetDisk, { callEntryId: record.publicationAnchor.entryId,
          callEntryHash: record.publicationAnchor.entryHash, source: { leafId: record.migration!.readyReceipt!.entryId }, forkCall: record.confirmationFork }, options.source);
        verifyPublication(targetDisk, clone);
      }
      clone.epoch = "inherited"; clone.source.epoch = "inherited"; clone.source.sessionId = options.target;
      // A complete original turn is not required on a fork cut after this UI
      // result. Its own exact call/result receipt remains authoritative.
      if (!clone.migration) delete clone.turnReceipt;
      inherited.records.push(clone);
    }
    for (const excluded of source.excludedOutputs ?? []) {
      const result = targetResult(excluded.operationId); if (!result) continue;
      verifyExcludedOutput(sourceDisk, excluded);
      const clone = copy(excluded); clone.forkCall = forkCallEvidence(sourceDisk, targetDisk, excluded, options.source);
      clone.contextTitles = forkContextTitles(sourceDisk, targetDisk, excluded, options.source);
      verifyExcludedOutput(targetDisk, clone); inherited.excludedOutputs.push(clone); verifiedResults.add(result.id);
    }
    check(outputs.every(entry => verifiedResults.has(entry.id)), "CORRUPT", "Fork history contains a generation without source journal evidence");
    const operations = new Set(inherited.records.map(record => record.operationId));
    inherited.active = source.active.filter(pointer => operations.has(pointer.operationId) && retained.has(pointer.anchor)).map(copy);
    const states = new Map<string, SavedState>(), sourceOrder = new Map(mapping.sourceEntries.map((entry, index) => [entry.id, index]));
    for (const state of source.states.filter(state => operations.has(state.operationId) && retained.has(state.anchor)).sort((a, b) => sourceOrder.get(a.anchor)! - sourceOrder.get(b.anchor)!)) {
      const anchor = mapping.anchors.get(state.anchor); check(anchor && targetDisk.byId.has(anchor), "RECEIPT", "Inherited parameter anchor is not retained on disk");
      states.set(`${state.operationId}:${anchor}`, { ...copy(state), anchor });
    }
    inherited.states = [...states.values()];
    inherited.revision = Math.max(0, ...inherited.records.map(record => record.stateRevision ?? 0), ...inherited.states.map(state => state.revision));
    options.beforePublish?.(); assertOwned();
    // The SDK closes its rewritten fork but does not fsync it. Make that exact
    // target log durable before publishing sidecars that authorize editing it.
    const fd = openSync(options.targetFile, "r+"); try { fsyncSync(fd); } finally { closeSync(fd); }
    check(generationDigest(readDisk(options.targetFile, options.target).entries) === generationDigest(targetDisk.entries), "RECEIPT", "Target fork changed before publication");
    assertOwned();
    if (options.includeLegacy) copyIntelligentUiState(options.source, options.target, options.retainedEntryIds, options.root, mapping.anchors);
    if (inherited.records.length || inherited.excludedOutputs.length) saveJournal(targetPath, inherited, assertOwned);
    return { copied: inherited.records.length, anchorMap: mapping.anchors };
  }));
}

/** Reproduce only the SDK's documented label removal/rebuild transformation. */
function verifyForkMapping(source: Disk, target: Disk, retainedIds: readonly string[], sourceLeafId?: string | null) {
  check(new Set(retainedIds).size === retainedIds.length && generationDigest(retainedIds) === generationDigest(target.entries.map(entry => entry.id)), "RECEIPT", "Retained entries do not match the exact target log");
  check(sourceLeafId !== undefined || !source.entries.some(entry => entry.type === "label"), "IDENTITY", "A labeled fork requires its original source leaf");
  const leaf = sourceLeafId === undefined ? target.entries.filter(entry => entry.type !== "label").at(-1)?.id ?? null : sourceLeafId;
  const sourceEntries = leaf === null ? [] : branch(source, leaf), expected: DiskEntry[] = [];
  const replacements = new Map<string, string>(), pending: string[] = [];
  let parent: string | null = null;
  for (const entry of sourceEntries) {
    if (entry.type === "label") { pending.push(entry.id); continue; }
    for (const id of pending) replacements.set(id, entry.id); pending.length = 0;
    expected.push(entry.type === "compaction" ? { ...entry, parentId: parent,
      firstKeptEntryId: entry.firstKeptEntryId === entry.id ? entry.id : replacements.get(String(entry.firstKeptEntryId)) ?? entry.firstKeptEntryId } : { ...entry, parentId: parent });
    parent = entry.id;
  }
  check(generationDigest(target.entries.slice(0, expected.length)) === generationDigest(expected), "RECEIPT", "Target history changed beyond the SDK label transformation");
  const labels = new Map<string, DiskEntry>();
  for (const entry of source.entries) if (entry.type === "label") {
    check(typeof entry.targetId === "string", "CORRUPT", "Invalid source label");
    if (entry.label) labels.set(entry.targetId, entry); else labels.delete(entry.targetId);
  }
  const ids = new Set(expected.map(entry => entry.id)), rebuilt = [...labels.values()].filter(entry => ids.has(String(entry.targetId)));
  check(target.entries.length === expected.length + rebuilt.length, "RECEIPT", "Target label set does not match the SDK fork");
  for (let index = 0; index < rebuilt.length; index++) {
    const original = rebuilt[index], actual = target.entries[expected.length + index];
    const label = { type: "label", id: actual.id, parentId: parent, timestamp: original.timestamp, targetId: original.targetId, label: original.label };
    check(generationDigest(actual) === generationDigest(label), "RECEIPT", "Target rebuilt label changed"); parent = actual.id;
  }
  const anchors = new Map<string, string>();
  let following = target.entries.at(-1)?.id;
  for (const entry of [...sourceEntries].reverse()) {
    if (entry.type !== "label") following = entry.id;
    if (following) anchors.set(entry.id, following);
  }
  return { sourceEntries, anchors: new Map(sourceEntries.filter(entry => anchors.has(entry.id)).map(entry => [entry.id, anchors.get(entry.id)!])) };
}

function forkContextTitles(source: Disk, target: Disk, record: { source: { leafId: string }; contextTitles?: ContextTitleReceipt[] }, sourceSessionId: string): ContextTitleReceipt[] | undefined {
  let parent = record.source.leafId;
  return record.contextTitles?.map(title => {
    const forkCall = forkCallEvidence(source, target, { callEntryId: title.entryId, callEntryHash: title.entryHash,
      source: { leafId: parent }, forkCall: title.forkCall }, sourceSessionId);
    parent = title.entryId;
    return { ...title, forkCall };
  });
}
function forkCallEvidence(source: Disk, target: Disk, record: BoundEntry, sourceSessionId: string): ForkCallProvenance | undefined {
  const old = source.byId.get(record.callEntryId), next = target.byId.get(record.callEntryId);
  check(old && next, "RECEIPT", "Fork assistant entry is missing");
  if (old.parentId === next.parentId) return copy(record.forkCall ?? null) ?? undefined;
  const removed = copy(record.forkCall?.removedLabels ?? []), seen = new Set<string>();
  let parent = old.parentId;
  while (parent !== next.parentId) {
    check(parent && !seen.has(parent), "RECEIPT", "Fork assistant parent mapping is invalid"); seen.add(parent);
    const label = source.byId.get(parent); check(label?.type === "label", "RECEIPT", "Fork may remove only label ancestors");
    removed.push({ entry: copy(label), hash: generationDigest(label) }); parent = label.parentId;
  }
  return { version: 1, sourceSessionId: record.forkCall?.sourceSessionId ?? sourceSessionId, targetParentId: next.parentId, removedLabels: removed };
}

function verifyExcludedOutput(disk: Disk, excluded: ExcludedGenerationOutput): UiSurface {
  verifyCall(disk, excluded);
  const entry = disk.byId.get(excluded.receipt.entryId), message = entry?.message;
  const output = (message?.details as { answerOutput?: { kind?: unknown; version?: unknown; operationId?: unknown; surfaceHash?: unknown; payload?: unknown } } | undefined)?.answerOutput;
  check(entry && entry.type === "message" && message?.role === "toolResult" && message.isError === false && message.toolCallId === excluded.toolCallId
    && generationDigest(entry) === excluded.receipt.entryHash && output?.kind === "intelligent-ui" && output.version === 2
    && output.operationId === excluded.operationId && output.surfaceHash === excluded.surfaceHash && generationDigest(output.payload) === excluded.surfaceHash, "RECEIPT", "Excluded output does not match its inherited disk evidence");
  turnPath(disk, excluded.callEntryId, entry.id);
  try { return validateSurface(output.payload); } catch { throw new UiGenerationError("CORRUPT", "Excluded output surface is invalid"); }
}

/** Only a recorded fork exclusion permits fallback; missing/corrupt journals still fail. */
export async function readExcludedGenerationOutput(manager: Manager, toolCallId: string, root: string): Promise<UiGenerationOutput | null> {
  const sessionId = manager.getSessionId(), file = manager.getSessionFile(); check(file, "IDENTITY", "A disk-backed session is required");
  const path = generationJournalPath(sessionId, root);
  return withUiSessionReadLock(sessionId, root, sessionOwned => withUiFileLock(`${intelligentUiStatePath(sessionId, root)}.lock`, legacyOwned => withUiFileLock(`${path}.lock`, journalOwned => {
    sessionOwned(); legacyOwned(); journalOwned();
    const journal = readJournal(path, sessionId), matches = (journal.excludedOutputs ?? []).filter(item => item.toolCallId === toolCallId);
    if (!matches.length) return null;
    check(matches.length === 1, "CORRUPT", "Excluded output identity is ambiguous");
    const excluded = matches[0], disk = readDisk(file, sessionId), leafId = manager.getLeafId();
    check(leafId && branch(disk, leafId).some(entry => entry.id === excluded.receipt.entryId), "RECEIPT", "Excluded output is outside the selected branch");
    const surface = verifyExcludedOutput(disk, excluded), state = initialState(surface);
    return { surface, state, revision: 0, leafId, snapshot: formatSnapshot(surface, state), publication: { status: "aborted", operationId: excluded.operationId } };
  })));
}
