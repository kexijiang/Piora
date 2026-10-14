/** Total turn clock: 12s · 1m 05s · 1h 02m 03s. */
export function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) ? ms : 0;
  const total = Math.max(0, Math.floor(safe / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}
