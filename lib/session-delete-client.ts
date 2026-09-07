export async function requestSessionDeletion(id: string, expectedSessionIds?: string[]): Promise<{ sessionIds: string[]; trashedCount: number }> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE",
    ...(expectedSessionIds ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedSessionIds }) } : {}) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
