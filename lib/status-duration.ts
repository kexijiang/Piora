/** Compact clock style for status lines: 45s · 1:23 · 1:02:03. */
export function formatStatusDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : minutes > 0 ? `${minutes}:${pad(seconds)}` : `${seconds}s`;
}
