export interface TerminalSearchMatch { offset: number; excerpt: string }

// PTY snapshots contain ANSI styling and cursor commands. Search the readable
// text shown to people, while retaining a bounded excerpt for the result list.
export function terminalSearchMatch(output: string, query: string): TerminalSearchMatch | null {
  const readable = output.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");
  const offset = readable.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (offset < 0) return null;
  const start = Math.max(0, offset - 40), end = Math.min(readable.length, offset + query.length + 70);
  return { offset, excerpt: `${start ? "…" : ""}${readable.slice(start, end).replaceAll(/\s+/g, " ")}${end < readable.length ? "…" : ""}` };
}
