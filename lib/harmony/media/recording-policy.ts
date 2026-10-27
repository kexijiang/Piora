export const RECORDING_POLICY = Object.freeze({
  durationMs: 30 * 60 * 1000,
  maxBytes: 2 * 1024 * 1024 * 1024,
  finalizationReserveBytes: 16 * 1024 * 1024,
  minimumFreeBytes: 256 * 1024 * 1024,
  diskCheckIntervalMs: 5000,
  maxFrames: 30 * 60 * 120,
});

export function recordingLimitReason(seconds: number, bytes: number, frames: number): "duration-limit" | "size-limit" | undefined {
  if (seconds >= RECORDING_POLICY.durationMs / 1000 || frames >= RECORDING_POLICY.maxFrames) return "duration-limit";
  if (bytes >= RECORDING_POLICY.maxBytes - RECORDING_POLICY.finalizationReserveBytes) return "size-limit";
}
