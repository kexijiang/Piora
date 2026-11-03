import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PromptRunFinishReason, PromptRunIdentity } from "./prompt-run-registry";
import type { AnswerOutputPreview } from "./answer-output-preview";
import { readBetaFeatures } from "./beta-features";
import { betaFeatureRevision, subscribeBetaFeatureChanges } from "./beta-feature-events";

export interface AnswerGenerationOptions {
  manager: Pick<SessionManager, "getSessionId" | "getSessionFile" | "getLeafId" | "getBranch">;
  identity: PromptRunIdentity;
  root: string;
  isActive(): boolean;
  assertOwned(): void;
  emitPreview?(preview: AnswerOutputPreview): void;
}

export interface AnswerGenerationRuntime {
  observePreviewEvent(event: { type: string; [key: string]: unknown }): void;
  finish(reason: PromptRunFinishReason): Promise<void>;
}

/** Only first-party adapters may be registered. A model cannot supply an import. */
export const ANSWER_GENERATION_ADAPTERS = [{
  tools: ["piora_render_ui_plan"],
  bind: async (options: AnswerGenerationOptions): Promise<AnswerGenerationRuntime | undefined> => {
    const { bindUiGenerationRuntime } = await import("./intelligent-ui/generation-runtime");
    if (!options.isActive()) return;
    options.assertOwned();
    return bindUiGenerationRuntime(options);
  },
}, {
  tools: ["piora_render_mini_app"],
  bind: async (options: AnswerGenerationOptions): Promise<AnswerGenerationRuntime | undefined> => {
    // Capture before the first await: off/on during lazy loading must also
    // revoke this originating run, even if no runtime exists to notify yet.
    const revision = betaFeatureRevision(options.root);
    const isActive = () => options.isActive() && readBetaFeatures(options.root).intelligentUi && betaFeatureRevision(options.root) === revision;
    if (!isActive()) return;
    const { bindMiniAppGenerationRuntime } = await import("./mini-app/generation-runtime");
    if (!isActive()) return;
    options.assertOwned();
    return bindMiniAppGenerationRuntime({ ...options, isActive,
      subscribeDisable: stop => subscribeBetaFeatureChanges(options.root, features => { if (!features.intelligentUi) stop(); }) });
  },
}];
