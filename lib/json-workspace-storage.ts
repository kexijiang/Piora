import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { getPocketStorageInfo } from "./pocket-storage";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { RuntimeHomeEnvironment } from "./runtime-home";

export interface JsonWorkspaceData {
  activeId: string; autoExtract: boolean; indent: 2 | 4; multiEscape: boolean; temporaryTitle: string; temporaryContent: string; wrap: boolean;
  drafts: Array<{ id: string; title: string; content: string; favorite: boolean }>;
}
export function normalizeJsonWorkspace(value: unknown): JsonWorkspaceData {
  if (!value || typeof value !== "object") throw new Error("JSON 工作区数据无效。");
  const raw = value as Record<string, unknown>;
  const text = (value: unknown, max: number) => {
    if (typeof value !== "string") return "";
    if (value.length > max) throw new Error("JSON 工作区内容超过限制，原数据未改变。");
    return value;
  };
  if (!Array.isArray(raw.drafts) || raw.drafts.length > 11) throw new Error("JSON 标签数据无效。");
  const ids = new Set<string>();
  const drafts = raw.drafts.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("JSON 标签数据无效。");
    const draft = entry as Record<string, unknown>;
    const id = text(draft.id, 120);
    if (!/^json:[a-zA-Z0-9-]+$/.test(id) || ids.has(id)) throw new Error("JSON 标签标识无效。");
    ids.add(id);
    return { id, title: text(draft.title, 80) || "JSON", content: text(draft.content, 200_000), favorite: draft.favorite === true };
  });
  const activeId = text(raw.activeId, 120);
  return { drafts, activeId: ids.has(activeId) ? activeId : "temp", temporaryTitle: text(raw.temporaryTitle, 80) || "temp", temporaryContent: text(raw.temporaryContent, 200_000), autoExtract: raw.autoExtract !== false, multiEscape: raw.multiEscape !== false, indent: raw.indent === 2 ? 2 : 4, wrap: raw.wrap === true };
}
export function readJsonWorkspace(environment: RuntimeHomeEnvironment = process.env): { revision: number; workbench: JsonWorkspaceData | null } {
  const { dataFile } = getPocketStorageInfo("json", environment);
  if (!existsSync(dataFile)) return { revision: 0, workbench: null };
  const stored = JSON.parse(readFileSync(dataFile, "utf8"));
  if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error("JSON 草稿文件损坏，请检查存储文件。");
  return { revision: stored.revision, workbench: normalizeJsonWorkspace(stored.workbench) };
}
export class JsonWorkspaceConflict extends Error {}
export function writeJsonWorkspace(value: unknown, revision: number, environment: RuntimeHomeEnvironment = process.env) {
  const current = readJsonWorkspace(environment);
  if (current.revision !== revision) throw new JsonWorkspaceConflict("另一个窗口已修改草稿。当前内容已保留在浏览器备份，请导出后重新打开。");
  const next = { revision: current.revision + 1, workbench: normalizeJsonWorkspace(value) };
  const storage = getPocketStorageInfo("json", environment);
  mkdirSync(storage.directory, { recursive: true });
  writePrivateFileAtomicSync(storage.dataFile, JSON.stringify(next, null, 2));
  return next;
}
