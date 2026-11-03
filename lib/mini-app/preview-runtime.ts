import { randomUUID } from "node:crypto";
import type { AnswerOutputPreview } from "../answer-output-preview";
import { compileMiniAppPreview, parseMiniAppPrefix } from "./preview";
import { MINI_APP_LIMITS } from "./limits";
import { boundedJson } from "./json";

type Data = Record<string, unknown>;
const object = (value: unknown): value is Data => !!value && typeof value === "object" && !Array.isArray(value);
interface Call { id: string; index: number; raw: string; retired: boolean; ended: boolean; compilations: number; timer?: ReturnType<typeof setTimeout>; fingerprint?: string }

/** Streaming layout only. This class never starts a VM or owns publication state. */
export class MiniAppPreviewRuntime {
  private active = false;
  private ended = false;
  private streamId = "";
  private sequence = 0;
  private messageContent?: unknown[];
  private messageStamp?: string;
  private readonly calls = new Map<number, Call>();
  private readonly visible = new Set<string>();
  constructor(private readonly options: { sessionId: string; runId: string; isActive(): boolean; emit(value: AnswerOutputPreview): void; intervalMs?: number }) {}
  beginRequest() { this.reset(); this.active = !this.ended && this.options.isActive(); }
  reset() { this.active = false; this.clear(); this.messageContent = undefined; this.messageStamp = undefined; }
  cancel() { this.ended = true; this.reset(); }
  private available() { return this.active && !this.ended && this.options.isActive(); }
  private publish(call: Call, phase: AnswerOutputPreview["phase"], content?: { payload: unknown; snapshot: string }) {
    if (phase === "cleared" ? !this.visible.has(call.id) : !this.available()) return;
    if (phase === "cleared") this.visible.delete(call.id); else this.visible.add(call.id);
    this.options.emit(structuredClone({ version: 1, kind: "mini-app", sessionId: this.options.sessionId, runId: this.options.runId,
      streamId: this.streamId, toolCallId: call.id, seq: ++this.sequence, phase, ...content }));
  }
  private clear() {
    for (const call of this.calls.values()) { if (call.timer) clearTimeout(call.timer); this.publish(call, "cleared"); }
    this.calls.clear(); this.visible.clear();
  }
  private stamp(message: Data) {
    return typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? JSON.stringify([message.timestamp, message.provider, message.model, message.api]) : undefined;
  }
  private matches(message: Data) { return this.messageContent !== undefined && (message.content === this.messageContent || this.messageStamp !== undefined && this.messageStamp === this.stamp(message)); }
  private call(index: number, block: unknown): Call | undefined {
    if (!object(block) || block.type !== "toolCall" || block.name !== "piora_render_mini_app" || typeof block.id !== "string" || !block.id || block.id.length > 256) return;
    const previous = this.calls.get(index); if (previous) return previous.id === block.id ? previous : undefined;
    if (this.calls.size >= 4 || [...this.calls.values()].some(call => call.id === block.id)) return;
    const call: Call = { id: block.id, index, raw: "", retired: false, ended: false, compilations: 0 };
    this.calls.set(index, call); this.publish(call, "preparing"); return call;
  }
  private partial(call: Call, complete = false) {
    call.timer = undefined;
    if (!this.available() || call.retired || this.calls.get(call.index) !== call || !complete && call.ended) return;
    if (++call.compilations > 128) { call.retired = true; this.publish(call, "cleared"); return; }
    const prefix = parseMiniAppPrefix(call.raw), preview = compileMiniAppPreview(prefix);
    if (preview.status === "invalid" || complete && prefix.status !== "complete") { call.retired = true; this.publish(call, "cleared"); return; }
    if (preview.status !== "ready") return;
    const fingerprint = JSON.stringify(preview.payload);
    if (fingerprint === call.fingerprint && !complete) return; call.fingerprint = fingerprint;
    this.publish(call, complete ? "complete" : "partial", { payload: preview.payload, snapshot: preview.snapshot });
  }
  private finalize(call: Call, value: unknown) {
    if (call.timer) clearTimeout(call.timer); call.timer = undefined; call.ended = true;
    if (call.retired || !this.available()) return;
    try {
      const raw = boundedJson(value, MINI_APP_LIMITS.planBytes);
      call.raw = raw; this.partial(call, true);
    } catch { call.retired = true; this.publish(call, "cleared"); }
  }
  observe(event: Data & { type: string }) {
    if (!this.available()) return;
    const message = object(event.message) ? event.message : undefined;
    if (event.type === "message_start" && message?.role === "assistant" && Array.isArray(message.content)) {
      this.clear(); this.streamId = randomUUID(); this.messageContent = message.content; this.messageStamp = this.stamp(message); return;
    }
    if (event.type === "message_update" && message?.role === "assistant" && this.matches(message)) {
      const update = event.assistantMessageEvent;
      if (!object(update) || !Number.isInteger(update.contentIndex) || Number(update.contentIndex) < 0 || Number(update.contentIndex) > 255) return;
      const index = Number(update.contentIndex), block = (message.content as unknown[])[index];
      if (update.type === "toolcall_start") { this.call(index, block); return; }
      const call = this.calls.get(index);
      if (!call || !object(block) || block.id !== call.id || block.name !== "piora_render_mini_app") return;
      if (update.type === "toolcall_delta" && typeof update.delta === "string" && !call.ended && !call.retired) {
        if (call.raw.length + update.delta.length > MINI_APP_LIMITS.planBytes) { call.retired = true; this.publish(call, "cleared"); return; }
        call.raw += update.delta; call.timer ??= setTimeout(() => this.partial(call), this.options.intervalMs ?? 100);
      } else if (update.type === "toolcall_end" && object(update.toolCall) && update.toolCall.id === call.id) this.finalize(call, update.toolCall.arguments);
    } else if (event.type === "message_end" && message?.role === "assistant" && this.matches(message)) {
      if (["aborted", "error", "length"].includes(String(message.stopReason))) { this.clear(); return; }
      const blocks = Array.isArray(message.content) ? message.content : [], final = new Set<string>();
      for (let i = 0; i < Math.min(blocks.length, 256); i++) {
        const block = blocks[i], call = this.call(i, block);
        if (call && object(block)) { final.add(call.id); this.finalize(call, block.arguments); }
      }
      for (const call of this.calls.values()) if (!final.has(call.id)) { call.retired = true; if (call.timer) clearTimeout(call.timer); this.publish(call, "cleared"); }
    } else if (["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type)) {
      for (const call of this.calls.values()) if (call.id === event.toolCallId) { call.ended = true; if (call.timer) clearTimeout(call.timer); this.publish(call, "cleared"); }
    } else if (["agent_end", "auto_retry_start", "model_fallback"].includes(event.type)) this.reset();
  }
}
