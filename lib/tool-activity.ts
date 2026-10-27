import { isCommandToolName } from "./command-execution";

export type ToolActivityKind = "command" | "read" | "directory" | "search" | "edit" | "other";

/** Identify the tool that actually ran, rather than guessing from shell text. */
export function toolActivityKind(name: string): ToolActivityKind {
  if (isCommandToolName(name)) return "command";
  if (name === "read") return "read";
  if (name === "ls") return "directory";
  if (name === "grep" || name === "find") return "search";
  if (name === "edit" || name === "write") return "edit";
  return "other";
}

export const toolActivityIcons = {
  command: "terminal", read: "file", directory: "folder", search: "search", edit: "edit", other: "wrench",
} as const;
