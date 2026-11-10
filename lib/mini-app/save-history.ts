import { answerDataDigest } from "../answer-output-receipts";
import { boundedJson, exactKeys, jsonRecord } from "./json";
import { miniAppCheckpointChanges, validateMiniAppChangeSummary, type MiniAppCheckpointChanges } from "./checkpoint-changes";
import { MiniAppError } from "./limits";
import type { MiniAppCheckpoint } from "./vm";

interface Endpoint { revision: number; digest: string }
interface SavedTransition { from: Endpoint; to: Endpoint; changes: MiniAppCheckpointChanges }
export interface MiniAppSaveHistory { version: 1; omitted: number; transitions: SavedTransition[] }
const MAX_TRANSITIONS = 16;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const validRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const fail = (): never => { throw new MiniAppError("CORRUPT", "Invalid mini app saved transition evidence"); };

/** Only host-confirmed saves enter this chain; it never claims to record UI events. */
export function appendMiniAppSaveHistory(previous: MiniAppSaveHistory | undefined, before: MiniAppCheckpoint, fromRevision: number,
  after: MiniAppCheckpoint, toRevision: number): MiniAppSaveHistory {
  const history: MiniAppSaveHistory = previous ? clone(previous) : { version: 1, omitted: 0, transitions: [] };
  const transition: SavedTransition = { from: { revision: fromRevision, digest: answerDataDigest(before) },
    to: { revision: toRevision, digest: answerDataDigest(after) }, changes: miniAppCheckpointChanges(before, after) };
  // Wrapping an otherwise legal deeply nested value in evidence adds depth.
  // Omit just that display value instead of making a valid checkpoint unsavable.
  const items = transition.changes.items; transition.changes.items = [];
  for (const item of items) {
    transition.changes.items.push(item);
    try { boundedJson({ version: 1, omitted: 0, transitions: [transition] }, 32_000); }
    catch (error) { if (!(error instanceof MiniAppError) || error.code !== "LIMIT") throw error; transition.changes.items.pop(); }
  }
  transition.changes.omitted = transition.changes.total - transition.changes.items.length;
  transition.changes.complete = transition.changes.omitted === 0;
  history.transitions.push(transition);
  while (history.transitions.length > MAX_TRANSITIONS) { history.transitions.shift(); history.omitted++; }
  for (;;) {
    try { boundedJson(history, 32_000); break; }
    catch (error) {
      if (!(error instanceof MiniAppError) || error.code !== "LIMIT" || history.transitions.length === 1) throw error;
      history.transitions.shift(); history.omitted++;
    }
  }
  return validateMiniAppSaveHistory(history, { revision: toRevision, digest: answerDataDigest(after) });
}

export function validateMiniAppSaveHistory(value: unknown, endpoint: Endpoint): MiniAppSaveHistory {
  boundedJson(value, 32_000, "saveHistory");
  const history = jsonRecord(value, "saveHistory"); exactKeys(history, ["version", "omitted", "transitions"], "saveHistory");
  if (history.version !== 1 || !validRevision(history.omitted) || !Array.isArray(history.transitions)
    || history.transitions.length < 1 || history.transitions.length > MAX_TRANSITIONS) fail();
  let previous: Endpoint | undefined;
  for (const raw of history.transitions as unknown[]) {
    const item = jsonRecord(raw, "saveHistory/transition"); exactKeys(item, ["from", "to", "changes"], "saveHistory/transition");
    for (const key of ["from", "to"]) {
      const end = jsonRecord(item[key], `saveHistory/${key}`); exactKeys(end, ["revision", "digest"], `saveHistory/${key}`);
      if (!validRevision(end.revision) || typeof end.digest !== "string" || !/^[a-f0-9]{64}$/.test(end.digest)) fail();
    }
    const from = item.from as unknown as Endpoint, to = item.to as unknown as Endpoint;
    if (to.revision <= from.revision || from.digest === to.digest
      || previous && (previous.revision !== from.revision || previous.digest !== from.digest)) fail();
    if (validateMiniAppChangeSummary(item.changes).total === 0) fail();
    previous = to;
  }
  if (previous?.revision !== endpoint.revision || previous.digest !== endpoint.digest) fail();
  return clone(value as MiniAppSaveHistory);
}

/** Context can omit older comparisons; absent observations never mean no interactions. */
export function miniAppSaveHistoryContext(history: MiniAppSaveHistory | undefined, characters = 3500) {
  const result = { scope: "confirmed-save-comparisons", eventHistory: "unavailable", arrayIdentity: "positions-not-stable-keys", status: history ? "available" : "unavailable",
    omittedTransitions: history?.omitted ?? 0,
    transitions: (history?.transitions ?? []).map(item => ({ fromRevision: item.from.revision, toRevision: item.to.revision, changes: clone(item.changes) })) };
  while (JSON.stringify(result).length > characters && result.transitions.length) { result.transitions.shift(); result.omittedTransitions++; }
  return result;
}
