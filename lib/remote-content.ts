export class RemoteContentProjection {
  private completed = "";
  private current = "";
  private tools: string[] = [];
  private sequence = 0;
  update(event: Record<string,unknown>): void {
    if (event.type === "agent_start") { this.completed = ""; this.current = ""; this.tools = []; this.sequence++; }
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") { this.tools = [...this.tools.slice(-19), event.toolName.slice(0,100)]; this.sequence++; }
    if (!["message_start", "message_update", "message_end"].includes(String(event.type))) return;
    const message = event.message as { role?: string; content?: unknown } | undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    this.current = message.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n").slice(-100_000);
    if (event.type === "message_end") { this.completed = (this.completed + (this.completed && this.current ? "\n\n" : "") + this.current).slice(-100_000); this.current = ""; }
    this.sequence++;
  }
  snapshot(): {type:string;text:string;tools:string[];sequence:number} { return {type:"content.snapshot",text:(this.completed+(this.completed&&this.current?"\n\n":"")+this.current).slice(-100_000),tools:[...this.tools],sequence:this.sequence}; }
}
