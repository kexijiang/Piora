import { flushPendingAnswerState } from "./answer-output-client";

/** Copy the current view's acknowledged state, never race its pending writes. */
export async function requestSessionDuplication(id: string): Promise<void> {
  await flushPendingAnswerState(id);
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/duplicate`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${response.status}`);
  }
}
