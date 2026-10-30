import type { PromptRunIdentity, PromptRunFinishReason } from "./prompt-run-registry";
import type { UiGenerationRuntime, UiGenerationRuntimeOptions } from "./intelligent-ui/generation-runtime";
import type { AnswerOutputPreview, AnswerOutputPreviewSnapshot } from "./answer-output-preview";

/** Shared chat code binds a capability; the feature is loaded only for plan runs. */
export function bindAnswerOutputGeneration(options: {
  manager: UiGenerationRuntimeOptions["manager"];
  identity: PromptRunIdentity;
  root: string;
  loadedTools: readonly { name: string }[];
  isActive(): boolean;
  assertOwned(): void;
  emitPreview?(preview: AnswerOutputPreview): void;
}) {
  const identity = Object.freeze({ ...options.identity });
  let disposed = false;
  let runtime: UiGenerationRuntime | undefined;
  let cancellation: Promise<void> | undefined;
  const isActive = () => !disposed && options.isActive();
  const enabled = options.loadedTools.some(tool => tool.name === "piora_render_ui_plan");
  const ready: Promise<void> = enabled ? import("./intelligent-ui/generation-runtime").then(({ bindUiGenerationRuntime }) => {
    if (!isActive()) return;
    options.assertOwned();
    runtime = bindUiGenerationRuntime({ manager: options.manager, identity, root: options.root, isActive, assertOwned: options.assertOwned, emitPreview: options.emitPreview });
  }) : Promise.resolve();
  const finish = (reason: PromptRunFinishReason): Promise<void> => {
    if (cancellation) return cancellation;
    disposed = true;
    const stopping = runtime?.finish(reason) ?? Promise.resolve();
    cancellation = Promise.all([ready.catch(() => undefined), stopping]).then(() => undefined);
    return cancellation;
  };
  return {
    identity,
    ready,
    observePreviewEvent: (event: { type: string; [key: string]: unknown }) => runtime?.observePreviewEvent(event),
    getPreviewSnapshot: (): AnswerOutputPreviewSnapshot => runtime?.getPreviewSnapshot()
      ?? { sessionId: identity.sessionId, runId: isActive() ? identity.runId : null, seq: 0, previews: [] },
    finish,
    cancel: (): Promise<void> => finish("abort"),
  };
}

/** Capture once at extension entry; this lookup never loads a feature module. */
export function getAnswerOutputGeneration(manager: object): UiGenerationRuntime | undefined {
  const runtime = globalThis.__pioraUiGenerationRuntimes?.get(manager);
  return runtime?.isAvailable() ? runtime : undefined;
}
