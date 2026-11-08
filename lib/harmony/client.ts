import { HarmonyRequestError } from "./request-error";

export async function harmonyJson<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { cache: "no-store", signal, ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  const data = await response.json();
  if (!response.ok) throw new HarmonyRequestError(data.error, response.status);
  return data;
}
