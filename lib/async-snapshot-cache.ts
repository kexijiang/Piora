/** Bounded, coalesced snapshots. Invalidated in-flight results cannot refill the cache. */
export function createAsyncSnapshotCache<T>(ttlMs: number, capacity = 32) {
  const entries = new Map<string, { promise: Promise<T>; expiresAt: number }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const previous = entries.get(key);
      if (previous && previous.expiresAt > Date.now()) return previous.promise;
      const entry = { promise: Promise.resolve().then(load), expiresAt: Infinity };
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > capacity) entries.delete(entries.keys().next().value!);
      void entry.promise.then(() => { entry.expiresAt = Date.now() + ttlMs; }, () => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return entry.promise;
    },
    invalidate() { entries.clear(); },
  };
}
