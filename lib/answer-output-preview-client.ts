import { readAnswerOutputPreview, readAnswerOutputPreviewSnapshot, type AnswerOutputPreview } from "./answer-output-preview";

const empty: ReadonlyMap<string, AnswerOutputPreview> = new Map();
const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;

/** Ephemeral observations only. No transcript, parameter store or persistence API. */
export class AnswerOutputPreviewStore {
  private sessionId: string | null = null;
  private runId: string | null = null;
  private connection = 0;
  private authorized = false;
  private seq = 0;
  private retiredRuns = new Set<string>();
  private retiredStreams = new Set<string>();
  private completedCalls = new Set<string>();
  private view = empty;
  private listeners = new Set<() => void>();

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(view: ReadonlyMap<string, AnswerOutputPreview>) {
    if (view === this.view) return;
    this.view = view;
    for (const listener of this.listeners) listener();
  }
  /** Token is local to one EventSource; an old connection cannot authorize runs. */
  connect(sessionId: string): number {
    if (this.sessionId !== sessionId) {
      this.sessionId = sessionId; this.runId = null; this.seq = 0;
      this.retiredRuns.clear(); this.retiredStreams.clear(); this.completedCalls.clear();
    }
    this.authorized = false;
    this.publish(empty);
    return ++this.connection;
  }
  disconnect(): void { this.connection++; this.authorized = false; this.publish(empty); }
  /** Stop/navigation/settlement revokes the run, including queued snapshots. */
  stop(): void {
    if (this.runId) this.retiredRuns.add(this.runId);
    this.disconnect();
  }
  private selectRun(runId: string | null): void {
    if (this.runId === runId) return;
    if (this.runId) this.retiredRuns.add(this.runId);
    this.runId = runId; this.seq = 0;
    this.retiredStreams.clear(); this.completedCalls.clear(); this.publish(empty);
  }
  started(token: number, sessionId: unknown, runId: unknown): void {
    if (token !== this.connection || sessionId !== this.sessionId || !validId(runId) || this.retiredRuns.has(runId)) return;
    this.selectRun(runId); this.authorized = true;
  }
  restore(token: number, value: unknown): void {
    const snapshot = readAnswerOutputPreviewSnapshot(value);
    if (token !== this.connection || !snapshot || snapshot.sessionId !== this.sessionId
      || snapshot.runId !== null && this.retiredRuns.has(snapshot.runId)) return;
    if (snapshot.runId === this.runId && snapshot.seq < this.seq) return;
    this.selectRun(snapshot.runId);
    this.seq = snapshot.seq; this.authorized = snapshot.runId !== null;
    const next = new Map<string, AnswerOutputPreview>();
    for (const preview of snapshot.previews) {
      if (this.retiredStreams.has(`${preview.streamId}:${preview.toolCallId}`) || this.completedCalls.has(preview.toolCallId)) continue;
      const existing = next.get(preview.toolCallId);
      if (!existing || preview.seq > existing.seq) next.set(preview.toolCallId, preview);
    }
    this.publish(next.size ? next : empty);
  }
  receive(token: number, value: unknown): void {
    const preview = readAnswerOutputPreview(value);
    if (token !== this.connection || !this.authorized || !preview || preview.sessionId !== this.sessionId
      || preview.runId !== this.runId || preview.seq <= this.seq) return;
    this.seq = preview.seq;
    if (this.retiredStreams.has(`${preview.streamId}:${preview.toolCallId}`) || this.completedCalls.has(preview.toolCallId)) return;
    const next = new Map(this.view), previous = next.get(preview.toolCallId);
    if (preview.phase === "cleared") {
      this.retiredStreams.add(`${preview.streamId}:${preview.toolCallId}`);
      if (previous?.streamId === preview.streamId) next.delete(preview.toolCallId);
    } else {
      if (!previous && next.size >= 4) return;
      if (previous && previous.streamId !== preview.streamId) this.retiredStreams.add(`${previous.streamId}:${previous.toolCallId}`);
      next.set(preview.toolCallId, preview);
    }
    this.publish(next.size ? next : empty);
  }
  handoff(token: number, toolCallId: unknown): void {
    if (token !== this.connection || !validId(toolCallId)) return;
    this.completedCalls.add(toolCallId);
    const next = new Map(this.view);
    next.delete(toolCallId); this.publish(next.size ? next : empty);
  }
}
