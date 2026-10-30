import { getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import { readExcludedGenerationOutput, UiGenerationPrototype, type UiGenerationOutput } from "./generation-journal";
import { branchSurfaces, getSurfaceState, UiStateError, type UiBranchEntry } from "./store";
import { formatSnapshot, type UiSurface } from "./surface-document";

type Manager = Pick<SessionManager, "getSessionId" | "getSessionFile" | "getLeafId" | "getBranch" | "getEntry">;
export type SavedUiOutput = Omit<ReturnType<typeof getSurfaceState>, "surface"> & { surface: UiSurface; publication?: UiGenerationOutput["publication"] | { status: "superseded"; currentToolCallId: string; operationId?: undefined } };
function generationResult(entry: UiBranchEntry): { toolCallId: string; surfaceId: string } | null {
  const message = entry.message as { role?: string; toolCallId?: unknown; isError?: boolean; details?: { answerOutput?: { kind?: unknown; version?: unknown; payload?: { id?: unknown } } } } | undefined;
  const output = message?.details?.answerOutput;
  if (entry.type !== "message" || message?.role !== "toolResult" || message.isError || output?.kind !== "intelligent-ui" || output.version !== 2) return null;
  if (typeof message.toolCallId !== "string" || typeof output.payload?.id !== "string") throw new UiStateError("Saved output identity is invalid", 409);
  return { toolCallId: message.toolCallId, surfaceId: output.payload.id };
}
function selectedManager(manager: Manager, leafId?: string | null) {
  if (leafId && !manager.getEntry(leafId)) throw new UiStateError("Branch not found", 404);
  return { getSessionId: () => manager.getSessionId(), getSessionFile: () => manager.getSessionFile(), getLeafId: () => leafId ?? manager.getLeafId() };
}

/** Version 1 remains readable; version 2 derives status and values from disk-backed journal evidence. */
export async function readUiOutput(manager: Manager, toolCallId: string, options: { root?: string; leafId?: string | null } = {}): Promise<SavedUiOutput> {
  const selected = selectedManager(manager, options.leafId);
  const branch = manager.getBranch(selected.getLeafId() ?? undefined);
  const found = branch.find(entry => generationResult(entry)?.toolCallId === toolCallId);
  if (!found) {
    const saved = getSurfaceState(manager.getSessionId(), branch, toolCallId, options.root);
    const legacy = branchSurfaces(branch), source = legacy.find(item => item.toolCallId === toolCallId)!;
    let latestToolCallId = toolCallId;
    const oldByEntry = new Map(legacy.map(item => [item.entryId, item]));
    for (const entry of branch.slice(branch.findIndex(item => item.id === source.entryId) + 1)) {
      const old = oldByEntry.get(entry.id);
      if (old?.surface.id === saved.surface.id) latestToolCallId = old.toolCallId;
      const generated = generationResult(entry);
      if (generated?.surfaceId !== saved.surface.id) continue;
      const newer = await readUiOutput(manager, generated.toolCallId, options);
      if (newer.publication?.status === "committed" || newer.publication?.status === "superseded") latestToolCallId = generated.toolCallId;
    }
    return latestToolCallId === toolCallId ? saved : { ...saved, publication: { status: "superseded", currentToolCallId: latestToolCallId } };
  }
  const root = options.root ?? getAgentDir();
  const excluded = await readExcludedGenerationOutput(selected, toolCallId, root);
  return excluded ?? new UiGenerationPrototype({ manager: selected, root }).readOutput(toolCallId);
}

/** One frozen source for model context and exports, including legacy controls. */
export function readUiDecisionRecords(manager: Manager, root = getAgentDir()) {
  return new UiGenerationPrototype({ manager, root }).readDecisionRecords();
}

/** Exports choose the newest committed structure in branch order, never a candidate. */
export async function readUiSnapshots(manager: Manager, root = getAgentDir()): Promise<string[]> {
  const snapshot = await readUiDecisionRecords(manager, root);
  return snapshot.records.slice(-12).map(record => formatSnapshot(record.surface, record.state));
}
