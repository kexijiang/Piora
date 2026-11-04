import { isCommandToolName } from "./command-execution";
export interface NestedCall {
  id: string;
  name: string;
  status: "running" | "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
  argumentsBytes?: number;
  /** Bounded live preview, not part of SDK saved call summaries. */
  command?: string;
  output?: string;
  outputTruncated?: boolean;
}
export interface NestedCallsSnapshot { calls: NestedCall[]; complete: boolean }

/** Display-only, bounded live summaries. Subscribers belong to one parent card,
 * so tool progress never rewrites chat messages or re-renders the whole list. */
export class NestedToolCallsStore {
  private roots = new Map<string, string>();
  private started = new Map<string, number>();
  private snapshots = new Map<string, NestedCallsSnapshot>();
  private listeners = new Map<string, Set<() => void>>();
  private changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finished = new Set<string>();
  private runId: number | undefined;

  subscribe(id: string, listener: () => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  getSnapshot(id: string): NestedCallsSnapshot | undefined { return this.snapshots.get(id); }
  beginRun(id: number): void { if (this.runId !== id) { this.reset(); this.runId = id; } }
  record(event: { type: string; toolCallId?: unknown; parentToolCallId?: unknown; toolName?: unknown; isError?: unknown; result?: unknown; partialResult?: unknown; args?: unknown }, now = Date.now()): void {
    if (typeof event.toolCallId !== "string" || typeof event.parentToolCallId !== "string") return;
    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end" && event.type !== "tool_execution_update") return;
    const id = event.toolCallId, root = this.roots.get(event.parentToolCallId) ?? event.parentToolCallId;
    if (this.finished.has(root)) return;
    const previous = this.snapshots.get(root) ?? { calls: [], complete: true };
    const index = previous.calls.findIndex(call => call.id === id);
    if (index < 0 && previous.calls.length >= 256) {
      if (previous.complete) { this.snapshots.set(root, { ...previous, complete: false }); this.notify(root); }
      return;
    }
    this.roots.set(id, root);
    const old = previous.calls[index];
    if (event.type === "tool_execution_update" && (!old || old.status !== "running" || !isCommandToolName(old.name))) return;

    if (event.type === "tool_execution_end" && old && old.status !== "running") return;
    if (event.type === "tool_execution_start" && old) return; // duplicate/reordered start
    if (event.type === "tool_execution_start") this.started.set(id, now);
    const result = (event.type === "tool_execution_update" ? event.partialResult : event.result) as { content?: Array<{ type?: string; text?: string }> } | undefined;
    const error = event.isError === true && Array.isArray(result?.content)
      ? result.content.filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text).join("\n").slice(0, 500) : undefined;
    const shell = isCommandToolName(old?.name ?? event.toolName);
    const text = shell && Array.isArray(result?.content)
      ? result.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : undefined;
    const args = event.args as { command?: unknown } | undefined;
    const command = old?.command ?? (shell && typeof args?.command === "string" ? args.command.slice(0, 8192) : undefined);
    const call: NestedCall = {
      ...(command !== undefined ? { command } : {}),
      ...(text !== undefined ? { output: text.slice(-64_000), outputTruncated: text.length > 64_000 } : old?.output !== undefined ? { output: old.output, outputTruncated: old.outputTruncated } : {}),

      id, name: typeof event.toolName === "string" ? event.toolName : old?.name ?? id,
      status: event.type !== "tool_execution_end" ? "running" : event.isError === true ? "error" : "ok",
      ...(this.started.has(id) && event.type === "tool_execution_end" ? { durationMs: Math.max(0, now - this.started.get(id)!) } : {}),
      ...(error ? { error } : {}),
    };
    const calls = [...previous.calls];
    if (index < 0) calls.push(call); else calls[index] = call;
    this.snapshots.set(root, { calls, complete: previous.complete && (event.type !== "tool_execution_end" || !!old) });
    if (event.type === "tool_execution_end") this.started.delete(id);
    this.notify(root);
  }
  finish(id?: string): void {
    if (id !== undefined) this.finished.add(id);
    for (const [root, snapshot] of this.snapshots) {
      if (id !== undefined && id !== root) continue;
      this.finished.add(root);
      if (!snapshot.calls.some(call => call.status === "running")) continue;
      this.snapshots.set(root, { complete: false, calls: snapshot.calls.map(call => call.status === "running" ? { ...call, status: "unfinished" } : call) });
      this.notify(root);
    }
  }
  reset(): void {
    for (const id of this.snapshots.keys()) this.changed.add(id);
    this.snapshots.clear(); this.roots.clear(); this.started.clear(); this.finished.clear(); this.runId = undefined;
    this.flush();
  }
  private notify(id: string): void {
    this.changed.add(id);
    this.timer ??= setTimeout(() => this.flush(), 16);
  }
  flush(): void {
    clearTimeout(this.timer); this.timer = undefined;
    const changed = [...this.changed]; this.changed.clear();
    for (const id of changed) for (const listener of this.listeners.get(id) ?? []) listener();
  }
}
