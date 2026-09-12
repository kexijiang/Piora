import type { ToolResultMessage } from "./types";

export type CommandExecutionStatus = "running" | "success" | "failed" | "cancelled" | "timed_out";

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

export function commandStatus(result: ToolResultMessage | undefined, output = toolResultText(result)): CommandExecutionStatus {
  if (!result || result.isStreaming) return "running";
  if (!result.isError) return "success";
  if (/Command timed out after|\btimed out\b/i.test(output)) return "timed_out";
  if (/Command aborted|Operation aborted|\bcancelled\b/i.test(output)) return "cancelled";
  return "failed";
}

const ERROR_LINE = /(?:\berror\b|\bfatal\b|\bexception\b|\bfailed\b|not found|cannot|denied|拒绝|错误|失败|找不到|无法)/i;
const STATUS_LINE = /^(?:Command exited with code\s+-?\d+|Command timed out after|Command aborted|Operation aborted|\[Showing )/i;

export function commandErrorExcerpt(output: string, maxLines = 2): string {
  const lines = output.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
  if (!lines.length) return "";
  const firstError = lines.findIndex((line) => ERROR_LINE.test(line) && !STATUS_LINE.test(line.trim()));
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
