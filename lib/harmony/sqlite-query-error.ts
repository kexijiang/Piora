import { HarmonyRequestError } from "./request-error";

/** Offsets refer to the submitted SQL's UTF-16 string, matching textarea selection coordinates. */
export class HarmonySqliteQueryError extends HarmonyRequestError {
  readonly offset?: number;
  constructor(error: unknown, status: number) {
    const value = error && typeof error === "object" ? error as { message?: unknown; code?: unknown; details?: { sqlErrorOffset?: unknown } } : undefined;
    super(error, status);
    const offset = value?.details?.sqlErrorOffset;
    if (value?.code === "INVALID_RESPONSE" && Number.isInteger(offset) && Number(offset) >= 0 && Number(offset) <= 4096) this.offset = Number(offset);
  }
}

export function sqliteQueryPosition(text: string, offset: number): { line: number; column: number } | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return undefined;
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return { line: lines.length, column: Array.from(lines.at(-1) ?? "").length + 1 };
}
