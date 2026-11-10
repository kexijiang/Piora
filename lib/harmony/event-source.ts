"use client";

type Listener = (event: MessageEvent) => void;
type Subscription = { listener: Listener; connect: boolean };
const subscriptions = new Set<Subscription>();
let source: EventSource | undefined;
let owners = 0;

/** Share metadata within a renderer. Polling-only consumers do not occupy a connection. */
export function subscribeHarmonyEvents(listener: Listener, { connect = true }: { connect?: boolean } = {}): () => void {
  const subscription = { listener, connect };
  subscriptions.add(subscription);
  if (connect) owners++;
  if (owners && !source) {
    try {
      const current = new EventSource("/api/harmony/events");
      source = current;
      current.onmessage = event => {
        if (source !== current) return;
        for (const subscriber of [...subscriptions]) {
          if (subscriptions.has(subscriber)) subscriber.listener(event);
        }
      };
      // EventSource reconnects itself; consumers retain their existing polling fallback.
    } catch (error) {
      subscriptions.delete(subscription);
      if (connect) owners--;
      throw error;
    }
  }
  return () => {
    if (!subscriptions.delete(subscription)) return;
    if (connect) owners--;
    if (!owners) { source?.close(); source = undefined; }
  };
}
