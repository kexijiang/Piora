/** One transient notification per error in a logical prompt, across SSE retries. */
export class PromptErrorNotices {
  private run = "";
  private sequence = 0;
  private errors = new Map<string, { id: string; notified: boolean; inHistory: boolean }>();

  record(run: string, raw: string, source: "notice" | "history") {
    if (run !== this.run) { this.run = run; this.errors.clear(); }
    const error = raw.trim().replace(/^(?:Error:\s*)+/i, "");
    let entry = this.errors.get(error);
    if (!entry) {
      entry = { id: `prompt-error-${++this.sequence}`, notified: false, inHistory: false };
      this.errors.set(error, entry);
    }
    if (source === "history") entry.inHistory = true;
    const show = source === "notice" && !entry.notified && !entry.inHistory;
    if (source === "notice") entry.notified = true;
    return { id: entry.id, show };
  }
}
