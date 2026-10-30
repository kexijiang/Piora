import { getAgentDir, type SessionManager } from "@earendil-works/pi-coding-agent";
import { UiGenerationPrototype } from "./generation-journal";
import { saveSurfaceState, UiStateError } from "./store";
import type { readUiOutput, SavedUiOutput } from "./read-output";

type Manager = Parameters<typeof readUiOutput>[0] & Pick<SessionManager, "getEntries">;
export async function saveUiOutput(input: {
  sessionId: string; toolCallId: string; leafId: string; expectedRevision: number; state: unknown;
  readManager(): Manager; enabled(): boolean; root?: string;
}): Promise<SavedUiOutput> {
  const enabled = () => {
    if (!input.enabled()) throw new UiStateError("Intelligent UI is disabled", 403);
    return true;
  };
  enabled();
  const manager = input.readManager();
  if (manager.getSessionId() !== input.sessionId) throw new UiStateError("Session identity changed", 409);
  const entry = manager.getBranch().find(entry => {
    if (entry.type !== "message") return false;
    const message = entry.message as { role?: string; toolCallId?: unknown } | undefined;
    return message?.role === "toolResult" && message.toolCallId === input.toolCallId;
  });
  const output = (entry?.type === "message" ? entry.message as { details?: { answerOutput?: { kind?: string; version?: number } } } : undefined)?.details?.answerOutput;
  if (output?.kind === "intelligent-ui" && output.version === 2) {
    // Resolve the live leaf again inside the journal's common session lock.
    const current = { getSessionId: () => input.readManager().getSessionId(), getSessionFile: () => input.readManager().getSessionFile(), getLeafId: () => input.readManager().getLeafId() };
    return new UiGenerationPrototype({ manager: current, root: input.root ?? getAgentDir() }).saveOutput({ ...input, enabled });
  }
  return saveSurfaceState({ ...input, enabled, branch: () => input.readManager().getBranch(), allEntries: () => input.readManager().getEntries(),
    canAdvanceLeaf: (from, branch) => {
      const start = branch.findIndex(entry => entry.id === from);
      if (start < 0) return false;
      const entries = input.readManager().getEntries();
      return branch.slice(start, -1).every(entry => entries.filter(candidate => candidate.parentId === entry.id).length === 1);
    } });
}
