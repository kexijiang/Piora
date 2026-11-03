import type { PromptRunFinishReason } from "./prompt-run-registry";
import type { AnswerOutputPreview, AnswerOutputPreviewSnapshot } from "./answer-output-preview";
import { ANSWER_GENERATION_ADAPTERS, type AnswerGenerationOptions, type AnswerGenerationRuntime } from "./answer-output-generation-adapters";

/** Shared chat code binds a capability; the feature is loaded only for plan runs. */
export function bindAnswerOutputGeneration(options: AnswerGenerationOptions & {
  loadedTools: readonly { name: string }[];
}) {
  const identity = Object.freeze({ ...options.identity });
  let disposed = false;
  const runtimes: AnswerGenerationRuntime[] = [];
  const previews = new Map<string, AnswerOutputPreview>();
  let sequence = 0;
  let cancellation: Promise<void> | undefined;
  const isActive = () => !disposed && options.isActive();
  const emitPreview = (value: AnswerOutputPreview) => {
    if (!isActive() && value.phase !== "cleared") return;
    const preview = { ...value, seq: ++sequence };
    const key = `${value.kind}:${value.streamId}:${value.toolCallId}`;
    if (value.phase === "cleared") previews.delete(key);
    else if (previews.has(key) || previews.size < 4) previews.set(key, preview);
    else return;
    options.emitPreview?.(preview);
  };
  const selected = ANSWER_GENERATION_ADAPTERS.filter(adapter => options.loadedTools.some(tool => adapter.tools.includes(tool.name)));
  const ready = Promise.all(selected.map(async adapter => {
    if (!isActive()) return;
    const runtime = await adapter.bind({ ...options, identity, isActive, emitPreview });
    if (!runtime) return;
    if (!isActive()) { await runtime.finish("abort"); return; }
    runtimes.push(runtime);
  })).then(() => undefined);
  const finish = (reason: PromptRunFinishReason): Promise<void> => {
    if (cancellation) return cancellation;
    disposed = true;
    previews.clear();
    const stopping = Promise.all(runtimes.map(runtime => runtime.finish(reason)));
    cancellation = Promise.all([ready.catch(() => undefined), stopping]).then(() => undefined);
    return cancellation;
  };
  return {
    identity,
    ready,
    observePreviewEvent: (event: { type: string; [key: string]: unknown }) => runtimes.forEach(runtime => runtime.observePreviewEvent(event)),
    getPreviewSnapshot: (): AnswerOutputPreviewSnapshot => ({ sessionId: identity.sessionId,
      runId: isActive() ? identity.runId : null, seq: sequence, previews: isActive() ? [...previews.values()] : [] }),
    finish,
    cancel: (): Promise<void> => finish("abort"),
  };
}
