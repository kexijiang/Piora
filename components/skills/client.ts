export async function skillsRequest<T>(path: string, data?: unknown, method = "POST", signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/skills${path}`, { method: data === undefined ? "GET" : method, headers: data === undefined ? undefined : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), signal });
  const result = await response.json();
  if (!response.ok || result.error && !result.state) throw new Error(result.error || `HTTP ${response.status}`);
  return result as T;
}
