import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  modelSupportsImages,
  readVisionAgentConfig,
  restoreVisionObservationCache,
  transformContextForTextOnlyModel,
  VISION_OBSERVATION_ENTRY_TYPE,
} from "../lib/vision-agent.ts";
import {
  formatVisionAgentStatus,
  VISION_AGENT_STATUS_KEY,
  type VisionAgentStatus,
} from "../lib/vision-agent-status.ts";

export default function registerVisionAgent(api: ExtensionAPI): void {
  let activeStatus: VisionAgentStatus | undefined;
  const failedAttempts = new Set<string>();

  api.on("before_agent_start", (_event, ctx) => {
    failedAttempts.clear();
    // A failure remains visible after the failed turn, but should not leak into
    // the next prompt while its new routing decision is still being made.
    if (activeStatus?.phase === "failed") {
      activeStatus = undefined;
      ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, undefined);
    }
  });

  api.on("message_start", (event, ctx) => {
    if (event.message.role === "assistant" && activeStatus?.phase === "ready") {
      activeStatus = undefined;
      ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, undefined);
    }
  });

  api.on("agent_settled", (_event, ctx) => {
    if (activeStatus && activeStatus.phase !== "failed") {
      activeStatus = undefined;
      ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, undefined);
    }
  });

  api.on("context", async (event, ctx) => {
    const config = readVisionAgentConfig();
    // Routing is capability based. Multimodal primary models keep receiving the
    // original image blocks and never invoke the configured sidecar.
    if (!config.enabled || modelSupportsImages(ctx.model)) {
      if (activeStatus) {
        activeStatus = undefined;
        ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, undefined);
      }
      return;
    }

    const cache = restoreVisionObservationCache(ctx.sessionManager.getBranch());
    const newEntries: Parameters<typeof api.appendEntry>[1][] = [];
    // Surface sidecar failures through the extension status channel instead of failing silently —
    // a text-only model replying "I cannot see images" is otherwise the only
    // hint the user gets.
    let failureReason: string | undefined;
    let analyzedImageCount = 0;
    let transformed = false;
    try {
      const messages = await transformContextForTextOnlyModel({
        messages: event.messages,
        config,
        cache,
        failedAttempts,
        signal: ctx.signal,
        modelRegistry: ctx.modelRegistry,
        cwd: ctx.cwd,
        onObservationStart(imageCount) {
          analyzedImageCount += imageCount;
          activeStatus = { phase: "analyzing", imageCount: analyzedImageCount };
          ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, formatVisionAgentStatus(activeStatus));
        },
        onCacheEntry(entry) {
          cache.set(entry.key, entry);
          newEntries.push(entry);
        },
        onObservationFailure(reason) {
          failureReason = reason;
        },
      });
      for (const entry of newEntries) api.appendEntry(VISION_OBSERVATION_ENTRY_TYPE, entry);
      transformed = true;
      if (failureReason) {
        activeStatus = { phase: "failed", reason: failureReason };
        ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, formatVisionAgentStatus(activeStatus));
      } else if (analyzedImageCount > 0) {
        activeStatus = { phase: "ready", imageCount: analyzedImageCount };
        ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, formatVisionAgentStatus(activeStatus));
      }
      return { messages };
    } finally {
      if (!transformed && activeStatus?.phase !== "failed") {
        activeStatus = undefined;
        ctx.ui.setStatus(VISION_AGENT_STATUS_KEY, undefined);
      }
    }
  });
}
