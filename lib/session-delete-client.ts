import { flushPendingAnswerState } from "./answer-output-client";

export async function requestSessionDeletion(id: string, expectedSessionIds?: string[]): Promise<{ sessionIds: string[]; trashedCount: number }> {
  // A subtree operation must also preserve open descendants, not just its root.
  await Promise.all([...new Set([id, ...expectedSessionIds ?? []])].map(sessionId => flushPendingAnswerState(sessionId)));
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE",
    ...(expectedSessionIds ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSessionIds }) } : {}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
