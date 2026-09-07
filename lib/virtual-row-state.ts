/** Small UI choices survive row recycling; no message content is retained here. */
export function createVirtualRowState() {
  const values = new Map<string, boolean>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get(key: string, initial: boolean) { return values.get(key) ?? initial; },
    set(key: string, value: boolean) {
      if (values.get(key) === value) return;
      values.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener();
    },
    subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set();
      listeners.set(key, subscribers);
      subscribers.add(listener);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
    },
  };
}
