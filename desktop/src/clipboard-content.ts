/** Shared parsing only; opening a URL remains a trusted main-process action. */
export function clipboardWebLink(text: unknown): { url: string; hostname: string } | null {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (!value || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return { url: url.href, hostname: url.hostname };
  } catch { return null; }
}

export function clipboardTextMetrics(text: string): { characters: number; lines: number } {
  let characters = 0, lines = text.length ? 1 : 0;
  for (let i = 0; i < text.length; i++) {
    const point = text.codePointAt(i)!; characters++;
    if (point > 0xffff) i++;
    if (point === 13 || point === 10 && (i === 0 || text.charCodeAt(i - 1) !== 13)) lines++;
  }
  return { characters, lines };
}

export function clipboardByteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
