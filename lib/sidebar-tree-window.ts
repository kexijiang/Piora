import type { SessionInfo } from "./types";
import type { SessionFlags } from "./session-flags";
import type { SessionTreeNode } from "./session-project-groups";

export interface FlatTask {
  session: SessionInfo;
  parentId: string | null;
  hasChildren: boolean;
  depth: number;
  collapsed: boolean;
}

/** Iterative pruning promotes active descendants of archived tasks without copying trees. */
export function indexTaskTree(nodes: SessionTreeNode[], flags: SessionFlags, order: readonly string[]) {
  const children = new Map<string | null, SessionInfo[]>();
  const parents = new Map<string, string | null>();
  const seen = new Set<string>();
  const stack = nodes.toReversed().map((node) => ({ node, parent: null as string | null }));
  while (stack.length) {
    const { node, parent } = stack.pop()!;
    if (seen.has(node.session.id)) continue;
    seen.add(node.session.id);
    const archived = Boolean(flags[node.session.id]?.archived);
    if (!archived) {
      parents.set(node.session.id, parent);
      const siblings = children.get(parent) ?? [];
      siblings.push(node.session);
      children.set(parent, siblings);
    }
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parent: archived ? parent : node.session.id });
  }
  const ranks = new Map(order.map((id, index) => [id, index]));
  for (const [parent, siblings] of children) siblings.sort((a, b) => {
    const pinned = Number(Boolean(flags[b.id]?.pinned)) - Number(Boolean(flags[a.id]?.pinned));
    if (pinned) return pinned;
    const rankA = ranks.get(a.id), rankB = ranks.get(b.id);
    if (rankA !== undefined || rankB !== undefined) return (rankA ?? Infinity) - (rankB ?? Infinity);
    return parent === null ? (flags[b.id]?.pinnedAt ?? "").localeCompare(flags[a.id]?.pinnedAt ?? "") : 0;
  });
  return { children, parents };
}

export function flattenTaskWindow(index: ReturnType<typeof indexTaskTree>, expanded: ReadonlySet<string>): FlatTask[] {
  const rows: FlatTask[] = [];
  const stack = (index.children.get(null) ?? []).toReversed().map((session) => ({ session, depth: 0 }));
  while (stack.length) {
    const { session, depth } = stack.pop()!;
    const children = index.children.get(session.id) ?? [];
    const collapsed = !expanded.has(session.id);
    rows.push({ session, depth, parentId: index.parents.get(session.id) ?? null, hasChildren: children.length > 0, collapsed });
    if (!collapsed) for (let i = children.length - 1; i >= 0; i--) stack.push({ session: children[i], depth: depth + 1 });
  }
  return rows;
}

export function taskAncestorIds(parents: ReadonlyMap<string, string | null>, id: string | null): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let cursor = id ? parents.get(id) : null;
  while (cursor && !seen.has(cursor)) { seen.add(cursor); result.push(cursor); cursor = parents.get(cursor); }
  return result;
}
