/** One confirmed read-only parameter response. Includes host HDC overhead, not video latency. */
export type HarmonyResponseSample = { durationMs: number; sampledAt: string };

/** Match HDC protocol diagnostics, not arbitrary words in device command output. */
export function isHdcChannelNotReadyResponse(output: string): boolean {
  return /^\s*\[Fail\](?:\[E\d+\])?:?\s*(?:The\s+)?communication channel is being established\.?\s*$/im.test(output)
    || /^\s*\[F\]\[[^\]\r\n]{1,80}\]\s*Send\s+(?:isDead|hChannel nullptr)\s+channelId:\s*\d+\s*$/im.test(output);
}

export function normalizeHarmonyResponseSample(value: unknown): HarmonyResponseSample | undefined {
  if (!value || typeof value !== "object") return;
  const sample = value as Partial<HarmonyResponseSample>;
  if (typeof sample.durationMs !== "number" || !Number.isFinite(sample.durationMs) || sample.durationMs < 0 || sample.durationMs > 60_000
    || typeof sample.sampledAt !== "string" || !Number.isFinite(Date.parse(sample.sampledAt))) return;
  return { durationMs: Math.round(sample.durationMs), sampledAt: sample.sampledAt };
}

export function currentHarmonyResponseSample(value: unknown, now = Date.now()): HarmonyResponseSample | undefined {
  const sample = normalizeHarmonyResponseSample(value);
  if (!sample) return;
  const age = now - Date.parse(sample.sampledAt);
  return age >= 0 && age <= 45_000 ? sample : undefined;
}
