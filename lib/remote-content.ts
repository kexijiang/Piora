import { randomUUID } from "node:crypto";
interface RemoteToolCall { toolCallId: string; toolName: string; status: "running" | "succeeded" | "failed"; output: string; truncated: boolean }
function toolOutput(result: unknown): { output: string; truncated: boolean } {
  const content = result && typeof result === "object" ? (result as { content?: unknown }).content : undefined;
  let output = "";
  if (Array.isArray(content)) for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string" || !block.text) continue;
    const separator = output ? "\n" : "";
    const remaining = 2000 - output.length - separator.length;
    output += separator + block.text.slice(0, Math.max(0, remaining));
    if (block.text.length > remaining) return { output: output.slice(0, 2000), truncated: true };
  }
  return { output, truncated: false };
}
export class RemoteContentProjection {
  private completed = "";
  private current = "";
  private tools: string[] = [];
  private toolCalls: RemoteToolCall[] = [];
  private omittedToolCalls = 0;
  private sequence = 0;
  private readonly streamId = randomUUID();
  private runId: string | null = null;
  resetForRun(runId: string | null): void {
    if (runId === this.runId) return;
    this.runId = runId; this.completed = ""; this.current = ""; this.tools = []; this.toolCalls = []; this.omittedToolCalls = 0; this.sequence++;
  }
  update(event: Record<string,unknown>): void {
    if (!this.runId) return;
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") { this.tools = [...this.tools.slice(-19), event.toolName.slice(0,100)]; this.sequence++; }
    if (typeof event.toolCallId === "string" && event.toolCallId.length > 0 && event.toolCallId.length <= 200) {
      const call = this.toolCalls.find(candidate => candidate.toolCallId === event.toolCallId);
      if (event.type === "tool_execution_start" && !call && typeof event.toolName === "string") {
        if (this.toolCalls.length >= 20) { this.toolCalls.shift(); this.omittedToolCalls++; }
        this.toolCalls.push({ toolCallId: event.toolCallId, toolName: event.toolName.slice(0, 100), status: "running", output: "", truncated: false });
      } else if (call?.status === "running" && (event.type === "tool_execution_update" || event.type === "tool_execution_end")) {
        Object.assign(call, toolOutput(event.type === "tool_execution_update" ? event.partialResult : event.result));
        if (event.type === "tool_execution_end") call.status = event.isError === true ? "failed" : "succeeded";
        this.sequence++;
      }
    }
    if (!["message_start", "message_update", "message_end"].includes(String(event.type))) return;
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    this.current = message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n").slice(-100_000);
    if (event.type === "message_end") { this.completed = (this.completed + (this.completed && this.current ? "\n\n" : "") + this.current).slice(-100_000); this.current = ""; }
    this.sequence++;
  }
  snapshot(): {type:string;text:string;tools:string[];toolCalls:RemoteToolCall[];omittedToolCalls:number;sequence:number;streamId:string} { return {type:"content.snapshot",text:(this.completed+(this.completed&&this.current?"\n\n":"")+this.current).slice(-100_000),tools:[...this.tools],toolCalls:this.toolCalls.map(call => ({...call})),omittedToolCalls:this.omittedToolCalls,sequence:this.sequence,streamId:this.streamId}; }
}
