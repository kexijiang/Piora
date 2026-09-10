import type { ChatDraft } from "./draft-store";
import type { AgentMessage, UserMessage } from "./types";

export interface PendingPrompt {
  id: string;
  scope: string;
  message: UserMessage;
  draft: ChatDraft;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("无法保存发送恢复副本，原文仍保留在输入框中。")); return; }
    const request = indexedDB.open("piora-prompt-recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("prompts", { keyPath: "id" }).createIndex("scope", "scope");
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("无法保存发送恢复副本。"));
    request.onblocked = () => reject(new Error("发送恢复存储被其他窗口占用，请稍后重试。"));
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

export async function savePendingPrompt(record: PendingPrompt): Promise<void> {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("prompts", "readwrite", { durability: "strict" });
    const store = transaction.objectStore("prompts");
    // When a new-chat draft acquires a session id, move its linked recovery
    // copies with it so one disk receipt can settle the whole retry chain.
    const previous = store.get(record.id);
    previous.onsuccess = () => {
      const oldScope = (previous.result as PendingPrompt | undefined)?.scope;
      if (!oldScope || oldScope === record.scope) return;
      for (const id of record.draft.retryOfPromptIds ?? []) {
        const ancestor = store.get(id);
        ancestor.onsuccess = () => {
          const saved = ancestor.result as PendingPrompt | undefined;
          if (saved?.scope === oldScope) store.put({ ...saved, scope: record.scope });
        };
      }
    };
    store.put(record);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("无法保存发送恢复副本，输入内容未清除。"));
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function readPendingPrompts(scope: string): Promise<PendingPrompt[]> {
  const db = await openDatabase();
  return await new Promise((resolve, reject) => {
    const request = db.transaction("prompts").objectStore("prompts").index("scope").getAll(scope);
    request.onsuccess = () => resolve(request.result as PendingPrompt[]);
    request.onerror = () => reject(request.error);
  });
}

export async function confirmPendingPrompts(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("prompts", "readwrite");
    for (const id of ids) transaction.objectStore("prompts").delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

/** A matching receipt ID, never matching text, is proof this exact send is durable. */
export function mergePendingPrompts(messages: AgentMessage[], entryIds: string[], pending: PendingPrompt[], persistedIds: string[] = []) {
  const displayed = new Set(messages.flatMap((message) => message.role === "user" && message.clientPromptId ? [message.clientPromptId] : []));
  const confirmed = new Set(persistedIds);
  const byId = new Map(pending.map(record => [record.id, record]));
  const receipts = [...confirmed];
  while (receipts.length) {
    const record = byId.get(receipts.pop()!);
    for (const id of record?.draft.retryOfPromptIds ?? []) {
      if (confirmed.has(id)) continue;
      confirmed.add(id);
      receipts.push(id);
    }
  }
  const missing = pending.filter((record) => !displayed.has(record.id) && !confirmed.has(record.id)).sort((a, b) => (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0));
  return {
    messages: [...messages, ...missing.map((record) => ({ ...record.message, clientPromptId: record.id, recoveryDraft: record.draft, sendError: "发送未完成确认，原文和附件已保留，可重新发送。" }))] as AgentMessage[],
    entryIds: [...entryIds, ...missing.map(() => "")],
    confirmedIds: pending.filter((record) => confirmed.has(record.id)).map((record) => record.id),
  };
}
