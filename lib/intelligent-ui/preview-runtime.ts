import { randomUUID } from "node:crypto";
import type { AnswerOutputPreview, AnswerOutputPreviewSnapshot } from "../answer-output-preview";
import { parseUiPlanPrefix } from "./preview-parser";
import { compileUiPreview } from "./preview-plan";
import { compileUiRichPlan } from "./rich-plan";
import { formatRichSnapshot } from "./rich-protocol";

type Event = { type: string; [key: string]: unknown };
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
const boundedId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
interface PendingCall { id: string; index: number; raw: string; disabled: boolean; ended: boolean; compilations: number; timer?: ReturnType<typeof setTimeout>; fingerprint?: string }

/** Request-local observations only: no manager, journal, tools, permissions or IO. */
export class UiPreviewRuntime {
  private active = false;
  private disposed = false;
  private streamId = "";
  private seq = 0;
  private messageContent?: unknown[];
  private messageStamp?: string;
  private readonly calls = new Map<number, PendingCall>();
  private readonly visible = new Map<string, AnswerOutputPreview>();
  constructor(private readonly options: {
    sessionId: string; runId: string; isActive(): boolean;
    emit(preview: AnswerOutputPreview): void; intervalMs?: number;
  }) {}

  private available(): boolean { return this.active && !this.disposed && this.options.isActive(); }

  beginRequest(): void {
    this.resetRequest();
    if (!this.disposed && this.options.isActive()) this.active = true;
  }

  resetRequest(): void {
    this.active = false;
    this.clearCalls();
    this.messageContent = undefined; this.messageStamp = undefined;
  }

  cancel(): void { this.disposed = true; this.resetRequest(); }

  snapshot(): AnswerOutputPreviewSnapshot {
    if (!this.options.isActive()) this.resetRequest();
    return { sessionId: this.options.sessionId, runId: this.disposed ? null : this.options.runId,
      seq: this.seq, previews: structuredClone([...this.visible.values()]) };
  }

  private publish(call: PendingCall, phase: AnswerOutputPreview["phase"], content?: { payload: unknown; snapshot: string }): void {
    if (phase !== "cleared" && !this.available()) return;
    if (phase === "cleared" && !this.visible.has(call.id)) return;
    const preview: AnswerOutputPreview = { version: 1, kind: "intelligent-ui", sessionId: this.options.sessionId,
      runId: this.options.runId, streamId: this.streamId, toolCallId: call.id, seq: ++this.seq, phase, ...content };
    if (phase === "cleared") this.visible.delete(call.id);
    else this.visible.set(call.id, preview);
    // Consumers must never retain the runtime's mutable payload or metadata.
    this.options.emit(structuredClone(preview));
  }

  private clearCalls(): void {
    for (const call of this.calls.values()) {
      if (call.timer) clearTimeout(call.timer);
      this.publish(call, "cleared");
    }
    this.calls.clear(); this.visible.clear();
  }

  private stamp(message: Data): string | undefined {
    return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
      ? JSON.stringify([message.timestamp, message.provider, message.model, message.api]) : undefined;
  }

  private matches(message: Data): boolean {
    return this.messageContent !== undefined && (message.content === this.messageContent
      || this.messageStamp !== undefined && this.stamp(message) === this.messageStamp);
  }

  private startCall(index: number, block: unknown): PendingCall | undefined {
    if (!object(block) || block.type !== "toolCall" || block.name !== "piora_render_ui_plan" || !boundedId(block.id)) return;
    const old = this.calls.get(index);
    if (old) return old.id === block.id ? old : undefined;
    if (this.calls.size >= 4 || [...this.calls.values()].some(call => call.id === block.id)) return;
    const call: PendingCall = { id: block.id, index, raw: "", disabled: false, ended: false, compilations: 0 };
    this.calls.set(index, call); this.publish(call, "preparing");
    return call;
  }

  private partial(call: PendingCall): void {
    call.timer = undefined;
    if (!this.available() || call.ended || call.disabled || this.calls.get(call.index) !== call) return;
    if (++call.compilations > 128) { call.disabled = true; this.publish(call, "cleared"); return; }
    // raw is copied synchronously from delta events; SDK's shared partial object
    // is never retained as a source for deferred parsing or compilation.
    const result = compileUiPreview(parseUiPlanPrefix(call.raw));
    if (result.status === "invalid") { call.disabled = true; this.publish(call, "cleared"); return; }
    if (result.status !== "ready") return;
    const fingerprint = JSON.stringify(result.surface);
    if (fingerprint === call.fingerprint) return;
    call.fingerprint = fingerprint;
    this.publish(call, "partial", { payload: result.surface, snapshot: result.snapshot });
  }

  private finalize(call: PendingCall, input: unknown): void {
    if (call.timer) clearTimeout(call.timer);
    call.timer = undefined; call.ended = true;
    if (!this.available()) return;
    try {
      // The authoritative final object may replace the prefix. Always validate
      // it independently; a good preview is never proof that final input is good.
      const { surface } = compileUiRichPlan(input, { revision: 1 });
      // A revoked stream stays retired on reconnect. A valid final tool result
      // can still create its ordinary candidate through the admission path.
      if (call.disabled) return;
      this.publish(call, "complete", { payload: surface, snapshot: formatRichSnapshot(surface) });
    } catch { this.publish(call, "cleared"); }
  }

  observe(event: Event): void {
    if (!this.available()) return;
    const message = object(event.message) ? event.message : undefined;
    if (event.type === "message_start" && message?.role === "assistant" && Array.isArray(message.content)) {
      this.clearCalls(); this.streamId = randomUUID();
      this.messageContent = message.content; this.messageStamp = this.stamp(message);
      return;
    }
    if (event.type === "message_update" && message?.role === "assistant" && this.matches(message)) {
      const update = event.assistantMessageEvent;
      if (!object(update) || !Number.isInteger(update.contentIndex) || Number(update.contentIndex) < 0 || Number(update.contentIndex) > 255) return;
      const index = Number(update.contentIndex), block = (message.content as unknown[])[index];
      if (update.type === "toolcall_start") { this.startCall(index, block); return; }
      const call = this.calls.get(index);
      if (!call || !object(block) || block.id !== call.id || block.name !== "piora_render_ui_plan") return;
      if (update.type === "toolcall_delta" && typeof update.delta === "string" && !call.ended && !call.disabled) {
        if (call.raw.length + update.delta.length > 64_000) { call.disabled = true; this.publish(call, "cleared"); return; }
        call.raw += update.delta;
        call.timer ??= setTimeout(() => this.partial(call), this.options.intervalMs ?? 80);
      } else if (update.type === "toolcall_end" && object(update.toolCall) && update.toolCall.id === call.id) {
        this.finalize(call, update.toolCall.arguments);
      }
      return;
    }
    if (event.type === "message_end" && message?.role === "assistant" && this.matches(message)) {
      if (["aborted", "error", "length"].includes(String(message.stopReason))) { this.clearCalls(); return; }
      const blocks = Array.isArray(message.content) ? message.content : [];
      const finalIds = new Set<string>();
      for (let index = 0; index < Math.min(blocks.length, 256); index++) {
        const block = blocks[index], call = this.startCall(index, block);
        if (call && object(block)) { finalIds.add(call.id); this.finalize(call, block.arguments); }
      }
      for (const call of this.calls.values()) if (!finalIds.has(call.id)) {
        call.ended = true; if (call.timer) clearTimeout(call.timer); this.publish(call, "cleared");
      }
      return;
    }
    if (["tool_execution_update", "tool_execution_end"].includes(event.type) && boundedId(event.toolCallId)) {
      for (const call of this.calls.values()) if (call.id === event.toolCallId) {
        call.ended = true; if (call.timer) clearTimeout(call.timer); this.publish(call, "cleared");
      }
    } else if (["agent_end", "auto_retry_start", "model_fallback"].includes(event.type)) this.resetRequest();
  }
}
