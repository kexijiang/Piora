/** Conservative redaction, including credentials embedded in shell text or URLs. */
export function redactReviewText(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[\w-]{10,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/(authorization\s*[:=]\s*["']?)(?:bearer|basic)\s+[^\s"']+/gi, "$1[REDACTED]")
    .replace(/((?:[\w.-]*(?:password|passwd|secret|token|api[_-]?key|credential)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}
export function reviewArguments(value: unknown): unknown {
  if (typeof value === "string") return redactReviewText(value);
  if (Array.isArray(value)) return value.map(reviewArguments);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /password|secret|token|api.?key|credential|authorization|cookie|^env$|^environment$/i.test(key) ? "[REDACTED]" : reviewArguments(item)]));
  return value;
}
