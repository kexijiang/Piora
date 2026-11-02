import { isAnswerStateEnabled, registerAnswerStateWriter } from "../answer-output-client";
import { compileMiniAppPlan, validateMiniAppResult, type CompiledMiniApp, type MiniAppResult } from "./plan";
import { MiniAppError, isMiniAppError } from "./limits";
import { readMiniAppResource } from "./resource";
import { miniAppBrowserDigest, miniAppEnvelopeIdentity, parseMiniAppOutput, validateMiniAppReceipt, type MiniAppEnvelopeIdentity } from "./client-protocol";
import { confirmMiniAppDraft, getMiniAppDraft, listMiniAppDraftPage, putMiniAppDraft, type MiniAppDraft, type MiniAppDraftInfo, type MiniAppDraftCursor } from "./drafts";
import type { MiniAppOutput } from "./state-service";
import type { MiniAppVmReply } from "./vm";
import type { MiniAppSaveReceipt } from "./state-store";

export interface MiniAppClientView {
  /** A server refresh changed the checkpoint; every mounted runtime must restore it. */
  restoreRevision?: number;
  status: "loading" | "saved" | "saving" | "error" | "conflict";
  output?: MiniAppOutput;
  current?: MiniAppResult;
  drafts: MiniAppDraftInfo[];
  hasMoreDrafts?: boolean;
  draftsLoading?: boolean;
  draftsError?: string;
  needsRecovery: boolean;
  error?: { code: string; message: string };
}
interface Pending { draft: MiniAppDraft; confirmed?: MiniAppSaveReceipt }
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Owns local recovery and server receipts. Runtime and React are replaceable views. */
export class MiniAppStateClient {
  private view: MiniAppClientView = { status: "loading", drafts: [], needsRecovery: false };
  private readonly listeners = new Set<() => void>();
  private readonly cancellation = new AbortController();
  private readonly identity: MiniAppEnvelopeIdentity;
  private readonly endpoint: string;
  private readonly scope: string;
  private compiled?: CompiledMiniApp;
  private pending?: Pending;
  private flight?: Pending;
  private localWrite?: Promise<void>;
  private operation?: Promise<void>;
  private flushing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private unregister?: () => void;
  private checkpointGate?: (work: () => Promise<void>) => Promise<void>;
  private ended = false;
  private ignoreRecovery = false;
  private resolving = false;
  private loading?: Promise<void>;
  private draftCursor?: MiniAppDraftCursor;
  private draftListRevision = 0;
  private draftPageTask?: Promise<void>;

  constructor(readonly sessionId: string, readonly toolCallId: string, envelope: unknown, private readonly onBlock: () => void) {
    this.identity = miniAppEnvelopeIdentity(envelope);
    this.endpoint = `/api/sessions/${encodeURIComponent(sessionId)}/mini-app`;
    this.scope = `${sessionId}:${toolCallId}`;
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setCheckpointGate(gate: ((work: () => Promise<void>) => Promise<void>) | undefined) { this.checkpointGate = gate; }
  private publish(patch: Partial<MiniAppClientView>) {
    if (this.ended) return;
    const next = { ...this.view, ...patch };
    this.view = { ...next, needsRecovery: !this.ignoreRecovery && (next.drafts.length > 0 || next.hasMoreDrafts === true) };
    for (const listener of this.listeners) listener();
  }
  private active() {
    if (this.ended || this.cancellation.signal.aborted) throw new MiniAppError("STOPPED", "This mini app view is no longer active");
    if (!isAnswerStateEnabled()) throw new MiniAppError("DISABLED", "Intelligent UI is disabled");
  }
  private block(error: unknown) {
    if (this.ended) return;
    const problem = isMiniAppError(error) ? error : new MiniAppError("UNAVAILABLE", "The checkpoint is retained locally; saving is not confirmed");
    this.publish({ status: problem.code === "CONFLICT" ? "conflict" : "error", error: { code: problem.code, message: problem.message } });
    this.onBlock();
  }
  private async request(query: string, init?: RequestInit): Promise<unknown> {
    this.active();
    const signal = AbortSignal.any([this.cancellation.signal, AbortSignal.timeout(10_000)]);
    const response = await fetch(`${this.endpoint}${query}`, { ...init, signal, cache: "no-store" });
    const data = JSON.parse(new TextDecoder().decode(await readMiniAppResource(response, 1024 * 1024, { allowErrorStatus: true })));
    this.active();
    if (!response.ok) throw new MiniAppError(typeof data?.code === "string" ? data.code : response.status === 409 ? "CONFLICT" : "UNAVAILABLE",
      typeof data?.error === "string" ? data.error.slice(0, 1000) : "Mini app state is unavailable");
    return data;
  }
  private async readCurrent(ancestor?: string) {
    const query = new URLSearchParams({ toolCallId: this.toolCallId, ...(ancestor ? { requiredAncestorLeafId: ancestor } : {}) });
    return parseMiniAppOutput(await this.request(`?${query}`), this.toolCallId, this.identity);
  }
  private async refreshDrafts() {
    const revision = ++this.draftListRevision;
    this.draftPageTask = undefined;
    this.publish({ draftsLoading: true, draftsError: undefined });
    try {
      const page = await listMiniAppDraftPage(this.scope);
      if (this.ended || revision !== this.draftListRevision) return;
      this.draftCursor = page.next;
      this.publish({ drafts: this.visibleDrafts(page.items), hasMoreDrafts: !!page.next });
    } catch (error) {
      if (this.ended || revision !== this.draftListRevision) return;
      throw error;
    } finally {
      if (revision === this.draftListRevision) this.publish({ draftsLoading: false });
    }
  }
  private visibleDrafts(items: MiniAppDraftInfo[]) {
    return items.filter(item => item.id !== this.pending?.draft.id && item.id !== this.flight?.draft.id);
  }
  /** A refresh invalidates a slower page read without dropping the retained records. */
  async reloadDrafts(): Promise<void> {
    this.active();
    try { await this.refreshDrafts(); }
    catch (error) { this.publish({ draftsError: "Cannot read local checkpoints. Existing recovery copies are retained." }); throw error; }
  }
  loadMoreDrafts(): Promise<void> {
    if (this.draftPageTask) return this.draftPageTask;
    if (!this.draftCursor || this.view.draftsLoading) return Promise.resolve();
    const cursor = this.draftCursor, revision = this.draftListRevision;
    this.publish({ draftsLoading: true, draftsError: undefined });
    const task = (async () => {
      try {
        this.active();
        const page = await listMiniAppDraftPage(this.scope, cursor);
        if (this.ended || revision !== this.draftListRevision) return;
        this.active();
        const merged = new Map(this.view.drafts.map(item => [item.id, item]));
        for (const item of page.items) merged.set(item.id, item);
        this.draftCursor = page.next;
        this.publish({ drafts: this.visibleDrafts([...merged.values()]), hasMoreDrafts: !!page.next });
      } catch (error) {
        if (this.ended || revision !== this.draftListRevision) return;
        if (revision === this.draftListRevision) this.publish({ draftsError: "Cannot load more checkpoints. Existing recovery copies are retained." });
        throw error;
      } finally {
        if (revision === this.draftListRevision) this.publish({ draftsLoading: false });
      }
    })();
    this.draftPageTask = task;
    void task.then(() => { if (this.draftPageTask === task) this.draftPageTask = undefined; }, () => { if (this.draftPageTask === task) this.draftPageTask = undefined; });
    return task;
  }
  load(): Promise<void> {
    if (this.loading) return this.loading;
    // A virtualized view may remount while an earlier write is still pending.
    // It must keep that state instead of replacing it with an older GET result.
    if (this.pending || this.flight || this.operation || this.resolving) return this.refreshDrafts();
    const task = (async () => { try {
      const [output] = await Promise.all([this.readCurrent(), this.refreshDrafts()]);
      this.active(); this.compiled = compileMiniAppPlan(output.plan);
      const changed = this.view.current && JSON.stringify(this.view.current.snapshot) !== JSON.stringify(output.result.snapshot);
      if (changed) this.onBlock();
      this.publish({ output, current: output.result, status: "saved", error: undefined,
        restoreRevision: (this.view.restoreRevision ?? 0) + (changed ? 1 : 0) });
      if (output.writable && output.publication.status === "committed") {
        this.unregister ??= registerAnswerStateWriter(`mini-app:${this.scope}:${crypto.randomUUID()}`, this.sessionId, () => this.flush(), () => this.refresh());
      } else if (!this.pending && !this.flight) { this.unregister?.(); this.unregister = undefined; }
    } catch (error) { this.block(error); throw error; } })();
    this.loading = task;
    void task.then(() => { if (this.loading === task) this.loading = undefined; }, () => { if (this.loading === task) this.loading = undefined; });
    return task;
  }
  /** Only clean views may adopt the current conversation boundary. Freeze the
   * runtime while reading so a user event cannot be overwritten by a late GET.
   * Pending writes and recovery copies keep their original branch identity. */
  refresh(): Promise<void> {
    const work = async () => {
      this.active();
      if (this.pending || this.flight || this.operation || this.flushing || this.resolving || this.view.needsRecovery) return;
      await this.load();
    };
    return this.checkpointGate ? this.checkpointGate(work) : work();
  }
  update(value: MiniAppResult): void {
    try {
      this.active(); const output = this.view.output;
      if (this.resolving || this.loading) throw new MiniAppError("BUSY", "Wait for checkpoint recovery to finish");
      if (!output?.writable || output.publication.status !== "committed" || !this.compiled) throw new MiniAppError("CONFLICT", "This mini app cannot be edited on the current branch");
      const result = validateMiniAppResult(this.compiled, value as unknown as MiniAppVmReply);
      if (JSON.stringify(result.snapshot) === JSON.stringify(this.view.current?.snapshot)) return;
      const previous = this.pending?.draft;
      const draft: MiniAppDraft = { id: previous?.id ?? crypto.randomUUID(), scope: this.scope, sessionId: this.sessionId, toolCallId: this.toolCallId,
        createdAt: previous?.createdAt ?? Date.now(), plan: output.plan, summary: result.frame.summary.slice(0, 4000), sent: false,
        request: { requestId: crypto.randomUUID(), toolCallId: this.toolCallId, publicationId: output.publication.id, planDigest: output.publication.planDigest,
          runtimeVersion: output.publication.runtimeVersion, leafId: output.leafId, expectedRevision: output.stateRevision, checkpoint: clone(result.snapshot) },
        ...(this.flight && !this.flight.confirmed ? { afterRequestId: this.flight.draft.request.requestId } : {}), ...(previous?.source ? { source: previous.source } : {}) };
      this.pending = { draft };
      this.publish({ current: result, status: "saving", error: undefined });
      void this.persistPending().catch(error => this.block(error)); this.schedule();
    } catch (error) { this.block(error); }
  }
  private persistPending(): Promise<void> {
    if (this.localWrite) return this.localWrite;
    const task = (async () => {
      while (this.pending) {
        const pending = this.pending;
        await putMiniAppDraft(pending.draft);
        if (this.pending === pending) break;
      }
    })();
    this.localWrite = task;
    void task.then(() => { if (this.localWrite === task) this.localWrite = undefined; }, () => { if (this.localWrite === task) this.localWrite = undefined; });
    return task;
  }
  private schedule() {
    if (this.ended || this.timer || this.operation || this.flushing || this.resolving) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.sendOne().catch(error => this.block(error)); }, 1000);
  }
  private async receipt(draft: MiniAppDraft): Promise<unknown> {
    const query = new URLSearchParams({ toolCallId: this.toolCallId, requestId: draft.request.requestId });
    const value = await this.request(`?${query}`) as { receipt?: unknown };
    return value.receipt;
  }
  private sendOne(): Promise<void> {
    if (this.operation) return this.operation;
    const task = (async () => {
      this.active(); await this.persistPending(); this.active();
      const retry = !!this.flight;
      if (!this.flight) {
        if (!this.pending) return;
        if (this.pending.draft.afterRequestId) throw new MiniAppError("RECOVERY", "Resolve the earlier unconfirmed save before this checkpoint");
        this.flight = this.pending; this.pending = undefined;
      }
      const flight = this.flight, wasSent = flight.draft.sent;
      flight.draft = { ...flight.draft, sent: true };
      await putMiniAppDraft(flight.draft); this.active();
      this.publish({ status: "saving", error: undefined });
      let raw = retry || wasSent ? await this.receipt(flight.draft) : undefined;
      if (!raw) raw = (await this.request("", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(flight.draft.request) }) as { receipt?: unknown }).receipt;
      const receipt = await validateMiniAppReceipt(raw, flight.draft.request); this.active();
      // Read the authoritative server projection; never label a client-supplied
      // frame as the confirmed result. Another writer may have advanced it.
      const output = await this.readCurrent();
      this.active();
      if (!output.writable || output.publication.status !== "committed" || output.stateRevision !== receipt.stateRevision
        || output.checkpointDigest !== receipt.checkpointDigest) throw new MiniAppError("CONFLICT", "Saved state changed while confirming this checkpoint; local changes have been retained");
      flight.confirmed = receipt;
      this.publish({ output, ...(!this.pending ? { current: output.result } : {}) });
      if (this.pending) {
        const draft = { ...this.pending.draft }; delete draft.afterRequestId;
        this.pending = { draft: { ...draft, request: { ...draft.request, expectedRevision: receipt.stateRevision, leafId: receipt.leafId } } };
        await this.persistPending();
      }
      this.active();
      await confirmMiniAppDraft(flight.draft.id, flight.draft.request.requestId);
      if (flight.draft.source) await confirmMiniAppDraft(flight.draft.source.id, flight.draft.source.requestId);
      this.flight = undefined;
      await this.refreshDrafts();
      this.publish({ status: this.pending ? "saving" : "saved", error: undefined });
    })();
    this.operation = task;
    void task.then(() => { if (this.operation === task) this.operation = undefined; if (this.pending) this.schedule(); }, () => { if (this.operation === task) this.operation = undefined; });
    return task;
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const work = async () => {
      this.active();
      if (this.resolving) throw new MiniAppError("RECOVERY", "Wait for checkpoint recovery to finish");
      if (this.view.needsRecovery) throw new MiniAppError("RECOVERY", "Choose whether to recover the local checkpoints or continue with saved state");
      while (this.flight || this.pending || this.operation) { await this.sendOne(); this.active(); }
    };
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    const task = (async () => {
      try { if (this.checkpointGate) await this.checkpointGate(work); else await work(); }
      catch (error) { this.block(error); throw error; }
    })();
    this.flushing = task;
    void task.then(() => { if (this.flushing === task) this.flushing = undefined; }, () => { if (this.flushing === task) this.flushing = undefined; });
    return task;
  }
  async useSavedState(): Promise<void> {
    if (this.resolving) throw new MiniAppError("BUSY", "Checkpoint recovery is already running");
    this.resolving = true;
    try {
      this.active(); this.onBlock();
      if (this.timer) clearTimeout(this.timer); this.timer = undefined;
      await this.operation?.catch(() => undefined);
      await this.persistPending();
      const output = await this.readCurrent(); this.active();
      // This is an explicit choice, not an implicit discard. Keep every local
      // recovery record, but stop retrying it against the chosen server state.
      this.pending = undefined; this.flight = undefined; this.ignoreRecovery = true;
      this.publish({ output, current: output.result, status: "saved", error: undefined });
      await this.refreshDrafts();
    } catch (error) { this.block(error); throw error; }
    finally { this.resolving = false; }
  }

  /** Explicit recovery clones a draft; another window's record is never edited. */
  async recover(id: string): Promise<void> {
    if (this.resolving) throw new MiniAppError("BUSY", "Checkpoint recovery is already running");
    this.resolving = true;
    try {
      this.active(); this.onBlock();
      if (this.pending || this.flight || this.operation) throw new MiniAppError("RECOVERY", "Resolve this view's pending checkpoint before recovering another draft");
      const source = await getMiniAppDraft(id);
      if (!source || source.scope !== this.scope || source.request.publicationId !== this.identity.operationId
        || source.request.planDigest !== this.identity.planDigest || source.request.runtimeVersion !== this.identity.runtimeVersion
        || await miniAppBrowserDigest(source.plan) !== this.identity.planDigest) throw new MiniAppError("CONFLICT", "This draft belongs to another program version; it has been retained");
      const current = await this.readCurrent(source.request.leafId); this.active();
      let expectedRevision = source.request.expectedRevision;
      if (source.sent) {
        const raw = await this.receipt(source);
        if (raw) {
          await validateMiniAppReceipt(raw, source.request); this.active();
          const confirmed = await this.readCurrent(source.request.leafId); this.active();
          await confirmMiniAppDraft(source.id, source.request.requestId);
          this.publish({ output: confirmed, current: confirmed.result, status: "saved", error: undefined });
          await this.refreshDrafts(); return;
        }
      }
      if (source.afterRequestId) {
        const query = new URLSearchParams({ toolCallId: this.toolCallId, requestId: source.afterRequestId });
        const prior = (await this.request(`?${query}`) as { receipt?: { requestId?: string; publicationId?: string; stateRevision?: number } }).receipt;
        if (prior?.requestId !== source.afterRequestId || prior.publicationId !== this.identity.operationId || !Number.isSafeInteger(prior.stateRevision)) throw new MiniAppError("RECOVERY", "Resolve the earlier unconfirmed save before restoring this draft");
        expectedRevision = prior.stateRevision!;
      }
      if (!current.writable || current.stateRevision !== expectedRevision) throw new MiniAppError("CONFLICT", "Saved state changed after this draft; compare or export it before replacing current values");
      const draft = { ...source }; delete draft.afterRequestId;
      this.pending = { draft: { ...draft, id: crypto.randomUUID(), createdAt: Date.now(), source: { id: source.id, requestId: source.request.requestId },
        request: source.sent ? source.request : { ...source.request, requestId: crypto.randomUUID(), leafId: current.leafId, expectedRevision } } };
      this.publish({ output: current, current: current.result, status: "saving", error: undefined });
      await this.sendOne();
    } catch (error) { this.block(error); throw error; }
    finally { this.resolving = false; }
  }
  async exportDraft(id: string): Promise<string> {
    const draft = await getMiniAppDraft(id);
    if (!draft || draft.scope !== this.scope) throw new MiniAppError("NOT_FOUND", "Local checkpoint not found");
    return JSON.stringify({ kind: "mini-app-checkpoint", version: 1, title: draft.plan.title, savedAt: draft.createdAt,
      planDigest: draft.request.planDigest, runtimeVersion: draft.request.runtimeVersion, checkpoint: draft.request.checkpoint, summary: draft.summary }, null, 2);
  }
  exportCurrent(): string {
    const { output, current } = this.view;
    if (!output || !current) throw new MiniAppError("NOT_FOUND", "No current checkpoint is available");
    return JSON.stringify({ kind: "mini-app-checkpoint", version: 1, title: output.plan.title, exportedAt: Date.now(),
      confirmed: !this.pending && !this.flight && output.checkpointDigest !== undefined,
      planDigest: output.publication.planDigest, runtimeVersion: output.publication.runtimeVersion,
      checkpoint: current.snapshot, summary: current.frame.summary }, null, 2);
  }
  isDisposable(): boolean { return !this.loading && !this.pending && !this.flight && !this.operation && !this.flushing && !this.localWrite && !this.resolving && !this.view.draftsLoading && !this.view.needsRecovery; }
  dispose(): void {
    this.ended = true; this.cancellation.abort(); this.unregister?.(); this.unregister = undefined;
    this.draftListRevision++; this.draftPageTask = undefined;
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    this.listeners.clear(); this.checkpointGate = undefined;
    // Local writes already queued are allowed to finish; no server retry survives.
    void this.persistPending().catch(() => {});
  }
}
