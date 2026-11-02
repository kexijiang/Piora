import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { answerOutputStatePath } from "../answer-output-paths";
import { answerDataDigest, answerDiskBranch, type AnswerDisk } from "../answer-output-receipts";
import { compileMiniAppPlan, validateMiniAppResult, type MiniAppResult } from "./plan";
import { MiniAppError } from "./limits";
import type { MiniAppRecord } from "./journal";
import type { MiniAppVmReply } from "./vm";

export interface MiniAppSavedState {
  stateRevision: number;
  checkpointDigest: string;
  result: MiniAppResult;
  savedAt: number | null;
}
interface StateEntry extends MiniAppSavedState {
  publicationId: string; planDigest: string; runtimeVersion: string;
  anchor: { id: string; hash: string };
  resultDigest: string;
}
export interface MiniAppSaveReceipt {
  requestId: string; requestDigest: string; publicationId: string; leafId: string;
  stateRevision: number; checkpointDigest: string; savedAt: number;
}
interface StateStore {
  version: 1; sessionId: string; revision: number;
  entries: StateEntry[]; receipts: MiniAppSaveReceipt[];
}
const MAX_BYTES = 32 * 1024 * 1024;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function valid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new MiniAppError("CORRUPT", message);
}
export function miniAppStatePath(sessionId: string, root: string): string {
  return answerOutputStatePath("mini-app", sessionId, root);
}

/** Caller holds the common session lock. Reads never create or repair records. */
function readStore(sessionId: string, root: string): StateStore {
  const path = miniAppStatePath(sessionId, root);
  if (!existsSync(path)) return { version: 1, sessionId, revision: 0, entries: [], receipts: [] };
  valid(statSync(path).size <= MAX_BYTES, "Mini app state exceeds its read budget");
  let store: StateStore;
  try { store = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new MiniAppError("CORRUPT", "Mini app state is unreadable"); }
  valid(store?.version === 1 && store.sessionId === sessionId && revision(store.revision)
    && Array.isArray(store.entries) && store.entries.length <= 10_000
    && Array.isArray(store.receipts) && store.receipts.length <= 50_000, "Invalid mini app state store");
  const entries = new Set<string>(), receipts = new Set<string>();
  for (const entry of store.entries) {
    valid(entry && id(entry.publicationId) && hash(entry.planDigest) && id(entry.runtimeVersion)
      && id(entry.anchor?.id) && hash(entry.anchor.hash) && revision(entry.stateRevision) && entry.stateRevision <= store.revision
      && hash(entry.checkpointDigest) && hash(entry.resultDigest) && (entry.savedAt === null || revision(entry.savedAt)), "Invalid mini app state entry");
    const key = `${entry.publicationId}:${entry.anchor.id}`;
    valid(!entries.has(key), "Duplicate mini app state anchor"); entries.add(key);
  }
  for (const receipt of store.receipts) {
    valid(receipt && id(receipt.requestId) && hash(receipt.requestDigest) && id(receipt.publicationId) && id(receipt.leafId)
      && revision(receipt.stateRevision) && receipt.stateRevision <= store.revision && hash(receipt.checkpointDigest)
      && revision(receipt.savedAt) && !receipts.has(receipt.requestId), "Invalid or duplicate mini app save receipt");
    receipts.add(receipt.requestId);
  }
  return store;
}
function selected(store: StateStore, record: MiniAppRecord, disk: AnswerDisk, leafId: string): MiniAppSavedState {
  const branch = answerDiskBranch(disk, leafId), positions = new Map(branch.map((entry, i) => [entry.id, i]));
  const publicationAnchor = record.migration?.anchor ?? record.receipt;
  const publicationPosition = publicationAnchor ? positions.get(publicationAnchor.id) : undefined;
  if (publicationPosition === undefined) throw new MiniAppError("CONFLICT", "Mini app publication is absent from this branch");
  const entries = store.entries.filter(entry => entry.publicationId === record.operationId && positions.has(entry.anchor.id));
  for (const entry of entries) {
    valid(entry.planDigest === record.planDigest && entry.runtimeVersion === record.runtimeVersion
      && positions.get(entry.anchor.id)! >= publicationPosition && answerDataDigest(disk.byId.get(entry.anchor.id)) === entry.anchor.hash,
    "Mini app saved state no longer matches its branch or program");
  }
  const entry = entries.sort((a, b) => positions.get(a.anchor.id)! - positions.get(b.anchor.id)!).at(-1);
  if (!entry) {
    const initial = record.migration?.result ?? record.initial;
    return { stateRevision: 0, checkpointDigest: answerDataDigest(initial.snapshot), result: clone(initial), savedAt: null };
  }
  const result = validateMiniAppResult(compileMiniAppPlan(record.plan), entry.result as unknown as MiniAppVmReply);
  valid(answerDataDigest(result) === entry.resultDigest && answerDataDigest(result.snapshot) === entry.checkpointDigest, "Mini app saved checkpoint changed");
  return { stateRevision: entry.stateRevision, checkpointDigest: entry.checkpointDigest, result: clone(result), savedAt: entry.savedAt };
}
export function readMiniAppSavedState(sessionId: string, root: string, record: MiniAppRecord, disk: AnswerDisk, leafId: string): MiniAppSavedState {
  return selected(readStore(sessionId, root), record, disk, leafId);
}
/** A lock-scoped snapshot avoids rereading the same bounded file for every app. */
export function miniAppSavedStateReader(sessionId: string, root: string) {
  const store = readStore(sessionId, root);
  return (record: MiniAppRecord, disk: AnswerDisk, leafId: string) => selected(store, record, disk, leafId);
}
export function readMiniAppSaveReceipt(sessionId: string, root: string, requestId: string): MiniAppSaveReceipt | undefined {
  const receipt = readStore(sessionId, root).receipts.find(item => item.requestId === requestId);
  return receipt ? clone(receipt) : undefined;
}

/** Caller holds both session locks and has verified the exact SDK fork mapping. */
export function copyMiniAppState(options: {
  source: string; target: string; root: string; sourceDisk: AnswerDisk; targetDisk: AnswerDisk;
  records: readonly MiniAppRecord[]; anchors: ReadonlyMap<string, string>; sourceOrder: ReadonlyMap<string, number>;
  assertOwned(): void;
}): void {
  options.assertOwned();
  const path = miniAppStatePath(options.target, options.root);
  if (existsSync(path)) throw new MiniAppError("CONFLICT", "Target mini app state already exists");
  const source = readStore(options.source, options.root), records = new Map(options.records.map(record => [record.operationId, record]));
  const entries = new Map<string, StateEntry>();
  for (const entry of source.entries.filter(entry => records.has(entry.publicationId) && options.anchors.has(entry.anchor.id))
    .sort((a, b) => options.sourceOrder.get(a.anchor.id)! - options.sourceOrder.get(b.anchor.id)!)) {
    const record = records.get(entry.publicationId)!;
    valid(record.status === "committed", "Only confirmed mini app state can be inherited");
    const saved = selected(source, record, options.sourceDisk, entry.anchor.id);
    const id = options.anchors.get(entry.anchor.id)!, targetAnchor = options.targetDisk.byId.get(id);
    valid(targetAnchor, "Fork state anchor is absent");
    // Multiple removed labels can map to one following entry. The latest source
    // anchor wins in the same order in which source branch selection saw it.
    entries.set(`${record.operationId}:${id}`, { ...clone(saved), publicationId: record.operationId, planDigest: record.planDigest,
      runtimeVersion: record.runtimeVersion, anchor: { id, hash: answerDataDigest(targetAnchor) }, resultDigest: answerDataDigest(saved.result) });
  }
  if (!entries.size) return;
  const inherited: StateStore = { version: 1, sessionId: options.target,
    revision: Math.max(0, ...[...entries.values()].map(entry => entry.stateRevision)), entries: [...entries.values()], receipts: [] };
  // Request identities belong to the original session; the copy starts a new
  // write history, while preserving confirmed state revisions and values.
  const serialized = JSON.stringify(inherited) + "\n";
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new MiniAppError("LIMIT", "Inherited mini app state exceeds its capacity");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  options.assertOwned(); writePrivateFileAtomicSync(path, serialized);
}

/** Atomic state + receipt commit; generation records and transcript stay immutable. */
export function commitMiniAppState(input: {
  sessionId: string; root: string; record: MiniAppRecord; disk: AnswerDisk; leafId: string;
  requestId: string; requestDigest: string; expectedRevision: number; result: MiniAppResult;
  assertOwned(): void;
}): MiniAppSaveReceipt {
  input.assertOwned();
  const { sessionId, root, record, disk, leafId } = input, store = readStore(sessionId, root);
  const prior = store.receipts.find(item => item.requestId === input.requestId);
  if (prior) {
    if (prior.requestDigest !== input.requestDigest || prior.publicationId !== record.operationId) throw new MiniAppError("CONFLICT", "Mini app save request identity was reused");
    return clone(prior);
  }
  if (!id(input.requestId) || !hash(input.requestDigest)) throw new MiniAppError("IDENTITY", "Invalid mini app save identity");
  const current = selected(store, record, disk, leafId);
  if (current.stateRevision !== input.expectedRevision) throw new MiniAppError("CONFLICT", "Mini app state changed in another view");
  const result = validateMiniAppResult(compileMiniAppPlan(record.plan), input.result as unknown as MiniAppVmReply);
  const checkpointDigest = answerDataDigest(result.snapshot), now = Date.now();
  let stateRevision = current.stateRevision;
  if (checkpointDigest !== current.checkpointDigest) {
    // Before editing an ancestor, freeze what existing child branches inherited.
    // A future child of this anchor will inherit the newly saved state instead.
    for (const child of disk.entries.filter(entry => entry.parentId === leafId)) {
      if (!store.entries.some(entry => entry.publicationId === record.operationId && entry.anchor.id === child.id)) {
        store.entries.push({ ...clone(current), publicationId: record.operationId, planDigest: record.planDigest, runtimeVersion: record.runtimeVersion,
          anchor: { id: child.id, hash: answerDataDigest(child) }, resultDigest: answerDataDigest(current.result) });
      }
    }
    if (!Number.isSafeInteger(store.revision + 1)) throw new MiniAppError("LIMIT", "Mini app state revision capacity reached");
    stateRevision = ++store.revision;
    store.entries = store.entries.filter(entry => entry.publicationId !== record.operationId || entry.anchor.id !== leafId);
    store.entries.push({ publicationId: record.operationId, planDigest: record.planDigest, runtimeVersion: record.runtimeVersion,
      anchor: { id: leafId, hash: answerDataDigest(disk.byId.get(leafId)) }, stateRevision, checkpointDigest, result: clone(result), resultDigest: answerDataDigest(result), savedAt: now });
  }
  const receipt: MiniAppSaveReceipt = { requestId: input.requestId, requestDigest: input.requestDigest, publicationId: record.operationId,
    leafId, stateRevision, checkpointDigest, savedAt: now };
  store.receipts.push(receipt);
  const serialized = JSON.stringify(store) + "\n";
  if (store.entries.length > 10_000 || store.receipts.length > 50_000 || Buffer.byteLength(serialized) > MAX_BYTES) throw new MiniAppError("LIMIT", "This conversation has reached its mini app state capacity");
  const path = miniAppStatePath(sessionId, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  input.assertOwned(); writePrivateFileAtomicSync(path, serialized);
  return clone(receipt);
}
