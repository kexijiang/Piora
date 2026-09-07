/** Resolve each ancestor at most once, including missing parents and cycles. */
export function createUserAncestorResolver(parents: ReadonlyMap<string, string | null>, userIds: ReadonlySet<string>) {
  const resolved = new Map<string, string | null>();
  return (entryId: string): string | null => {
    const path: string[] = [];
    const visiting = new Set<string>();
    let cursor: string | null = entryId;
    let user: string | null = null;
    while (cursor && !visiting.has(cursor)) {
      if (userIds.has(cursor)) { user = cursor; break; }
      if (resolved.has(cursor)) { user = resolved.get(cursor)!; break; }
      visiting.add(cursor);
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const id of path) resolved.set(id, user);
    return user;
  };
}
