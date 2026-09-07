import { reduceAgentTerminal, type AgentTerminalCommand } from "./agent-terminal";

declare global {
  var __pioraAgentTerminals: Map<string, AgentTerminalCommand[]> | undefined;
}
const registry = () => globalThis.__pioraAgentTerminals ??= new Map();
export function recordAgentTerminalEvent(sessionId: string, event: unknown): void {
  const current = registry().get(sessionId) ?? [];
  const next = reduceAgentTerminal(current, event);
  if (next === current || next.length === 0) return;
  registry().delete(sessionId);
  registry().set(sessionId, next);
  if (registry().size > 24) registry().delete(registry().keys().next().value!);
}
export function getAgentTerminalCommands(sessionId: string): AgentTerminalCommand[] {
  return registry().get(sessionId) ?? [];
}
