import { answerDataDigest, answerDiskBranch, assertAnswerReceipt, type AnswerDisk, type AnswerDiskEntry } from "./answer-output-receipts";

/** Only the SDK's label removal/rebuild and compaction-anchor mapping are allowed. */
export function verifyAnswerForkMapping(source: AnswerDisk, target: AnswerDisk, retainedIds: readonly string[], sourceLeafId?: string | null) {
  assertAnswerReceipt(new Set(retainedIds).size === retainedIds.length && answerDataDigest(retainedIds) === answerDataDigest(target.entries.map(entry => entry.id)), "Retained entries do not match the exact target log");
  assertAnswerReceipt(sourceLeafId !== undefined || !source.entries.some(entry => entry.type === "label"), "A labeled fork requires its original source leaf");
  const leaf = sourceLeafId === undefined ? target.entries.filter(entry => entry.type !== "label").at(-1)?.id ?? null : sourceLeafId;
  const sourceEntries = leaf === null ? [] : answerDiskBranch(source, leaf), expected: AnswerDiskEntry[] = [];
  const replacements = new Map<string, string>(), pending: string[] = [];
  let parent: string | null = null;
  for (const entry of sourceEntries) {
    if (entry.type === "label") { pending.push(entry.id); continue; }
    for (const id of pending) replacements.set(id, entry.id);
    pending.length = 0;
    expected.push(entry.type === "compaction" ? { ...entry, parentId: parent,
      firstKeptEntryId: entry.firstKeptEntryId === entry.id ? entry.id : replacements.get(String(entry.firstKeptEntryId)) ?? entry.firstKeptEntryId } : { ...entry, parentId: parent });
    parent = entry.id;
  }
  assertAnswerReceipt(answerDataDigest(target.entries.slice(0, expected.length)) === answerDataDigest(expected), "Target history changed beyond the SDK label transformation");
  const labels = new Map<string, AnswerDiskEntry>();
  for (const entry of source.entries) if (entry.type === "label") {
    assertAnswerReceipt(typeof entry.targetId === "string", "Invalid source label");
    if (entry.label) labels.set(entry.targetId, entry); else labels.delete(entry.targetId);
  }
  const ids = new Set(expected.map(entry => entry.id)), rebuilt = [...labels.values()].filter(entry => ids.has(String(entry.targetId)));
  assertAnswerReceipt(target.entries.length === expected.length + rebuilt.length, "Target label set does not match the SDK fork");
  for (let index = 0; index < rebuilt.length; index++) {
    const original = rebuilt[index], actual = target.entries[expected.length + index];
    const label = { type: "label", id: actual.id, parentId: parent, timestamp: original.timestamp, targetId: original.targetId, label: original.label };
    assertAnswerReceipt(answerDataDigest(actual) === answerDataDigest(label), "Target rebuilt label changed"); parent = actual.id;
  }
  const anchors = new Map<string, string>();
  let following = target.entries.at(-1)?.id;
  for (const entry of [...sourceEntries].reverse()) {
    if (entry.type !== "label") following = entry.id;
    if (following) anchors.set(entry.id, following);
  }
  return { sourceEntries, anchors };
}

export interface AnswerForkCall {
  version: 1;
  sourceSessionId: string;
  targetParentId: string | null;
  removedLabels: Array<{ entry: AnswerDiskEntry; hash: string }>;
}

/** Preserve the original assistant hash, even after a fork removes label parents. */
export function verifyAnswerForkCall(disk: AnswerDisk, call: { id: string; hash: string }, fork?: AnswerForkCall): void {
  const entry = disk.byId.get(call.id);
  assertAnswerReceipt(entry, "Assistant receipt is absent");
  if (!fork) { assertAnswerReceipt(answerDataDigest(entry) === call.hash, "Assistant receipt changed"); return; }
  assertAnswerReceipt(fork.version === 1 && typeof fork.sourceSessionId === "string" && fork.sourceSessionId.length > 0
    && fork.targetParentId === entry.parentId && Array.isArray(fork.removedLabels) && fork.removedLabels.length > 0
    && fork.removedLabels.length <= 10_000, "Invalid fork call provenance");
  const seen = new Set<string>();
  for (let index = 0; index < fork.removedLabels.length; index++) {
    const label = fork.removedLabels[index];
    assertAnswerReceipt(label.entry?.type === "label" && typeof label.entry.id === "string" && !seen.has(label.entry.id)
      && answerDataDigest(label.entry) === label.hash
      && label.entry.parentId === (fork.removedLabels[index + 1]?.entry.id ?? entry.parentId), "Fork may remove only the verified label parent chain");
    seen.add(label.entry.id);
  }
  assertAnswerReceipt(answerDataDigest({ ...entry, parentId: fork.removedLabels[0].entry.id }) === call.hash, "Fork assistant content changed");
}

export function inheritAnswerForkCall(source: AnswerDisk, target: AnswerDisk, call: { id: string; hash: string }, sourceSessionId: string, previous?: AnswerForkCall): AnswerForkCall | undefined {
  verifyAnswerForkCall(source, call, previous);
  const old = source.byId.get(call.id)!, next = target.byId.get(call.id);
  assertAnswerReceipt(next, "Fork assistant is missing");
  if (old.parentId === next.parentId) { verifyAnswerForkCall(target, call, previous); return previous ? structuredClone(previous) : undefined; }
  const removed = structuredClone(previous?.removedLabels ?? []), seen = new Set<string>();
  let parent = old.parentId;
  while (parent !== next.parentId) {
    assertAnswerReceipt(parent && !seen.has(parent), "Invalid fork assistant ancestry"); seen.add(parent);
    const label = source.byId.get(parent);
    assertAnswerReceipt(label?.type === "label", "Fork may only remove label ancestors");
    removed.push({ entry: structuredClone(label), hash: answerDataDigest(label) }); parent = label.parentId;
  }
  const result: AnswerForkCall = { version: 1, sourceSessionId: previous?.sourceSessionId ?? sourceSessionId, targetParentId: next.parentId, removedLabels: removed };
  verifyAnswerForkCall(target, call, result); return result;
}
