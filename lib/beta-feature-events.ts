import { resolve } from "node:path";
import type { BetaFeatures } from "./beta-feature-types";

type Listener = (features: Readonly<BetaFeatures>) => void;
interface State { revision: number; listeners: Set<Listener> }
declare global { var __pioraBetaFeatureEvents: Map<string, State> | undefined }
const key = (root: string) => process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
function state(root: string): State {
  const entries = globalThis.__pioraBetaFeatureEvents ??= new Map<string, State>(), id = key(root);
  let value = entries.get(id);
  if (!value) { value = { revision: 0, listeners: new Set() }; entries.set(id, value); }
  return value;
}
export function betaFeatureRevision(root: string): number { return state(root).revision; }
export function subscribeBetaFeatureChanges(root: string, listener: Listener): () => void {
  const value = state(root); value.listeners.add(listener);
  return () => { value.listeners.delete(listener); };
}
/** Called only after a changed preference has been durably written. */
export function publishBetaFeatureChange(root: string, features: BetaFeatures): void {
  const value = state(root); value.revision++;
  const snapshot = Object.freeze({ ...features });
  for (const listener of [...value.listeners]) {
    try { listener(snapshot); }
    catch { console.warn("A Beta feature listener could not finish its cleanup"); }
  }
}
