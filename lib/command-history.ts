export const COMMAND_HISTORY_SUGGESTION_LIMIT = 8;
const COMMAND_HISTORY_LIMIT = 200;

export function terminalHistoryKey(cwd: string): string {
  const normalized = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? cwd.replace(/\\/g, "/").toLowerCase() : cwd;
  return `piora-terminal-history-v1:${normalized.replace(/\/+$/, "")}`;
}

export function readCommandHistory(storage: Pick<Storage, "getItem">, cwd: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(terminalHistoryKey(cwd)) ?? "[]");
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()) && item.length <= 65536))].slice(0, COMMAND_HISTORY_LIMIT) : [];
  } catch { return []; }
}

export function rememberCommand(history: readonly string[], command: string): string[] {
  const value = command.trim();
  return value ? [value, ...history.filter((item) => item !== value)].slice(0, COMMAND_HISTORY_LIMIT) : [...history];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scoreCommand(command: string, query: string): number | null {
  const normalizedCommand = normalize(command);
  if (!normalizedCommand || !query) return null;
  if (normalizedCommand === query) return 0;
  if (normalizedCommand.startsWith(query)) return 1;
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length > 1 && terms.every((term) => normalizedCommand.includes(term))) return 2;
  return normalizedCommand.includes(query) ? 3 : null;
}

/** Rank matching commands while preserving recency inside each match tier. */
export function filterCommandHistory(
  history: readonly string[],
  query: string,
  limit = COMMAND_HISTORY_SUGGESTION_LIMIT,
): string[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery || limit <= 0) return [];

  return history
    .map((command, recency) => ({ command, recency, score: scoreCommand(command, normalizedQuery) }))
    .filter((candidate): candidate is { command: string; recency: number; score: number } => candidate.score !== null)
    .sort((first, second) => first.score - second.score || first.recency - second.recency)
    .slice(0, limit)
    .map(({ command }) => command);
}
