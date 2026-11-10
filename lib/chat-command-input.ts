import type { ChatCommandCatalog, ChatCommandDescriptor, ChatCommandOperation, ChatInputOptions, ParsedChatInput } from "./chat-command-types";

const BUILTINS: Array<[string, ChatCommandDescriptor["argumentMode"], ChatCommandDescriptor["busyBehavior"]]> = [
  ["reload", "none", "wait"],
  ["compact", "optional", "wait"],
  ["name", "required", "wait"],
  ["session", "none", "read"],
  ["copy", "none", "read"],
];

export const CHAT_BUILTIN_COMMANDS: ChatCommandDescriptor[] = BUILTINS.map(([name, argumentMode, busyBehavior]) => ({
  key: `builtin:${name}`,
  name,
  source: "builtin",
  argumentMode,
  busyBehavior,
  supported: true,
  ...(name === "name" ? { argumentHint: "<name>" } : name === "compact" ? { argumentHint: "[instructions]" } : {}),
}));

export const PI_INTERACTIVE_COMMANDS = ["settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new", "resume", "quit"];

export function createChatCommandCatalog(commands: Array<{ name: string; description?: string; source: "extension" | "prompt" | "skill"; sourceInfo?: ChatCommandDescriptor["sourceInfo"]; argumentHint?: string; usesTemplateArguments?: boolean }>): ChatCommandCatalog {
  const resolved = new Map(CHAT_BUILTIN_COMMANDS.map(command => [command.name, { ...command }]));
  const diagnostics: string[] = [];
  const ordered = [...commands.filter(command => command.source === "extension"), ...commands.filter(command => command.source !== "extension")];
  for (const command of ordered) {
    if (resolved.has(command.name)) {
      diagnostics.push(`/${command.name}: ${command.source} is shadowed by ${resolved.get(command.name)!.source}`);
      continue;
    }
    resolved.set(command.name, {
      ...command,
      key: `${command.source}:${command.sourceInfo?.path ?? "runtime"}:${command.name}`,
      argumentMode: command.source === "extension" ? "opaque" : "optional",
      busyBehavior: command.source === "extension" ? "immediate" : "wait",
      supported: true,
    });
  }
  for (const name of PI_INTERACTIVE_COMMANDS) {
    if (resolved.has(name)) continue;
    resolved.set(name, { key: `interactive:${name}`, name, source: "builtin", argumentMode: "opaque", busyBehavior: "wait", supported: false, unavailableReason: "PI_INTERACTIVE_ONLY" });
  }
  const catalog = [...resolved.values()];
  const signature = JSON.stringify(catalog);
  let hash = 2166136261;
  for (const character of signature) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return { revision: `commands-v1-${(hash >>> 0).toString(16)}`, commands: catalog, diagnostics };
}

export function parseChatInput(text: string, catalog: ChatCommandCatalog, options: ChatInputOptions & { hasAttachments?: boolean } = {}): ParsedChatInput {
  if (options.inputMode === "text" || !text.trimStart().startsWith("/")) return { kind: "message", text };
  const match = text.trimStart().match(/^\/([^\s]+)(?:\s([\s\S]*))?$/);
  const name = match?.[1] ?? "";
  const command = catalog.commands.find(item => item.name === name && (!options.commandKey || item.key === options.commandKey));
  // Exact registered names (including skill namespaces and extension names)
  // take precedence. Paths, regexes and prose are ordinary user content;
  // retain typo feedback for unknown single-word commands.
  if (!command && !options.commandKey && name && !/^[a-zA-Z][\w:-]*$/.test(name)) return { kind: "message", text };
  if (!command) return { kind: "invalid", code: "UNKNOWN_COMMAND", name };
  if (!command.supported) return { kind: "invalid", code: "UNSUPPORTED_COMMAND", name };
  const argumentsText = match?.[2] ?? "";
  if (command.argumentMode === "required" && !argumentsText.trim()) return { kind: "invalid", code: "COMMAND_ARGUMENT_REQUIRED", name };
  if (command.source === "prompt" && command.usesTemplateArguments === false && argumentsText.trim()) return { kind: "invalid", code: "UNUSED_TEMPLATE_ARGUMENTS", name };
  if (command.argumentMode === "none" && argumentsText.trim() && options.afterPrompt?.trim()) return { kind: "invalid", code: "AMBIGUOUS_AFTER_PROMPT", name };
  const afterPrompt = command.argumentMode === "none" && argumentsText.trim() ? argumentsText : options.afterPrompt;
  if (options.hasAttachments && (command.source === "extension" || command.source === "builtin") && !afterPrompt?.trim()) return { kind: "invalid", code: "COMMAND_ATTACHMENTS_UNSUPPORTED", name };
  const args = command.argumentMode === "none" ? "" : argumentsText;
  return { kind: "command", command, arguments: args, invocation: `/${name}${args ? ` ${args}` : ""}`, ...(afterPrompt?.trim() ? { afterPrompt } : {}) };
}

export function createChatCommandOperation(text: string, catalog: ChatCommandCatalog, parsed: Extract<ParsedChatInput, { kind: "command" }>, inputOptions?: ChatInputOptions): ChatCommandOperation {
  return {
    ...(inputOptions ? { inputOptions: { ...inputOptions } } : {}),
    version: 1,
    rawText: text,
    catalogRevision: catalog.revision,
    command: parsed.command,
    arguments: parsed.arguments,
    ...(parsed.afterPrompt ? { afterPrompt: parsed.afterPrompt } : {}),
    phase: "preparing",
    steps: [
      { id: "command", kind: "command", status: "pending" },
      ...(parsed.afterPrompt ? [{ id: "prompt", kind: "prompt" as const, status: "pending" as const }] : []),
    ],
  };
}

export function templateUsesArguments(content: string): boolean {
  return /\$\{(?:\d+|ARGUMENTS|@):-|\$\{@:\d+|\$(?:ARGUMENTS|@|\d+)/.test(content);
}

export function persistentChatInputOptions(options: ChatInputOptions = {}): ChatInputOptions {
  const persistent = { ...options };
  delete persistent.submissionId;
  return persistent;
}
