import type { SystemPromptCatalog } from "./system-prompt-types";

// One catalog per renderer, shared across conversation remounts. Never persist
// prompt text in browser storage. Failed refreshes retain the last known choice.
let catalog: SystemPromptCatalog | null = null;
let loadedAt = 0;
let generation = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const getSystemPromptCatalog = () => catalog;
export const getServerSystemPromptCatalog = () => null;

export function publishSystemPromptCatalog(next: SystemPromptCatalog): void {
  if (catalog === next) return;
  generation++;
  catalog = next;
  loadedAt = Date.now();
  for (const listener of listeners) listener();
}

export function loadSystemPromptCatalog(force = false): Promise<void> {
  if (pending) return pending;
  if (!force && catalog && Date.now() - loadedAt < 30_000) return Promise.resolve();
  const requestGeneration = generation;
  pending = (async () => {
    try {
      const response = await fetch("/api/system-prompt", { cache: "no-store" });
      const next = await response.json() as SystemPromptCatalog & { error?: string };
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      // A slow GET must not undo a newer settings save.
      if (generation === requestGeneration) publishSystemPromptCatalog(next);
    } catch { /* Keep a known hidden selector hidden, including while offline. */ }
    finally { pending = null; }
  })();
  return pending;
}

function changed(event: Event): void {
  const next = (event as CustomEvent<SystemPromptCatalog | undefined>).detail;
  if (next) publishSystemPromptCatalog(next);
  else void loadSystemPromptCatalog(true);
}
function focused(): void { void loadSystemPromptCatalog(); }

export function subscribeSystemPromptCatalog(listener: () => void): () => void {
  if (!listeners.size) {
    window.addEventListener("piora:system-prompt-changed", changed);
    window.addEventListener("focus", focused);
  }
  listeners.add(listener);
  void loadSystemPromptCatalog();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      window.removeEventListener("piora:system-prompt-changed", changed);
      window.removeEventListener("focus", focused);
    }
  };
}
