import type { ShellInputMode, ShellReference } from "./types";
export interface ShellSubmission { clientRequestId: string; terminalId: string; text: string; mode: ShellInputMode; references: ShellReference[]; createdAt: number }
let database: Promise<IDBDatabase> | null = null;
function openRecovery(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("piora-shell-recovery-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("submissions", { keyPath: "clientRequestId" });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    request.onerror = () => { database = null; reject(request.error); };
  });
  return database;
}
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openRecovery();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("submissions", mode); const request = operation(tx.objectStore("submissions"));
    tx.oncomplete = () => resolve(request.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error("Shell recovery storage failed"));
  });
}
export async function saveShellSubmission(submission: ShellSubmission): Promise<void> { await transaction("readwrite", store => store.put(submission)); }
export async function confirmShellSubmission(id: string): Promise<void> { await transaction("readwrite", store => store.delete(id)); }
export async function pendingShellSubmissions(terminalId: string): Promise<ShellSubmission[]> {
  return (await transaction<ShellSubmission[]>("readonly", store => store.getAll())).filter(item => item.terminalId === terminalId).sort((a, b) => a.createdAt - b.createdAt);
}
