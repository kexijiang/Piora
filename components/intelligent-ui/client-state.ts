import { isAnswerStateEnabled, registerAnswerStateWriter } from "../../lib/answer-output-client";
import { initialState, validateState, validateSurface, type UiState, type UiSurface } from "../../lib/intelligent-ui/protocol";

export type SaveStatus = "loading" | "saved" | "saving" | "error" | "conflict";
export interface SurfaceView {
  surface: UiSurface;
  state: UiState;
  status: SaveStatus;
  revision: number;
  leafId: string;
  error?: string;
}
interface SavedSurface { surface: UiSurface; state: UiState; revision: number; leafId: string }
interface Recovery { state: UiState; revision: number; leafId: string; surfaceRevision: number }
const stores = new Map<string, SurfaceState>();

function parseSaved(value: unknown): SavedSurface {
  const data = value as SavedSurface;
  const surface = validateSurface(data.surface);
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.leafId !== "string") throw new Error("Invalid saved state");
  return { surface, state: validateState(surface, data.state), revision: data.revision, leafId: data.leafId };
}

/** Shared by all mounts of a virtual row. Pending edits stay alive until acknowledged on disk. */
export class SurfaceState {
  private view: SurfaceView;
  private listeners = new Set<() => void>();
  private operation: Promise<void> | undefined;
  private dirty = false;
  private generation = 0;
  private unregister: (() => void) | undefined;
  private readonly endpoint: string;
  private readonly recoveryKey: string;

  constructor(readonly key: string, readonly sessionId: string, readonly toolCallId: string, surface: UiSurface) {
    this.view = { surface, state: initialState(surface), status: "loading", revision: 0, leafId: "" };
    this.endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/intelligent-ui`;
    this.recoveryKey = `piora-ui-pending:${key}`;
  }

  getSnapshot = () => this.view;
  isDisposable = () => !this.dirty && !this.operation && this.listeners.size === 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<SurfaceView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private track() {
    this.unregister ??= registerAnswerStateWriter(this.key, this.sessionId, () => this.flush());
  }
  private recover(): Recovery | undefined {
    try {
      const text = localStorage.getItem(this.recoveryKey);
      return text ? JSON.parse(text) as Recovery : undefined;
    } catch { return undefined; }
  }
  private journal() {
    try {
      if (!this.dirty) localStorage.removeItem(this.recoveryKey);
      else localStorage.setItem(this.recoveryKey, JSON.stringify({ state: this.view.state, revision: this.view.revision, leafId: this.view.leafId, surfaceRevision: this.view.surface.revision } satisfies Recovery));
    } catch { /* Durable server writes remain authoritative; the status stays unsaved until acknowledgement. */ }
  }
  private async read(): Promise<SavedSurface> {
    const response = await fetch(`${this.endpoint}?toolCallId=${encodeURIComponent(this.toolCallId)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`State load failed (${response.status})`);
    return parseSaved(await response.json());
  }

  load = async (refresh = false): Promise<void> => {
    if (this.operation) {
      await this.operation.catch(() => {});
      if (refresh) await this.load();
      return;
    }
    if (!isAnswerStateEnabled()) return;
    if (this.dirty) { void this.flush().catch(() => {}); return; }
    // A reused virtual row may now be on another branch. Never permit edits to
    // its previous branch while the authoritative branch is being resolved.
    this.publish({ status: "loading", leafId: "", error: undefined });
    this.operation = (async () => {
      try {
        const saved = await this.read();
        const recovery = this.recover();
        this.publish({ ...saved, status: "saved", error: undefined });
        if (recovery) {
          const draft = validateState(saved.surface, recovery.state);
          this.dirty = true;
          this.track();
          const conflict = recovery.revision !== saved.revision || recovery.leafId !== saved.leafId || recovery.surfaceRevision !== saved.surface.revision;
          this.publish({ state: draft, status: conflict ? "conflict" : "saving" });
        }
      } catch (error) {
        this.publish({ status: "error", error: error instanceof Error ? error.message : "State load failed" });
      }
    })().finally(() => { this.operation = undefined; });
    await this.operation;
    if (this.dirty && this.view.status === "saving") void this.flush().catch(() => {});
  };

  change(id: string, value: string | number | boolean) {
    if (!this.view.leafId || this.view.status === "loading") return;
    const state = validateState(this.view.surface, { ...this.view.state, [id]: value });
    this.generation += 1;
    this.dirty = true;
    this.track();
    this.publish({ state, status: this.view.status === "conflict" ? "conflict" : "saving", error: undefined });
    this.journal();
    if (this.view.status !== "conflict") void this.flush().catch(() => {});
  }

  flush = async (): Promise<void> => {
    if (!isAnswerStateEnabled()) return;
    if (this.operation) { await this.operation; return this.flush(); }
    if (!this.dirty) return;
    if (this.view.status === "conflict") throw new Error("Intelligent UI has conflicting unsaved changes. Resolve them in the answer before continuing.");
    this.operation = this.save().finally(() => { this.operation = undefined; });
    await this.operation;
  };

  private async save() {
    while (this.dirty && isAnswerStateEnabled()) {
      const generation = this.generation;
      const { state, revision, leafId } = this.view;
      this.publish({ status: "saving", error: undefined });
      try {
        const response = await fetch(this.endpoint, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ toolCallId: this.toolCallId, leafId, expectedRevision: revision, state }),
        });
        if (response.status === 409) {
          this.publish({ status: "conflict" });
          throw new Error("Intelligent UI state changed elsewhere. Resolve the conflict before continuing.");
        }
        if (!response.ok) throw new Error(`State save failed (${response.status})`);
        const saved = parseSaved(await response.json());
        this.dirty = generation !== this.generation;
        this.publish({ revision: saved.revision, leafId: saved.leafId, status: this.dirty ? "saving" : "saved" });
        this.journal();
        if (!this.dirty) { this.unregister?.(); this.unregister = undefined; }
      } catch (error) {
        if (this.view.status !== "conflict") this.publish({ status: "error", error: error instanceof Error ? error.message : "State save failed" });
        throw error;
      }
    }
  }

  /** Explicit user choices only: never silently overwrite another tab's state. */
  resolve = async (keepDraft: boolean): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    const generation = this.generation;
    const draft = this.view.state;
    const saved = await this.read();
    if (this.generation !== generation) throw new Error("Values changed while loading; choose again to keep your latest edits.");
    this.dirty = keepDraft;
    this.generation += 1;
    this.publish({ ...saved, state: keepDraft ? validateState(saved.surface, draft) : saved.state, status: keepDraft ? "saving" : "saved", error: undefined });
    this.journal();
    if (keepDraft) { this.track(); await this.flush(); }
    else { this.unregister?.(); this.unregister = undefined; }
  };

  retry = async (): Promise<void> => this.dirty ? this.flush() : this.load();

  discard = async (): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    this.dirty = false;
    this.generation += 1;
    this.unregister?.(); this.unregister = undefined;
    this.journal();
    await this.load();
  };
}

export function surfaceState(sessionId: string, toolCallId: string, surface: UiSurface): SurfaceState {
  // Tool-call identity exists before history hydration; entry IDs may arrive later.
  const key = JSON.stringify([sessionId, toolCallId, surface.id, surface.revision]);
  let store = stores.get(key);
  if (!store) {
    if (stores.size >= 128) for (const [oldKey, old] of stores) {
      if (old.isDisposable()) stores.delete(oldKey);
      if (stores.size < 128) break;
    }
    store = new SurfaceState(key, sessionId, toolCallId, surface); stores.set(key, store);
  }
  return store;
}
