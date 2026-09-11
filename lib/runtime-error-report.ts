export function runtimeErrorReference(error: Error & { digest?: string }): string {
  if (error.digest) return error.digest;
  const text = `${error.name}\n${error.message}\n${error.stack ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return `client-render-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function isPageAssetLoadError(error: Error): boolean {
  return /ChunkLoadError|Loading (?:CSS )?chunk .+ failed|Failed to fetch dynamically imported module|Importing a module script failed/i.test(`${error.name}: ${error.message}`);
}

export function formatRuntimeErrorReport(error: Error & { digest?: string }, context: { version: string; time: string; runtime: string; userAgent: string }): string {
  const lines = [
    "Piora render error", `Reference: ${runtimeErrorReference(error)}`, `Version: ${context.version}`,
    `Time: ${context.time}`, `Runtime: ${context.runtime}`, `User agent: ${context.userAgent}`,
    "", error.stack || `${error.name}: ${error.message}`,
  ];
  const seen = new Set<unknown>([error]);
  let cause: unknown = error.cause;
  for (let depth = 0; cause && !seen.has(cause) && depth < 5; depth++) {
    seen.add(cause);
    lines.push("", `Caused by: ${cause instanceof Error ? cause.stack || `${cause.name}: ${cause.message}` : String(cause)}`);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
