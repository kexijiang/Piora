import { isAnswerStateEnabled, registerAnswerStateWriter } from "../../lib/answer-output-client";
import { initialState, validateState, validateSurface, type UiState, type UiSurface } from "../../lib/intelligent-ui/surface-document";
import { mapDraftValues } from "../../lib/intelligent-ui/draft-migration";

export interface UiPublication {
  status: "candidate" | "awaiting_confirmation" | "committed" | "aborted" | "superseded";
  operationId?: string;
  currentToolCallId?: string;
}
export type SaveStatus = "loading" | "saved" | "saving" | "error" | "conflict" | "candidate" | "awaiting_confirmation" | "aborted" | "superseded";
export interface RetainedDraft {
  id: string; sessionId: string; toolCallId: string; surface: UiSurface; state: UiState;
  revision: number; leafId: string; surfaceRevision: number; retainedAt: string;
  publication?: UiPublication;
  sourceDraftId?: string;
  migration?: DraftMigrationLink;
}
export interface SurfaceView {
  surface: UiSurface;
  state: UiState;
  status: SaveStatus;
  revision: number;
  leafId: string;
  publication?: UiPublication;
  hasPendingDraft: boolean;
  retainedDrafts: readonly RetainedDraft[];
  recoverableDrafts: readonly RetainedDraft[];
  error?: string;
  migration?: DraftMigrationReview;
  migrationSaved?: boolean;
  migrationFailed?: boolean;
}
interface SavedSurface { surface: UiSurface; state: UiState; revision: number; leafId: string; publication?: UiPublication }
interface DraftMigrationLink { id: string; sourceKey: string; sourceDraftId: string; sourceToolCallId: string; sourceLeafId: string; targetToolCallId: string }
export interface DraftMigrationReview { id: string; source: RetainedDraft; target: SavedSurface; targetToolCallId: string }
interface Recovery { state: UiState; revision: number; leafId: string; surfaceRevision: number; surface?: UiSurface; publication?: UiPublication; migration?: DraftMigrationLink }
const stores = new Map<string, SurfaceState>();

function parsePublication(value: unknown): UiPublication | undefined {
  if (value === undefined) return undefined;
  const data = value as UiPublication;
  if (!data || !["candidate", "awaiting_confirmation", "committed", "aborted", "superseded"].includes(data.status)
    || (data.operationId !== undefined && (typeof data.operationId !== "string" || !data.operationId))
    || (data.currentToolCallId !== undefined && (typeof data.currentToolCallId !== "string" || !data.currentToolCallId))) throw new Error("Invalid publication state");
  return { status: data.status, operationId: data.operationId, ...(data.currentToolCallId ? { currentToolCallId: data.currentToolCallId } : {}) };
}
function parseSaved(value: unknown, envelopeVersion = 1): SavedSurface {
  const data = value as SavedSurface;
  const surface = validateSurface(data.surface);
  const publication = parsePublication(data.publication);
  if (envelopeVersion === 2 && !publication?.operationId) throw new Error("Publication confirmation is unavailable; this preview cannot be edited.");
  if (!Number.isSafeInteger(data.revision) || data.revision < 0 || typeof data.leafId !== "string") throw new Error("Invalid saved state");
  return { surface, state: validateState(surface, data.state), revision: data.revision, leafId: data.leafId, publication };
}
function savedStatus(saved: SavedSurface): SaveStatus { return saved.publication && saved.publication.status !== "committed" ? saved.publication.status : "saved"; }
function blocked(status: SaveStatus): boolean { return status === "candidate" || status === "awaiting_confirmation" || status === "aborted" || status === "superseded"; }

/** Shared by all mounts of a virtual row. Pending edits stay alive until acknowledged on disk. */
export class SurfaceState {
  private view: SurfaceView;
  private listeners = new Set<() => void>();
  private operation: Promise<void> | undefined;
  private dirty = false;
  private pending: Recovery | undefined;
  private generation = 0;
  private unregister: (() => void) | undefined;
  private readonly endpoint: string;
  private readonly recoveryKey: string;
  private readonly retainedKey: string;
  private readonly windowKey: string;
  private readonly windowStorage: Storage | undefined;
  // A new document gets a new writer even when a duplicated tab inherited its
  // sessionStorage. It may recover the same bytes, but never edits that record.
  private readonly writerId = crypto.randomUUID();
  private pendingId: string | undefined;
  private pendingBytes: string | undefined;
  private localRecoveryError: string | undefined;
  private migrationReview: { view: DraftMigrationReview; generation: number; draftId?: string } | undefined;
  private migrationEpoch = 0;

  constructor(readonly key: string, readonly sessionId: string, readonly toolCallId: string, private readonly originalSurface: UiSurface, readonly envelopeVersion = 1) {
    this.view = { surface: originalSurface, state: initialState(originalSurface), status: "loading", revision: 0, leafId: "", hasPendingDraft: false, retainedDrafts: [], recoverableDrafts: [] };
    this.endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/intelligent-ui`;
    this.recoveryKey = `piora-ui-pending:${key}`;
    this.retainedKey = `piora-ui-retained:${key}`;
    this.windowKey = `piora-ui-window:${key}`;
    try { this.windowStorage = typeof sessionStorage === "undefined" ? undefined : sessionStorage; } catch { /* Recovery remains available through the explicit draft list. */ }
  }

  getSnapshot = () => this.view;
  isDisposable = () => !this.dirty && !this.operation && this.listeners.size === 0;
  isEditable = () => this.view.status !== "loading" && !!this.view.leafId && !blocked(this.view.status)
    && (!this.view.publication || this.view.publication.status === "committed")
    && (this.envelopeVersion !== 2 || this.view.publication?.status === "committed");
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<SurfaceView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private track() {
    this.unregister ??= registerAnswerStateWriter(this.key, this.sessionId, () => this.flush());
  }
  private parseRecovery(text: string): Recovery {
    const value = JSON.parse(text) as Recovery;
    const surface = value.surface ? validateSurface(value.surface) : this.originalSurface;
    if (!Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.leafId !== "string"
      || value.surfaceRevision !== surface.revision || surface.id !== this.originalSurface.id) throw new Error("The local draft needs recovery; it has not been deleted.");
    if (value.migration && (!Object.values(value.migration).every(item => typeof item === "string" && item.length > 0 && item.length <= 2048)
      || !["id", "sourceKey", "sourceDraftId", "sourceToolCallId", "sourceLeafId", "targetToolCallId"].every(key => Object.hasOwn(value.migration!, key))
      || value.migration.targetToolCallId !== this.toolCallId)) throw new Error("The migration draft needs recovery.");
    return { ...value, surface, state: validateState(surface, value.state), publication: parsePublication(value.publication) };
  }
  private readRecords(prefix: string): RetainedDraft[] {
    if (typeof localStorage === "undefined") return [];
    const records: RetainedDraft[] = [];
    // Independent records avoid a shared read/modify/write index: two windows
    // retaining different drafts must not overwrite each other's archives.
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}:`)) continue;
      const text = localStorage.getItem(key);
      if (text) records.push(JSON.parse(text) as RetainedDraft);
    }
    return records.map(record => {
      if (record.sessionId !== this.sessionId || record.toolCallId !== this.toolCallId || typeof record.id !== "string"
        || typeof record.leafId !== "string" || typeof record.retainedAt !== "string" || !Number.isSafeInteger(record.revision)) throw new Error("Retained draft identity does not match this answer.");
      return { ...record, ...this.parseRecovery(JSON.stringify(record)), surface: validateSurface(record.surface) };
    });
  }
  private readRetained(): RetainedDraft[] { return this.readRecords(this.retainedKey); }
  private hasUnretainedRecovery(): boolean {
    const retained = this.readRetained();
    const content = (record: RetainedDraft) => JSON.stringify({ surface: record.surface, state: record.state,
      revision: record.revision, leafId: record.leafId, surfaceRevision: record.surfaceRevision, publication: record.publication, migration: record.migration });
    return this.readRecords(this.recoveryKey).some(record => !retained.some(archive => archive.sourceDraftId === record.id && content(archive) === content(record)));
  }
  private archive(draft: Recovery, sourceDraftId?: string): RetainedDraft {
    const record = this.readRetained().find(record => record.leafId === draft.leafId && record.revision === draft.revision
      && record.surfaceRevision === draft.surfaceRevision && JSON.stringify(record.state) === JSON.stringify(draft.state)
      && JSON.stringify(record.surface) === JSON.stringify(draft.surface ?? this.originalSurface)
      && JSON.stringify(record.publication) === JSON.stringify(draft.publication)
      && JSON.stringify(record.migration) === JSON.stringify(draft.migration)
      && (sourceDraftId === undefined || record.sourceDraftId === sourceDraftId))
      ?? { ...draft, id: crypto.randomUUID(), sessionId: this.sessionId, toolCallId: this.toolCallId,
        surface: draft.surface ?? this.originalSurface, retainedAt: new Date().toISOString(), ...(sourceDraftId ? { sourceDraftId } : {}) };
    const key = `${this.retainedKey}:${record.id}`, serialized = JSON.stringify(record);
    localStorage.setItem(key, serialized);
    if (localStorage.getItem(key) !== serialized) throw new Error("The old draft could not be retained on this device. It remains pending.");
    return record;
  }
  private recover(): Recovery | undefined {
    if (typeof localStorage === "undefined") return undefined;
    // Old clients used one shared record with no window identity. Preserve it
    // in the visible archive, never guess which current window should use it.
    const legacy = localStorage.getItem(this.recoveryKey);
    if (legacy) {
      const markerKey = `${this.retainedKey}-legacy`;
      let marker: { source?: string; id?: string } = {};
      try { marker = JSON.parse(localStorage.getItem(markerKey) ?? "{}"); } catch { /* Reverify the source below. */ }
      if (marker.source !== legacy || !this.readRetained().some(record => record.id === marker.id)) {
        const record = this.archive(this.parseRecovery(legacy));
        const markerBytes = JSON.stringify({ source: legacy, id: record.id });
        localStorage.setItem(markerKey, markerBytes);
        if (localStorage.getItem(markerKey) !== markerBytes) throw new Error("The legacy draft could not be retained on this device.");
      }
      // Keep the original key intact for older clients and concurrent migration.
    }
    const id = this.windowStorage?.getItem(this.windowKey);
    const text = id ? localStorage.getItem(`${this.recoveryKey}:${id}`) : null;
    if (!text) return undefined;
    const record = JSON.parse(text) as RetainedDraft;
    if (record.id !== id || record.sessionId !== this.sessionId || record.toolCallId !== this.toolCallId) throw new Error("The local draft identity does not match this answer.");
    const recovery = this.parseRecovery(text);
    // sessionStorage is copied when a tab is duplicated. Recover into this
    // document's own record before *any* action, including discard or loading
    // saved parameters, can settle it. The originating record stays available.
    const bytes = id === this.writerId ? text : JSON.stringify({ ...record, id: this.writerId });
    const key = `${this.recoveryKey}:${this.writerId}`;
    localStorage.setItem(key, bytes);
    if (localStorage.getItem(key) !== bytes) throw new Error("The recovered draft could not be copied safely. Its original record is retained.");
    this.windowStorage?.setItem(this.windowKey, this.writerId);
    if (this.windowStorage?.getItem(this.windowKey) !== this.writerId) throw new Error("The recovered draft could not be attached to this window. Its original record is retained.");
    this.pendingId = this.writerId; this.pendingBytes = bytes;
    return recovery;
  }
  refreshLocalDrafts = (): void => {
    try {
      this.publish({ retainedDrafts: this.readRetained(), recoverableDrafts: this.readRecords(this.recoveryKey).filter(record => record.id !== this.pendingId) });
    } catch { /* A malformed foreign record cannot erase this window's draft. */ }
  };
  private settlePending() {
    if (!this.pendingId) return;
    const key = `${this.recoveryKey}:${this.pendingId}`;
    // Only this exact acknowledged/archived snapshot is settled. Another
    // document's draft has its own ID and cannot be deleted by this window.
    if (localStorage.getItem(key) === this.pendingBytes) localStorage.removeItem(key);
    if (this.windowStorage?.getItem(this.windowKey) === this.pendingId) this.windowStorage.removeItem(this.windowKey);
    this.pendingId = undefined; this.pendingBytes = undefined;
  }
  private draft(): Recovery {
    return { ...(this.pending ?? { revision: this.view.revision, leafId: this.view.leafId, surfaceRevision: this.view.surface.revision, publication: this.view.publication }), surface: this.view.surface, state: this.view.state };
  }
  private journal() {
    try {
      if (!this.dirty) this.settlePending();
      else {
        this.pending = this.draft();
        const record: RetainedDraft = { ...this.pending, id: this.writerId, sessionId: this.sessionId, toolCallId: this.toolCallId,
          surface: this.pending.surface ?? this.originalSurface, retainedAt: new Date().toISOString() };
        const bytes = JSON.stringify(record), key = `${this.recoveryKey}:${this.writerId}`;
        localStorage.setItem(key, bytes);
        if (localStorage.getItem(key) !== bytes) throw new Error("The local draft could not be stored.");
        this.pendingId = this.writerId; this.pendingBytes = bytes;
        this.windowStorage?.setItem(this.windowKey, this.writerId);
      }
      this.refreshLocalDrafts();
    } catch { /* Durable server writes remain authoritative; the status stays unsaved until acknowledgement. */ }
  }
  private async read(requiredAncestorLeafId?: string): Promise<SavedSurface> {
    const ancestor = requiredAncestorLeafId ? `&requiredAncestorLeafId=${encodeURIComponent(requiredAncestorLeafId)}` : "";
    const response = await fetch(`${this.endpoint}?toolCallId=${encodeURIComponent(this.toolCallId)}${ancestor}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`State load failed (${response.status})`);
    try {
      const saved = parseSaved(await response.json(), this.envelopeVersion);
      if (saved.surface.id !== this.originalSurface.id || saved.surface.revision !== this.originalSurface.revision) throw new Error("The saved output identity changed; the original draft has been kept.");
      return saved;
    } catch (error) {
      if (this.envelopeVersion === 2) this.publish({ publication: undefined });
      throw error;
    }
  }

  load = async (refresh = false): Promise<void> => {
    this.cancelMigration();
    if (this.operation) {
      await this.operation.catch(() => {});
      if (refresh) await this.load();
      return;
    }
    if (!isAnswerStateEnabled()) return;
    if (this.dirty) this.pending = this.draft();
    // A reused virtual row may now be on another branch. Never permit edits to
    // its previous branch while the authoritative branch is being resolved.
    this.publish({ status: "loading", ...(!this.dirty ? { leafId: "" } : {}), error: undefined });
    this.operation = (async () => {
      try {
        let recovery: Recovery | undefined;
        try { recovery = this.dirty ? this.draft() : this.recover(); }
        catch (error) {
          this.localRecoveryError = "The local draft needs recovery before continuing.";
          this.track();
          throw error;
        }
        this.localRecoveryError = undefined;
        // Local recovery precedes the network: a failed GET must not hide an
        // unsaved draft or let a dependent prompt bypass its writer.
        if (recovery) {
          const surface = recovery.surface ?? this.originalSurface;
          const draft = validateState(surface, recovery.state);
          this.pending = recovery; this.dirty = true;
          this.track();
          this.publish({ surface, state: draft, hasPendingDraft: true });
        }
        this.refreshLocalDrafts();
        const saved = await this.read();
        this.publish({ ...saved, status: savedStatus(saved), hasPendingDraft: Boolean(recovery), error: undefined });
        if (recovery) {
          const surface = recovery.surface ?? this.originalSurface, draft = validateState(surface, recovery.state);
          const conflict = recovery.revision !== saved.revision || recovery.leafId !== saved.leafId || recovery.surfaceRevision !== saved.surface.revision
            || (recovery.publication?.operationId !== undefined && recovery.publication.operationId !== saved.publication?.operationId);
          this.publish({ surface, state: draft, status: blocked(savedStatus(saved)) ? savedStatus(saved) : conflict ? "conflict" : "saving" });
        }
      } catch (error) {
        if (!this.dirty && this.windowStorage?.getItem(this.windowKey)) {
          this.localRecoveryError = "The local draft needs recovery before continuing.";
          this.track();
        }
        this.publish({ status: "error", leafId: "", publication: undefined, error: error instanceof Error ? error.message : "State load failed" });
      }
    })().finally(() => { this.operation = undefined; });
    await this.operation;
    if (this.dirty && this.view.status === "saving") void this.flush().catch(() => {});
  };

  change(id: string, value: string | number | boolean) {
    if (!this.isEditable()) return;
    const state = validateState(this.view.surface, { ...this.view.state, [id]: value });
    if (!this.dirty) this.pending = { state, revision: this.view.revision, leafId: this.view.leafId, surfaceRevision: this.view.surface.revision, surface: this.view.surface, publication: this.view.publication };
    this.generation += 1;
    this.dirty = true;
    this.track();
    this.publish({ state, status: this.view.status === "conflict" ? "conflict" : "saving", hasPendingDraft: true, error: undefined });
    this.journal();
    if (this.view.status !== "conflict") void this.flush().catch(() => {});
  }

  flush = async (): Promise<void> => {
    if (!isAnswerStateEnabled()) return;
    if (this.operation) { await this.operation; return this.flush(); }
    if (this.localRecoveryError) throw new Error(this.localRecoveryError);
    if (!this.dirty) return;
    if (blocked(this.view.status)) throw new Error("This version cannot save changes. Keep the old draft separately or explicitly discard it before continuing.");
    if (this.view.status === "conflict") throw new Error("Intelligent UI has conflicting unsaved changes. Resolve them in the answer before continuing.");
    this.operation = this.save().finally(() => { this.operation = undefined; });
    await this.operation;
  };

  private async save() {
    while (this.dirty && isAnswerStateEnabled()) {
      const generation = this.generation;
      const { state } = this.view;
      // Loading can clear the visible branch while offline. Its pending draft
      // still belongs to the original confirmed revision and branch anchor.
      const { revision, leafId } = this.pending ?? this.view;
      try {
        // Recheck publication before a pending writer feeds a dependent send.
        // The PUT remains the authoritative CAS if publication races this GET.
        const current = await this.read(this.pending?.migration?.sourceLeafId);
        if (this.pending?.migration) {
          const link = this.pending.migration;
          const source = await this.readMigrationOutput(link.sourceToolCallId, link.sourceLeafId);
          if (source.publication?.status !== "superseded" || source.publication.currentToolCallId !== this.toolCallId
            || source.leafId !== current.leafId || current.leafId !== leafId
            || current.surface.id !== this.view.surface.id || current.surface.revision !== this.view.surface.revision) {
            this.publish({ status: "conflict" });
            throw new Error("The migration destination changed. Review the retained draft again.");
          }
        }
        this.publish({ publication: current.publication });
        if (blocked(savedStatus(current))) {
          this.publish({ status: savedStatus(current) });
          throw new Error("This version is no longer editable. Your original draft has been kept.");
        }
        if (current.revision !== revision) {
          this.publish({ status: "conflict" });
          throw new Error("Intelligent UI state changed elsewhere. Resolve the conflict before continuing.");
        }
        // The switch may change while either preflight read is in flight. Keep
        // the pending record, but do not start a write after it was disabled.
        if (!isAnswerStateEnabled()) throw new Error("Intelligent UI was disabled before saving. Your pending draft is retained.");
        this.publish({ status: "saving", error: undefined });
        const response = await fetch(this.endpoint, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ toolCallId: this.toolCallId, leafId, expectedRevision: revision, state }),
        });
        if (response.status === 409) {
          let latest: SavedSurface | undefined;
          try {
            const body = await response.json();
            latest = body.current ? parseSaved(body.current, this.envelopeVersion) : await this.read();
          } catch { /* Keep the draft even if current publication is unavailable. */ }
          this.publish({ status: latest && blocked(savedStatus(latest)) ? savedStatus(latest) : "conflict", ...(latest ? { publication: latest.publication } : {}) });
          throw new Error("Intelligent UI state changed elsewhere. Resolve the conflict before continuing.");
        }
        if (!response.ok) throw new Error(`State save failed (${response.status})`);
        const saved = parseSaved(await response.json(), this.envelopeVersion);
        if (blocked(savedStatus(saved))) throw new Error("The server did not confirm a committed parameter save.");
        if (this.pending?.migration) {
          if (JSON.stringify(saved.surface) !== JSON.stringify(this.view.surface)
            || saved.publication?.operationId !== current.publication?.operationId
            || JSON.stringify(saved.state) !== JSON.stringify(state) || saved.revision <= revision) throw new Error("The migration save was not acknowledged.");
          this.writeMigrationRecord(this.pending.migration, "saved", saved);
        }
        this.dirty = generation !== this.generation;
        this.pending = this.dirty ? { state: this.view.state, revision: saved.revision, leafId: saved.leafId, surfaceRevision: this.view.surface.revision, surface: this.view.surface, publication: saved.publication } : undefined;
        this.publish({ revision: saved.revision, leafId: saved.leafId, publication: saved.publication, status: this.dirty ? "saving" : "saved", hasPendingDraft: this.dirty });
        this.journal();
        if (!this.dirty) { this.unregister?.(); this.unregister = undefined; }
      } catch (error) {
        if (this.view.status !== "conflict" && !blocked(this.view.status)) this.publish({ status: "error", error: error instanceof Error ? error.message : "State save failed" });
        throw error;
      }
    }
  }

  private async readMigrationOutput(toolCallId: string, ancestor: string): Promise<SavedSurface> {
    const response = await fetch(`${this.endpoint}?toolCallId=${encodeURIComponent(toolCallId)}&requiredAncestorLeafId=${encodeURIComponent(ancestor)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("This draft does not belong to the current branch, or its latest version is unavailable.");
    const saved = parseSaved(await response.json());
    if (saved.surface.id !== this.originalSurface.id) throw new Error("The migration destination belongs to another task.");
    return saved;
  }
  private writeMigrationRecord(link: DraftMigrationLink, status: "prepared" | "saved", target: SavedSurface) {
    const key = `piora-ui-transfer:${link.id}`;
    const text = JSON.stringify({ ...link, sessionId: this.sessionId, status, target, updatedAt: new Date().toISOString() });
    localStorage.setItem(key, text);
    if (localStorage.getItem(key) !== text) throw new Error("The migration record could not be retained. Both drafts have been kept.");
  }
  cancelMigration = (): void => { this.migrationEpoch += 1; this.migrationReview = undefined; if (this.view.migration) this.publish({ migration: undefined }); };

  /** Preparation is read-only. Every mapping starts empty, including same IDs. */
  prepareMigration = async (draftId?: string): Promise<void> => {
    this.cancelMigration();
    const epoch = this.migrationEpoch;
    if (this.operation) await this.operation.catch(() => {});
    const generation = this.generation;
    const source = draftId ? [...this.readRetained(), ...this.readRecords(this.recoveryKey)].find(record => record.id === draftId)
      : this.dirty ? { ...this.draft(), id: this.pendingId ?? this.writerId, sessionId: this.sessionId, toolCallId: this.toolCallId, surface: this.view.surface, retainedAt: new Date().toISOString() } : undefined;
    if (!source) throw new Error("Choose a retained or unsaved draft to migrate.");
    const current = await this.readMigrationOutput(this.toolCallId, source.leafId);
    const targetToolCallId = current.publication?.currentToolCallId;
    if (current.publication?.status !== "superseded" || !targetToolCallId || targetToolCallId === this.toolCallId) throw new Error("There is no newer committed destination for this draft.");
    const target = await this.readMigrationOutput(targetToolCallId, source.leafId);
    if (blocked(savedStatus(target)) || target.leafId !== current.leafId) throw new Error("The destination changed. Review the latest version again.");
    if (this.migrationEpoch !== epoch || this.generation !== generation || !isAnswerStateEnabled()) throw new Error("The draft changed. Review it again.");
    const view = { id: crypto.randomUUID(), source, target, targetToolCallId };
    this.migrationReview = { view, generation, draftId };
    this.publish({ migration: view, migrationSaved: false, migrationFailed: false });
  };

  migrateDraft = async (reviewId: string, mapping: Record<string, string>): Promise<void> => {
    const review = this.migrationReview;
    if (!review || review.view.id !== reviewId || this.operation || !isAnswerStateEnabled()) throw new Error("Review this draft before migrating it.");
    const { source, target, targetToolCallId } = review.view;
    if (!Object.keys(mapping).length) throw new Error("Select at least one field to migrate.");
    const state = mapDraftValues(source.surface, source.state, target.surface, target.state, mapping);
    this.operation = (async () => {
      const current = await this.readMigrationOutput(this.toolCallId, source.leafId);
      const latest = await this.readMigrationOutput(targetToolCallId, source.leafId);
      if (this.migrationReview !== review || this.generation !== review.generation || !isAnswerStateEnabled()
        || current.publication?.status !== "superseded" || current.publication.currentToolCallId !== targetToolCallId
        || current.leafId !== target.leafId || JSON.stringify(latest) !== JSON.stringify(target)) {
        this.cancelMigration(); throw new Error("The source or destination changed. Review the mapping again.");
      }
      const destination = surfaceState(this.sessionId, targetToolCallId, target.surface, target.publication?.operationId ? 2 : 1);
      destination.refreshLocalDrafts();
      if (destination.dirty || destination.operation || destination.localRecoveryError || destination.hasUnretainedRecovery()) {
        throw new Error("The destination has unsaved edits. Resolve those edits before migrating this draft.");
      }
      // Archive the source first. A subsequent local/network failure never loses it.
      const archived = this.archive(source, source.id);
      const link = { id: crypto.randomUUID(), sourceKey: this.key, sourceDraftId: archived.id, sourceToolCallId: this.toolCallId, sourceLeafId: source.leafId, targetToolCallId };
      const recovery: Recovery = { ...target, state, surfaceRevision: target.surface.revision, migration: link };
      const record = { ...recovery, id: destination.writerId, sessionId: this.sessionId, toolCallId: targetToolCallId, retainedAt: new Date().toISOString() };
      const key = `${destination.recoveryKey}:${destination.writerId}`, bytes = JSON.stringify(record);
      localStorage.setItem(key, bytes);
      if (localStorage.getItem(key) !== bytes) throw new Error("The new draft could not be stored. The original is retained.");
      // Track before any additional persistence can fail; a durable target record
      // must never become an untracked automatic write or disappear from recovery.
      destination.pendingId = destination.writerId; destination.pendingBytes = bytes;
      destination.pending = recovery; destination.dirty = true; destination.generation += 1; destination.track();
      destination.publish({ ...target, state, status: "conflict", hasPendingDraft: true });
      destination.windowStorage?.setItem(destination.windowKey, destination.writerId);
      if (!destination.windowStorage || destination.windowStorage.getItem(destination.windowKey) !== destination.writerId) throw new Error("The new draft could not be attached to this window. Both drafts are retained.");
      destination.writeMigrationRecord(link, "prepared", target);
      if (!review.draftId && this.dirty) {
        this.settlePending(); this.dirty = false; this.pending = undefined; this.generation += 1;
        this.unregister?.(); this.unregister = undefined;
        this.publish({ ...current, status: savedStatus(current), hasPendingDraft: false });
      }
      this.refreshLocalDrafts(); this.cancelMigration();
      destination.publish({ status: "saving" });
      await destination.flush();
      // flush also resolves when the feature is disabled. Only the record
      // written after an acknowledged PUT proves this transfer finished.
      const receipt = JSON.parse(localStorage.getItem(`piora-ui-transfer:${link.id}`) ?? "null");
      if (!receipt || receipt.status !== "saved" || receipt.id !== link.id || receipt.sessionId !== this.sessionId
        || receipt.sourceDraftId !== archived.id || receipt.targetToolCallId !== targetToolCallId
        || JSON.stringify(receipt.target?.state) !== JSON.stringify(state)) throw new Error("Migration is pending. Re-enable Intelligent UI to finish saving; both drafts are retained.");
      this.publish({ migrationSaved: true });
    })().catch(error => { this.publish({ migrationFailed: true }); throw error; }).finally(() => { this.operation = undefined; });
    await this.operation;
  };

  /** Explicit user choices only: never silently overwrite another tab's state. */
  resolve = async (keepDraft: boolean): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    const generation = this.generation;
    const draft = this.view.state;
    const saved = await this.read();
    if (this.generation !== generation) throw new Error("Values changed while loading; choose again to keep your latest edits.");
    if (blocked(savedStatus(saved)) && this.dirty) {
      this.publish({ publication: saved.publication, status: savedStatus(saved) });
      throw new Error("This output is read-only. Keep the old draft separately before using saved parameters.");
    }
    this.dirty = keepDraft;
    this.generation += 1;
    this.pending = keepDraft ? { ...saved, state: validateState(saved.surface, draft), surfaceRevision: saved.surface.revision } : undefined;
    this.publish({ ...saved, state: keepDraft ? this.pending!.state : saved.state, status: keepDraft ? "saving" : savedStatus(saved), hasPendingDraft: keepDraft, error: undefined });
    this.journal();
    if (keepDraft) { this.track(); await this.flush(); }
    else { this.unregister?.(); this.unregister = undefined; }
  };

  /** Verify a separate durable recovery record before removing a writer from send flushes. */
  retainDraft = async (): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    if (!this.dirty) return;
    const generation = this.generation, draft = this.draft();
    const saved = await this.read();
    if (generation !== this.generation) throw new Error("Values changed while preserving the draft; try again.");
    this.archive(draft, this.pendingId);
    this.settlePending();
    this.dirty = false; this.pending = undefined; this.generation += 1;
    this.unregister?.(); this.unregister = undefined;
    this.publish({ ...saved, status: savedStatus(saved), hasPendingDraft: false, retainedDrafts: this.readRetained(), error: undefined });
    this.refreshLocalDrafts();
  };

  /** Explicit copies leave the originating window's pending bytes untouched. */
  restoreDraft = async (id: string): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    const record = [...this.readRecords(this.recoveryKey), ...this.readRetained()].find(record => record.id === id);
    if (!record) throw new Error("This draft is no longer available. Refresh the draft list.");
    if (this.dirty) { this.archive(this.draft(), this.pendingId); this.settlePending(); }
    this.pending = this.parseRecovery(JSON.stringify(record)); this.dirty = true; this.generation += 1;
    this.track();
    this.publish({ surface: record.surface, state: record.state, hasPendingDraft: true,
      status: blocked(this.view.status) ? this.view.status : "conflict", error: undefined });
    this.journal();
  };
  retainRecovery = async (id: string): Promise<void> => {
    const record = this.readRecords(this.recoveryKey).find(record => record.id === id);
    if (!record) throw new Error("This draft is no longer available. Refresh the draft list.");
    this.archive(record, id); this.refreshLocalDrafts();
  };

  retry = async (): Promise<void> => this.dirty ? this.flush() : this.load(true);

  discard = async (): Promise<void> => {
    if (this.operation) await this.operation.catch(() => {});
    this.dirty = false;
    this.pending = undefined;
    this.generation += 1;
    this.unregister?.(); this.unregister = undefined;
    this.journal();
    await this.load();
  };
}

export async function refreshSessionSurfaces(sessionId: string): Promise<void> {
  await Promise.all([...stores.values()].filter(store => store.sessionId === sessionId).map(store => store.load(true)));
}

export function surfaceState(sessionId: string, toolCallId: string, surface: UiSurface, envelopeVersion = 1): SurfaceState {
  // Tool-call identity exists before history hydration; entry IDs may arrive later.
  const key = JSON.stringify([sessionId, toolCallId, surface.id, surface.revision, ...(envelopeVersion === 2 ? [2] : [])]);
  let store = stores.get(key);
  if (!store) {
    if (stores.size >= 128) for (const [oldKey, old] of stores) {
      if (old.isDisposable()) stores.delete(oldKey);
      if (stores.size < 128) break;
    }
    store = new SurfaceState(key, sessionId, toolCallId, surface, envelopeVersion); stores.set(key, store);
  }
  return store;
}
