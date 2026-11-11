import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ToolReviewRecord } from "./tool-review-types";
import { redactReviewText } from "./tool-review-redaction";

function directory(root: string, sessionId: string): string {
  if (!/^[\w-]{1,128}$/.test(sessionId)) throw new Error("Invalid review session");
  return join(root, "piora", "tool-reviews", sessionId);
}
export function saveToolReview(root: string, record: ToolReviewRecord): void {
  if (!/^[\w-]{1,128}$/.test(record.id)) throw new Error("Invalid review id");
  const dir = directory(root, record.sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(join(dir, `${record.id}.json`), JSON.stringify({ ...record, reason: redactReviewText(record.reason).slice(0, 1600) }));
}
export function readToolReviews(root: string, sessionId: string): ToolReviewRecord[] {
  const dir = directory(root, sessionId);
  let files: string[];
  try { files = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  // IDs start with time so only the latest visible records need parsing. Older audit files remain on disk.
  return files.filter(file => /^[\w-]+\.json$/.test(file)).sort().slice(-100).flatMap(file => {
    try {
      const value = JSON.parse(readFileSync(join(dir, file), "utf8")) as ToolReviewRecord;
      if (value.schemaVersion !== 1 || value.sessionId !== sessionId || `${value.id}.json` !== file || typeof value.status !== "string" || typeof value.reason !== "string") return [];
      return [value];
    } catch { return []; } // Audit is never used as an executable authorization token.
  });
}
export function inactiveToolReviews(root: string, sessionId: string): ToolReviewRecord[] {
  return readToolReviews(root, sessionId).map(record => ["reviewing", "needs_user", "approved", "executing"].includes(record.status)
    ? { ...record, status: "interrupted", reason: "The previous runtime ended. This approval cannot be replayed; verify any uncertain effects." } as ToolReviewRecord : record);
}
