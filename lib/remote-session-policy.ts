export type RemoteSessionPolicy = "agent" | "notes";
export function readRemoteSessionPolicy(entries: readonly unknown[]): RemoteSessionPolicy {
  let policy: RemoteSessionPolicy = "agent";
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: string; customType?: string; data?: { policy?: unknown } };
    if (record.type !== "custom" || record.customType !== "piora-remote-policy") continue;
    if (record.data?.policy === "notes") policy = "notes";
    else if (record.data?.policy !== "agent") throw new Error("Invalid persisted remote session policy");
  }
  return policy;
}
const NOTES_COMMANDS = new Set(["prompt", "steer", "follow_up", "abort", "get_state", "get_messages", "get_session_stats", "get_tools", "get_commands", "get_available_models", "set_model", "set_thinking_level", "set_session_name", "compact"]);
export function assertRemotePolicyCommand(policy: RemoteSessionPolicy, command: Record<string,unknown>): void {
  if (policy !== "notes") return;
  if (!NOTES_COMMANDS.has(String(command.type))) throw new Error("Command is disabled for notes-only sessions");
  if (["prompt", "steer", "follow_up"].includes(String(command.type)) && (String(command.message ?? "").trimStart().startsWith("/") || command.teamExecution || command.materials)) throw new Error("Notes-only sessions accept plain messages, not commands or runtime materials");
}
export function remotePolicyResources(policy: RemoteSessionPolicy) {
  if (policy !== "notes") return undefined;
  return { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [] as string[], systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [] as string[], agentsFilesOverride: () => ({ agentsFiles: [] }) };
}
