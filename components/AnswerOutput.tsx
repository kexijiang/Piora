"use client";

import { Component, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { useBetaFeatures } from "@/hooks/useBetaFeatures";
import { useI18n } from "@/hooks/useI18n";
import { answerOutputSnapshot, readAnswerOutput } from "@/lib/answer-output";
import type { ToolResultMessage } from "@/lib/types";
import { AnswerOutputScope } from "./AnswerOutputScope";

// The loader is invoked only after the enabled feature reaches this output slot.
const IntelligentUiSurface = lazy(() => import("./intelligent-ui/IntelligentUiSurface"));

class AnswerOutputBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

interface Props {
  result?: ToolResultMessage;
  toolCallId: string;
  sessionId?: string;
  entryId?: string;
  readOnly?: boolean;
  generating?: boolean;
}

function SavedAnswerSnapshot({ snapshot, sessionId, toolCallId }: { snapshot: string; sessionId: string; toolCallId: string }) {
  const key = `${sessionId}:${toolCallId}`;
  const [saved, setSaved] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const query = new URLSearchParams({ kind: "intelligent-ui", toolCallId });
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer-output?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json();
        if (!controller.signal.aborted && typeof body.snapshot === "string" && body.snapshot.length <= 128_000) setSaved({ key, text: body.snapshot });
      }).catch(() => { /* The original durable snapshot stays readable offline. */ })
      .finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [key, sessionId, toolCallId]);
  return saved?.key === key ? saved.text : snapshot;
}

/** Chat knows only the envelope and fallback; feature code owns its state and controls. */
export function AnswerOutput({ result, toolCallId, sessionId, entryId, readOnly = false, generating = false }: Props) {
  const branch = useContext(AnswerOutputScope);
  const { features, loading } = useBetaFeatures();
  const { t } = useI18n();
  const output = readAnswerOutput(result?.details);
  const snapshot = answerOutputSnapshot(result);
  const fallback = <div data-answer-output-snapshot role={result?.isError ? "alert" : undefined}
    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", lineHeight: 1.6 }}>
    {!loading && !features.intelligentUi && output?.kind === "intelligent-ui" && !result?.isError && !result?.isStreaming && !readOnly && sessionId
      ? <SavedAnswerSnapshot key={branch} snapshot={snapshot} sessionId={sessionId} toolCallId={toolCallId} />
      : snapshot || t(generating || result?.isStreaming ? "answerOutput.preparing" : "answerOutput.unavailable")}
  </div>;

  if (loading || !features.intelligentUi || !output || output.kind !== "intelligent-ui" || output.version !== 1 || result?.isError || readOnly) return fallback;
  return <AnswerOutputBoundary key={`${toolCallId}:${branch}:${output.kind}:${output.version}:${snapshot}`} fallback={fallback}>
    <Suspense fallback={fallback}>
      <IntelligentUiSurface payload={output.payload} snapshot={snapshot} sessionId={sessionId} toolCallId={toolCallId}
        entryId={entryId} branchKey={branch ?? undefined} readOnly={Boolean(result?.isStreaming)} />
    </Suspense>
  </AnswerOutputBoundary>;
}
