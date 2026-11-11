import type { ToolResultMessage } from "./types";

export type CommandExecutionStatus = "running" | "success" | "warning" | "failed" | "cancelled" | "timed_out";

export interface CommandExecutionData {
  id: string;
  toolName: string;
  command: string;
  output: string;
  status: CommandExecutionStatus;
  isStreaming: boolean;
  duration?: number;
  cwd?: string;
  exitCode?: number;
  truncated: boolean;
  fullOutputPath?: string;
  sessionId?: string;
  diagnostics?: string;
  /** A saved history card must not subscribe to live command updates. */
  historical?: boolean;
}

export function isCommandToolName(name: unknown): boolean {
  return typeof name === "string" && /^(?:bash|powershell)(?:\s|$)/i.test(name.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeCommandOutputDetails(
  toolName: unknown,
  streamedDetails: unknown,
  finalDetails: unknown,
): unknown {
  if (!isCommandToolName(toolName) || !isRecord(streamedDetails)) return finalDetails;
  return { ...streamedDetails, ...(isRecord(finalDetails) ? finalDetails : {}) };
}

export function toolResultText(result: ToolResultMessage | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function parseCommandExitCode(output: string): number | undefined {
  const matches = [...output.matchAll(/Command exited with code\s+(-?\d+)/gi)];
  const raw = matches.at(-1)?.[1];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function commandExitCode(result: ToolResultMessage | undefined, output = toolResultText(result)): number | undefined {
  const details = isRecord(result?.details) ? result.details : {};
  if (typeof details.exitCode === "number" && Number.isSafeInteger(details.exitCode)) return details.exitCode;
  const parsed = parseCommandExitCode(output);
  if (parsed !== undefined) return parsed;
  if (result && !result.isStreaming && !result.isError) return 0;
  return undefined;
}

export function commandResultMetadata(result: ToolResultMessage | undefined): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const details = isRecord(result?.details) ? result.details : {};
  const truncation = isRecord(details.truncation) ? details.truncation : {};
  const output = toolResultText(result);
  return {
    truncated: truncation.truncated === true || /\[Showing (?:lines|last) .+Full output:/i.test(output),
    ...(typeof details.fullOutputPath === "string" && details.fullOutputPath ? { fullOutputPath: details.fullOutputPath } : {}),
  };
}

const SUCCESS_OUTPUT_LINE = /^\s*(?:BUILD SUCCESSFUL(?:\s+in\s+[^\r\n]+)?|(?:All\s+)?Tests? passed(?:[.:\s][^\r\n]*)?)\s*$/im;

export function commandStatus(result: ToolResultMessage | undefined, output = toolResultText(result)): CommandExecutionStatus {
  if (!result || result.isStreaming) return "running";
  const details = isRecord(result.details) ? result.details : {};
  if (details.timedOut === true || result.isError && /Command timed out after|\btimed out\b/i.test(output)) return "timed_out";
  if (details.cancelled === true || details.aborted === true || result.isError && /Command aborted|Operation aborted|\bcancelled\b/i.test(output)) return "cancelled";
  const exitCode = commandExitCode(result, output);
  if (exitCode === 0) return "success";
  if (exitCode !== undefined && exitCode !== 0) {
    // A successful subcommand does not make a nonzero compound command succeed.
    // Retain its actual exit code and show the conflicting evidence as a warning.
    return SUCCESS_OUTPUT_LINE.test(output) ? "warning" : "failed";
  }
  if (!result.isError) return "success";
  if (SUCCESS_OUTPUT_LINE.test(output)) return "warning";
  return "failed";
}

const ERROR_LINE = /(?:\berror\b|\bfatal\b|\bexception\b|\bfailed\b|not found|cannot|denied|拒绝|错误|失败|找不到|无法)/i;
export function isCommandErrorLine(line: string): boolean {
  const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  return ERROR_LINE.test(plain) && !/\b(?:0|no)\s+errors?\b/i.test(plain);
}

const STATUS_LINE = /^(?:Command exited with code\s+-?\d+|Command timed out after|Command aborted|Operation aborted|\[Showing )/i;

export function commandErrorExcerpt(output: string, maxLines = 2): string {
  const lines = output.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!lines.length) return "";
  const firstError = lines.findIndex((line) => isCommandErrorLine(line) && !STATUS_LINE.test(line.trim()));
  const candidates = firstError >= 0
    ? lines.slice(firstError).filter((line) => !STATUS_LINE.test(line.trim())).slice(0, maxLines)
    : lines.filter((line) => !STATUS_LINE.test(line.trim())).slice(-maxLines);
  return candidates.join("\n");
}

export function commandDisplayName(toolName: string): string {
  if (/^powershell(?:\s|$)/i.test(toolName.trim())) return "PowerShell";
  if (/^bash\s*\(local\)$/i.test(toolName.trim())) return "Shell · local";
  return "Shell";
}

/** Conservative labels for common commands; unknown scripts retain a neutral title. */
export function commandActionKey(command: string): string {
  const tokens = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|\n]|[^\s;|&]+|&/g) ?? [];
  const segments: string[][] = [[]];
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;|\n&])$/.test(token)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  const actions: string[] = [];
  for (const [raw, ...args] of segments) {
    if (!raw) continue;
    const executable = raw.toLowerCase();
    if (["cd", "echo", "printf", "set-location", "write-output"].includes(executable)) continue;
    if (["ls", "dir", "find", "tree", "get-childitem"].includes(executable)) actions.push("inspect");
    else if (["cat", "head", "tail", "wc", "get-content"].includes(executable)) actions.push("read");
    else if (["rg", "grep", "select-string"].includes(executable)) actions.push("search");
    else if (executable === "git" && ["status", "log", "diff", "show"].includes(args[0])) actions.push("inspect");
    else if (["npm", "pnpm", "yarn", "bun"].includes(executable) && (args[0] === "test" || args[0] === "run" && args[1] === "test")) actions.push("test");
    else return "command.action.run";
  }
  const kinds = new Set(actions);
  return `command.action.${kinds.size === 1 ? actions[0] : kinds.size > 1 && !kinds.has("test") ? "inspect" : "run"}`;
}
