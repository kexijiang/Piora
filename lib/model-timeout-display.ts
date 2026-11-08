/** Recognize our watchdog's wire errors without changing retry/fallback semantics. */
export function modelTimeoutDisplay(raw: string): { key: "chat.modelFirstEventTimeout" | "chat.modelStreamTimeout"; seconds: number } | null {
  const text = raw.trim().replace(/^(?:Error:\s*)+/i, "");
  const first = /^Model request timed out: the provider sent no response data within (\d+(?:\.\d+)?) seconds\./.exec(text);
  const idle = /^Model request timed out: the response stream stopped sending data for (\d+(?:\.\d+)?) seconds\./.exec(text);
  const match = first ?? idle;
  if (!match || !Number.isFinite(Number(match[1]))) return null;
  return { key: first ? "chat.modelFirstEventTimeout" : "chat.modelStreamTimeout", seconds: Number(match[1]) };
}
