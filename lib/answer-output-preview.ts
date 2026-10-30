/** Transient host output. Never a durable answerOutput or a publication receipt. */
export interface AnswerOutputPreview {
  version: 1;
  kind: "intelligent-ui";
  sessionId: string;
  runId: string;
  streamId: string;
  toolCallId: string;
  seq: number;
  phase: "preparing" | "partial" | "complete" | "cleared";
  payload?: unknown;
  snapshot?: string;
}

export interface AnswerOutputPreviewSnapshot {
  sessionId: string;
  runId: string | null;
  seq: number;
  previews: AnswerOutputPreview[];
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const sequence = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Feature payload validation remains in its lazy renderer; shared chat checks scope. */
export function readAnswerOutputPreview(value: unknown): AnswerOutputPreview | null {
  if (!record(value) || value.version !== 1 || value.kind !== "intelligent-ui"
    || !identity(value.sessionId) || !identity(value.runId) || !identity(value.streamId) || !identity(value.toolCallId)
    || !sequence(value.seq) || value.seq === 0
    || !["preparing", "partial", "complete", "cleared"].includes(String(value.phase))) return null;
  const hasContent = value.phase === "partial" || value.phase === "complete";
  if (hasContent) {
    if (!record(value.payload) || typeof value.snapshot !== "string" || value.snapshot.length > 128_000) return null;
    try { if (JSON.stringify(value.payload).length > 64_000) return null; } catch { return null; }
  } else if (value.payload !== undefined || value.snapshot !== undefined) return null;
  return { version: 1, kind: "intelligent-ui", sessionId: value.sessionId, runId: value.runId,
    streamId: value.streamId, toolCallId: value.toolCallId, seq: value.seq,
    phase: value.phase as AnswerOutputPreview["phase"],
    ...(hasContent ? { payload: value.payload, snapshot: value.snapshot as string } : {}) };
}

export function readAnswerOutputPreviewSnapshot(value: unknown): AnswerOutputPreviewSnapshot | null {
  if (!record(value) || !identity(value.sessionId) || value.runId !== null && !identity(value.runId)
    || !sequence(value.seq) || !Array.isArray(value.previews) || value.previews.length > 4) return null;
  const previews: AnswerOutputPreview[] = [];
  const seen = new Set<string>();
  for (const item of value.previews) {
    const preview = readAnswerOutputPreview(item);
    if (!preview || preview.sessionId !== value.sessionId || preview.runId !== value.runId || preview.seq > value.seq || preview.phase === "cleared") return null;
    const key = `${preview.streamId}:${preview.toolCallId}`;
    if (seen.has(key)) return null;
    seen.add(key); previews.push(preview);
  }
  if (value.runId === null && previews.length) return null;
  return { sessionId: value.sessionId, runId: value.runId as string | null, seq: value.seq, previews };
}
