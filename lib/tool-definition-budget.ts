export const TOOL_DEFINITION_PROMPT_TOKEN_LIMIT = 10_000;

export interface ToolDefinitionLike {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
}

function serializableToolDefinition(value: ToolDefinitionLike): unknown {
  return {
    name: value.name,
    description: value.description,
    parameters: value.parameters ?? value.inputSchema,
  };
}

function serializeToolDefinitions(tools: readonly ToolDefinitionLike[]): string | null {
  try {
    return JSON.stringify(tools.map(serializableToolDefinition)) ?? "";
  } catch {
    return null;
  }
}

export function measureToolDefinitionPromptBytes(tools: readonly ToolDefinitionLike[]): number {
  const serialized = serializeToolDefinitions(tools);
  return serialized === null ? Number.POSITIVE_INFINITY : new TextEncoder().encode(serialized).byteLength;
}

export function estimateToolDefinitionPromptTokens(tools: readonly ToolDefinitionLike[]): number {
  const serialized = serializeToolDefinitions(tools);
  if (serialized === null) return Number.POSITIVE_INFINITY;
  // Three UTF-8 bytes per token is deliberately more conservative than the
  // four-character estimate used by the context meter, while still allowing
  // compact non-ASCII tool descriptions.
  return Math.ceil(new TextEncoder().encode(serialized).byteLength / 3);
}

export interface ToolDefinitionBudgetResult {
  toolNames: string[];
  droppedToolNames: string[];
  promptBytes: number;
  promptTokens: number;
  tokenLimit: number;
}

/**
 * Preserve requested order and omit definitions that would cross the hard
 * serialized prompt limit. The estimator intentionally keeps headroom relative
 * to the context meter so provider tokenizer differences do not ride the cap.
 */
export function fitToolNamesWithinDefinitionBudget(
  tools: readonly ToolDefinitionLike[],
  requestedToolNames: readonly string[],
  tokenLimit = TOOL_DEFINITION_PROMPT_TOKEN_LIMIT,
): ToolDefinitionBudgetResult {
  const definitions = new Map<string, ToolDefinitionLike>();
  for (const tool of tools) {
    if (typeof tool.name === "string" && !definitions.has(tool.name)) definitions.set(tool.name, tool);
  }

  const toolNames: string[] = [];
  const droppedToolNames: string[] = [];
  const seen = new Set<string>();
  for (const name of requestedToolNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = definitions.get(name);
    if (!definition) continue;
    const next = [...toolNames, name];
    const tokens = estimateToolDefinitionPromptTokens(next.map((candidate) => definitions.get(candidate)!));
    if (tokens <= tokenLimit) toolNames.push(name);
    else droppedToolNames.push(name);
  }

  return {
    toolNames,
    droppedToolNames,
    promptBytes: measureToolDefinitionPromptBytes(toolNames.map((name) => definitions.get(name)!)),
    promptTokens: estimateToolDefinitionPromptTokens(toolNames.map((name) => definitions.get(name)!)),
    tokenLimit,
  };
}
