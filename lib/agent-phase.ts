export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "stopping" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

/** Tool results and assistant messages can interleave with parallel tools. */
export function reduceAgentPhase(phase: AgentPhase, event: {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
}): AgentPhase {
  if (phase?.kind === "stopping") return phase;
  switch (event.type) {
    case "agent_start":
      return { kind: "waiting_model" };
    case "agent_end":
      return null;
    case "message_start":
    case "message_update":
      return phase?.kind === "running_tools" ? phase : null;
    case "message_end":
      return phase?.kind === "running_tools" ? phase : { kind: "waiting_model" };
    case "tool_execution_start": {
      if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return phase;
      const tools = phase?.kind === "running_tools" ? phase.tools : [];
      if (tools.some((tool) => tool.id === event.toolCallId)) return phase;
      return { kind: "running_tools", tools: [...tools, { id: event.toolCallId, name: event.toolName }] };
    }
    case "tool_execution_end": {
      if (phase?.kind !== "running_tools") return phase;
      const tools = phase.tools.filter((tool) => tool.id !== event.toolCallId);
      return tools.length ? { kind: "running_tools", tools } : { kind: "waiting_model" };
    }
    default:
      return phase;
  }
}
