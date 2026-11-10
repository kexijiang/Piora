/** Only report this attempt's loader lines, never an unfiltered device log. */
export function videoStartupDiagnostics(name: string, ownLog: string, hilog: string) {
  const lines = [
    ...ownLog.split(/\r?\n/).filter(line => /dlopen|relocat|symbol not found|failed|error/i.test(line)),
    ...hilog.split(/\r?\n/).filter(line => line.includes(name) && /dlopen|relocat|symbol not found|failed/i.test(line)),
  ];
  const diagnostic = lines.slice(-8).map(line => line.replace(/[\x00-\x08\x0b-\x1f]/g, "").slice(0, 512)).join("\n").slice(-2048);
  // MUSL can print "relocating failed: symbol not found" before the actual
  // mangled name in s= or in UiTest's later Error relocating line.
  const symbol = "([_A-Za-z][_A-Za-z0-9.$]{1,255})";
  const missingSymbol = new RegExp(`Error relocating [^:\\r\\n]+:\\s*${symbol}:\\s*symbol not found`, "i").exec(diagnostic)?.[1]
    ?? new RegExp(`symbol not found[^\\r\\n]*\\bs=${symbol}`, "i").exec(diagnostic)?.[1]
    ?? new RegExp(`(?:^|\\n)${symbol}:\\s*symbol not found`, "i").exec(diagnostic)?.[1];
  return { ...(diagnostic ? { diagnostic } : {}), ...(missingSymbol ? { missingSymbol } : {}) };
}
