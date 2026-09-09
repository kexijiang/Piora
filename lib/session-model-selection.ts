import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getRuntimeAgentDataDirectory } from "./runtime-home";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface PendingSessionModel { provider: string; modelId: string; revision: string }
function file() { return join(getRuntimeAgentDataDirectory(), "piora", "session-model-selections.json"); }
function read(): Record<string, PendingSessionModel> {
  try { return JSON.parse(readFileSync(file(), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
function write(data: Record<string, PendingSessionModel>) { mkdirSync(dirname(file()), { recursive: true }); writePrivateFileAtomicSync(file(), JSON.stringify(data)); }
export function readPendingSessionModel(id: string): PendingSessionModel | undefined { return read()[id]; }
/** Persist the complete project request atomically before touching any live wrapper. */
export function scheduleSessionModels(ids: string[], model: { provider: string; modelId: string }): PendingSessionModel {
  const data = read(); const selection = { ...model, revision: randomUUID() };
  for (const id of ids) data[id] = selection;
  write(data); return selection;
}
export function clearPendingSessionModel(id: string, revision?: string) {
  const data = read(); if (!data[id] || (revision && data[id].revision !== revision)) return;
  delete data[id]; write(data);
}
