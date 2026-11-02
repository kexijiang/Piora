import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, statSync } from "node:fs";
import { answerCanonicalJson } from "./answer-output-data";

/** Evidence from raw durable bytes. Never an SDK in-memory message or SSE event. */
export interface AnswerDiskEntry {
  id: string; parentId: string | null; type: string;
  message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown };
  [key: string]: unknown;
}
export interface AnswerDisk { entries: AnswerDiskEntry[]; byId: Map<string, AnswerDiskEntry> }
export class AnswerReceiptError extends Error {
  constructor(readonly code: "RECEIPT" | "IDENTITY" | "CONFLICT", message: string) { super(message); this.name = "AnswerReceiptError"; }
}
export function isAnswerReceiptError(value: unknown): value is AnswerReceiptError {
  if (!value || typeof value !== "object") return false;
  const error = value as AnswerReceiptError;
  return error.name === "AnswerReceiptError" && typeof error.message === "string" && ["RECEIPT", "IDENTITY", "CONFLICT"].includes(error.code);
}
export function assertAnswerReceipt(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AnswerReceiptError("RECEIPT", message);
}
export function answerDataDigest(value: unknown): string {
  return createHash("sha256").update(answerCanonicalJson(value)).digest("hex");
}
export function readAnswerDisk(file: string, sessionId: string): AnswerDisk {
  assertAnswerReceipt(statSync(file).size <= 64 * 1024 * 1024, "Session exceeds the answer receipt read budget");
  const text = readFileSync(file, "utf8");
  assertAnswerReceipt(text.endsWith("\n"), "Session has an incomplete durable record");
  let records: Array<Record<string, unknown>>;
  try { records = text.trimEnd().split(/\r?\n/).map(line => JSON.parse(line)); }
  catch { throw new AnswerReceiptError("RECEIPT", "Session is not complete JSONL"); }
  assertAnswerReceipt(records[0]?.type === "session" && records[0]?.version === 3 && records[0]?.id === sessionId, "Session identity or format changed");
  const entries = records.slice(1) as AnswerDiskEntry[], byId = new Map<string, AnswerDiskEntry>();
  for (const entry of entries) {
    assertAnswerReceipt(typeof entry.id === "string" && entry.id.length > 0 && entry.id.length <= 256 && !byId.has(entry.id)
      && (entry.parentId === null || typeof entry.parentId === "string") && typeof entry.type === "string", "Invalid or duplicate session entry");
    byId.set(entry.id, entry);
  }
  return { entries, byId };
}
export function syncAnswerDisk(file: string): void {
  // FlushFileBuffers on Windows requires a writable handle. This never writes
  // transcript bytes and must only be called inside the session ownership lock.
  const handle = openSync(file, "r+");
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
export function answerDiskBranch(disk: AnswerDisk, leaf: string): AnswerDiskEntry[] {
  const result: AnswerDiskEntry[] = [], visited = new Set<string>();
  let id: string | null = leaf;
  while (id !== null) {
    assertAnswerReceipt(!visited.has(id), "Session ancestry contains a cycle"); visited.add(id);
    const entry = disk.byId.get(id); assertAnswerReceipt(entry, "Requested branch is absent from disk");
    result.push(entry); id = entry.parentId;
  }
  return result.reverse();
}
export function answerDeclaredCalls(entry: AnswerDiskEntry): Array<{ id: string; name: string }> {
  assertAnswerReceipt(entry.type === "message" && entry.message?.role === "assistant" && Array.isArray(entry.message.content), "Expected a durable assistant tool call");
  const calls = (entry.message.content as Array<Record<string, unknown>>).filter(block => block?.type === "toolCall");
  assertAnswerReceipt(calls.length > 0 && calls.length <= 64 && calls.every(call => typeof call.id === "string" && call.id.length > 0 && call.id.length <= 256 && typeof call.name === "string")
    && new Set(calls.map(call => call.id)).size === calls.length, "Tool calls must have unique bounded identities");
  return calls as Array<{ id: string; name: string }>;
}
export function answerTurnResults(disk: AnswerDisk, assistantId: string, leaf: string, complete: boolean): AnswerDiskEntry[] {
  const call = disk.byId.get(assistantId); assertAnswerReceipt(call, "Assistant receipt is absent");
  const declared = new Map(answerDeclaredCalls(call).map(call => [call.id, call.name]));
  const branch = answerDiskBranch(disk, leaf), index = branch.findIndex(entry => entry.id === assistantId);
  assertAnswerReceipt(index >= 0, "Assistant is not on the selected branch");
  const results = branch.slice(index + 1), seen = new Set<string>();
  for (const entry of results) {
    const message = entry.message, id = message?.toolCallId;
    assertAnswerReceipt(entry.type === "message" && message?.role === "toolResult" && typeof id === "string" && declared.has(id)
      && message.toolName === declared.get(id) && !seen.has(id), "Only declared unique tool results can complete this turn");
    seen.add(id);
  }
  assertAnswerReceipt(!complete || seen.size === declared.size, "Complete tool result set is not on disk");
  return results;
}
