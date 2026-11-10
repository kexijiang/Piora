import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "../atomic-file.ts";
import { extractSurface, formatSnapshot, initialState, mergeState, validateState, type UiState, type UiSurface } from "./protocol.ts";
import { formatUiDecisionContext } from "./decision-context.ts";
import { withUiFileLock, withUiSessionLock } from "./session-lock.ts";
import { retainSessionFileOwnership } from "../session-file-ownership.ts";

export interface UiBranchEntry { id: string; parentId: string | null; type: string; message?: unknown }
interface SavedState { anchor: string; surfaceId: string; revision: number; state: UiState }
interface Store { version: 1; revision: number; entries: SavedState[] }
export class UiStateError extends Error { constructor(message: string, public status = 400) { super(message); this.name = "UiStateError"; } }
/** Extensions and the web server may load separate module instances. */
export function isUiStateError(error: unknown): error is UiStateError {
  return error instanceof Error && error.name === "UiStateError" && [400, 403, 404, 409, 413].includes((error as UiStateError).status);
}
export function intelligentUiStatePath(sessionId: string, root = getAgentDir()): string {
  // Hash arbitrary SDK IDs: no caller-provided path segment reaches the filesystem.
  return join(root, "piora", "intelligent-ui", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}
export function hasIntelligentUiState(sessionId: string, root?: string): boolean { return existsSync(intelligentUiStatePath(sessionId, root)); }
function readStore(sessionId: string, root?: string): Store {
  try {
    const data = JSON.parse(readFileSync(intelligentUiStatePath(sessionId, root), "utf8")) as Store;
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || !Array.isArray(data.entries)) throw new Error("Unsupported saved UI state");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, entries: [] };
    throw error;
  }
}
export function branchSurfaces(branch: readonly UiBranchEntry[]): Array<{ toolCallId: string; entryId: string; surface: UiSurface }> {
  return branch.flatMap(entry => {
    const message = entry.message as { role?: string; toolCallId?: string; details?: unknown; isError?: boolean } | undefined;
    if (entry.type !== "message" || message?.role !== "toolResult" || !message.toolCallId || message.isError) return [];
    const surface = extractSurface(message.details);
    return surface ? [{ toolCallId: message.toolCallId, entryId: entry.id, surface }] : [];
  });
}
export function stateOnBranch(store: Store, branch: readonly UiBranchEntry[], surface: UiSurface): UiState {
  const selected = selectedState(store, branch, surface);
  // Revision zero freezes an untouched ancestor's defaults, not a user edit.
  // A later model revision may therefore supply new defaults on that branch.
  return selected && selected.revision > 0 ? mergeState(surface, selected.state) : initialState(surface);
}
function selectedState(store: Store, branch: readonly UiBranchEntry[], surface: UiSurface): SavedState | undefined {
  const byAnchor = new Map(store.entries.filter(item => item.surfaceId === surface.id).map(item => [item.anchor, item]));
  let selected: SavedState | undefined;
  for (const entry of branch) { const candidate = byAnchor.get(entry.id); if (candidate) selected = candidate; }
  return selected;
}
/** Resolve saved values against the requested revision, never an older schema's fallbacks. */
export function readSurfaceState(sessionId: string, branch: readonly UiBranchEntry[], surface: UiSurface, root?: string): UiState {
  return stateOnBranch(readStore(sessionId, root), branch, surface);
}
export function getSurfaceState(sessionId: string, branch: readonly UiBranchEntry[], toolCallId: string, root?: string) {
  const found = branchSurfaces(branch).find(item => item.toolCallId === toolCallId);
  if (!found) throw new UiStateError("UI output does not belong to this branch", 404);
  const store = readStore(sessionId, root);
  const state = stateOnBranch(store, branch, found.surface);
  return { surface: found.surface, state, revision: selectedState(store, branch, found.surface)?.revision ?? 0, leafId: branch.at(-1)?.id ?? null, snapshot: formatSnapshot(found.surface, state) };
}
export async function saveSurfaceState(options: {
  sessionId: string; toolCallId: string; leafId: string; expectedRevision: number; state: unknown;
  /** Re-read branch under the store lock to reject navigation/new-turn races. */
  branch: () => readonly UiBranchEntry[]; enabled: () => boolean; root?: string;
  allEntries?: () => readonly UiBranchEntry[];
  canAdvanceLeaf?: (from: string, branch: readonly UiBranchEntry[]) => boolean;
}) {
  const path = intelligentUiStatePath(options.sessionId, options.root);
  const { assertLegacySurfaceWritable } = await import("./generation-journal.ts");
  return withUiSessionLock(options.sessionId, options.root ?? getAgentDir(), assertSessionOwned => withUiFileLock(`${path}.lock`, assertStateOwned => {
    assertSessionOwned();
    assertStateOwned();
    if (!options.enabled()) throw new UiStateError("Intelligent UI is disabled", 403);
    const branch = options.branch();
    assertLegacySurfaceWritable(options.sessionId, branch, options.toolCallId, options.root ?? getAgentDir());
    if (branch.at(-1)?.id !== options.leafId && !options.canAdvanceLeaf?.(options.leafId, branch)) throw new UiStateError("Conversation branch changed; reload saved parameters", 409);
    const anchor = branch.at(-1)!.id;
    const current = getSurfaceState(options.sessionId, branch, options.toolCallId, options.root);
    const latest = branchSurfaces(branch).filter(item => item.surface.id === current.surface.id).at(-1);
    if (latest?.toolCallId !== options.toolCallId) throw new UiStateError("This UI has a newer revision; use the latest output", 409);
    if (current.revision !== options.expectedRevision) throw new UiStateError("Parameters changed in another view; reload saved parameters", 409);
    const state = validateState(current.surface, options.state);
    const store = readStore(options.sessionId, options.root);
    const inherited = selectedState(store, branch, current.surface);
    // Editing an earlier branch point must not rewrite values already inherited
    // by its existing descendants. Freeze the previous effective state at each
    // outgoing edge; newly-created children will inherit the new state instead.
    for (const child of (options.allEntries?.() ?? branch).filter(entry => entry.parentId === anchor)) {
      if (!store.entries.some(item => item.anchor === child.id && item.surfaceId === current.surface.id)) {
        // Descendants may use a different schema. Keep the original saved choice,
        // not a fallback produced by this ancestor's temporarily narrower bounds.
        store.entries.push({ anchor: child.id, surfaceId: current.surface.id, revision: inherited?.revision ?? 0, state: inherited?.state ?? initialState(current.surface) });
      }
    }
    store.revision++;
    store.entries = store.entries.filter(item => !(item.anchor === anchor && item.surfaceId === current.surface.id));
    if (store.entries.length >= 10_000) throw new UiStateError("This conversation has reached the saved UI state limit", 413);
    store.entries.push({ anchor, surfaceId: current.surface.id, revision: store.revision, state });
    assertSessionOwned();
    assertStateOwned();
    writePrivateFileAtomicSync(path, `${JSON.stringify(store)}\n`);
    return { ...current, state, revision: store.revision, snapshot: formatSnapshot(current.surface, state) };
  }));
}
/** A fork/duplicate receives an independent copy, restricted to its retained ancestry. */
export function copyIntelligentUiState(source: string, target: string, retainedEntryIds?: readonly string[], root?: string, verifiedAnchorMap?: ReadonlyMap<string, string>): void {
  if (source === target || !hasIntelligentUiState(source, root)) return;
  const sourceOwner = retainSessionFileOwnership(source, root);
  let targetOwner: ReturnType<typeof retainSessionFileOwnership> | undefined;
  try {
  targetOwner = retainSessionFileOwnership(target, root);
  const store = readStore(source, root), ids = retainedEntryIds ? new Set(retainedEntryIds) : null;
  let entries = ids ? store.entries.filter(entry => ids.has(entry.anchor)) : store.entries;
  if (verifiedAnchorMap) {
    // A removed label takes effect at its next retained entry (or the final
    // rebuilt label). Resolve collisions in original branch order, not write time.
    const order = new Map([...verifiedAnchorMap.keys()].map((id, index) => [id, index]));
    const mapped = new Map<string, typeof store.entries[number]>();
    for (const entry of store.entries.filter(item => verifiedAnchorMap.has(item.anchor)).sort((a, b) => order.get(a.anchor)! - order.get(b.anchor)!)) {
      const anchor = verifiedAnchorMap.get(entry.anchor)!;
      mapped.set(`${entry.surfaceId}:${anchor}`, { ...entry, anchor });
    }
    entries = [...mapped.values()];
  }
  if (!entries.length) return;
  const path = intelligentUiStatePath(target, root);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) throw new UiStateError("Target UI state already exists", 409);
  sourceOwner.assertOwned(); targetOwner.assertOwned();
  writePrivateFileAtomicSync(path, `${JSON.stringify({ ...store, entries })}\n`);
  } finally { targetOwner?.release(); sourceOwner.release(); }
}
export function intelligentUiSnapshots(sessionId: string, branch: readonly UiBranchEntry[], root?: string): string[] {
  const surfaces = new Map(branchSurfaces(branch).map(item => [item.surface.id, item.surface]));
  if (!surfaces.size) return [];
  const store = readStore(sessionId, root);
  return [...surfaces.values()].slice(-12).map(surface => formatSnapshot(surface, stateOnBranch(store, branch, surface)));
}
export function intelligentUiContext(sessionId: string, branch: readonly UiBranchEntry[], root?: string): string {
  const latest = new Map<string, ReturnType<typeof branchSurfaces>[number]>();
  for (const item of branchSurfaces(branch)) { latest.delete(item.surface.id); latest.set(item.surface.id, item); }
  if (!latest.size) return "";
  const store = readStore(sessionId, root);
  return formatUiDecisionContext([...latest.values()].map(item => ({ ...item,
    state: stateOnBranch(store, branch, item.surface),
    stateRevision: selectedState(store, branch, item.surface)?.revision ?? 0,
  })), branch.at(-1)?.id ?? null);
}
