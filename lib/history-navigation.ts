import type { ChatDraft } from "./draft-store";

export interface HistoryChatControls {
  busy: boolean;
  entryIds: string[];
  leafId: string | null;
  switchBranch: (leafId: string) => Promise<boolean>;
  forkQuestion: (entryId: string, draft: ChatDraft) => Promise<boolean>;
  focusEntry: (entryId: string) => void;
}
export interface HistoryLocation { open: boolean; leafId: string | null; entryId: string | null }
export function readHistoryLocation(params: Pick<URLSearchParams, "get">): HistoryLocation {
  const open = params.get("view") === "history" && Boolean(params.get("session")) && !params.get("cwd");
  return { open, leafId: open ? params.get("historyLeaf") : null, entryId: open ? params.get("historyEntry") : null };
}
export function historyLocationUrl(sessionId: string, leafId?: string | null, entryId?: string | null): string {
  const params = new URLSearchParams({ session: sessionId, view: "history" });
  if (leafId) params.set("historyLeaf", leafId);
  if (entryId) params.set("historyEntry", entryId);
  return `?${params}`;
}
