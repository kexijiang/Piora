import { MiniAppStateClient } from "./client-state";
import { miniAppEnvelopeIdentity } from "./client-protocol";

interface Entry {
  client: MiniAppStateClient;
  users: Set<() => void>;
  touched: number;
}
const entries = new Map<string, Entry>();
const MAX_IDLE = 16;

/** Reload committed identities after an explicit revision decision. Drafts remain owned by each client. */
export async function refreshMiniAppClients(sessionId: string): Promise<void> {
  await Promise.all([...entries.values()].filter(entry => entry.client.sessionId === sessionId).map(entry => entry.client.load()));
}

function prune() {
  const idle = [...entries].filter(([, entry]) => !entry.users.size && entry.client.isDisposable()).sort((a, b) => b[1].touched - a[1].touched);
  for (const [key, entry] of idle.slice(MAX_IDLE)) { entry.client.dispose(); entries.delete(key); }
}

/** Views can disappear through virtualization; their save gate must survive. */
export function acquireMiniAppClient(sessionId: string, toolCallId: string, envelope: unknown, branchKey: string, onBlock: () => void) {
  const identity = miniAppEnvelopeIdentity(envelope), key = JSON.stringify([sessionId, toolCallId, identity, branchKey]);
  let entry = entries.get(key);
  if (!entry) {
    const users = new Set<() => void>();
    entry = { client: new MiniAppStateClient(sessionId, toolCallId, identity, () => { for (const block of users) block(); }), users, touched: Date.now() };
    entries.set(key, entry);
  }
  const selected = entry;
  selected.users.add(onBlock); selected.touched = Date.now(); prune();
  let released = false;
  return { client: selected.client, release() {
    if (released) return; released = true;
    selected.users.delete(onBlock); selected.touched = Date.now();
    if (!selected.users.size) selected.client.setCheckpointGate(undefined);
    prune();
  } };
}
