export const COMPACT_PROCESS_STORAGE_KEY = "piora-compact-process:v1";
export const DEFAULT_COMPACT_PROCESS = true;

export function parseCompactProcessPreference(value: string | null): boolean {
  return value !== "false";
}
