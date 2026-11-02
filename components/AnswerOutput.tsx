"use client";

import { Component, Suspense, useContext, useEffect, useState, type ReactNode } from "react";
import { useBetaFeatures } from "@/hooks/useBetaFeatures";
import { useI18n } from "@/hooks/useI18n";
import { answerOutputSnapshot, readAnswerOutput } from "@/lib/answer-output";
import type { ToolResultMessage } from "@/lib/types";
import { AnswerOutputPreviews, AnswerOutputScope } from "./AnswerOutputScope";
import { answerOutputDescriptor } from "@/lib/answer-output-catalog";
import { answerOutputRenderer } from "./answer-output-renderers";

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

function SavedAnswerSnapshot({ kind, snapshot, sessionId, toolCallId }: { kind: string; snapshot: string; sessionId: string; toolCallId: string }) {
  const key = `${kind}:${sessionId}:${toolCallId}`;
  const [saved, setSaved] = useState<{ key: string; text: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const query = new URLSearchParams({ kind, toolCallId });
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/answer-output?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) return;
        const body = await response.json();
        if (!controller.signal.aborted && typeof body.snapshot === "string" && body.snapshot.length <= 128_000) setSaved({ key, text: body.snapshot });
      }).catch(() => { /* The original durable snapshot stays readable offline. */ })
      .finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [key, kind, sessionId, toolCallId]);
  return saved?.key === key ? saved.text : snapshot;
}

/** Chat knows only the envelope and fallback; feature code owns its state and controls. */
export function AnswerOutput({ result, toolCallId, sessionId, entryId, readOnly = false, generating = false }: Props) {
  const branch = useContext(AnswerOutputScope);
  const previews = useContext(AnswerOutputPreviews);
  const { features, loading } = useBetaFeatures();
  const { t } = useI18n();
  const output = readAnswerOutput(result?.details);
  const snapshot = answerOutputSnapshot(result);
  const preview = !result && !readOnly ? previews.get(toolCallId) : undefined;
  const descriptor = answerOutputDescriptor(output?.kind ?? preview?.kind ?? "");
  const enabled = !!descriptor && features[descriptor.feature];
  const renderer = descriptor ? answerOutputRenderer(descriptor.kind) : undefined;
  const fallback = <div data-answer-output-snapshot role={result?.isError ? "alert" : undefined}
    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "12px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text)", lineHeight: 1.6 }}>
    {!loading && !enabled && descriptor && output && !result?.isError && !result?.isStreaming && !readOnly && sessionId
      ? <SavedAnswerSnapshot key={branch} kind={output.kind} snapshot={snapshot} sessionId={sessionId} toolCallId={toolCallId} />
      : snapshot || t(generating || result?.isStreaming ? "answerOutput.preparing" : "answerOutput.unavailable")}
  </div>;

  if (!loading && enabled && renderer && preview && preview.sessionId === sessionId) {
    const Preview = renderer.Preview;
    return <AnswerOutputBoundary key={`preview:${preview.sessionId}:${preview.runId}:${preview.streamId}:${toolCallId}:${branch}`} fallback={fallback}>
      <Suspense fallback={fallback}><Preview preview={preview} /></Suspense>
    </AnswerOutputBoundary>;
  }
  if (loading || !enabled || !renderer || !output || !descriptor?.versions.includes(output.version) || result?.isError || readOnly) return fallback;
  const Surface = renderer.Surface;
  return <AnswerOutputBoundary key={`${toolCallId}:${branch}:${output.kind}:${output.version}:${snapshot}`} fallback={fallback}>
    <Suspense fallback={fallback}>
      <Surface payload={output.payload} snapshot={snapshot} sessionId={sessionId} toolCallId={toolCallId}
        entryId={entryId} branchKey={branch ?? undefined} envelopeVersion={output.version} readOnly={Boolean(result?.isStreaming)} />
    </Suspense>
  </AnswerOutputBoundary>;
}
