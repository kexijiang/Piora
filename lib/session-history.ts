import { normalizeToolCalls } from "./normalize";
import { getMessageImageSource } from "./message-images";
import type { AgentMessage, SessionEntry, SessionHeader, ToolResultMessage } from "./types";

export type HistoryCategory = "user" | "assistant" | "tool" | "system";
export interface HistoryNode {
  id: string; parentId: string | null; type: string; category: HistoryCategory;
  timestamp: string; preview: string; failed: boolean; hasAnswer: boolean; hasMedia?: boolean; toolOwnerId?: string;
}
export interface HistoryBranch { id: string; forkId: string | null; depth: number; preview: string; timestamp: string }
export interface HistoryIndex {
  sessionId: string; name: string | null; cwd: string; version: string;
  currentLeafId: string | null; nodes: HistoryNode[]; branches: HistoryBranch[];
  related: Array<{ id: string; name: string; relation: "parent" | "child" }>;
}
export interface HistoryDetail {
  id: string; message: AgentMessage | null; raw?: SessionEntry;
  tools: ToolResultMessage[];
}
export interface HistorySearchOptions {
  query: string; leafId?: string; category?: HistoryCategory; from?: string; to?: string;
  failedOnly?: boolean; includeThinking?: boolean; offset?: number;
}
export interface HistoryHit { id: string; snippet: string; leafId: string; category: HistoryCategory; timestamp: string }
export interface HistorySearchResult { version: string; hits: HistoryHit[]; total: number; nextOffset: number | null }

export function historyPath<T extends { id: string; parentId: string | null }>(nodes: readonly T[], leafId: string | null): T[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const path: T[] = [], seen = new Set<string>();
  let node = leafId ? byId.get(leafId) : undefined;
  while (node && !seen.has(node.id)) { seen.add(node.id); path.push(node); node = node.parentId ? byId.get(node.parentId) : undefined; }
  return path.reverse();
}

export function historyMessage(entry: SessionEntry): AgentMessage | null {
  return entry.type === "message" ? normalizeToolCalls(entry.message) : null;
}

/** Text only: binary image payloads never enter the index or search snippets. */
export function historyEntryText(entry: SessionEntry, includeThinking = false): string {
  const message = historyMessage(entry);
  if (message) {
    if (message.role === "bashExecution") return [message.command, message.output].filter(Boolean).join("\n");
    const content = "content" in message ? message.content : "";
    if (typeof content === "string") return content;
    const text = Array.isArray(content) ? content.flatMap(block => {
      if (block.type === "text") return [block.text];
      if (block.type === "thinking") return includeThinking ? [block.thinking] : [];
      if (block.type === "toolCall") return [block.toolName, JSON.stringify(block.input)];
      return [];
    }).join("\n") : "";
    return message.role === "toolResult" ? `${message.toolName}\n${text}` : text;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary;
  if (entry.type === "custom_message") return typeof entry.content === "string" ? entry.content : entry.content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return JSON.stringify(entry, (key, value) => /^(data|signature)$/.test(key) && typeof value === "string" && value.length > 4096 ? "[binary data]" : value, 2);
}

export function historyCategory(entry: SessionEntry): HistoryCategory {
  const message = historyMessage(entry);
  if (!message) return "system";
  if (message.role === "user") return "user";
  if (message.role === "assistant") return message.content.some(block => block.type === "toolCall") && !message.content.some(block => block.type === "text" && block.text.trim() || block.type === "image") ? "tool" : "assistant";
  if (message.role === "toolResult" || message.role === "bashExecution") return "tool";
  return "system";
}

export function historyFailed(entry: SessionEntry): boolean {
  const message = historyMessage(entry);
  if (message?.role === "toolResult") return Boolean(message.isError);
  if (message?.role === "bashExecution") return Boolean(message.exitCode && message.exitCode !== 0) && !message.cancelled;
  return false;
}

export function buildHistoryIndex(entries: SessionEntry[], header: SessionHeader, leafId: string | null, version: string): HistoryIndex {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const nodes: HistoryNode[] = entries.map(entry => {
    const message = historyMessage(entry);
    let toolOwnerId: string | undefined;
    if (message?.role === "toolResult") {
      let parent = entry.parentId ? byId.get(entry.parentId) : undefined;
      const seen = new Set<string>();
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        const candidate = historyMessage(parent);
        if (candidate?.role === "assistant" && candidate.content.some(block => block.type === "toolCall" && block.toolCallId === message.toolCallId)) { toolOwnerId = parent.id; break; }
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
    }
    return {
      id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp,
      category: historyCategory(entry), preview: historyEntryText(entry).replace(/\s+/g, " ").slice(0, 180), failed: historyFailed(entry), toolOwnerId,
      hasAnswer: message?.role === "assistant" && message.content.some(b => b.type === "text" && b.text.trim() || b.type === "image") || false,
      hasMedia: Boolean(message && "content" in message && Array.isArray(message.content) && message.content.some(block => block.type === "image")),
    };
  });
  const children = new Map<string, number>();
  for (const node of nodes) if (node.parentId) children.set(node.parentId, (children.get(node.parentId) ?? 0) + 1);
  const branches = nodes.filter(node => !children.has(node.id)).map(node => {
    const path = historyPath(nodes, node.id);
    const forks = path.filter(item => (children.get(item.id) ?? 0) > 1);
    const forkId = forks.at(-1)?.id ?? null;
    const afterFork = path.slice(forkId ? path.findIndex(item => item.id === forkId) + 1 : 0);
    const question = afterFork.find(item => item.category === "user") ?? [...path].reverse().find(item => item.category === "user");
    return { id: node.id, forkId, depth: forks.length, preview: question?.preview ?? node.preview, timestamp: node.timestamp };
  });
  const nameEntry = [...entries].reverse().find(entry => entry.type === "session_info" && entry.name);
  const name = nameEntry?.type === "session_info" ? nameEntry.name : null;
  return { sessionId: header.id, cwd: header.cwd, name: typeof name === "string" ? name : null, currentLeafId: leafId,
    version, nodes, branches, related: [] };
}

/** Each result belongs to the nearest preceding call on this exact branch. */
export function pairHistoryTools(path: SessionEntry[]): Map<string, SessionEntry[]> {
  const owners = new Map<string, string>(), paired = new Map<string, SessionEntry[]>();
  for (const entry of path) {
    const message = historyMessage(entry);
    if (message?.role === "assistant") for (const block of message.content) if (block.type === "toolCall") owners.set(block.toolCallId, entry.id);
    if (message?.role === "toolResult") {
      const owner = owners.get(message.toolCallId);
      if (owner) paired.set(owner, [...(paired.get(owner) ?? []), entry]);
    }
  }
  return paired;
}

export function selectHistoryBranch(index: HistoryIndex, entryId: string, preferred: string | null): string | null {
  if (preferred && historyPath(index.nodes, preferred).some(node => node.id === entryId)) return preferred;
  return [...index.branches].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .find(branch => historyPath(index.nodes, branch.id).some(node => node.id === entryId))?.id ?? null;
}

export function searchHistory(entries: SessionEntry[], index: HistoryIndex, options: HistorySearchOptions): HistorySearchResult {
  const source = options.leafId ? historyPath(entries, options.leafId) : entries;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const nodes = new Map(index.nodes.map(node => [node.id, node]));
  const branchByEntry = new Map<string, string>();
  for (const branch of [...index.branches].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    for (const node of historyPath(index.nodes, branch.id)) branchByEntry.set(node.id, branch.id);
  }
  const preferred = options.leafId ?? index.currentLeafId;
  if (preferred) for (const node of historyPath(index.nodes, preferred)) branchByEntry.set(node.id, preferred);
  const tokens = options.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hits: HistoryHit[] = [];
  for (const entry of source) {
    const category = historyCategory(entry);
    if (options.category && category !== options.category || options.failedOnly && !historyFailed(entry)) continue;
    const date = Date.parse(entry.timestamp);
    if (options.from && date < Date.parse(options.from) || options.to && date > Date.parse(options.to)) continue;
    let content = historyEntryText(entry, options.includeThinking);
    const ownerId = nodes.get(entry.id)?.toolOwnerId;
    const owner = ownerId ? byId.get(ownerId) : undefined;
    const message = historyMessage(entry), caller = owner ? historyMessage(owner) : null;
    if (message?.role === "toolResult" && caller?.role === "assistant") {
      const call = caller.content.find(block => block.type === "toolCall" && block.toolCallId === message.toolCallId);
      if (call?.type === "toolCall") content = `${call.toolName} ${JSON.stringify(call.input)}\n${content}`;
    }
    const lowered = content.toLocaleLowerCase();
    if (!tokens.every(token => lowered.includes(token))) continue;
    const match = tokens.length ? Math.max(0, lowered.indexOf(tokens[0]) - 55) : 0;
    hits.push({ id: entry.id, category, timestamp: entry.timestamp,
      snippet: `${match ? "…" : ""}${content.slice(match, match + 220).replace(/\s+/g, " ")}`,
      leafId: branchByEntry.get(entry.id) ?? entry.id });
  }
  const offset = Math.max(0, options.offset ?? 0), end = offset + 50;
  return { version: index.version, hits: hits.slice(offset, end), total: hits.length, nextOffset: end < hits.length ? end : null };
}

export function historyMarkdown(entries: SessionEntry[], title: string): string {
  return `# ${title.replace(/[\r\n]/g, " ")}\n\n` + entries.map(entry => {
    const message = historyMessage(entry);
    const role = message?.role ?? entry.type;
    const content = message && "content" in message ? message.content : entry.type === "custom_message" ? entry.content : [];
    const images = Array.isArray(content) ? content.filter(block => block.type === "image").flatMap((block, position) => {
      const source = getMessageImageSource(block);
      const url = source?.type === "base64" ? `data:${source.media_type ?? "image/png"};base64,${source.data}` : source?.url;
      return url ? [`![Image ${position + 1}](<${url.replace(/[\r\n<>]/g, char => encodeURIComponent(char))}>)`] : [];
    }) : [];
    return `## ${role} · ${entry.timestamp}\n\n${[historyEntryText(entry, true), ...images].join("\n\n")}\n`;
  }).join("\n");
}

export interface HistoryTurn { id: string; question?: HistoryNode; entries: HistoryNode[] }
export function historyReadingAnchor(previous: HistoryNode[], next: HistoryNode[], requested: string | null): string | null {
  const available = new Set(next.map(node => node.id));
  if (requested && available.has(requested)) return requested;
  const position = previous.findIndex(node => node.id === requested);
  if (position >= 0) for (let distance = 1; distance < previous.length; distance++) {
    for (const candidate of [previous[position - distance], previous[position + distance]]) {
      if (candidate && available.has(candidate.id)) return candidate.id;
    }
  }
  return [...next].reverse().find(node => node.category === "user")?.id ?? next.at(-1)?.id ?? null;
}

export function historyTurns(path: HistoryNode[]): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  for (const node of path) {
    if (node.category === "user" || !turns.length) turns.push({ id: node.id, question: node.category === "user" ? node : undefined, entries: [] });
    turns[turns.length - 1].entries.push(node);
  }
  return turns;
}
