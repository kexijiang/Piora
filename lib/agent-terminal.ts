/** Display-only command records. Never run an observed Agent command again. */
export interface AgentTerminalCommand {
  id: string;
  command: string;
  output: string;
  status: "running" | "completed" | "failed" | "interrupted";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function outputText(value: unknown): string {
  const content = record(value).content;
  if (typeof content === "string") return content.slice(-100_000);
  return Array.isArray(content) ? content.filter((block) => record(block).type === "text")
    .map((block) => typeof record(block).text === "string" ? record(block).text : "").join("\n").slice(-100_000) : "";
}

export function reduceAgentTerminal(commands: AgentTerminalCommand[], value: unknown): AgentTerminalCommand[] {
  const event = record(value);
  if (event.type === "agent_end" || event.type === "prompt_done") {
    return commands.map((item) => item.status === "running" ? { ...item, status: "interrupted" } : item);
  }
  const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
  if (!id) return commands;
  if (event.type === "tool_execution_start" && event.toolName === "bash") {
    const command = record(event.args).command;
    if (typeof command !== "string") return commands;
    return [...commands.filter((item) => item.id !== id), { id, command: command.slice(0, 64_000), output: "", status: "running" as const }].slice(-60);
  }
  if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return commands;
  return commands.map((item) => item.id !== id ? item : {
    ...item,
    // Pi partial results are cumulative snapshots, not output deltas.
    output: outputText(event.type === "tool_execution_update" ? event.partialResult : event.result),
    status: event.type === "tool_execution_update" ? "running" : event.isError === true ? "failed" : "completed",
  });
}

export function restoreAgentTerminal(messages: unknown): AgentTerminalCommand[] {
  let commands: AgentTerminalCommand[] = [];
  if (!Array.isArray(messages)) return commands;
  for (const raw of messages) {
    const message = record(raw);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const rawBlock of message.content) {
        const block = record(rawBlock);
        if (block.type !== "toolCall") continue;
        commands = reduceAgentTerminal(commands, { type: "tool_execution_start", toolCallId: block.toolCallId ?? block.id, toolName: block.toolName ?? block.name, args: block.input ?? block.arguments });
      }
    } else if (message.role === "toolResult") {
      commands = reduceAgentTerminal(commands, { type: "tool_execution_end", toolCallId: message.toolCallId, result: message, isError: message.isError });
    } else if (message.role === "bashExecution" && typeof message.command === "string") {
      commands.push({ id: `manual:${commands.length}:${message.timestamp}`, command: message.command, output: typeof message.output === "string" ? message.output.slice(-100_000) : "", status: message.cancelled ? "interrupted" : message.exitCode ? "failed" : "completed" });
    }
  }
  return commands.slice(-60).map((item) => item.status === "running" ? { ...item, status: "interrupted" } : item);
}
