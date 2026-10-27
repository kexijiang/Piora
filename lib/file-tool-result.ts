import type { ToolCallContent, ToolResultMessage } from "./types";
import { resolveWorkspaceFilePath } from "./file-links";

export interface FileResultLine { number: number; text: string; match?: boolean }
export interface FileResultGroup { path: string; openPath?: string; lines: FileResultLine[] }
export type FileToolResult =
  | { kind: "read"; path: string; openPath?: string; lines: FileResultLine[]; notice?: string }
  | { kind: "grep"; groups: FileResultGroup[]; notice?: string }
  | { kind: "find" | "ls"; entries: { path: string; directory: boolean; openPath?: string }[]; notice?: string };

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Adapt saved Pi output; never re-read today's file or guess a shell command's meaning. */
export function fileToolResult(call: ToolCallContent, result: ToolResultMessage | undefined, cwd?: string): FileToolResult | null {
  if (!result || result.isError || result.isStreaming || !["read", "grep", "find", "ls"].includes(call.toolName)) return null;
  if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text") return null;
  const raw = result.content[0].text;
  if (typeof raw !== "string" || raw.length > 512 * 1024 || raw.includes("\0")) return null;
  const input = record(call.input), details = record(result.details), truncation = record(details.truncation);
  if (truncation.firstLineExceedsLimit) return null;
  let body = raw.replace(/\r\n/g, "\n"), notice: string | undefined;
  if (body.split("\n").length > 10000) return null;
  if (call.toolName === "read") {
    if (typeof input.path !== "string" || !input.path || (input.offset !== undefined && !positive(input.offset)) || (input.limit !== undefined && !positive(input.limit))) return null;
    const offset = positive(input.offset) ? input.offset : 1;
    // Strip only a consistent SDK continuation footer. Other text remains literal file content.
    const footer = /\n\n\[(?:(\d+) more lines in file|Showing lines (\d+)-(\d+) of (\d+)(?: \([^\n]+ limit\))?)\. Use offset=(\d+) to continue\.\]$/.exec(body);
    if (footer) {
      const content = body.slice(0, footer.index), count = content.split("\n").length;
      if (Number(footer[5]) !== offset + count || (footer[2] && (Number(footer[2]) !== offset || Number(footer[3]) !== offset + count - 1 || Number(footer[4]) < offset + count))) return null;
      notice = footer[0].trim(); body = content;
    } else if (truncation.truncated) return null;
    const lines = body === "" ? [] : body.split("\n").map((text, index) => ({ number: offset + index, text }));
    return { kind: "read", path: input.path, openPath: resolveWorkspaceFilePath(input.path, cwd) ?? undefined, lines, notice };
  }
  // Limit notices are metadata-backed, not inferred from arbitrary output lines.
  if (truncation.truncated || details.matchLimitReached || details.resultLimitReached || details.entryLimitReached || details.linesTruncated) {
    const footer = /\n\n\[[^\n]*\]$/.exec(body);
    if (!footer) return null;
    notice = footer[0].trim(); body = body.slice(0, footer.index);
    // Byte truncation may cut a filename or a match in half; use the raw fallback.
    if (truncation.truncated) return null;
  }
  if (call.toolName === "grep") {
    if (body === "No matches found") return { kind: "grep", groups: [] };
    const groups: FileResultGroup[] = [];
    for (const line of body.split("\n")) {
      const match = /^(.+?)([:\-])(\d+)\2 (.*)$/.exec(line);
      if (!match || !positive(Number(match[3]))) return null;
      const [, path, separator, number, text] = match;
      let group = groups.at(-1);
      if (group?.path !== path) {
        // With an explicit path Pi can search either a file or a directory;
        // old results do not record which. Do not create a misleading file link.
        group = { path, openPath: input.path === undefined || input.path === "." ? resolveWorkspaceFilePath(path, cwd) ?? undefined : undefined, lines: [] };
        groups.push(group);
      }
      group.lines.push({ number: Number(number), text, match: separator === ":" });
    }
    return { kind: "grep", groups, notice };
  }
  if (body === (call.toolName === "ls" ? "(empty directory)" : "No files found matching pattern")) return { kind: call.toolName as "ls" | "find", entries: [] };
  const base = typeof input.path === "string" ? resolveWorkspaceFilePath(input.path, cwd) : cwd;
  const paths = body.split("\n");
  if (paths.some(path => !path || /[\u0000-\u001f]/.test(path))) return null;
  return { kind: call.toolName as "ls" | "find", notice, entries: paths.map(path => ({ path, directory: call.toolName === "ls" && path.endsWith("/"), openPath: base ? resolveWorkspaceFilePath(path, base) ?? undefined : undefined })) };
}
